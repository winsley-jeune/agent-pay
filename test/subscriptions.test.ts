import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, deny, startApproval } from "../src/approvals.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import { balance } from "../src/ledger.js";
import { finishRegistration, startRegistration } from "../src/passkeys.js";
import { recommend } from "../src/recommend.js";
import { createTool } from "../src/registry.js";
import {
  cancelSubscription,
  createPlan,
  listSubscriptions,
  renewDueSubscriptions,
  requestResume,
  requestSubscription,
  setPlanPrice,
  subscriptionById,
} from "../src/subscriptions.js";
import { devCredit } from "../src/wallet.js";
import { fakeFetch, freshDb, ledgerTotal, setup } from "./helpers.js";
import { SoftPasskey } from "./softPasskey.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

let n = 0;
async function world(credit = 10_000) {
  const s = await setup(db, { credit });
  n++;
  const plan = await createPlan(db, s.provider.id, {
    slug: `weather-pro-${n}`,
    name: "Weather Pro",
    description: "forecasts",
    category: `weather-${n}`,
    priceCents: 1000,
    interval: "month",
    toolSlug: s.tool.slug,
    includedCalls: 3,
  });
  const device = new SoftPasskey(config.publicOrigin, config.rpId);
  const regOptions = await startRegistration(db, s.user);
  await finishRegistration(db, s.user.id, device.register(regOptions) as any, "Test laptop");
  return { ...s, plan, device };
}

async function approveWithDevice(userId: string, approvalId: string, device: SoftPasskey) {
  const { options } = await startApproval(db, userId, approvalId);
  return approve(db, userId, approvalId, device.sign(options) as any);
}

describe("passkey approvals", () => {
  it("activates a subscription only after a valid passkey signature, charging the first period", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug, { reason: "need forecasts" });
    expect(req.status).toBe("pending_approval");
    expect(await balance(db, w.user.walletAccountId)).toBe(10_000);

    await expect(approve(db, w.user.id, req.approvalId)).rejects.toMatchObject({ code: "passkey_required" });

    const res = await approveWithDevice(w.user.id, req.approvalId, w.device);
    expect(res).toMatchObject({ status: "used", signedWithPasskey: true });
    const sub = await subscriptionById(db, w.user.id, req.subscriptionId);
    expect(sub.status).toBe("active");
    expect(await balance(db, w.user.walletAccountId)).toBe(9_000);
    expect(await balance(db, w.provider.accountId)).toBe(900);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("rejects a forged signature", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    const { options } = await startApproval(db, w.user.id, req.approvalId);
    await expect(approve(db, w.user.id, req.approvalId, w.device.sign(options, { tamper: true }) as any)).rejects.toMatchObject({
      code: "passkey_rejected",
    });
    expect((await subscriptionById(db, w.user.id, req.subscriptionId)).status).toBe("pending_approval");
  });

  it("rejects a passkey from another device", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    const { options } = await startApproval(db, w.user.id, req.approvalId);
    const stranger = new SoftPasskey(config.publicOrigin, config.rpId);
    await expect(approve(db, w.user.id, req.approvalId, stranger.sign(options) as any)).rejects.toMatchObject({ code: "passkey_unknown" });
  });

  it("won't let a signature for one approval approve another, or be replayed", async () => {
    const w = await world();
    const a = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    const otherPlan = await createPlan(db, w.provider.id, {
      slug: `other-${n}`,
      name: "Other",
      description: "x",
      category: "misc",
      priceCents: 500,
      interval: "month",
    });
    const b = await requestSubscription(db, w.user.id, w.agentKey, otherPlan.slug);

    const { options } = await startApproval(db, w.user.id, a.approvalId);
    const signed = w.device.sign(options);
    await expect(approve(db, w.user.id, b.approvalId, signed as any)).rejects.toMatchObject({ code: "challenge_invalid" });
    await approve(db, w.user.id, a.approvalId, signed as any);
    await expect(approve(db, w.user.id, a.approvalId, signed as any)).rejects.toMatchObject({ code: "not_pending" });
  });

  it("keeps the request pending and charges nothing when funds are short", async () => {
    const w = await world(500);
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await expect(approveWithDevice(w.user.id, req.approvalId, w.device)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect((await subscriptionById(db, w.user.id, req.subscriptionId)).status).toBe("pending_approval");
    expect(await balance(db, w.user.walletAccountId)).toBe(500);

    await devCredit(db, w.user.walletAccountId, 1000);
    await approveWithDevice(w.user.id, req.approvalId, w.device);
    expect((await subscriptionById(db, w.user.id, req.subscriptionId)).status).toBe("active");
  });

  it("denies without a passkey", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await deny(db, w.user.id, req.approvalId);
    expect((await subscriptionById(db, w.user.id, req.subscriptionId)).status).toBe("denied");
  });

  it("rejects a second live subscription to the same plan", async () => {
    const w = await world();
    await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await expect(requestSubscription(db, w.user.id, w.agentKey, w.plan.slug)).rejects.toMatchObject({ code: "already_subscribed" });
  });
});

