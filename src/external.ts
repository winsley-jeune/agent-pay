import type { AgentKey } from "./auth.js";
import { BUNDLES, SERVICES, STORE_BILLERS, serviceBySlug, type Service } from "./catalog.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { listSubscriptions, monthlyCents, type Interval } from "./subscriptions.js";

// Everyday subscriptions billed outside AgentPay (Netflix, AT&T, the gym...).
// Nothing in this module moves money.

export type BilledThrough = "direct" | "apple" | "google" | "amazon" | "carrier" | "other";
export type ExternalStatus = "active" | "trial" | "cancel_requested" | "cancel_approved" | "canceled";

export interface ExternalSubscription {
  id: string;
  userId: string;
  serviceSlug: string | null;
  name: string;
  category: string;
  planName: string | null;
  priceCents: number;
  interval: Interval;
  billedThrough: BilledThrough;
  paymentMethod: string | null;
  status: ExternalStatus;
  nextRenewalOn: string | null;
  trialEndsOn: string | null;
  contractUntil: string | null;
  earlyTerminationFeeCents: number | null;
  lastUsedOn: string | null;
  merchantKey: string | null;
  priceHistory: { date: string; fromCents: number; toCents: number }[];
  /** The price the owner accepted; a newer, higher price waits for "keep" or "cancel". */
  acceptedPriceCents: number | null;
  notes: string | null;
  source: "manual" | "import" | "agent";
  canceledAt: Date | null;
  cancelConfirmation: string | null;
  createdAt: Date;
}

export interface ExternalInput {
  serviceSlug?: string | null;
  name?: string;
  category?: string;
  planName?: string | null;
  priceCents?: number;
  interval?: Interval;
  billedThrough?: BilledThrough;
  paymentMethod?: string | null;
  status?: "active" | "trial";
  nextRenewalOn?: string | null;
  trialEndsOn?: string | null;
  contractUntil?: string | null;
  earlyTerminationFeeCents?: number | null;
  lastUsedOn?: string | null;
  merchantKey?: string | null;
  notes?: string | null;
}

// Dates are plain calendar days; return them as YYYY-MM-DD strings, not JS Dates.
const extColumns = `id, user_id AS "userId", service_slug AS "serviceSlug", name, category, plan_name AS "planName",
  price_cents AS "priceCents", interval, billed_through AS "billedThrough", payment_method AS "paymentMethod", status,
  to_char(next_renewal_on, 'YYYY-MM-DD') AS "nextRenewalOn", to_char(trial_ends_on, 'YYYY-MM-DD') AS "trialEndsOn",
  to_char(contract_until, 'YYYY-MM-DD') AS "contractUntil", early_termination_fee_cents AS "earlyTerminationFeeCents",
  to_char(last_used_on, 'YYYY-MM-DD') AS "lastUsedOn", merchant_key AS "merchantKey", price_history AS "priceHistory",
  accepted_price_cents AS "acceptedPriceCents", notes, source, canceled_at AS "canceledAt", cancel_confirmation AS "cancelConfirmation", created_at AS "createdAt"`;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(field: string, v: string | null | undefined) {
  if (v != null && (!isoDate.test(v) || Number.isNaN(Date.parse(v)))) throw new AppError(400, "invalid_date", `${field} must be YYYY-MM-DD`);
}

/** True if `pattern` occurs in `text` at the start of a word ("HULU" matches "HULU 877..." but not "SHULUX"). */
function startsWord(text: string, pattern: string): boolean {
  for (let i = text.indexOf(pattern); i >= 0; i = text.indexOf(pattern, i + 1)) {
    if (i === 0 || !/[A-Z0-9]/.test(text[i - 1])) return true;
  }
  return false;
}

