import type { AgentKey } from "./auth.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";
import type { Tool } from "./registry.js";

export type Interval = "week" | "month" | "year";

export interface Plan {
  id: string;
  providerId: string;
  providerName: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;
  interval: Interval;
  toolId: string | null;
  toolSlug: string | null;
  includedCalls: number | null;
  features: string[];
  active: boolean;
}

export interface NewPlan {
  slug: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;
  interval: Interval;
  toolSlug?: string;
  includedCalls?: number;
  features?: string[];
}

export interface Subscription {
  id: string;
  userId: string;
  agentKeyId: string | null;
  agentKeyName: string | null;
  planId: string;
  plan: string;
  planName: string;
  provider: string;
  category: string;
  priceCents: number;
  interval: Interval;
  status: "pending_approval" | "active" | "past_due" | "canceled" | "denied";
  maxPriceCents: number;
  reason: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pastDueReason: string | null;
  includedCalls: number | null;
  toolSlug: string | null;
  createdAt: Date;
  canceledAt: Date | null;
}

const planColumns = `pl.id, pl.provider_id AS "providerId", p.name AS "providerName", pl.slug, pl.name, pl.description,
  pl.category, pl.price_cents AS "priceCents", pl.interval, pl.tool_id AS "toolId", t.slug AS "toolSlug",
  pl.included_calls AS "includedCalls", pl.features, pl.active`;
const planFrom = `plans pl JOIN providers p ON p.id = pl.provider_id LEFT JOIN tools t ON t.id = pl.tool_id`;

const subColumns = `s.id, s.user_id AS "userId", s.agent_key_id AS "agentKeyId", k.name AS "agentKeyName", s.plan_id AS "planId",
  pl.slug AS plan, pl.name AS "planName", p.name AS provider, pl.category, pl.price_cents AS "priceCents", pl.interval,
  s.status, s.max_price_cents AS "maxPriceCents", s.reason, s.current_period_start AS "currentPeriodStart",
  s.current_period_end AS "currentPeriodEnd", s.cancel_at_period_end AS "cancelAtPeriodEnd",
  s.past_due_reason AS "pastDueReason", pl.included_calls AS "includedCalls", t.slug AS "toolSlug",
  s.created_at AS "createdAt", s.canceled_at AS "canceledAt"`;
const subFrom = `subscriptions s JOIN plans pl ON pl.id = s.plan_id JOIN providers p ON p.id = pl.provider_id
  LEFT JOIN tools t ON t.id = pl.tool_id LEFT JOIN agent_keys k ON k.id = s.agent_key_id`;

/** How many days a renewal may stay unpaid before the subscription is canceled. */
const PAST_DUE_GRACE_DAYS = 7;

export function monthlyCents(priceCents: number, interval: Interval): number {
  if (interval === "week") return Math.round((priceCents * 52) / 12);
  if (interval === "year") return Math.round(priceCents / 12);
  return priceCents;
}

// ---------------------------------------------------------------- plans

