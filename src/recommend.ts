import type { Db } from "./db.js";
import { listPlans, listSubscriptions, monthlyCents, type Plan } from "./subscriptions.js";

export type Suggestion =
  | { type: "duplicate"; category: string; subscriptions: string[]; keep: string; monthlySavingsCents: number; message: string }
  | { type: "cheaper_alternative"; subscription: string; alternative: string; monthlySavingsCents: number; message: string }
  | { type: "underused"; subscription: string; callsLast30d: number; payPerCallCents: number; monthlySavingsCents: number; message: string }
  | { type: "subscribe_to_save"; tool: string; plan: string; spentLast30dCents: number; monthlySavingsCents: number; message: string };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * Compare the owner's subscriptions and pay-per-call spending against every
 * plan in the marketplace and suggest where to save. Also returns matching
 * catalog plans, cheapest per month first, for the agent to choose from.
 */
export async function recommend(db: Db, userId: string, opts: { category?: string; search?: string } = {}) {
  const [subs, allPlans] = await Promise.all([listSubscriptions(db, userId), listPlans(db)]);
  const live = subs.filter((s) => s.status === "active" || s.status === "past_due");
  const mySubPlans = new Set(subs.map((s) => s.plan));
  const suggestions: Suggestion[] = [];
  const monthly = (p: { priceCents: number; interval: Plan["interval"] }) => monthlyCents(p.priceCents, p.interval);

  // 1. Paying for several plans in the same category.
  const byCategory = new Map<string, typeof live>();
  for (const s of live) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
  for (const [category, group] of byCategory) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => monthly(a) - monthly(b));
    const keep = sorted[0];
    const savings = sorted.slice(1).reduce((sum, s) => sum + monthly(s), 0);
    suggestions.push({
      type: "duplicate",
      category,
      subscriptions: group.map((s) => s.plan),
      keep: keep.plan,
      monthlySavingsCents: savings,
      message: `You pay for ${group.length} ${category} plans (${group.map((s) => s.planName).join(", ")}). Keeping only ${keep.planName} saves ${usd(savings)}/month.`,
    });
  }

  // 2. A cheaper plan in the same category that includes at least as many calls.
  for (const s of live) {
    const better = allPlans
      .filter(
        (p) =>
          p.category === s.category &&
          p.slug !== s.plan &&
          !mySubPlans.has(p.slug) &&
          monthly(p) < monthly(s) &&
          (s.includedCalls === null || (p.includedCalls ?? 0) >= monthlyCalls(s.includedCalls, s.interval, p.interval)),
      )
      .sort((a, b) => monthly(a) - monthly(b))[0];
    if (better) {
      const savings = monthly(s) - monthly(better);
      suggestions.push({
        type: "cheaper_alternative",
        subscription: s.plan,
        alternative: better.slug,
        monthlySavingsCents: savings,
        message: `${better.name} from ${better.providerName} covers the same ${s.category} needs for ${usd(monthly(better))}/month instead of ${usd(monthly(s))}.`,
      });
    }
  }

  // 3. Subscriptions used so little that paying per call would be cheaper.
  const usage = await db.query(
    `SELECT h.subscription_id AS "subscriptionId", count(*)::int AS calls
       FROM holds h JOIN tools t ON t.id = h.tool_id JOIN agent_keys k ON k.id = h.agent_key_id
      WHERE k.user_id = $1 AND h.subscription_id IS NOT NULL AND h.status <> 'released' AND h.created_at > now() - interval '30 days'
      GROUP BY h.subscription_id`,
    [userId],
  );
  const callsBySub = new Map(usage.rows.map((r) => [r.subscriptionId, r]));
  for (const s of live) {
    if (s.includedCalls === null || !s.toolSlug || !s.currentPeriodStart) continue;
    const ageDays = (Date.now() - new Date(s.currentPeriodStart).getTime()) / 86_400_000;
    if (ageDays < 7) continue; // too new to judge
    const calls = callsBySub.get(s.id)?.calls ?? 0;
    const { rows } = await db.query("SELECT price_cents FROM tools WHERE slug = $1", [s.toolSlug]);
    const payPerCall = calls * (rows[0]?.price_cents ?? 0);
    if (payPerCall < monthly(s)) {
      suggestions.push({
        type: "underused",
        subscription: s.plan,
        callsLast30d: calls,
        payPerCallCents: payPerCall,
        monthlySavingsCents: monthly(s) - payPerCall,
        message: `You made ${calls} calls with ${s.planName} in the last 30 days. Paying per call would have cost ${usd(payPerCall)} instead of ${usd(monthly(s))}.`,
      });
    }
  }

  // 4. Heavy pay-per-call spending on a tool that a plan would cover for less.
  const perCall = await db.query(
    `SELECT t.id AS "toolId", t.slug, count(*)::int AS calls, COALESCE(SUM(h.captured_cents), 0)::bigint AS spent
       FROM holds h JOIN tools t ON t.id = h.tool_id JOIN agent_keys k ON k.id = h.agent_key_id
      WHERE k.user_id = $1 AND h.subscription_id IS NULL AND h.status = 'captured' AND h.created_at > now() - interval '30 days'
      GROUP BY t.id, t.slug`,
    [userId],
  );
  for (const r of perCall.rows) {
    const plan = allPlans
      .filter((p) => p.toolId === r.toolId && !mySubPlans.has(p.slug) && (p.includedCalls ?? 0) >= monthlyCalls(r.calls, "month", p.interval))
      .sort((a, b) => monthly(a) - monthly(b))[0];
    if (plan && monthly(plan) < r.spent) {
      suggestions.push({
        type: "subscribe_to_save",
        tool: r.slug,
        plan: plan.slug,
        spentLast30dCents: r.spent,
        monthlySavingsCents: r.spent - monthly(plan),
        message: `You spent ${usd(r.spent)} on ${r.calls} ${r.slug} calls in the last 30 days. ${plan.name} includes ${plan.includedCalls} calls per ${plan.interval} for ${usd(plan.priceCents)}.`,
      });
    }
  }

  const catalog = (await listPlans(db, { category: opts.category, search: opts.search }))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      provider: p.providerName,
      category: p.category,
      description: p.description,
      priceCents: p.priceCents,
      interval: p.interval,
      monthlyCents: monthly(p),
      includedCalls: p.includedCalls,
      tool: p.toolSlug,
      features: p.features,
      alreadySubscribed: mySubPlans.has(p.slug),
    }))
    .sort((a, b) => a.monthlyCents - b.monthlyCents);

  suggestions.sort((a, b) => b.monthlySavingsCents - a.monthlySavingsCents);
  return { suggestions, catalog };
}

/** Convert a call allowance from one billing interval to another, rounding up. */
function monthlyCalls(calls: number, from: Plan["interval"], to: Plan["interval"]): number {
  const perMonth = { week: 52 / 12, month: 1, year: 1 / 12 };
  return Math.ceil((calls * perMonth[from]) / perMonth[to]);
}
