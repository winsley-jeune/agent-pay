import type { AgentKey } from "./auth.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";
import { createCallApproval } from "./approvals.js";
import { audit } from "./audit.js";
import { decideCall, frozenAt, frozenError, LEVEL_LABELS, listEnvelopes, lockEnvelopeFor } from "./controls.js";
import { quote, toolById, toolBySlug, type Tool } from "./registry.js";
import { findCoverage } from "./subscriptions.js";
import { enforce } from "./policy.js";

export interface CallRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Same key + same agent = same call. Retrying never charges twice. */
  idempotencyKey: string;
  approvalId?: string;
  /** Why the agent is making this call, and what the owner asked for. Kept in the owner's log. */
  reason?: string;
  instruction?: string;
}

export type CallResult =
  | {
      status: "ok";
      callId: string;
      chargedCents: number;
      balanceCents: number;
      result: unknown;
      replayed: boolean;
      /** Set when the call was free because a subscription included it. */
      coveredBySubscription?: string;
    }
  | { status: "failed"; callId: string; chargedCents: 0; balanceCents: number; error: string; replayed: boolean }
  | { status: "pending_approval"; approvalId: string; amountCents: number; approveUrl: string; message: string; why: string };

interface HoldRow {
  id: string;
  agentKeyId: string;
  walletAccountId: string;
  toolId: string;
  amountCents: number;
  capturedCents: number | null;
  status: "held" | "captured" | "released";
  result: unknown;
  error: string | null;
}

const holdColumns = `id, agent_key_id AS "agentKeyId", wallet_account_id AS "walletAccountId", tool_id AS "toolId",
  amount_cents AS "amountCents", captured_cents AS "capturedCents", status, result, error`;

export interface GatewayOptions {
  fetchImpl?: typeof fetch;
  platformFeeBps?: number;
}

export function checkToolAllowed(agentKey: AgentKey, tool: Tool) {
  if (agentKey.allowedToolSlugs && !agentKey.allowedToolSlugs.includes(tool.slug)) {
    throw new AppError(403, "tool_not_allowed", `this agent key is not allowed to use "${tool.slug}"`);
  }
}

export async function getToolForAgent(db: Db, agentKey: AgentKey, slug: string): Promise<Tool> {
  const tool = await toolBySlug(db, slug);
  if (!tool) throw new AppError(404, "unknown_tool", `no active tool named "${slug}"`);
  checkToolAllowed(agentKey, tool);
  return tool;
}