export async function createPlan(db: Db, providerId: string, p: NewPlan): Promise<Plan> {
  if (!Number.isSafeInteger(p.priceCents) || p.priceCents <= 0) throw new AppError(400, "invalid_price", "priceCents must be a positive integer");
  if (!["week", "month", "year"].includes(p.interval)) throw new AppError(400, "invalid_interval", "interval must be week, month or year");
  if (!p.category?.trim()) throw new AppError(400, "invalid_category", "category is required");
  let toolId: string | null = null;
  if (p.toolSlug) {
    const { rows } = await db.query("SELECT id, pricing_type FROM tools WHERE slug = $1 AND provider_id = $2", [p.toolSlug, providerId]);
    if (!rows[0]) throw new AppError(400, "unknown_tool", `you have no tool named "${p.toolSlug}"`);
    if (rows[0].pricing_type !== "per_call") throw new AppError(400, "invalid_tool", "included calls only work with per_call tools");
    if (!Number.isInteger(p.includedCalls) || p.includedCalls! <= 0) {
      throw new AppError(400, "invalid_included_calls", "includedCalls must be a positive integer when a tool is linked");
    }
    toolId = rows[0].id;
  } else if (p.includedCalls !== undefined) {
    throw new AppError(400, "invalid_included_calls", "includedCalls needs a toolSlug");
  }
  await db
    .query(
      `INSERT INTO plans (provider_id, slug, name, description, category, price_cents, interval, tool_id, included_calls, features)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [providerId, p.slug, p.name, p.description, p.category.trim().toLowerCase(), p.priceCents, p.interval, toolId, toolId ? p.includedCalls : null, p.features ?? []],
    )
    .catch((err) => {
      if (err.code === "23505") throw new AppError(409, "slug_taken", `a plan with slug "${p.slug}" already exists`);
      if (err.code === "23514") throw new AppError(400, "invalid_plan", "slug must be lowercase letters, digits and dashes");
      throw err;
    });
  return (await planBySlug(db, p.slug, { includeInactive: true }))!;
}

export async function planBySlug(q: Db | Tx, slug: string, opts: { includeInactive?: boolean } = {}): Promise<Plan | null> {
  const { rows } = await q.query(`SELECT ${planColumns} FROM ${planFrom} WHERE pl.slug = $1 ${opts.includeInactive ? "" : "AND pl.active"}`, [slug]);
  return rows[0] ?? null;
}

export async function listPlans(q: Db | Tx, opts: { providerId?: string; category?: string; search?: string } = {}): Promise<Plan[]> {
  const where = [opts.providerId ? "pl.provider_id = $1" : "pl.active"];
  const values: unknown[] = opts.providerId ? [opts.providerId] : [];
  if (opts.category) {
    values.push(opts.category.toLowerCase());
    where.push(`pl.category = $${values.length}`);
  }
  if (opts.search) {
    values.push(`%${opts.search.toLowerCase()}%`);
    where.push(
      `(lower(pl.name) LIKE $${values.length} OR lower(pl.description) LIKE $${values.length} OR pl.category LIKE $${values.length}
        OR EXISTS (SELECT 1 FROM unnest(pl.features) f WHERE lower(f) LIKE $${values.length}))`,
    );
  }
  const { rows } = await q.query(`SELECT ${planColumns} FROM ${planFrom} WHERE ${where.join(" AND ")} ORDER BY pl.category, pl.price_cents`, values);
  return rows;
}

export async function setPlanActive(db: Db, providerId: string, slug: string, active: boolean) {
  const { rowCount } = await db.query("UPDATE plans SET active = $1 WHERE provider_id = $2 AND slug = $3", [active, providerId, slug]);
  if (!rowCount) throw new AppError(404, "not_found", "plan not found");
}

export async function setPlanPrice(db: Db, providerId: string, slug: string, priceCents: number) {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new AppError(400, "invalid_price", "priceCents must be a positive integer");
  const { rowCount } = await db.query("UPDATE plans SET price_cents = $1 WHERE provider_id = $2 AND slug = $3", [priceCents, providerId, slug]);
  if (!rowCount) throw new AppError(404, "not_found", "plan not found");
}

// ---------------------------------------------------------------- subscriptions

export async function subscriptionById(q: Db | Tx, userId: string, id: string): Promise<Subscription> {
  const { rows } = await q.query(`SELECT ${subColumns} FROM ${subFrom} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "subscription not found");
  return rows[0];
}