/** Merchant key used to link statement lines to subscriptions: a catalog slug when known. */
export function merchantKeyFor(description: string): { key: string; serviceSlug: string | null; billedThrough: BilledThrough | null } {
  const d = description.toUpperCase();
  for (const s of SERVICES) {
    if (s.merchantPatterns.some((p) => startsWord(d, p))) return { key: `service:${s.slug}`, serviceSlug: s.slug, billedThrough: s.category === "phone" ? "carrier" : null };
  }
  for (const b of STORE_BILLERS) {
    if (d.includes(b.pattern)) return { key: `store:${b.billedThrough}`, serviceSlug: null, billedThrough: b.billedThrough };
  }
  const cleaned = d
    .replace(/\b(POS|ACH|DEBIT|PURCHASE|RECURRING|PAYMENT|CARD|ONLINE|WWW|COM|INC|LLC)\b/g, " ")
    .replace(/[#*]\S*/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^A-Z&+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
  return { key: `merchant:${cleaned || d.slice(0, 20)}`, serviceSlug: null, billedThrough: null };
}

export async function getExternal(q: Db | Tx, userId: string, id: string): Promise<ExternalSubscription> {
  const { rows } = await q.query(`SELECT ${extColumns} FROM external_subscriptions WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "subscription not found");
  return rows[0];
}

export async function listExternal(q: Db | Tx, userId: string, opts: { includeCanceled?: boolean } = {}): Promise<ExternalSubscription[]> {
  const { rows } = await q.query(
    `SELECT ${extColumns} FROM external_subscriptions WHERE user_id = $1 ${opts.includeCanceled ? "" : "AND status <> 'canceled'"}
      ORDER BY category, name`,
    [userId],
  );
  return rows;
}

export async function addExternal(db: Db, userId: string, input: ExternalInput, by: { source: "manual" | "import" | "agent"; agentKey?: AgentKey | null }) {
  const service = input.serviceSlug ? serviceBySlug(input.serviceSlug) : undefined;
  if (input.serviceSlug && !service) throw new AppError(400, "unknown_service", `no service "${input.serviceSlug}"; omit serviceSlug and give a name instead`);
  const name = input.name?.trim() || service?.name;
  if (!name) throw new AppError(400, "invalid_request", "name or serviceSlug is required");
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents! < 0) throw new AppError(400, "invalid_price", "priceCents must be a non-negative integer");
  for (const f of ["nextRenewalOn", "trialEndsOn", "contractUntil", "lastUsedOn"] as const) checkDate(f, input[f]);
  const billedThrough = input.billedThrough ?? (service?.category === "phone" ? "carrier" : "direct");
  const merchantKey =
    input.merchantKey ??
    (billedThrough === "apple" || billedThrough === "google" || billedThrough === "amazon"
      ? `store:${billedThrough}`
      : service
        ? `service:${service.slug}`
        : merchantKeyFor(name).key);
  const { rows } = await db.query(
    `INSERT INTO external_subscriptions (user_id, service_slug, name, category, plan_name, price_cents, interval, billed_through,
       payment_method, status, next_renewal_on, trial_ends_on, contract_until, early_termination_fee_cents, last_used_on,
       merchant_key, notes, source, added_by_agent_key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      userId, service?.slug ?? null, name, (input.category ?? service?.category ?? "other").toLowerCase(), input.planName ?? null,
      input.priceCents, input.interval ?? "month", billedThrough, input.paymentMethod ?? null, input.status ?? "active",
      input.nextRenewalOn ?? null, input.trialEndsOn ?? null, input.contractUntil ?? null, input.earlyTerminationFeeCents ?? null,
      input.lastUsedOn ?? null, merchantKey, input.notes ?? null, by.source, by.agentKey?.id ?? null,
    ],
  );
  // Link any already-imported charges for this merchant.
  await db.query(
    "UPDATE external_charges SET external_subscription_id = $1 WHERE user_id = $2 AND merchant_key = $3 AND external_subscription_id IS NULL",
    [rows[0].id, userId, merchantKey],
  );
  return getExternal(db, userId, rows[0].id);
}

const updatable: Record<string, string> = {
  name: "name", category: "category", planName: "plan_name", priceCents: "price_cents", interval: "interval",
  billedThrough: "billed_through", paymentMethod: "payment_method", nextRenewalOn: "next_renewal_on", trialEndsOn: "trial_ends_on",
  contractUntil: "contract_until", earlyTerminationFeeCents: "early_termination_fee_cents", lastUsedOn: "last_used_on", notes: "notes",
};

export async function updateExternal(
  db: Db,
  userId: string,
  id: string,
  input: ExternalInput & { status?: "active" | "trial" },
  opts: { byOwner?: boolean } = {},
) {
  for (const f of ["nextRenewalOn", "trialEndsOn", "contractUntil", "lastUsedOn"] as const) checkDate(f, input[f]);
  return withTx(db, async (tx) => {
    const current = await getExternal(tx, userId, id);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(updatable)) {
      const v = (input as Record<string, unknown>)[field];
      if (v !== undefined) {
        values.push(v);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (input.status) {
      values.push(input.status);
      sets.push(`status = $${values.length}`);
    }
    if (input.priceCents !== undefined && input.priceCents !== current.priceCents) {
      values.push(JSON.stringify([...current.priceHistory, { date: new Date().toISOString().slice(0, 10), fromCents: current.priceCents, toCents: input.priceCents }]));
      sets.push(`price_history = $${values.length}`);
      // The owner typing in the new price is accepting it; an agent reporting it is not.
      if (opts.byOwner) {
        values.push(input.priceCents);
        sets.push(`accepted_price_cents = $${values.length}`);
      }
    }
    if (sets.length) {
      values.push(id, userId);
      await tx.query(`UPDATE external_subscriptions SET ${sets.join(", ")} WHERE id = $${values.length - 1} AND user_id = $${values.length}`, values);
    }
    return getExternal(tx, userId, id);
  });
}

// ---------------------------------------------------------------- cancelling

export interface CancelGuide {
  subscription: string;
  billedThrough: BilledThrough;
  where: string;
  url: string | null;
  steps: string[];
  warnings: string[];
  cancelBy: string | null;
}

const STORE_GUIDES: Record<"apple" | "google" | "amazon", { where: string; url: string; steps: string[] }> = {
  apple: {
    where: "Apple subscriptions (not the service's website)",
    url: "https://apps.apple.com/account/subscriptions",
    steps: ["On iPhone or iPad: Settings → [your name] → Subscriptions", "Tap the subscription → Cancel Subscription", "On a Mac or PC, use the link above and sign in with your Apple Account"],
  },
  google: {
    where: "Google Play subscriptions (not the service's website)",
    url: "https://play.google.com/store/account/subscriptions",
    steps: ["Open the link above, or Play Store → profile → Payments & subscriptions → Subscriptions", "Select the subscription → Cancel subscription"],
  },
  amazon: {
    where: "Amazon Memberships & Subscriptions (not the service's website)",
    url: "https://www.amazon.com/yourmembershipsandsubscriptions",
    steps: ["Open the link above and sign in", "Find the subscription → Cancel subscription"],
  },
};

/** How to cancel, which depends on who bills it, plus anything that could cost money. */
export function cancelGuide(sub: ExternalSubscription): CancelGuide {
  const service: Service | undefined = sub.serviceSlug ? serviceBySlug(sub.serviceSlug) : undefined;
  const warnings: string[] = [];
  let where: string;
  let url: string | null;
  let steps: string[];

  if (sub.billedThrough === "apple" || sub.billedThrough === "google" || sub.billedThrough === "amazon") {
    ({ where, url, steps } = STORE_GUIDES[sub.billedThrough]);
    warnings.push(`You pay for ${sub.name} through ${sub.billedThrough === "apple" ? "Apple" : sub.billedThrough === "google" ? "Google" : "Amazon"}. Cancelling on ${sub.name}'s own website won't stop the charge.`);
  } else if (sub.billedThrough === "carrier" && service?.category !== "phone") {
    where = "your phone carrier's account";
    url = null;
    steps = [`Open your carrier's app or account and look for ${sub.name} under add-ons or subscriptions`, "Remove it, or call your carrier"];
  } else {
    where = service ? `${service.name} account` : `${sub.name} account`;
    url = service?.cancelUrl ?? service?.website ?? null;
    steps = service?.cancelSteps?.length ? service.cancelSteps : ["Sign in to your account on the provider's website or app", "Look for Account, Billing or Membership → Cancel", "Save the confirmation email or number"];
  }

  if (service?.contractRisk || sub.contractUntil || sub.earlyTerminationFeeCents) {
    warnings.push(service?.contractNote ?? "This may be a contract; check for notice periods or fees before cancelling.");
    if (sub.contractUntil) warnings.push(`Contract runs until ${sub.contractUntil}.`);
    if (sub.earlyTerminationFeeCents) warnings.push(`Estimated early termination fee: $${(sub.earlyTerminationFeeCents / 100).toFixed(2)}.`);
    warnings.push("Blocking the card or not paying does not cancel it, and can lead to late fees or collections.");
  }
  const cancelBy = sub.status === "trial" ? sub.trialEndsOn : sub.nextRenewalOn;
  if (cancelBy) warnings.push(`Cancel before ${cancelBy} to avoid the next charge.`);
  return { subscription: sub.name, billedThrough: sub.billedThrough, where, url, steps, warnings, cancelBy };
}

/**
 * An agent asks to cancel an everyday subscription. Cancelling can cost money
 * (contract fees) and is hard to undo, so the owner approves first.
 */
export async function requestExternalCancel(db: Db, userId: string, id: string, agentKey: AgentKey | null, reason?: string) {
  const sub = await getExternal(db, userId, id);
  if (sub.status === "canceled") throw new AppError(409, "already_canceled", "this subscription is already cancelled");
  if (sub.status === "cancel_requested" || sub.status === "cancel_approved") throw new AppError(409, "cancel_pending", `cancellation is already ${sub.status.replace("_", " ")}`);
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO approvals (kind, user_id, agent_key_id, external_subscription_id, amount_cents, input)
       VALUES ('external_cancel', $1, $2, $3, $4, $5) RETURNING id`,
      [userId, agentKey?.id ?? null, id, sub.earlyTerminationFeeCents ?? 0, JSON.stringify({ name: sub.name, reason: reason ?? null, previousStatus: sub.status })],
    );
    await tx.query("UPDATE external_subscriptions SET status = 'cancel_requested' WHERE id = $1", [id]);
    return { status: "pending_approval" as const, approvalId: rows[0].id as string, guide: cancelGuide(sub) };
  });
}

/** Called when the owner approves an external_cancel approval. */
export async function approveExternalCancel(tx: Tx, externalSubscriptionId: string) {
  await tx.query("UPDATE external_subscriptions SET status = 'cancel_approved' WHERE id = $1 AND status = 'cancel_requested'", [externalSubscriptionId]);
}

/** Called when the owner denies an external_cancel approval: back to how it was. */
export async function denyExternalCancel(tx: Tx, externalSubscriptionId: string, previousStatus: string) {
  await tx.query("UPDATE external_subscriptions SET status = $2 WHERE id = $1 AND status = 'cancel_requested'", [
    externalSubscriptionId,
    previousStatus === "trial" ? "trial" : "active",
  ]);
}

/**
 * Record that it has actually been cancelled with the provider. The owner can
 * always do this; an agent only after the owner approved the cancellation.
 */
export async function markExternalCanceled(db: Db, userId: string, id: string, opts: { confirmation?: string; byAgent?: boolean } = {}) {
  const sub = await getExternal(db, userId, id);
  if (sub.status === "canceled") throw new AppError(409, "already_canceled", "already marked as cancelled");
  if (opts.byAgent && sub.status !== "cancel_approved") {
    throw new AppError(403, "not_approved", "the owner has to approve this cancellation first (use request_cancel)");
  }
  await db.query(
    "UPDATE external_subscriptions SET status = 'canceled', canceled_at = now(), cancel_confirmation = $3 WHERE id = $1 AND user_id = $2",
    [id, userId, opts.confirmation?.slice(0, 200) ?? null],
  );
  await db.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE external_subscription_id = $1 AND status = 'pending'", [id]);
  return getExternal(db, userId, id);
}

/** Stop tracking a subscription. If approvals refer to it, keep it as cancelled for the record instead. */
export async function deleteExternal(db: Db, userId: string, id: string) {
  await getExternal(db, userId, id);
  await withTx(db, async (tx) => {
    await tx.query("UPDATE external_charges SET external_subscription_id = NULL WHERE external_subscription_id = $1", [id]);
    await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE external_subscription_id = $1 AND status = 'pending'", [id]);
    const { rowCount } = await tx.query("SELECT 1 FROM approvals WHERE external_subscription_id = $1", [id]);
    if (rowCount) {
      await tx.query("UPDATE external_subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, now()), merchant_key = NULL WHERE id = $1", [id]);
    } else {
      await tx.query("DELETE FROM external_subscriptions WHERE id = $1", [id]);
    }
  });
}

// ---------------------------------------------------------------- statement import

export interface StatementLine {
  date: string;
  description: string;
  amountCents: number;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";" || c === "\t") out.push(cur.trim()), (cur = "");
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseDate(s: string): string | null {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US banks: MM/DD/YYYY
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

function parseAmount(s: string): number | null {
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  const n = Number(s.replace(/[()$,\s-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (negative ? -1 : 1);
}

/**
 * Parse a bank or card CSV export. Finds the date, description and amount
 * columns by header name; handles signed amounts or separate debit/credit
 * columns. Returns money going out as positive cents.
 */
export function parseStatementCsv(csv: string): StatementLine[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new AppError(400, "invalid_csv", "the CSV needs a header row and at least one transaction");
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const dateCol = find("date", "posted");
  const descCol = find("description", "merchant", "payee", "name", "details", "memo");
  const amountCol = header.findIndex((h) => h === "amount" || h.includes("amount"));
  const debitCol = find("debit", "withdrawal");
  if (dateCol < 0 || descCol < 0 || (amountCol < 0 && debitCol < 0)) {
    throw new AppError(400, "invalid_csv", "could not find date, description and amount columns in the header");
  }
  const rows = lines.slice(1).map(splitCsvLine);
  const signed = rows.map((r) => (amountCol >= 0 ? parseAmount(r[amountCol]) : null)).filter((v): v is number => v !== null);
  // Most banks export spending as negative numbers; some card issuers export it as positive.
  const spendingIsNegative = signed.filter((v) => v < 0).length >= signed.filter((v) => v > 0).length;

  const out: StatementLine[] = [];
  for (const r of rows) {
    const date = parseDate(r[dateCol] ?? "");
    const description = (r[descCol] ?? "").trim();
    if (!date || !description) continue;
    let spent: number | null;
    if (debitCol >= 0 && r[debitCol]) spent = Math.abs(parseAmount(r[debitCol]) ?? 0);
    else if (amountCol >= 0) {
      const v = parseAmount(r[amountCol]);
      spent = v === null ? null : spendingIsNegative ? -v : v;
    } else spent = null;
    if (spent && spent > 0) out.push({ date, description, amountCents: spent });
  }
  return out;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function intervalFromGap(gap: number): Interval | null {
  if (gap >= 6 && gap <= 8) return "week";
  if (gap >= 26 && gap <= 35) return "month";
  if (gap >= 350 && gap <= 380) return "year";
  return null;
}

export function addInterval(date: string, interval: Interval): string {
  const d = new Date(date + "T00:00:00Z");
  if (interval === "week") d.setUTCDate(d.getUTCDate() + 7);
  if (interval === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export type ImportAlert =
  | { type: "still_charged_after_cancel"; subscriptionId: string; name: string; chargedOn: string; amountCents: number; message: string }
  | { type: "price_increase"; subscriptionId: string; name: string; fromCents: number; toCents: number; chargedOn: string; message: string };

export interface Proposal {
  merchantKey: string;
  name: string;
  serviceSlug: string | null;
  category: string;
  billedThrough: BilledThrough;
  priceCents: number;
  interval: Interval;
  lastChargedOn: string;
  nextRenewalOn: string;
  charges: number;
  confidence: "high" | "medium" | "low";
  note?: string;
}

/**
 * Import statement lines, link them to known subscriptions, and find
 * recurring charges that aren't tracked yet. Proposals are not saved; the
 * owner (or agent) confirms them with addExternal.
 */
export async function importStatement(db: Db, userId: string, lines: StatementLine[]) {
  let inserted = 0;
  for (const l of lines) {
    const { key, serviceSlug } = merchantKeyFor(l.description);
    const { rowCount } = await db.query(
      `INSERT INTO external_charges (user_id, charged_on, description, amount_cents, merchant_key, service_slug, external_subscription_id)
       VALUES ($1, $2, $3, $4, $5, $6,
               (SELECT id FROM external_subscriptions WHERE user_id = $1 AND merchant_key = $5 ORDER BY (status = 'canceled'), created_at LIMIT 1))
       ON CONFLICT DO NOTHING`,
      [userId, l.date, l.description, l.amountCents, key, serviceSlug],
    );
    inserted += rowCount ?? 0;
  }

  const alerts: ImportAlert[] = [];
  const subs = await listExternal(db, userId, { includeCanceled: true });

  for (const s of subs) {
    if (!s.merchantKey) continue;
    // Store billers (Apple, Google) bill many subscriptions together; per-subscription price checks would be noise.
    if (s.merchantKey.startsWith("store:")) continue;
    const { rows } = await db.query(
      `SELECT to_char(charged_on, 'YYYY-MM-DD') AS date, amount_cents AS amount FROM external_charges
        WHERE user_id = $1 AND merchant_key = $2 ORDER BY charged_on`,
      [userId, s.merchantKey],
    );
    if (s.status === "canceled" && s.canceledAt) {
      const canceledOn = new Date(s.canceledAt).toISOString().slice(0, 10);
      for (const c of rows.filter((c) => c.date > canceledOn)) {
        alerts.push({
          type: "still_charged_after_cancel", subscriptionId: s.id, name: s.name, chargedOn: c.date, amountCents: c.amount,
          message: `${s.name} charged $${(c.amount / 100).toFixed(2)} on ${c.date}, after you cancelled it on ${canceledOn}. Contact them for a refund, or check whether it's billed through another account.`,
        });
      }
      continue;
    }
    const latest = rows.at(-1);
    if (latest && latest.amount !== s.priceCents) {
      const raised = latest.amount > s.priceCents;
      await db.query(
        `UPDATE external_subscriptions SET price_cents = $2, price_history = price_history || $3::jsonb WHERE id = $1`,
        [s.id, latest.amount, JSON.stringify([{ date: latest.date, fromCents: s.priceCents, toCents: latest.amount }])],
      );
      if (raised) {
        alerts.push({
          type: "price_increase", subscriptionId: s.id, name: s.name, fromCents: s.priceCents, toCents: latest.amount, chargedOn: latest.date,
          message: `${s.name} went up from $${(s.priceCents / 100).toFixed(2)} to $${(latest.amount / 100).toFixed(2)} (charged ${latest.date}).`,
        });
      }
    }
    if (latest && s.status === "active") {
      const next = addInterval(latest.date, s.interval);
      if (!s.nextRenewalOn || s.nextRenewalOn < next) await db.query("UPDATE external_subscriptions SET next_renewal_on = $2 WHERE id = $1", [s.id, next]);
    }
  }

  // Recurring charges nobody is tracking yet.
  const tracked = new Set(subs.filter((s) => s.status !== "canceled").map((s) => s.merchantKey));
  const { rows: groups } = await db.query(
    `SELECT merchant_key AS key, service_slug AS "serviceSlug",
            array_agg(to_char(charged_on, 'YYYY-MM-DD') ORDER BY charged_on) AS dates,
            array_agg(amount_cents ORDER BY charged_on) AS amounts,
            (array_agg(description ORDER BY charged_on DESC))[1] AS description
       FROM external_charges WHERE user_id = $1 AND external_subscription_id IS NULL
      GROUP BY merchant_key, service_slug`,
    [userId],
  );
  const proposals: Proposal[] = [];
  for (const g of groups) {
    if (tracked.has(g.key)) continue;
    const dates: string[] = g.dates;
    const amounts: number[] = g.amounts;
    const service = g.serviceSlug ? serviceBySlug(g.serviceSlug) : undefined;
    const store = STORE_BILLERS.find((b) => g.key === `store:${b.billedThrough}`);
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    let interval = gaps.length ? intervalFromGap(median(gaps)) : null;
    // Recurring = regular gaps and similar amounts (a price change is fine; random purchases aren't).
    const steady = isSteady(amounts, store !== undefined || service?.category === "phone");
    let confidence: Proposal["confidence"];
    if (interval && steady && dates.length >= 3) confidence = "high";
    else if (interval && steady) confidence = "medium";
    else if (service && dates.length === 1) {
      interval = "month";
      confidence = "low";
    } else continue;
    const last = dates.at(-1)!;
    const name = service?.name ?? store?.label ?? titleCase(g.description);
    proposals.push({
      merchantKey: g.key,
      name,
      serviceSlug: service?.slug ?? null,
      category: service?.category ?? (store ? "app store" : "other"),
      billedThrough: store?.billedThrough ?? (service?.category === "phone" ? "carrier" : "direct"),
      priceCents: amounts.at(-1)!,
      interval: interval!,
      lastChargedOn: last,
      nextRenewalOn: addInterval(last, interval!),
      charges: dates.length,
      confidence,
      note: store
        ? `${store.label} can include several subscriptions (for example Apple TV+, Paramount+ bought on an iPhone, iCloud+). Check the list in your ${store.billedThrough === "apple" ? "Apple" : store.billedThrough === "google" ? "Google" : "Amazon"} account and add each one.`
        : confidence === "low"
          ? "Only one charge found; check that this is a subscription."
          : undefined,
    });
  }
  proposals.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.confidence] - ({ high: 0, medium: 1, low: 2 })[b.confidence]);
  return { imported: inserted, skippedDuplicates: lines.length - inserted, proposals, alerts };
}