/** Cents this key has spent or has in flight over the last `days` days. */
async function spentSince(q: Db | Tx, agentKeyId: string, days: number): Promise<number> {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(COALESCE(captured_cents, amount_cents)), 0)::bigint AS s
       FROM holds
      WHERE agent_key_id = $1 AND status <> 'released' AND created_at > now() - make_interval(days => $2)`,
    [agentKeyId, days],
  );
  return rows[0].s;
}

export async function spendSummary(q: Db | Tx, agentKey: AgentKey) {
  const [last24h, last30d] = await Promise.all([spentSince(q, agentKey.id, 1), spentSince(q, agentKey.id, 30)]);
  const envelopes = (await listEnvelopes(q, agentKey.userId)).filter((e) => e.status === "active" && (!e.agentKeyId || e.agentKeyId === agentKey.id));
  return {
    frozen: (await frozenAt(q, agentKey.userId)) !== null,
    level: agentKey.level,
    levelLabel: LEVEL_LABELS[agentKey.level],
    spendRules: agentKey.spendRules,
    observeAboveCents: agentKey.observeAboveCents,
    coolingOffUntil: agentKey.coolingOffUntil && new Date(agentKey.coolingOffUntil) > new Date() ? agentKey.coolingOffUntil : null,
    envelopes: envelopes.map((e) => ({ id: e.id, name: e.name, purpose: e.purpose, toolSlugs: e.toolSlugs, balanceCents: e.balanceCents, expiresAt: e.expiresAt })),
    walletBalanceCents: await balance(q, agentKey.walletAccountId),
    spentLast24hCents: last24h,
    spentLast30dCents: last30d,
    limits: {
      perCallMaxCents: agentKey.perCallMaxCents,
      dailyCapCents: agentKey.dailyCapCents,
      monthlyCapCents: agentKey.monthlyCapCents,
      approvalThresholdCents: agentKey.approvalThresholdCents,
      allowedToolSlugs: agentKey.allowedToolSlugs,
    },
  };
}

async function holdByKey(q: Db | Tx, agentKeyId: string, idempotencyKey: string): Promise<HoldRow | null> {
  const { rows } = await q.query(`SELECT ${holdColumns} FROM holds WHERE agent_key_id = $1 AND idempotency_key = $2`, [
    agentKeyId,
    idempotencyKey,
  ]);
  return rows[0] ?? null;
}

async function replay(db: Db, hold: HoldRow, toolId: string): Promise<CallResult> {
  if (hold.toolId !== toolId) {
    throw new AppError(422, "idempotency_conflict", "this idempotency key was already used for a different tool");
  }
  if (hold.status === "held") {
    throw new AppError(409, "call_in_progress", "a call with this idempotency key is still running; retry shortly");
  }
  const balanceCents = await balance(db, hold.walletAccountId);
  if (hold.status === "captured") {
    return { status: "ok", callId: hold.id, chargedCents: hold.capturedCents!, balanceCents, result: hold.result, replayed: true };
  }
  return { status: "failed", callId: hold.id, chargedCents: 0, balanceCents, error: hold.error ?? "call failed", replayed: true };
}

/**
 * Reserve funds for one call. Takes the wallet lock so that balance and
 * budget checks cannot race with another call from the same wallet.
 */
async function placeHold(
  db: Db,
  agentKey: AgentKey,
  tool: Tool,
  amountCents: number,
  req: CallRequest,
  subscriptionId: string | null,
  decision: { kind: "auto" | "observe" | "approved" | "covered"; reason: string; envelopeId: string | null },
): Promise<HoldRow> {
  return withTx(db, async (tx) => {
    // Always the owner's wallet first, then any envelope: per-agent caps count holds from both.
    await lockAccount(tx, agentKey.walletAccountId);
    if (await frozenAt(tx, agentKey.userId)) throw frozenError();
    const funding = decision.envelopeId ? await lockEnvelopeFor(tx, agentKey, decision.envelopeId, tool, amountCents) : agentKey.walletAccountId;

    if (subscriptionId) {
      // Re-check quota under the wallet lock so parallel calls can't overspend it.
      const coverage = await findCoverage(tx, agentKey.userId, tool);
      if (coverage?.subscriptionId !== subscriptionId) {
        throw new AppError(409, "quota_changed", "the subscription's included calls just ran out; retry to pay per call");
      }
    }

    if (agentKey.dailyCapCents !== null) {
      const spent = await spentSince(tx, agentKey.id, 1);
      if (spent + amountCents > agentKey.dailyCapCents) {
        throw new AppError(402, "daily_cap_exceeded", "this call would exceed the agent's 24-hour spending cap", {
          capCents: agentKey.dailyCapCents,
          spentCents: spent,
          amountCents,
        });
      }
    }
    if (agentKey.monthlyCapCents !== null) {
      const spent = await spentSince(tx, agentKey.id, 30);
      if (spent + amountCents > agentKey.monthlyCapCents) {
        throw new AppError(402, "monthly_cap_exceeded", "this call would exceed the agent's 30-day spending cap", {
          capCents: agentKey.monthlyCapCents,
          spentCents: spent,
          amountCents,
        });
      }
    }

    if (req.approvalId) {
      const { rowCount } = await tx.query(
        `UPDATE approvals SET status = 'used'
          WHERE id = $1 AND agent_key_id = $2 AND tool_id = $3 AND status = 'approved' AND amount_cents >= $4`,
        [req.approvalId, agentKey.id, tool.id, amountCents],
      );
      if (!rowCount) {
        throw new AppError(403, "approval_invalid", "approval not found, not approved yet, already used, or for a smaller amount");
      }
    }

    const available = await balance(tx, funding);
    if (available < amountCents) {
      throw new AppError(402, "insufficient_funds", "not enough credits; ask the owner to top up", {
        balanceCents: available,
        amountCents,
      });
    }

    const { rows } = await tx.query(
      `INSERT INTO holds (agent_key_id, wallet_account_id, tool_id, idempotency_key, amount_cents, expires_at, subscription_id,
                          decision, decision_reason, agent_reason)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, $8, $9, $10)
       RETURNING ${holdColumns}`,
      [agentKey.id, funding, tool.id, req.idempotencyKey, amountCents, config.holdTtlSeconds, subscriptionId,
       decision.kind, decision.reason.slice(0, 300), req.reason?.slice(0, 500) ?? null],
    );
    const hold: HoldRow = rows[0];
    if (amountCents > 0) {
      await post(
        tx,
        "hold",
        [
          { accountId: funding, amountCents: -amountCents },
          { accountId: await systemAccount(tx, "holds"), amountCents },
        ],
        `hold ${hold.id} for ${tool.slug}`,
      );
    }
    return hold;
  });
}

/** Lock a hold and return it only if it is still open. */
async function lockOpenHold(tx: Tx, holdId: string): Promise<HoldRow | null> {
  const { rows } = await tx.query(`SELECT ${holdColumns} FROM holds WHERE id = $1 FOR UPDATE`, [holdId]);
  return rows[0]?.status === "held" ? rows[0] : null;
}

/**
 * Charge `capturedCents` (≤ the held amount) to the provider, minus the platform
 * fee, and return any remainder to the wallet. No-op if the hold already settled.
 */
export async function captureHold(
  db: Db,
  holdId: string,
  capturedCents: number,
  result: unknown,
  feeBps = config.platformFeeBps,
): Promise<boolean> {
  return withTx(db, async (tx) => {
    const hold = await lockOpenHold(tx, holdId);
    if (!hold) return false;
    const charged = Math.max(0, Math.min(hold.amountCents, Math.floor(capturedCents)));
    const fee = Math.floor((charged * feeBps) / 10_000);
    const tool = (await toolById(tx, hold.toolId))!;
    const { rows } = await tx.query("SELECT account_id FROM providers WHERE id = $1", [tool.providerId]);
    if (hold.amountCents > 0) {
      await post(
        tx,
        "capture",
        [
          { accountId: await systemAccount(tx, "holds"), amountCents: -hold.amountCents },
          { accountId: rows[0].account_id, amountCents: charged - fee },
          { accountId: await systemAccount(tx, "platform_fees"), amountCents: fee },
          { accountId: hold.walletAccountId, amountCents: hold.amountCents - charged },
        ],
        `capture ${hold.id}: ${charged}c of ${hold.amountCents}c held`,
      );
    }
    await tx.query(
      "UPDATE holds SET status = 'captured', captured_cents = $2, result = $3, settled_at = now() WHERE id = $1",
      [holdId, charged, JSON.stringify(result ?? null)],
    );
    return true;
  });
}

/** Return the full held amount to the wallet. No-op if the hold already settled. */
export async function releaseHold(db: Db, holdId: string, error: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const hold = await lockOpenHold(tx, holdId);
    if (!hold) return false;
    if (hold.amountCents > 0) {
      await post(
        tx,
        "release",
        [
          { accountId: await systemAccount(tx, "holds"), amountCents: -hold.amountCents },
          { accountId: hold.walletAccountId, amountCents: hold.amountCents },
        ],
        `release ${hold.id}: ${error.slice(0, 200)}`,
      );
    }
    await tx.query("UPDATE holds SET status = 'released', error = $2, settled_at = now() WHERE id = $1", [holdId, error.slice(0, 2000)]);
    return true;
  });
}

/** Release holds whose call never settled (crash, lost process). Run periodically. */
export async function sweepExpiredHolds(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT id FROM holds WHERE status = 'held' AND expires_at < now()");
  let released = 0;
  for (const { id } of rows) {
    if (await releaseHold(db, id, "hold expired before the call settled")) released++;
  }
  return released;
}

async function callUpstream(tool: Tool, callId: string, input: unknown, fetchImpl: typeof fetch) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-agentpay-call-id": callId,
    "x-agentpay-tool": tool.slug,
  };
  if (tool.upstreamAuth) headers.authorization = tool.upstreamAuth;
  const res = await fetchImpl(tool.upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ callId, input }),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`provider returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain-text result is fine
  }
  const unitsHeader = res.headers.get("x-agentpay-units");
  return { body, unitsUsed: unitsHeader !== null && /^\d+$/.test(unitsHeader) ? Number(unitsHeader) : null };
}