export async function listSubscriptions(q: Db | Tx, userId: string, opts: { includeEnded?: boolean } = {}): Promise<(Subscription & { callsUsedThisPeriod: number | null })[]> {
  const { rows } = await q.query(
    `SELECT ${subColumns},
            CASE WHEN pl.included_calls IS NULL THEN NULL ELSE
              (SELECT count(*)::int FROM holds h WHERE h.subscription_id = s.id AND h.status <> 'released'
                 AND h.created_at >= s.current_period_start)
            END AS "callsUsedThisPeriod"
       FROM ${subFrom}
      WHERE s.user_id = $1 ${opts.includeEnded ? "" : "AND s.status IN ('pending_approval','active','past_due')"}
      ORDER BY s.created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * An agent (or the owner, with agentKey null) asks to subscribe. Nothing is
 * charged until the owner approves with a passkey.
 */
export async function requestSubscription(
  db: Db,
  userId: string,
  agentKey: AgentKey | null,
  planSlug: string,
  opts: { maxPriceCents?: number; reason?: string } = {},
) {
  const plan = await planBySlug(db, planSlug);
  if (!plan) throw new AppError(404, "unknown_plan", `no active plan named "${planSlug}"`);
  if (agentKey?.allowedToolSlugs && plan.toolSlug && !agentKey.allowedToolSlugs.includes(plan.toolSlug)) {
    throw new AppError(403, "tool_not_allowed", `this agent key may not use "${plan.toolSlug}", which the plan covers`);
  }
  const maxPriceCents = opts.maxPriceCents ?? plan.priceCents;
  if (!Number.isSafeInteger(maxPriceCents) || maxPriceCents < plan.priceCents) {
    throw new AppError(400, "invalid_max_price", `maxPriceCents must be at least the plan price (${plan.priceCents})`);
  }
  return withTx(db, async (tx) => {
    const { rows } = await tx
      .query(
        `INSERT INTO subscriptions (user_id, agent_key_id, plan_id, status, max_price_cents, reason)
         VALUES ($1, $2, $3, 'pending_approval', $4, $5) RETURNING id`,
        [userId, agentKey?.id ?? null, plan.id, maxPriceCents, opts.reason?.slice(0, 500) ?? null],
      )
      .catch((err) => {
        if (err.code === "23505") throw new AppError(409, "already_subscribed", `there is already a live subscription to "${plan.slug}"`);
        throw err;
      });
    const subscriptionId = rows[0].id;
    const approval = await tx.query(
      `INSERT INTO approvals (kind, user_id, agent_key_id, subscription_id, amount_cents, input)
       VALUES ('subscription', $1, $2, $3, $4, $5) RETURNING id`,
      [userId, agentKey?.id ?? null, subscriptionId, plan.priceCents, JSON.stringify({ plan: plan.slug, reason: opts.reason ?? null })],
    );
    return {
      status: "pending_approval" as const,
      subscriptionId,
      approvalId: approval.rows[0].id as string,
      plan: plan.slug,
      priceCents: plan.priceCents,
      interval: plan.interval,
      approveUrl: `${config.publicUrl}/#approvals`,
      message: `Subscription to ${plan.name} (${plan.priceCents}c/${plan.interval}) is waiting for the owner to approve it with their passkey.`,
    };
  });
}

/** Lock the owner's wallet and charge one period. Throws insufficient_funds without changing anything. */
async function chargePeriod(tx: Tx, subscriptionId: string, start: "now" | "period_end") {
  const { rows } = await tx.query(
    `SELECT s.id, s.user_id AS "userId", s.current_period_end AS "currentPeriodEnd", pl.price_cents AS "priceCents",
            pl.interval, pl.slug, pr.account_id AS "providerAccountId", a.id AS "walletAccountId"
       FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id JOIN providers pr ON pr.id = pl.provider_id
       JOIN accounts a ON a.owner_id = s.user_id AND a.kind = 'wallet'
      WHERE s.id = $1`,
    [subscriptionId],
  );
  const sub = rows[0];
  await lockAccount(tx, sub.walletAccountId);
  const available = await balance(tx, sub.walletAccountId);
  if (available < sub.priceCents) {
    throw new AppError(402, "insufficient_funds", "not enough credits for this subscription; top up first", {
      balanceCents: available,
      priceCents: sub.priceCents,
    });
  }
  // Renewals continue from the old period end so there are no gaps, unless that end is more than one
  // interval in the past (e.g. the server was down); then a fresh period starts now rather than back-billing.
  const period = await tx.query(
    `WITH s AS (
       SELECT CASE WHEN $1::timestamptz IS NOT NULL AND $1::timestamptz + ('1 ' || $2)::interval > now()
                   THEN $1::timestamptz ELSE now() END AS start
     )
     SELECT start, start + ('1 ' || $2)::interval AS end FROM s`,
    [start === "period_end" ? sub.currentPeriodEnd : null, sub.interval],
  );
  const periodStart: Date = period.rows[0].start;
  const periodEnd: Date = period.rows[0].end;
  const fee = Math.floor((sub.priceCents * config.platformFeeBps) / 10_000);
  await post(
    tx,
    "subscription",
    [
      { accountId: sub.walletAccountId, amountCents: -sub.priceCents },
      { accountId: sub.providerAccountId, amountCents: sub.priceCents - fee },
      { accountId: await systemAccount(tx, "platform_fees"), amountCents: fee },
    ],
    `subscription ${sub.slug} ${periodStart.toISOString().slice(0, 10)}`,
  );
  await tx.query("INSERT INTO subscription_charges (subscription_id, amount_cents, period_start, period_end) VALUES ($1, $2, $3, $4)", [
    sub.id,
    sub.priceCents,
    periodStart,
    periodEnd,
  ]);
  await tx.query(
    `UPDATE subscriptions SET status = 'active', current_period_start = $2, current_period_end = $3, past_due_reason = NULL
      WHERE id = $1`,
    [sub.id, periodStart, periodEnd],
  );
}