describe("included calls", () => {
  it("makes calls free until the quota runs out, then charges per call", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await approveWithDevice(w.user.id, req.approvalId, w.device);
    const after = await balance(db, w.user.walletAccountId);
    const { impl } = fakeFetch();

    for (let i = 0; i < 3; i++) {
      const r = await callPaidTool(db, w.agentKey, { tool: w.tool.slug, input: {}, idempotencyKey: `free-${i}` }, { fetchImpl: impl });
      expect(r).toMatchObject({ status: "ok", chargedCents: 0, coveredBySubscription: req.subscriptionId });
    }
    const paid = await callPaidTool(db, w.agentKey, { tool: w.tool.slug, input: {}, idempotencyKey: "paid" }, { fetchImpl: impl });
    expect(paid).toMatchObject({ status: "ok", chargedCents: 100 });
    expect(paid).not.toHaveProperty("coveredBySubscription");
    expect(await balance(db, w.user.walletAccountId)).toBe(after - 100);

    const [sub] = await listSubscriptions(db, w.user.id);
    expect(sub.callsUsedThisPeriod).toBe(3);
  });

  it("does not use up quota when the provider fails", async () => {
    const w = await world();
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await approveWithDevice(w.user.id, req.approvalId, w.device);
    await callPaidTool(db, w.agentKey, { tool: w.tool.slug, input: {}, idempotencyKey: "f" }, { fetchImpl: fakeFetch({ status: 500 }).impl });
    const [sub] = await listSubscriptions(db, w.user.id);
    expect(sub.callsUsedThisPeriod).toBe(0);
  });
});

describe("renewals", () => {
  async function activeSub(credit = 10_000) {
    const w = await world(credit);
    const req = await requestSubscription(db, w.user.id, w.agentKey, w.plan.slug);
    await approveWithDevice(w.user.id, req.approvalId, w.device);
    const expire = () =>
      db.query("UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE id = $1", [req.subscriptionId]);
    return { ...w, subId: req.subscriptionId, expire };
  }

  it("charges the next period when the current one ends, without gaps", async () => {
    const w = await activeSub();
    await w.expire();
    const before = await subscriptionById(db, w.user.id, w.subId);
    const outcomes = await renewDueSubscriptions(db);
    expect(outcomes).toContainEqual({ subscriptionId: w.subId, outcome: "renewed" });
    const after = await subscriptionById(db, w.user.id, w.subId);
    expect(after.currentPeriodStart!.getTime()).toBe(before.currentPeriodEnd!.getTime());
    expect(await balance(db, w.user.walletAccountId)).toBe(8_000);
    // Running again does nothing.
    expect((await renewDueSubscriptions(db)).filter((o) => o.subscriptionId === w.subId)).toEqual([]);
  });

  it("ends a subscription cancelled for period end without charging", async () => {
    const w = await activeSub();
    expect(await cancelSubscription(db, w.user.id, w.subId)).toEqual({ status: "cancels_at_period_end" });
    expect((await subscriptionById(db, w.user.id, w.subId)).status).toBe("active");
    await w.expire();
    await renewDueSubscriptions(db);
    expect((await subscriptionById(db, w.user.id, w.subId)).status).toBe("canceled");
    expect(await balance(db, w.user.walletAccountId)).toBe(9_000);
  });

  it("stops at past_due when the provider raises the price above the owner's limit, until the owner re-approves", async () => {
    const w = await activeSub();
    await setPlanPrice(db, w.provider.id, w.plan.slug, 1500);
    await w.expire();
    await renewDueSubscriptions(db);
    const sub = await subscriptionById(db, w.user.id, w.subId);
    expect(sub).toMatchObject({ status: "past_due", pastDueReason: "price_above_owner_limit" });
    expect(await balance(db, w.user.walletAccountId)).toBe(9_000);

    const resume = await requestResume(db, w.user.id, w.subId);
    expect(resume.priceCents).toBe(1500);
    await approveWithDevice(w.user.id, resume.approvalId, w.device);
    expect(await subscriptionById(db, w.user.id, w.subId)).toMatchObject({ status: "active", maxPriceCents: 1500 });
    expect(await balance(db, w.user.walletAccountId)).toBe(7_500);
  });

  it("goes past_due on insufficient funds and renews automatically after a top-up", async () => {
    const w = await activeSub(1000);
    await w.expire();
    await renewDueSubscriptions(db);
    expect(await subscriptionById(db, w.user.id, w.subId)).toMatchObject({ status: "past_due", pastDueReason: "insufficient_funds" });

    await devCredit(db, w.user.walletAccountId, 1000);
    const outcomes = await renewDueSubscriptions(db);
    expect(outcomes).toContainEqual({ subscriptionId: w.subId, outcome: "renewed" });
    expect((await subscriptionById(db, w.user.id, w.subId)).status).toBe("active");
    expect(await balance(db, w.user.walletAccountId)).toBe(0);
  });

  it("does not back-bill missed periods after downtime", async () => {
    const w = await activeSub();
    await db.query(
      "UPDATE subscriptions SET current_period_start = now() - interval '4 months', current_period_end = now() - interval '3 months' WHERE id = $1",
      [w.subId],
    );
    await renewDueSubscriptions(db);
    const sub = await subscriptionById(db, w.user.id, w.subId);
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    expect(await balance(db, w.user.walletAccountId)).toBe(8_000);
  });

  it("cancels immediately when asked, and agents can cancel", async () => {
    const w = await activeSub();
    expect(await cancelSubscription(db, w.user.id, w.subId, { immediately: true })).toEqual({ status: "canceled" });
    await expect(cancelSubscription(db, w.user.id, w.subId)).rejects.toMatchObject({ code: "already_ended" });
  });
});