/**
 * Subscriptions charge the same amount each time, or step up once when the
 * price changes. Groceries and fuel drift. Phone bills and app-store totals
 * vary a little (taxes, add-ons), so they get more slack.
 */
function isSteady(amounts: number[], variableBill: boolean): boolean {
  const last = amounts.at(-1)!;
  const tolerance = variableBill ? 0.1 : 0.02;
  if (amounts.every((a) => Math.abs(a - last) <= last * tolerance)) return true;
  // One price change: a run of one amount followed by a run of another.
  const change = amounts.findIndex((a) => a !== amounts[0]);
  return change > 0 && amounts.slice(change).every((a) => a === amounts[change]);
}

function titleCase(s: string): string {
  return s
    .replace(/[#*]\S*/g, "")
    .split(/\s+/)
    .filter((w) => !/\.(COM|NET|ORG)|\/|\d{3,}/i.test(w))
    .join(" ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 60);
}

// ---------------------------------------------------------------- reminders + one view

/**
 * One-tap actions shown with a reminder (Alipay's "cancel auto-debit" button on
 * every debit notice). request_cancel starts a cancellation the owner approves;
 * accept_price keeps the subscription at its new price.
 */
export type ReminderAction = "request_cancel" | "accept_price";
export type Reminder = {
  type: "renewal" | "trial_ending" | "contract_ending" | "price_rise";
  subscriptionId: string;
  name: string;
  on: string;
  daysLeft: number;
  message: string;
  actions: ReminderAction[];
};

/** A price rise the owner hasn't decided on yet (Korea requires consent before a subscription costs more). */
export function pendingPriceRise(s: ExternalSubscription) {
  const raise = s.priceHistory.at(-1);
  if (!raise || raise.toCents <= raise.fromCents || raise.toCents !== s.priceCents) return null;
  if (s.status !== "active" && s.status !== "trial") return null;
  if ((s.acceptedPriceCents ?? raise.fromCents) >= s.priceCents) return null;
  return raise;
}

export async function acceptPrice(db: Db, userId: string, id: string) {
  const s = await getExternal(db, userId, id);
  await db.query("UPDATE external_subscriptions SET accepted_price_cents = price_cents WHERE id = $1 AND user_id = $2", [id, userId]);
  return { ...s, acceptedPriceCents: s.priceCents };
}

/** Move renewal dates that have passed forward to the next one. Billing happens at the merchant; this only keeps dates right. */
export async function rollRenewalDates(db: Db, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  // A trial that ended without being cancelled is now a paid subscription.
  await db.query(
    `UPDATE external_subscriptions SET status = 'active', next_renewal_on = COALESCE(next_renewal_on, trial_ends_on)
      WHERE status = 'trial' AND trial_ends_on < $1::date`,
    [today],
  );
  const { rows } = await db.query(
    `SELECT id, interval, to_char(next_renewal_on, 'YYYY-MM-DD') AS next FROM external_subscriptions
      WHERE status IN ('active','cancel_requested','cancel_approved') AND next_renewal_on < $1::date`,
    [today],
  );
  for (const r of rows) {
    let next: string = r.next;
    while (next < today) next = addInterval(next, r.interval);
    await db.query("UPDATE external_subscriptions SET next_renewal_on = $2 WHERE id = $1", [r.id, next]);
  }
  return rows.length;
}

export async function reminders(db: Db, userId: string, today = new Date().toISOString().slice(0, 10)): Promise<Reminder[]> {
  const subs = await listExternal(db, userId);
  const out: Reminder[] = [];
  const add = (type: Reminder["type"], s: ExternalSubscription, on: string | null, within: number, msg: (d: number) => string) => {
    if (!on) return;
    const d = daysBetween(today, on);
    const canCancel = s.status === "active" || s.status === "trial";
    const actions: ReminderAction[] = type === "contract_ending" || !canCancel ? [] : ["request_cancel"];
    if (d >= 0 && d <= within) out.push({ type, subscriptionId: s.id, name: s.name, on, daysLeft: d, message: msg(d), actions });
  };
  const when = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
  for (const s of subs) {
    const price = `$${(s.priceCents / 100).toFixed(2)}`;
    if (s.status === "trial") add("trial_ending", s, s.trialEndsOn, 7, (d) => `${s.name} free trial ends ${when(d)}; then it costs ${price}/${s.interval}. Cancel before then if you don't want it.`);
    else add("renewal", s, s.nextRenewalOn, s.interval === "year" ? 14 : 3, (d) => `${s.name} renews ${when(d)} for ${price}.`);
    add("contract_ending", s, s.contractUntil, 30, (d) => `${s.name} contract ends ${when(d)}: a good time to switch plans or carriers without a fee.`);
    const raise = pendingPriceRise(s);
    if (raise) {
      out.push({
        type: "price_rise", subscriptionId: s.id, name: s.name, on: raise.date, daysLeft: 0, actions: ["accept_price", "request_cancel"],
        message: `${s.name} went up from $${(raise.fromCents / 100).toFixed(2)} to ${price}. Keep it at the new price, or cancel?`,
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Every subscription in one list: AgentPay marketplace plans and everyday ones. */
export async function allSubscriptions(db: Db, userId: string) {
  const [market, external] = await Promise.all([listSubscriptions(db, userId), listExternal(db, userId)]);
  const items = [
    ...market
      .filter((s) => s.status !== "denied")
      .map((s) => ({
        kind: "agentpay" as const, id: s.id, name: s.planName, provider: s.provider, category: s.category, priceCents: s.priceCents,
        interval: s.interval, monthlyCents: monthlyCents(s.priceCents, s.interval),
        status: s.status === "active" && s.cancelAtPeriodEnd ? "canceling" : s.status,
        nextRenewalOn: s.status === "active" && !s.cancelAtPeriodEnd && s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toISOString().slice(0, 10) : null,
        billedThrough: "agentpay", paymentMethod: "AgentPay wallet",
      })),
    ...external.map((s) => ({
      kind: "external" as const, id: s.id, name: s.name, provider: s.planName ?? null, category: s.category, priceCents: s.priceCents,
      interval: s.interval, monthlyCents: monthlyCents(s.priceCents, s.interval), status: s.status,
      nextRenewalOn: s.status === "trial" ? s.trialEndsOn : s.nextRenewalOn, billedThrough: s.billedThrough, paymentMethod: s.paymentMethod,
      contract: !!(s.contractUntil || (s.serviceSlug && serviceBySlug(s.serviceSlug)?.contractRisk)),
    })),
  ];
  // Free trials and requested-but-unapproved plans don't cost anything yet.
  const paying = items.filter((i) => !["trial", "pending_approval", "canceled"].includes(i.status));
  const byCategory: Record<string, number> = {};
  for (const i of paying) byCategory[i.category] = (byCategory[i.category] ?? 0) + i.monthlyCents;
  return {
    items: items.sort((a, b) => a.category.localeCompare(b.category) || b.monthlyCents - a.monthlyCents),
    totals: { monthlyCents: paying.reduce((t, i) => t + i.monthlyCents, 0), yearlyCents: paying.reduce((t, i) => t + i.monthlyCents * 12, 0), byCategory },
    reminders: await reminders(db, userId),
  };
}

// ---------------------------------------------------------------- recommendations

export type ExternalSuggestion = {
  type: "bundle" | "already_in_bundle" | "cheaper_tier" | "annual_plan" | "rotate_streaming" | "unused" | "price_increase" | "trial_ending" | "contract_ending";
  monthlySavingsCents: number;
  subscriptions: string[];
  message: string;
  approximate?: boolean;
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Savings ideas for everyday subscriptions. Catalog prices are approximate, so those suggestions say so. */
export async function externalSuggestions(db: Db, userId: string, today = new Date().toISOString().slice(0, 10)): Promise<ExternalSuggestion[]> {
  const subs = (await listExternal(db, userId)).filter((s) => s.status === "active" || s.status === "trial");
  const out: ExternalSuggestion[] = [];
  const bySlug = new Map(subs.filter((s) => s.serviceSlug).map((s) => [s.serviceSlug!, s]));
  const m = (s: ExternalSubscription) => monthlyCents(s.priceCents, s.interval);

  for (const b of BUNDLES) {
    const have = b.includes.filter((slug) => bySlug.has(slug));
    const bundleSub = subs.find((s) => s.name.toLowerCase().includes(b.name.toLowerCase().split(" (")[0].toLowerCase()));
    if (bundleSub && have.length) {
      out.push({
        type: "already_in_bundle", monthlySavingsCents: have.reduce((t, slug) => t + m(bySlug.get(slug)!), 0), subscriptions: [bundleSub.id, ...have.map((s) => bySlug.get(s)!.id)],
        message: `${b.name} already includes ${have.map((s) => bySlug.get(s)!.name).join(", ")}, but you also pay for ${have.length > 1 ? "them" : "it"} separately.`,
      });
      continue;
    }
    if (have.length >= 2) {
      const current = have.reduce((t, slug) => t + m(bySlug.get(slug)!), 0);
      const bundleMonthly = monthlyCents(b.priceCents, b.interval);
      if (bundleMonthly < current && !out.some((o) => o.type === "bundle" && o.subscriptions.join() === have.map((s) => bySlug.get(s)!.id).join() && o.monthlySavingsCents >= current - bundleMonthly)) {
        // Keep only the best bundle for the same set of subscriptions.
        const same = out.findIndex((o) => o.type === "bundle" && o.subscriptions.join() === have.map((s) => bySlug.get(s)!.id).join());
        if (same >= 0) out.splice(same, 1);
        out.push({
          type: "bundle", monthlySavingsCents: current - bundleMonthly, subscriptions: have.map((s) => bySlug.get(s)!.id), approximate: true,
          message: `You pay ${usd(current)}/month for ${have.map((s) => bySlug.get(s)!.name).join(" + ")}. ${b.name} is about ${usd(bundleMonthly)}/month${b.note ? ` (${b.note})` : ""}.`,
        });
      }
    }
  }

  for (const s of subs) {
    const service = s.serviceSlug ? serviceBySlug(s.serviceSlug) : undefined;
    const tiers = (service?.tiers ?? []) as { name: string; priceCents: number; interval: Interval; ads?: boolean }[];
    const adTier = tiers.filter((t) => t.ads && t.interval === s.interval && t.priceCents < s.priceCents).sort((a, b) => a.priceCents - b.priceCents)[0];
    if (adTier) {
      out.push({
        type: "cheaper_tier", monthlySavingsCents: m(s) - monthlyCents(adTier.priceCents, adTier.interval), subscriptions: [s.id], approximate: true,
        message: `${s.name} "${adTier.name}" is about ${usd(adTier.priceCents)}/${adTier.interval} if you don't mind ads (you pay ${usd(s.priceCents)}).`,
      });
    }
    const annual = tiers.find((t) => t.interval === "year");
    if (s.interval === "month" && annual && annual.priceCents < s.priceCents * 12) {
      out.push({
        type: "annual_plan", monthlySavingsCents: m(s) - monthlyCents(annual.priceCents, "year"), subscriptions: [s.id], approximate: true,
        message: `${s.name} yearly (${annual.name}) is about ${usd(annual.priceCents)}/year vs ${usd(s.priceCents * 12)} paying monthly, if you'll keep it all year.`,
      });
    }
    if (s.lastUsedOn && daysBetween(s.lastUsedOn, today) > 45 && s.priceCents > 0) {
      out.push({
        type: "unused", monthlySavingsCents: m(s), subscriptions: [s.id],
        message: `You haven't used ${s.name} since ${s.lastUsedOn}. Cancelling saves ${usd(m(s))}/month.`,
      });
    }
    const raise = s.priceHistory.at(-1);
    if (raise && raise.toCents > raise.fromCents && daysBetween(raise.date, today) <= 60) {
      out.push({
        type: "price_increase", monthlySavingsCents: 0, subscriptions: [s.id],
        message: `${s.name} went up from ${usd(raise.fromCents)} to ${usd(raise.toCents)} on ${raise.date}. Worth checking it's still worth it.`,
      });
    }
  }

  const streaming = subs.filter((s) => s.category === "streaming" && s.status === "active");
  if (streaming.length >= 3) {
    // Keep the two used most recently (or the cheapest if usage is unknown); rotate the rest.
    const sorted = [...streaming].sort((a, b) => (a.lastUsedOn ?? "").localeCompare(b.lastUsedOn ?? "") || m(b) - m(a));
    const keep = sorted.slice(-2);
    const pause = sorted.slice(0, -2);
    const savings = pause.reduce((t, s) => t + m(s), 0);
    out.push({
      type: "rotate_streaming", monthlySavingsCents: savings, subscriptions: streaming.map((s) => s.id),
      message: `You have ${streaming.length} streaming services (${usd(streaming.reduce((t, s) => t + m(s), 0))}/month). Keeping two at a time, e.g. ${keep.map((s) => s.name).join(" and ")}, and rotating the rest month to month when a show you want comes out, saves about ${usd(savings)}/month.`,
    });
  }

  for (const r of await reminders(db, userId, today)) {
    if (r.type === "trial_ending" || r.type === "contract_ending") out.push({ type: r.type, monthlySavingsCents: 0, subscriptions: [r.subscriptionId], message: r.message });
  }
  return out.sort((a, b) => b.monthlySavingsCents - a.monthlySavingsCents);
}