/** Called from an approved 'subscription' approval: charge the first period and activate. */
export async function activateSubscription(tx: Tx, subscriptionId: string) {
  const { rows } = await tx.query("SELECT status FROM subscriptions WHERE id = $1 FOR UPDATE", [subscriptionId]);
  if (rows[0]?.status !== "pending_approval") throw new AppError(409, "not_pending", "this subscription is no longer waiting for approval");
  await chargePeriod(tx, subscriptionId, "now");
}

/**
 * Called from an approved 'resume' approval. Undoes a scheduled cancel, or
 * pays a past-due renewal and starts a fresh period.
 */
export async function resumeSubscription(tx: Tx, subscriptionId: string, approvedPriceCents: number) {
  const { rows } = await tx.query("SELECT status, cancel_at_period_end, max_price_cents FROM subscriptions WHERE id = $1 FOR UPDATE", [
    subscriptionId,
  ]);
  const sub = rows[0];
  // The owner just approved this price with their passkey; it becomes the new ceiling if higher.
  await tx.query("UPDATE subscriptions SET max_price_cents = GREATEST(max_price_cents, $2), cancel_at_period_end = false WHERE id = $1", [
    subscriptionId,
    approvedPriceCents,
  ]);
  if (sub.status === "past_due") await chargePeriod(tx, subscriptionId, "now");
  else if (sub.status !== "active") throw new AppError(409, "not_resumable", `a ${sub.status} subscription cannot be renewed; subscribe again`);
}

/** Owner (from the dashboard) or agent asks to renew a past-due or cancelling subscription. Needs a passkey approval. */
export async function requestResume(db: Db, userId: string, subscriptionId: string, agentKey: AgentKey | null = null) {
  const sub = await subscriptionById(db, userId, subscriptionId);
  if (!(sub.status === "past_due" || (sub.status === "active" && sub.cancelAtPeriodEnd))) {
    throw new AppError(409, "not_resumable", "only past-due subscriptions or ones scheduled to cancel can be renewed");
  }
  const { rows } = await db.query(
    `INSERT INTO approvals (kind, user_id, agent_key_id, subscription_id, amount_cents, input)
     VALUES ('resume', $1, $2, $3, $4, $5) RETURNING id`,
    [userId, agentKey?.id ?? null, sub.id, sub.priceCents, JSON.stringify({ plan: sub.plan })],
  );
  return { status: "pending_approval" as const, approvalId: rows[0].id as string, subscriptionId: sub.id, priceCents: sub.priceCents };
}

/**
 * Cancel. Cancelling never spends money, so it needs no passkey and agents
 * may do it. By default the subscription runs until the paid period ends.
 */
export async function cancelSubscription(db: Db, userId: string, subscriptionId: string, opts: { immediately?: boolean } = {}) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT status FROM subscriptions WHERE id = $1 AND user_id = $2 FOR UPDATE", [subscriptionId, userId]);
    const status = rows[0]?.status;
    if (!status) throw new AppError(404, "not_found", "subscription not found");
    if (status === "canceled" || status === "denied") throw new AppError(409, "already_ended", "this subscription has already ended");
    if (status === "pending_approval" || status === "past_due" || opts.immediately) {
      await tx.query("UPDATE subscriptions SET status = 'canceled', canceled_at = now(), cancel_at_period_end = false WHERE id = $1", [subscriptionId]);
      await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE subscription_id = $1 AND status = 'pending'", [subscriptionId]);
      return { status: "canceled" as const };
    }
    await tx.query("UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1", [subscriptionId]);
    await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE subscription_id = $1 AND status = 'pending'", [subscriptionId]);
    return { status: "cancels_at_period_end" as const };
  });
}