/**
 * The paid call: quote → decision (level, rules, envelope) → hold → upstream →
 * capture or release. Every path that places a hold settles it before
 * returning. Each outcome is written to the owner's "why" log.
 */
export async function callPaidTool(db: Db, agentKey: AgentKey, req: CallRequest, opts: GatewayOptions = {}): Promise<CallResult> {
  let result: CallResult;
  try {
    result = await runPaidCall(db, agentKey, req, opts);
  } catch (err) {
    if (err instanceof AppError && err.status !== 400) {
      await logCall(agentKey, req, "call_refused", `Refused a call to ${req.tool}`, err.message, { code: err.code, ...(err.details as object) }, db);
    }
    throw err;
  }
  if (result.status === "pending_approval") {
    await logCall(agentKey, req, "call_needs_approval", `Asked the owner to approve ${usd(result.amountCents)} for ${req.tool}`, result.why, { approvalId: result.approvalId }, db);
  } else if (!result.replayed) {
    const summary = result.status === "ok" ? `Paid ${usd(result.chargedCents)} for ${req.tool}` : `Call to ${req.tool} failed; not charged`;
    await logCall(agentKey, req, result.status === "ok" ? "call_paid" : "call_failed", summary, result.status === "ok" ? null : result.error, { callId: result.callId }, db);
  }
  return result;
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function logCall(agentKey: AgentKey, req: CallRequest, kind: string, summary: string, result: string | null, data: Record<string, unknown>, db: Db) {
  const reason = req.reason ?? null;
  if (kind === "call_paid" && data.callId) {
    const { rows } = await db.query(`SELECT decision, decision_reason AS "decisionReason" FROM holds WHERE id = $1`, [data.callId]);
    if (rows[0]) data = { ...data, decision: rows[0].decision, decidedBecause: rows[0].decisionReason };
  }
  // The money has already moved; a failure to log must not turn a paid call into an error.
  await audit(db, agentKey.userId, { actor: "agent", agentKeyId: agentKey.id, kind, summary, instruction: req.instruction, reason, result, data }).catch((err) =>
    console.error("audit log write failed", err),
  );
}

async function runPaidCall(db: Db, agentKey: AgentKey, req: CallRequest, opts: GatewayOptions): Promise<CallResult> {
  if (!req.idempotencyKey || req.idempotencyKey.length > 200) {
    throw new AppError(400, "invalid_idempotency_key", "idempotencyKey is required (max 200 chars)");
  }
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const tool = await getToolForAgent(db, agentKey, req.tool);
  enforce(tool.slug, tool.name, tool.description);

  const existing = await holdByKey(db, agentKey.id, req.idempotencyKey);
  if (existing) return replay(db, existing, tool.id);

  // A subscription with included calls left makes this call free; budgets and approvals don't apply.
  const coverage = await findCoverage(db, agentKey.userId, tool);
  const amountCents = coverage ? 0 : quote(tool, req.input).amountCents;

  if (!coverage && agentKey.perCallMaxCents !== null && amountCents > agentKey.perCallMaxCents) {
    throw new AppError(402, "per_call_max_exceeded", "this call costs more than the agent's per-call limit", {
      amountCents,
      perCallMaxCents: agentKey.perCallMaxCents,
    });
  }

  let decision: Parameters<typeof placeHold>[6];
  if (coverage) {
    decision = { kind: "covered", reason: "included in a subscription", envelopeId: null };
  } else if (req.approvalId) {
    decision = { kind: "approved", reason: "approved by the owner with a passkey", envelopeId: null };
  } else {
    const d = await decideCall(db, agentKey, tool, amountCents);
    if (d.outcome === "approve") {
      const approvalId = await createCallApproval(db, agentKey, tool, amountCents, req.input, { why: d.reason, agentReason: req.reason });
      return {
        status: "pending_approval",
        approvalId,
        amountCents,
        approveUrl: `${config.publicUrl}/#approvals`,
        why: d.reason,
        message:
          `This call costs ${amountCents}c and needs the owner's approval (${d.reason}). ` +
          `Ask the owner to approve it with their passkey, then retry with the same input and approvalId "${approvalId}".`,
      };
    }
    decision = { kind: d.outcome, reason: d.reason, envelopeId: d.envelopeId };
  }

  let hold: HoldRow;
  try {
    hold = await placeHold(db, agentKey, tool, amountCents, { ...req, approvalId: coverage ? undefined : req.approvalId }, coverage?.subscriptionId ?? null, decision);
  } catch (err: any) {
    // Lost a race with a concurrent call using the same idempotency key.
    if (err?.code === "23505") {
      const winner = await holdByKey(db, agentKey.id, req.idempotencyKey);
      if (winner) return replay(db, winner, tool.id);
    }
    throw err;
  }

  let upstream: Awaited<ReturnType<typeof callUpstream>>;
  try {
    upstream = await callUpstream(tool, hold.id, req.input, opts.fetchImpl ?? fetch);
  } catch (err: any) {
    const message = err?.name === "TimeoutError" ? "provider timed out" : String(err?.message ?? err);
    await releaseHold(db, hold.id, message);
    return {
      status: "failed",
      callId: hold.id,
      chargedCents: 0,
      balanceCents: await balance(db, agentKey.walletAccountId),
      error: message,
      replayed: false,
    };
  }

  const charge =
    tool.pricingType === "per_unit" && upstream.unitsUsed !== null
      ? Math.min(amountCents, upstream.unitsUsed * tool.priceCents)
      : amountCents;
  try {
    const captured = await captureHold(db, hold.id, charge, upstream.body, opts.platformFeeBps);
    if (!captured) {
      // The sweeper released this hold while the provider was still working; the call is free.
      return {
        status: "failed",
        callId: hold.id,
        chargedCents: 0,
        balanceCents: await balance(db, agentKey.walletAccountId),
        error: "hold expired before the provider answered; you were not charged",
        replayed: false,
      };
    }
  } catch (err) {
    // Couldn't record the charge: give the money back rather than leave it held. The sweeper is the backstop.
    await releaseHold(db, hold.id, "gateway error while settling").catch(() => {});
    throw err;
  }
  return {
    status: "ok",
    callId: hold.id,
    chargedCents: charge,
    balanceCents: await balance(db, agentKey.walletAccountId),
    result: upstream.body,
    replayed: false,
    ...(coverage ? { coveredBySubscription: coverage.subscriptionId } : {}),
  };
}
