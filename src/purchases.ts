import type { AgentKey } from "./auth.js";
import { auditTx } from "./audit.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";

// Every order the agent places (groceries, items bought under a buy mandate)
// becomes a purchase with a return deadline. It stays open until the owner
// confirms everything arrived, and the owner is reminded before the return
// window closes. Ideas from China's 7-day no-reason returns and Alipay's
// "confirm receipt" (docs/asia-features.md).

/**
 * Typical return windows in days, as of 2026-10. Stores change these and
 * categories differ (perishables, electronics, holiday extensions), so the
 * owner can always correct the date. Check the store's policy before relying on it.
 */
export const RETURN_DAYS: Record<string, number> = {
  walmart: 90,
  "walmart.com": 90,
  whole_foods: 30,
  amazon: 30,
  "amazon.com": 30,
  "target.com": 90,
  "costco.com": 90,
  "bestbuy.com": 15,
  "apple.com": 14,
};
const DEFAULT_RETURN_DAYS = 30;
const REMIND_DAYS = 3;

export function returnDaysFor(store: string): number {
  return RETURN_DAYS[store.toLowerCase().replace(/^www\./, "")] ?? DEFAULT_RETURN_DAYS;
}

const purchaseColumns = `id, source, source_id AS "sourceId", store, title, order_number AS "orderNumber", total_cents AS "totalCents",
  ordered_at AS "orderedAt", return_days AS "returnDays", to_char(return_by, 'YYYY-MM-DD') AS "returnBy", status,
  received_at AS "receivedAt", missing_items AS "missingItems", problem_note AS "problemNote",
  (return_by - CURRENT_DATE) AS "daysLeft"`;

export interface NewPurchase {
  source: "grocery" | "price_watch" | "manual" | "agent";
  sourceId?: string | null;
  store: string;
  title: string;
  orderNumber?: string | null;
  totalCents?: number | null;
  returnDays?: number;
}

/** Record a purchase. Recording the same grocery order or watch twice does nothing. */
export async function recordPurchase(q: Db | Tx, userId: string, p: NewPurchase, agentKey: AgentKey | null = null) {
  const days = Math.min(Math.max(Math.round(p.returnDays ?? returnDaysFor(p.store)), 0), 365);
  const { rows } = await q.query(
    `INSERT INTO purchases (user_id, source, source_id, store, title, order_number, total_cents, return_days, return_by, added_by_agent_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE + $8::int, $9)
     ON CONFLICT (source, source_id) DO NOTHING RETURNING id`,
    [userId, p.source, p.sourceId ?? null, p.store.slice(0, 80), p.title.slice(0, 200), p.orderNumber?.slice(0, 80) ?? null, p.totalCents ?? null, days, agentKey?.id ?? null],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function getPurchase(q: Db | Tx, userId: string, id: string) {
  const { rows } = await q.query(`SELECT ${purchaseColumns} FROM purchases WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "purchase not found");
  return rows[0];
}

export async function listPurchases(q: Db | Tx, userId: string, opts: { open?: boolean } = {}) {
  const { rows } = await q.query(
    `SELECT ${purchaseColumns} FROM purchases WHERE user_id = $1 AND (NOT $2 OR status IN ('ordered','received','problem'))
      ORDER BY (status IN ('returned','closed')), return_by LIMIT 200`,
    [userId, !!opts.open],
  );
  return rows;
}

/** Open purchases whose return window closes within a few days, and orders still waiting to be confirmed. */
export async function purchaseReminders(q: Db | Tx, userId: string) {
  const open = await listPurchases(q, userId, { open: true });
  const out: { purchaseId: string; type: "return_window" | "confirm_received"; title: string; message: string; daysLeft: number }[] = [];
  for (const p of open) {
    if (p.daysLeft >= 0 && p.daysLeft <= REMIND_DAYS) {
      out.push({
        purchaseId: p.id, type: "return_window", title: p.title, daysLeft: p.daysLeft,
        message: `Last day to return "${p.title}" at ${p.store} is ${p.daysLeft === 0 ? "today" : p.daysLeft === 1 ? "tomorrow" : `in ${p.daysLeft} days`} (${p.returnBy}).`,
      });
    }
    if (p.status === "ordered" && Date.now() - new Date(p.orderedAt).getTime() > 2 * 86_400_000) {
      out.push({ purchaseId: p.id, type: "confirm_received", title: p.title, daysLeft: p.daysLeft, message: `Did everything from "${p.title}" arrive? Confirm it, or note what's missing.` });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * The owner confirms what arrived. Missing items mark the purchase as a
 * problem, with a note of what to ask the store to refund; the agent may
 * draft that request but sends it only with the owner's go-ahead.
 */
export async function confirmReceived(
  db: Db,
  userId: string,
  id: string,
  input: { missingItems?: string[]; note?: string },
  agentKey: AgentKey | null = null,
) {
  const missing = (input.missingItems ?? []).map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 50);
  return withTx(db, async (tx) => {
    const p = await getPurchase(tx, userId, id);
    if (p.status === "returned" || p.status === "closed") throw new AppError(409, "closed", `this purchase is already ${p.status}`);
    const problem = missing.length > 0 || !!input.note?.trim();
    await tx.query(
      "UPDATE purchases SET status = $3, received_at = now(), missing_items = $4, problem_note = $5 WHERE id = $1 AND user_id = $2",
      [id, userId, problem ? "problem" : "received", missing, input.note?.slice(0, 500) ?? null],
    );
    await auditTx(tx, userId, {
      actor: agentKey ? "agent" : "owner", agentKeyId: agentKey?.id ?? null, kind: problem ? "purchase_problem" : "purchase_received",
      summary: problem ? `Problem with "${p.title}": ${missing.length ? `missing ${missing.join(", ")}` : input.note}` : `Everything from "${p.title}" arrived`,
      data: { purchaseId: id },
    });
    const updated = await getPurchase(tx, userId, id);
    return problem
      ? { purchase: updated, next: `Ask ${p.store} to refund ${missing.length ? missing.join(", ") : "the problem"} before ${p.returnBy}. The agent may draft the request; send it only with the owner's go-ahead.` }
      : { purchase: updated };
  });
}

export async function setPurchaseStatus(db: Db, userId: string, id: string, status: "returned" | "closed") {
  await getPurchase(db, userId, id);
  await db.query("UPDATE purchases SET status = $3 WHERE id = $1 AND user_id = $2", [id, userId, status]);
  return getPurchase(db, userId, id);
}

/** The owner corrects the return date (store policy, holiday extension, category rules). */
export async function setReturnBy(db: Db, userId: string, id: string, returnBy: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(returnBy) || Number.isNaN(Date.parse(returnBy))) throw new AppError(400, "invalid_date", "returnBy must be YYYY-MM-DD");
  await getPurchase(db, userId, id);
  await db.query("UPDATE purchases SET return_by = $3::date, return_days = GREATEST(0, LEAST(365, $3::date - ordered_at::date)) WHERE id = $1 AND user_id = $2", [id, userId, returnBy]);
  return getPurchase(db, userId, id);
}