export type RenewalOutcome = { subscriptionId: string; outcome: "renewed" | "canceled" | "past_due"; reason?: string };

/** Renew, cancel or mark past-due every subscription whose period has ended. Run periodically. */
export async function renewDueSubscriptions(db: Db): Promise<RenewalOutcome[]> {
  const { rows } = await db.query(
    `SELECT id FROM subscriptions
      WHERE (status = 'active' AND current_period_end <= now())
         OR (status = 'past_due' AND past_due_reason = 'insufficient_funds')`,
  );
  const outcomes: RenewalOutcome[] = [];
  for (const { id } of rows) {
    const outcome = await withTx(db, async (tx): Promise<RenewalOutcome | null> => {
      const { rows } = await tx.query(
        `SELECT s.status, s.cancel_at_period_end AS "cancelAtPeriodEnd", s.max_price_cents AS "maxPriceCents",
                s.current_period_end AS "currentPeriodEnd", pl.price_cents AS "priceCents", pl.active AS "planActive"
           FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.id = $1 FOR UPDATE OF s SKIP LOCKED`,
        [id],
      );
      const s = rows[0];
      if (!s) return null; // another worker has it
      if (s.status === "active" && new Date(s.currentPeriodEnd) > new Date()) return null;

      const end = async (reason: string): Promise<RenewalOutcome> => {
        await tx.query("UPDATE subscriptions SET status = 'canceled', canceled_at = now(), past_due_reason = $2 WHERE id = $1", [id, reason]);
        return { subscriptionId: id, outcome: "canceled", reason };
      };
      const pastDue = async (reason: string): Promise<RenewalOutcome> => {
        await tx.query("UPDATE subscriptions SET status = 'past_due', past_due_reason = $2 WHERE id = $1", [id, reason]);
        return { subscriptionId: id, outcome: "past_due", reason };
      };

      if (s.cancelAtPeriodEnd) return end("canceled_by_owner");
      if (!s.planActive) return end("plan_discontinued");
      if (s.status === "past_due") {
        const graceOver = await tx.query(`SELECT $1::timestamptz + make_interval(days => $2) < now() AS over`, [s.currentPeriodEnd, PAST_DUE_GRACE_DAYS]);
        if (graceOver.rows[0].over) return end("unpaid_after_grace_period");
      }
      if (s.priceCents > s.maxPriceCents) return pastDue("price_above_owner_limit");
      try {
        await tx.query("SAVEPOINT charge");
        await chargePeriod(tx, id, s.status === "active" ? "period_end" : "now");
        return { subscriptionId: id, outcome: "renewed" };
      } catch (err) {
        await tx.query("ROLLBACK TO SAVEPOINT charge");
        if (err instanceof AppError && err.code === "insufficient_funds") {
          return s.status === "past_due" ? null : pastDue("insufficient_funds");
        }
        throw err;
      }
    });
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * If the owner has an active subscription that includes free calls to this
 * tool and quota is left this period, return it. Pass a transaction holding
 * the wallet lock to make the answer race-free.
 */
export async function findCoverage(q: Db | Tx, userId: string, tool: Tool): Promise<{ subscriptionId: string; remaining: number } | null> {
  const { rows } = await q.query(
    `SELECT s.id, pl.included_calls -
              (SELECT count(*)::int FROM holds h WHERE h.subscription_id = s.id AND h.status <> 'released'
                 AND h.created_at >= s.current_period_start) AS remaining
       FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND pl.tool_id = $2 AND s.current_period_end > now()
      ORDER BY s.current_period_end`,
    [userId, tool.id],
  );
  const usable = rows.find((r) => r.remaining > 0);
  return usable ? { subscriptionId: usable.id, remaining: usable.remaining } : null;
}
