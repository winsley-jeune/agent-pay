import type { Db, Tx } from "./db.js";

export type SystemAccount = "holds" | "platform_fees" | "stripe_clearing" | "dev_clearing" | "payouts";
export type TxnType = "topup" | "hold" | "capture" | "release" | "refund" | "payout" | "dev_credit" | "subscription";

export interface Entry {
  accountId: string;
  amountCents: number;
}

const systemAccountIds = new Map<SystemAccount, string>();

export async function systemAccount(q: Db | Tx, kind: SystemAccount): Promise<string> {
  const cached = systemAccountIds.get(kind);
  if (cached) return cached;
  const { rows } = await q.query("SELECT id FROM accounts WHERE kind = $1 AND owner_id IS NULL", [kind]);
  if (!rows[0]) throw new Error(`system account ${kind} missing; run migrations`);
  systemAccountIds.set(kind, rows[0].id);
  return rows[0].id;
}

/** Forget cached system account ids (tests recreate the schema). */
export function resetSystemAccountCache() {
  systemAccountIds.clear();
}

export async function createAccount(tx: Tx, kind: "wallet" | "provider", ownerId: string): Promise<string> {
  const { rows } = await tx.query("INSERT INTO accounts (kind, owner_id) VALUES ($1, $2) RETURNING id", [kind, ownerId]);
  return rows[0].id;
}

/**
 * Write one balanced transaction. Entries must sum to zero; the database
 * enforces the same rule at commit time with a deferred trigger.
 */
export async function post(tx: Tx, type: TxnType, entries: Entry[], memo?: string): Promise<string> {
  const nonZero = entries.filter((e) => e.amountCents !== 0);
  for (const e of nonZero) {
    if (!Number.isSafeInteger(e.amountCents)) throw new Error(`amount must be integer cents, got ${e.amountCents}`);
  }
  const sum = nonZero.reduce((s, e) => s + e.amountCents, 0);
  if (sum !== 0) throw new Error(`unbalanced ${type} txn (sum=${sum})`);
  const { rows } = await tx.query("INSERT INTO ledger_txns (type, memo) VALUES ($1, $2) RETURNING id", [type, memo ?? null]);
  const txnId = rows[0].id;
  for (const e of nonZero) {
    await tx.query("INSERT INTO ledger_entries (txn_id, account_id, amount_cents) VALUES ($1, $2, $3)", [txnId, e.accountId, e.amountCents]);
  }
  return txnId;
}

/**
 * Lock an account row for the rest of the transaction. Every code path that
 * spends from a wallet takes this lock first, so concurrent spends against
 * the same wallet run one at a time and cannot overdraw it.
 */
export async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  const { rowCount } = await tx.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
  if (!rowCount) throw new Error(`account ${accountId} not found`);
}

export async function balance(q: Db | Tx, accountId: string): Promise<number> {
  const { rows } = await q.query("SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1", [accountId]);
  return rows[0].b;
}

export interface LedgerLine {
  txnId: string;
  type: TxnType;
  memo: string | null;
  amountCents: number;
  createdAt: Date;
}

export async function history(q: Db | Tx, accountId: string, limit = 100): Promise<LedgerLine[]> {
  const { rows } = await q.query(
    `SELECT t.id AS "txnId", t.type, t.memo, e.amount_cents AS "amountCents", e.created_at AS "createdAt"
       FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id
      WHERE e.account_id = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}
