import type { AgentKey } from "./auth.js";
import { auditTx } from "./audit.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, createAccount, lockAccount, post } from "./ledger.js";
import type { Tool } from "./registry.js";
import { enforce } from "./policy.js";

// Owner controls over everything agents can spend (see docs/asia.md):
//   - the kill switch (OCBC): one action stops every agent; unfreezing takes a passkey
//   - autonomy levels and spend rules (Alipay AI Wallet, JD A2P2, Singapore SAFR)
//   - envelopes: money set aside for one agent or set of tools, returned when it ends
//     (WeChat Pay AI card, UPI Reserve Pay, Singapore Purpose Bound Money)
//   - the vault: money no agent or approval can spend (DBS digiVault, OCBC Money Lock)

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

// ---------------------------------------------------------------- kill switch

export async function frozenAt(q: Db | Tx, userId: string): Promise<Date | null> {
  const { rows } = await q.query("SELECT frozen_at AS f FROM users WHERE id = $1", [userId]);
  return rows[0]?.f ?? null;
}

export function frozenError() {
  return new AppError(423, "frozen", "the owner froze all agent activity. Stop, and tell the owner; only they can unfreeze it.");
}

/**
 * Stop everything at once: agents can't call the API, AgentPay plan renewals
 * wait, and every pending approval is declined. Needs no passkey, because it
 * only ever stops spending. `declinePending` is approvals.deny, passed in to
 * keep this module free of a circular import.
 */
export async function freeze(
  db: Db,
  userId: string,
  declinePending: (db: Db, userId: string, id: string) => Promise<void>,
  by: { helperLabel: string } | null = null,
) {
  const { rows } = await db.query("UPDATE users SET frozen_at = COALESCE(frozen_at, now()) WHERE id = $1 RETURNING frozen_at AS f", [userId]);
  const pending = await db.query("SELECT id FROM approvals WHERE user_id = $1 AND status = 'pending' AND kind <> 'unfreeze'", [userId]);
  for (const { id } of pending.rows) await declinePending(db, userId, id).catch(() => {});
  await withTx(db, (tx) =>
    auditTx(tx, userId, {
      actor: by ? "helper" : "owner", kind: "freeze", summary: by ? `${by.helperLabel} froze all agent activity` : "Froze all agent activity",
      result: `${pending.rows.length} pending approval(s) declined`,
    }),
  );
  return { frozenAt: rows[0].f as Date, declined: pending.rows.length };
}

/** Unfreezing gives agents their spending back, so it is an approval signed with a passkey. */
export async function requestUnfreeze(db: Db, userId: string) {
  if (!(await frozenAt(db, userId))) throw new AppError(409, "not_frozen", "nothing is frozen");
  const existing = await db.query("SELECT id FROM approvals WHERE user_id = $1 AND kind = 'unfreeze' AND status = 'pending'", [userId]);
  if (existing.rows[0]) return { approvalId: existing.rows[0].id as string };
  const { rows } = await db.query("INSERT INTO approvals (kind, user_id, amount_cents, input) VALUES ('unfreeze', $1, 0, '{}') RETURNING id", [userId]);
  return { approvalId: rows[0].id as string };
}

/** Called from approve() for an 'unfreeze' approval. */
export async function applyUnfreeze(tx: Tx, userId: string) {
  await tx.query("UPDATE users SET frozen_at = NULL WHERE id = $1", [userId]);
  await auditTx(tx, userId, { actor: "owner", kind: "unfreeze", summary: "Unfroze agent activity (passkey)" });
}

// ---------------------------------------------------------------- autonomy levels

export type Level = "ask" | "rules" | "budget";
export type RuleOutcome = "auto" | "observe";
export interface SpendRule {
  name: string;
  tools: string[] | null;
  maxCents: number;
  outcome: RuleOutcome;
}

export const LEVEL_LABELS: Record<Level, string> = {
  ask: "L0 · asks before every paid call",
  rules: "L1 · pays only what a rule allows",
  budget: "L2 · pays on its own within its limits",
};

export type Decision =
  | { outcome: "auto" | "observe"; reason: string; envelopeId: string | null }
  | { outcome: "approve"; reason: string; envelopeId: null };

/**
 * How a paid call should be handled, from the agent's level, rules, cooling-off,
 * the drain guard and any envelope that covers it. Per-call maximums, caps and
 * the balance are enforced separately when the money is held.
 */
