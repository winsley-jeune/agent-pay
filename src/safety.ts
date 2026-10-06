import { createHash } from "node:crypto";
import type { AgentKey } from "./auth.js";
import { auditTx } from "./audit.js";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { getProtection } from "./helpers.js";
import { lockAccount, post, systemAccount } from "./ledger.js";

// Payment safety checks that run before money is held (ideas from presidio-
// hardened-x402, sphere-sdk and oneshot; docs/landscape.md):
//   - possibly paid: an outside payment whose outcome was unclear blocks paying that seller again
//   - payee pinning: a seller's payment address changed since the last payment
//   - price jump: much more than the last payment to the same seller or tool
//   - duplicate: same payee or task, same amount, same input, within a few minutes (outside payments and quoted tasks)
// A block refuses; an "ask" sends the payment to the owner for approval instead.

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface SafetyInput {
  /** The marketplace tool id, or for outside payments the seller's host. */
  target: string;
  outside: boolean;
  amountCents: number;
  input: unknown;
  /** Outside payments: the address the seller wants to be paid at. */
  payTo?: string;
  /**
   * Check for duplicates. Purchases and paid tasks, yes; repeated lookups
   * (the same weather query twice) are normal, so fixed-price tool calls don't.
   */
  checkDuplicates?: boolean;
}

export interface SafetyResult {
  fingerprint: string;
  ask: string | null;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function fingerprintOf(userId: string, s: SafetyInput): string {
  return createHash("sha256").update(stable([userId, s.outside ? "outside" : "tool", s.target, s.amountCents, s.input ?? null])).digest("hex");
}

export async function checkSafety(db: Db, agentKey: AgentKey, s: SafetyInput): Promise<SafetyResult> {
  const fingerprint = fingerprintOf(agentKey.userId, s);
  if (agentKey.test || s.amountCents === 0) return { fingerprint, ask: null };

  if (s.outside) {
    const unclear = await db.query(
      `SELECT h.id FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id
        WHERE k.user_id = $1 AND h.external_status = 'unclear' AND h.external_target LIKE $2 LIMIT 1`,
      [agentKey.userId, `%://${s.target}%`],
    );
    if (unclear.rows[0]) {
      throw new AppError(409, "possibly_paid", `an earlier payment to ${s.target} may already have gone through; the owner has to confirm it before paying this seller again`, {
        callId: unclear.rows[0].id,
      });
    }
    if (s.payTo) {
      const { rows } = await db.query("SELECT pay_to AS \"payTo\" FROM known_payees WHERE user_id = $1 AND target = $2", [agentKey.userId, s.target]);
      if (rows[0] && rows[0].payTo.toLowerCase() !== s.payTo.toLowerCase()) {
        const why = `${s.target} now wants to be paid at a different address (${s.payTo.slice(0, 10)}…, was ${rows[0].payTo.slice(0, 10)}…)`;
        if ((await getProtection(db, agentKey.userId)).protectedAt) throw new AppError(403, "payee_changed", `${why}; this protected account doesn't pay changed addresses`);
        return { fingerprint, ask: why };
      }
    }
  }

  const ref = await db.query(
    `SELECT h.captured_cents AS c FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id
      WHERE k.user_id = $1 AND h.status = 'captured' AND h.captured_cents > 0 AND NOT h.test
        AND ${s.outside ? "h.external_target LIKE $2" : "h.tool_id::text = $2"} AND h.created_at > now() - interval '90 days'
      ORDER BY h.created_at DESC LIMIT 1`,
    [agentKey.userId, s.outside ? `%://${s.target}%` : s.target],
  );
  const last: number | undefined = ref.rows[0]?.c;
  if (last && s.amountCents > last * config.priceJumpRatio && s.amountCents - last >= 100) {
    return { fingerprint, ask: `${usd(s.amountCents)} is ${(s.amountCents / last).toFixed(1)}× the last payment to the same seller (${usd(last)})` };
  }

  if (!s.outside && !s.checkDuplicates) return { fingerprint, ask: null };
  const dup = await db.query(
    `SELECT h.created_at AS at FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id
      WHERE k.user_id = $1 AND h.fingerprint = $2 AND h.status <> 'released' AND h.external_status IS DISTINCT FROM 'refunded'
        AND h.created_at > now() - make_interval(secs => $3)
      ORDER BY h.created_at DESC LIMIT 1`,
    [agentKey.userId, fingerprint, config.duplicateWindowSeconds],
  );
  if (dup.rows[0]) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(dup.rows[0].at).getTime()) / 60_000));
    return { fingerprint, ask: `looks like a duplicate: the same payment was made ${mins} minute${mins === 1 ? "" : "s"} ago` };
  }
  return { fingerprint, ask: null };
}

/** Remember where a seller was paid, so a later change of address is noticed. */
export async function recordPayee(db: Db, userId: string, target: string, payTo: string) {
  await db.query(
    `INSERT INTO known_payees (user_id, target, pay_to) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, target) DO UPDATE SET pay_to = EXCLUDED.pay_to, last_paid = now(), payments = known_payees.payments + 1`,
    [userId, target, payTo],
  );
}

/** Outside payments whose outcome the owner still has to confirm. */
export async function listUnclear(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT h.id, h.external_protocol AS protocol, h.external_target AS target, h.captured_cents AS "amountCents", h.result, h.created_at AS "createdAt", k.name AS "agentKeyName"
       FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id WHERE k.user_id = $1 AND h.external_status = 'unclear' ORDER BY h.created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * The owner settles an unclear outside payment: it did go through (keep the
 * charge and remember the payee), or it didn't (refund the credits).
 */
export async function resolveUnclear(db: Db, userId: string, holdId: string, paid: boolean) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT h.id, h.wallet_account_id AS wallet, h.captured_cents AS amount, h.test, h.external_target AS target, h.result
         FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id WHERE h.id = $1 AND k.user_id = $2 AND h.external_status = 'unclear' FOR UPDATE OF h`,
      [holdId, userId],
    );
    const h = rows[0];
    if (!h) throw new AppError(404, "not_found", "no unclear payment with that id");
    if (paid) {
      await tx.query("UPDATE holds SET external_status = 'confirmed_paid' WHERE id = $1", [h.id]);
    } else {
      await lockAccount(tx, h.wallet);
      if (h.amount > 0) {
        const sink = await systemAccount(tx, h.test ? "test_sink" : "external_settlement");
        await post(tx, "refund", [{ accountId: sink, amountCents: -h.amount }, { accountId: h.wallet, amountCents: h.amount }], `refund unclear payment ${h.id}`);
      }
      await tx.query("UPDATE holds SET external_status = 'refunded' WHERE id = $1", [h.id]);
    }
    await auditTx(tx, userId, {
      actor: "owner", kind: "payment_resolved", summary: paid ? `Confirmed the payment to ${h.target} went through` : `The payment to ${h.target} didn't go through; ${usd(h.amount)} refunded`,
      data: { callId: h.id },
    });
    return { id: h.id, status: paid ? "confirmed_paid" : "refunded" };
  });
}