describe("recommendations", () => {
  it("flags duplicates, cheaper alternatives, and subscriptions that would save money", async () => {
    const w = await world();
    const category = `maps-${n}`;
    const mk = (slug: string, priceCents: number, extra: object = {}) =>
      createPlan(db, w.provider.id, { slug: `${slug}-${n}`, name: slug, description: "maps", category, priceCents, interval: "month", ...extra });
    const pricey = await mk("maps-gold", 3000);
    const mid = await mk("maps-silver", 2000);
    const cheap = await mk("maps-bronze", 800);

    for (const p of [pricey, mid]) {
      const r = await requestSubscription(db, w.user.id, w.agentKey, p.slug);
      await approveWithDevice(w.user.id, r.approvalId, w.device);
    }

    // Heavy pay-per-call use of a tool that a plan covers.
    const tool = await createTool(db, w.provider.id, {
      slug: `geocode-${n}`,
      name: "Geocode",
      description: "geocode",
      pricingType: "per_call",
      priceCents: 50,
      upstreamUrl: "https://provider.example/geo",
    });
    await createPlan(db, w.provider.id, {
      slug: `geo-unlimited-${n}`,
      name: "Geo 1000",
      description: "geocoding",
      category: "geo",
      priceCents: 500,
      interval: "month",
      toolSlug: tool.slug,
      includedCalls: 1000,
    });
    const { impl } = fakeFetch();
    for (let i = 0; i < 20; i++) {
      await callPaidTool(db, w.agentKey, { tool: tool.slug, input: {}, idempotencyKey: `geo-${i}` }, { fetchImpl: impl });
    }

    const { suggestions, catalog } = await recommend(db, w.user.id, { category });
    expect(suggestions).toContainEqual(expect.objectContaining({ type: "duplicate", category, keep: mid.slug, monthlySavingsCents: 3000 }));
    expect(suggestions).toContainEqual(expect.objectContaining({ type: "cheaper_alternative", subscription: pricey.slug, alternative: cheap.slug }));
    expect(suggestions).toContainEqual(
      expect.objectContaining({ type: "subscribe_to_save", tool: tool.slug, plan: `geo-unlimited-${n}`, spentLast30dCents: 1000, monthlySavingsCents: 500 }),
    );
    expect(catalog.map((p) => p.slug)).toEqual([cheap.slug, mid.slug, pricey.slug]);
    expect(catalog.find((p) => p.slug === pricey.slug)?.alreadySubscribed).toBe(true);
  });
});