export async function decideCall(q: Db | Tx, agentKey: AgentKey, tool: Tool, amountCents: number): Promise<Decision> {
  if (amountCents === 0) return { outcome: "auto", reason: "free call", envelopeId: null };
  const observe = (reason: string, envelopeId: string | null = null): Decision =>
    agentKey.observeAboveCents !== null && amountCents > agentKey.observeAboveCents
      ? { outcome: "observe", reason: `${reason}; above the ${usd(agentKey.observeAboveCents)} review line`, envelopeId }
      : { outcome: "auto", reason, envelopeId };
  const ask = (reason: string): Decision => ({ outcome: "approve", reason, envelopeId: null });

  // Money the owner already set aside with a passkey is pre-approved for this agent and tool.
  const envelope = await findEnvelopeFor(q, agentKey, tool, amountCents);
  if (envelope) return observe(`paid from envelope "${envelope.name}"`, envelope.id);

  if (agentKey.level === "ask") return ask("this agent asks before every paid call");
  if (agentKey.coolingOffUntil && new Date(agentKey.coolingOffUntil) > new Date() && amountCents > config.coolingOffAutoMaxCents) {
    return ask(`new agent: until ${new Date(agentKey.coolingOffUntil).toISOString()} it pays only up to ${usd(config.coolingOffAutoMaxCents)} on its own`);
  }
  if (config.drainGuard) {
    const { rows } = await q.query(
      `SELECT COALESCE(SUM(COALESCE(captured_cents, amount_cents)), 0)::bigint AS s FROM holds
        WHERE agent_key_id = $1 AND status <> 'released' AND created_at > now() - interval '1 hour'`,
      [agentKey.id],
    );
    const lastHour: number = rows[0].s;
    const wallet = await balance(q, agentKey.walletAccountId);
    if (lastHour + amountCents > Math.max(config.drainGuardMinCents, Math.floor((wallet + lastHour) / 2))) {
      return ask(`unusual spending: ${usd(lastHour + amountCents)} in an hour would be more than half the wallet`);
    }
  }
  if (agentKey.approvalThresholdCents !== null && amountCents > agentKey.approvalThresholdCents) {
    return ask(`above the ${usd(agentKey.approvalThresholdCents)} approval threshold`);
  }
  if (agentKey.level === "rules") {
    const rule = agentKey.spendRules.find((r) => (!r.tools || r.tools.includes(tool.slug)) && amountCents <= r.maxCents);
    if (!rule) return ask("no spending rule covers this call");
    return rule.outcome === "observe"
      ? { outcome: "observe", reason: `rule "${rule.name}" (flagged for review)`, envelopeId: null }
      : observe(`rule "${rule.name}"`);
  }
  return observe("within this agent's limits");
}

// ---------------------------------------------------------------- envelopes

export interface Envelope {
  id: string;
  name: string;
  purpose: string | null;
  agentKeyId: string | null;
  agentKeyName: string | null;
  toolSlugs: string[] | null;
  amountCents: number;
  balanceCents: number;
  status: "pending" | "active" | "closed" | "denied";
  expiresAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  accountId: string;
  createdAt: Date;
}

const envelopeColumns = `e.id, e.name, e.purpose, e.agent_key_id AS "agentKeyId", k.name AS "agentKeyName", e.tool_slugs AS "toolSlugs",
  e.amount_cents AS "amountCents", e.status, e.expires_at AS "expiresAt", e.closed_at AS "closedAt", e.close_reason AS "closeReason",
  e.account_id AS "accountId", e.created_at AS "createdAt",
  (SELECT COALESCE(SUM(amount_cents), 0) FROM ledger_entries WHERE account_id = e.account_id)::bigint AS "balanceCents"`;
const envelopeFrom = `envelopes e LEFT JOIN agent_keys k ON k.id = e.agent_key_id`;

export async function listEnvelopes(q: Db | Tx, userId: string, opts: { includeEnded?: boolean } = {}): Promise<Envelope[]> {
  const { rows } = await q.query(
    `SELECT ${envelopeColumns} FROM ${envelopeFrom}
      WHERE e.user_id = $1 AND ($2 OR e.status IN ('pending','active')) ORDER BY e.created_at DESC`,
    [userId, !!opts.includeEnded],
  );
  return rows;
}

async function envelopeById(q: Db | Tx, userId: string, id: string): Promise<Envelope> {
  const { rows } = await q.query(`SELECT ${envelopeColumns} FROM ${envelopeFrom} WHERE e.id = $1 AND e.user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "envelope not found");
  return rows[0];
}

/** The live envelope that can pay this call, soonest-ending first. */
export async function findEnvelopeFor(q: Db | Tx, agentKey: AgentKey, tool: Tool, amountCents: number): Promise<Envelope | null> {
  const { rows } = await q.query(
    `SELECT * FROM (SELECT ${envelopeColumns} FROM ${envelopeFrom}
      WHERE e.user_id = $1 AND e.status = 'active' AND e.expires_at > now()
        AND (e.agent_key_id IS NULL OR e.agent_key_id = $2)
        AND (e.tool_slugs IS NULL OR $3 = ANY(e.tool_slugs))) x
      WHERE "balanceCents" >= $4 ORDER BY "expiresAt" LIMIT 1`,
    [agentKey.userId, agentKey.id, tool.slug, amountCents],
  );
  return rows[0] ?? null;
}

/** Re-check, under the wallet lock, that an envelope can still pay; lock its account and return it. */
export async function lockEnvelopeFor(tx: Tx, agentKey: AgentKey, envelopeId: string, tool: Tool, amountCents: number): Promise<string> {
  const e = await envelopeById(tx, agentKey.userId, envelopeId);
  await lockAccount(tx, e.accountId);
  const ok =
    e.status === "active" &&
    new Date(e.expiresAt) > new Date() &&
    (!e.agentKeyId || e.agentKeyId === agentKey.id) &&
    (!e.toolSlugs || e.toolSlugs.includes(tool.slug)) &&
    (await balance(tx, e.accountId)) >= amountCents;
  if (!ok) throw new AppError(409, "envelope_changed", "the envelope for this call just closed or ran low; retry");
  return e.accountId;
}

export interface EnvelopeInput {
  name: string;
  amountCents: number;
  days: number;
  purpose?: string;
  agentKeyId?: string | null;
  toolSlugs?: string[] | null;
}

/** Ask to set money aside. Nothing moves until the owner approves with a passkey. */
export async function requestEnvelope(db: Db, userId: string, input: EnvelopeInput, requestedBy: AgentKey | null = null) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new AppError(400, "invalid_amount", "amountCents must be a positive integer");
  enforce(input.name, input.purpose);
  const days = Math.min(Math.max(Math.round(input.days), 1), 90);
  // An agent can only ask for an envelope for itself.
  const agentKeyId = requestedBy ? requestedBy.id : (input.agentKeyId ?? null);
  return withTx(db, async (tx) => {
    let agentName: string | null = null;
    if (agentKeyId) {
      const { rows } = await tx.query("SELECT name FROM agent_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [agentKeyId, userId]);
      if (!rows[0]) throw new AppError(404, "unknown_agent", "no active agent key with that id");
      agentName = rows[0].name;
    }
    const accountId = await createAccount(tx, "envelope", userId);
    const toolSlugs = input.toolSlugs?.length ? [...new Set(input.toolSlugs)] : null;
    const { rows } = await tx.query(
      `INSERT INTO envelopes (user_id, account_id, agent_key_id, name, purpose, tool_slugs, amount_cents, expires_at, requested_by_agent_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9) RETURNING id, expires_at AS "expiresAt"`,
      [userId, accountId, agentKeyId, input.name.slice(0, 80), input.purpose?.slice(0, 300) ?? null, toolSlugs, input.amountCents, days, requestedBy?.id ?? null],
    );
    const approval = await tx.query(
      `INSERT INTO approvals (kind, user_id, agent_key_id, envelope_id, amount_cents, input) VALUES ('envelope', $1, $2, $3, $4, $5) RETURNING id`,
      [
        userId, requestedBy?.id ?? null, rows[0].id, input.amountCents,
        JSON.stringify({ name: input.name, purpose: input.purpose ?? null, agent: agentName, tools: toolSlugs, days, expiresOn: new Date(rows[0].expiresAt).toISOString().slice(0, 10) }),
      ],
    );
    return { status: "pending_approval" as const, envelopeId: rows[0].id as string, approvalId: approval.rows[0].id as string };
  });
}

/** Called from approve() for an 'envelope' approval: move the money out of the wallet. */
export async function activateEnvelope(tx: Tx, userId: string, envelopeId: string) {
  const e = await envelopeById(tx, userId, envelopeId);
  if (e.status !== "pending") throw new AppError(409, "not_pending", `this envelope is already ${e.status}`);
  const { rows } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'wallet'", [userId]);
  const wallet: string = rows[0].id;
  await lockAccount(tx, wallet);
  const available = await balance(tx, wallet);
  if (available < e.amountCents) {
    throw new AppError(402, "insufficient_funds", `the wallet has ${usd(available)}; top up before setting aside ${usd(e.amountCents)}`);
  }
  await post(tx, "envelope", [{ accountId: wallet, amountCents: -e.amountCents }, { accountId: e.accountId, amountCents: e.amountCents }], `fund envelope ${e.id}`);
  await tx.query("UPDATE envelopes SET status = 'active' WHERE id = $1", [e.id]);
  await auditTx(tx, userId, { actor: "owner", kind: "envelope_funded", summary: `Set aside ${usd(e.amountCents)} in "${e.name}"`, data: { envelopeId: e.id } });
}

export async function denyEnvelope(tx: Tx, envelopeId: string) {
  await tx.query("UPDATE envelopes SET status = 'denied' WHERE id = $1 AND status = 'pending'", [envelopeId]);
}

/** Return what's left to the wallet. Waits while a call paid from it is still running. */
export async function closeEnvelope(db: Db, userId: string, envelopeId: string, reason = "closed_by_owner") {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'wallet'", [userId]);
    const wallet: string = rows[0].id;
    await lockAccount(tx, wallet); // same order as paid calls: wallet, then envelope
    const e = await envelopeById(tx, userId, envelopeId);
    if (e.status === "pending") {
      await tx.query("UPDATE envelopes SET status = 'denied', closed_at = now(), close_reason = $2 WHERE id = $1", [e.id, reason]);
      await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE envelope_id = $1 AND status = 'pending'", [e.id]);
      return { returnedCents: 0 };
    }
    if (e.status !== "active") throw new AppError(409, "not_active", `this envelope is already ${e.status}`);
    await lockAccount(tx, e.accountId);
    const open = await tx.query("SELECT 1 FROM holds WHERE wallet_account_id = $1 AND status = 'held' LIMIT 1", [e.accountId]);
    if (open.rowCount) throw new AppError(409, "envelope_busy", "a call paid from this envelope is still running; try again in a minute");
    const left = await balance(tx, e.accountId);
    if (left > 0) {
      await post(tx, "envelope", [{ accountId: e.accountId, amountCents: -left }, { accountId: wallet, amountCents: left }], `close envelope ${e.id}: ${reason}`);
    }
    await tx.query("UPDATE envelopes SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1", [e.id, reason]);
    await auditTx(tx, userId, {
      actor: reason === "expired" ? "system" : "owner", kind: "envelope_closed",
      summary: `Closed "${e.name}"; ${usd(left)} returned to the wallet`, reason, data: { envelopeId: e.id },
    });
    return { returnedCents: left };
  });
}

/** Close envelopes whose time is up. Run periodically. */
export async function sweepEnvelopes(db: Db): Promise<number> {
  const { rows } = await db.query(`SELECT id, user_id AS "userId" FROM envelopes WHERE status = 'active' AND expires_at <= now()`);
  let closed = 0;
  for (const r of rows) {
    try {
      await closeEnvelope(db, r.userId, r.id, "expired");
      closed++;
    } catch (err) {
      if (!(err instanceof AppError && err.code === "envelope_busy")) throw err;
    }
  }
  return closed;
}

// ---------------------------------------------------------------- vault

async function vaultAccount(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'vault'", [userId]);
  return rows[0]?.id ?? (await createAccount(tx, "vault", userId));
}

export async function vaultSummary(q: Db | Tx, userId: string) {
  const { rows } = await q.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'vault'", [userId]);
  const unlocks = await q.query(
    `SELECT id, amount_cents AS "amountCents", status, available_at AS "availableAt", created_at AS "createdAt"
       FROM vault_unlocks WHERE user_id = $1 AND status IN ('requested','waiting') ORDER BY created_at`,
    [userId],
  );
  return { balanceCents: rows[0] ? await balance(q, rows[0].id) : 0, unlockDelayHours: config.vaultUnlockDelayHours, unlocks: unlocks.rows };
}

/** Move money from the wallet into the vault. No passkey: it only makes money harder to spend. */
export async function lockInVault(db: Db, userId: string, amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError(400, "invalid_amount", "amountCents must be a positive integer");
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'wallet'", [userId]);
    const wallet: string = rows[0].id;
    await lockAccount(tx, wallet);
    const available = await balance(tx, wallet);
    if (available < amountCents) throw new AppError(402, "insufficient_funds", `the wallet has ${usd(available)}`);
    const vault = await vaultAccount(tx, userId);
    await post(tx, "vault", [{ accountId: wallet, amountCents: -amountCents }, { accountId: vault, amountCents }], "lock in vault");
    await auditTx(tx, userId, { actor: "owner", kind: "vault_lock", summary: `Locked ${usd(amountCents)} in the vault` });
    return vaultSummary(tx, userId);
  });
}

/** Unlocking is a passkey approval followed by a wait, so a stolen session can't empty the vault quickly. */
export async function requestVaultUnlock(db: Db, userId: string, amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError(400, "invalid_amount", "amountCents must be a positive integer");
  const { balanceCents } = await vaultSummary(db, userId);
  if (amountCents > balanceCents) throw new AppError(402, "insufficient_funds", `the vault has ${usd(balanceCents)}`);
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("INSERT INTO vault_unlocks (user_id, amount_cents) VALUES ($1, $2) RETURNING id", [userId, amountCents]);
    const approval = await tx.query(
      "INSERT INTO approvals (kind, user_id, vault_unlock_id, amount_cents, input) VALUES ('vault_unlock', $1, $2, $3, $4) RETURNING id",
      [userId, rows[0].id, amountCents, JSON.stringify({ delayHours: config.vaultUnlockDelayHours })],
    );
    return { status: "pending_approval" as const, unlockId: rows[0].id as string, approvalId: approval.rows[0].id as string };
  });
}

/** Called from approve() for a 'vault_unlock' approval: start the wait. */
export async function approveVaultUnlock(tx: Tx, unlockId: string) {
  await tx.query(
    "UPDATE vault_unlocks SET status = 'waiting', available_at = now() + make_interval(hours => $2) WHERE id = $1 AND status = 'requested'",
    [unlockId, config.vaultUnlockDelayHours],
  );
}

export async function denyVaultUnlock(tx: Tx, unlockId: string) {
  await tx.query("UPDATE vault_unlocks SET status = 'denied' WHERE id = $1 AND status = 'requested'", [unlockId]);
}

export async function cancelVaultUnlock(db: Db, userId: string, unlockId: string) {
  await withTx(db, async (tx) => {
    const { rowCount } = await tx.query(
      "UPDATE vault_unlocks SET status = 'canceled' WHERE id = $1 AND user_id = $2 AND status IN ('requested','waiting')",
      [unlockId, userId],
    );
    if (!rowCount) throw new AppError(404, "not_found", "no unlock in progress with that id");
    await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE vault_unlock_id = $1 AND status = 'pending'", [unlockId]);
  });
}

/** Move unlocked money back to the wallet once the wait is over. Run periodically. */
export async function releaseVaultUnlocks(db: Db): Promise<number> {
  const { rows } = await db.query(`SELECT id, user_id AS "userId" FROM vault_unlocks WHERE status = 'waiting' AND available_at <= now()`);
  for (const r of rows) {
    await withTx(db, async (tx) => {
      const u = await tx.query(`SELECT amount_cents AS "amountCents" FROM vault_unlocks WHERE id = $1 AND status = 'waiting' FOR UPDATE`, [r.id]);
      if (!u.rows[0]) return;
      const { rows: w } = await tx.query("SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'wallet'", [r.userId]);
      await lockAccount(tx, w[0].id);
      const vault = await vaultAccount(tx, r.userId);
      await lockAccount(tx, vault);
      const amount = Math.min(u.rows[0].amountCents, await balance(tx, vault));
      if (amount > 0) {
        await post(tx, "vault", [{ accountId: vault, amountCents: -amount }, { accountId: w[0].id, amountCents: amount }], `vault unlock ${r.id}`);
      }
      await tx.query("UPDATE vault_unlocks SET status = 'done', done_at = now() WHERE id = $1", [r.id]);
      await auditTx(tx, r.userId, { actor: "system", kind: "vault_unlock", summary: `Moved ${usd(amount)} from the vault to the wallet` });
    });
  }
  return rows.length;
}
