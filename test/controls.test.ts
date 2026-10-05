import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, deny, listApprovals } from "../src/approvals.js";
import { listAudit, verifyAudit } from "../src/audit.js";
import { agentKeyById, updateAgentKeyLimits } from "../src/auth.js";
import { config } from "../src/config.js";
import {
  cancelVaultUnlock,
  closeEnvelope,
  freeze,
  listEnvelopes,
  lockInVault,
  releaseVaultUnlocks,
  requestEnvelope,
  requestUnfreeze,
  requestVaultUnlock,
  sweepEnvelopes,
  vaultSummary,
} from "../src/controls.js";
import type { Db } from "../src/db.js";
import { acceptPrice, addExternal, reminders, updateExternal } from "../src/external.js";
import { callPaidTool } from "../src/gateway.js";
import { guaranteePolicy, listIncidents, reportIncident, updateIncident } from "../src/incidents.js";
import { balance } from "../src/ledger.js";
import { checkMandate, requestMandate } from "../src/mandates.js";
import { requestBrowserAccess, requestConsent } from "../src/permissions.js";
import { addWatch, markBought } from "../src/pricewatch.js";
import { createPlan, renewDueSubscriptions, requestSubscription } from "../src/subscriptions.js";
import { fakeFetch, freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const ok = { requirePasskey: false };
let k = 0;
const call = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, input: {}, idempotencyKey: `c-${++k}`, ...extra });
const fetchImpl = fakeFetch().impl;

describe("autonomy levels and rules", () => {
  it("L0 asks before every paid call, with the reason on the approval", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 1000, limits: { level: "ask" } });
    const res = await callPaidTool(db, agentKey, call(tool.slug, { reason: "need the forecast" }), { fetchImpl });
    expect(res).toMatchObject({ status: "pending_approval", why: "this agent asks before every paid call" });
    const [a] = await listApprovals(db, user.id, "pending");
    expect(a).toMatchObject({ why: "this agent asks before every paid call", agentReason: "need the forecast" });
    expect(a.terms[0]).toBe("One charge of $1.00 from your prepaid wallet");
  });

  it("L1 pays what a rule allows, flags 'observe' rules, and asks for everything else", async () => {
    const { user, agentKey, tool } = await setup(db, {
      credit: 1000,
      limits: { level: "rules", spendRules: [{ name: "cheap lookups", tools: null, maxCents: 100, outcome: "observe" }] },
    });
    const paid = await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl });
    expect(paid.status).toBe("ok");
    const { rows } = await db.query("SELECT decision, decision_reason FROM holds WHERE id = $1", [(paid as { callId: string }).callId]);
    expect(rows[0]).toMatchObject({ decision: "observe", decision_reason: 'rule "cheap lookups" (flagged for review)' });

    await db.query("UPDATE tools SET price_cents = 150 WHERE id = $1", [tool.id]);
    expect(await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl })).toMatchObject({ status: "pending_approval", why: "no spending rule covers this call" });
    expect(await balance(db, user.walletAccountId)).toBe(900);
  });

  it("L2 flags calls above the review line but still pays them", async () => {
    const { agentKey, tool } = await setup(db, { credit: 1000, limits: { observeAboveCents: 50 } });
    const res = await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl });
    const { rows } = await db.query("SELECT decision FROM holds WHERE id = $1", [(res as { callId: string }).callId]);
    expect(rows[0].decision).toBe("observe");
  });

  it("a new key in cooling-off only pays small calls on its own", async () => {
    const s = await setup(db, { credit: 1000 });
    await db.query("UPDATE agent_keys SET cooling_off_until = now() + interval '12 hours' WHERE id = $1", [s.agentKey.id]);
    const key = (await agentKeyById(db, s.agentKey.id))!;
    expect((await callPaidTool(db, key, call(s.tool.slug), { fetchImpl })).status).toBe("ok"); // 100c = the cooling-off limit
    await db.query("UPDATE tools SET price_cents = 101 WHERE id = $1", [s.tool.id]);
    const res = await callPaidTool(db, key, call(s.tool.slug), { fetchImpl });
    expect(res.status).toBe("pending_approval");
    expect((res as { why: string }).why).toMatch(/^new agent/);
  });

  it("the drain guard asks when an hour of spending would take more than half the wallet", async () => {
    const { agentKey, tool } = await setup(db, { credit: 5000, tool: { priceCents: 1500 } });
    config.drainGuard = true;
    try {
      expect((await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl })).status).toBe("ok");
      // 1500 spent + 1500 more = 3000, over max(2000, (3500 + 1500) / 2 = 2500).
      const res = await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl });
      expect((res as { why: string }).why).toMatch(/^unusual spending/);
    } finally {
      config.drainGuard = false;
    }
  });
});

describe("envelopes", () => {
  it("sets money aside with a passkey, pays matching calls from it without asking, and returns the rest", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 1000, limits: { level: "ask" } });
    const req = await requestEnvelope(db, user.id, { name: "Research", amountCents: 300, days: 7, toolSlugs: [tool.slug] }, agentKey);
    expect(await balance(db, user.walletAccountId)).toBe(1000); // nothing moves before approval
    const [a] = await listApprovals(db, user.id, "pending");
    expect(a.summary).toMatch(/^Set aside \$3\.00 in "Research" for test agent until \d{4}-\d{2}-\d{2}$/);
    expect(a.terms).toContain(`Only for these tools: ${tool.slug}`);
    await approve(db, user.id, req.approvalId, undefined, ok);
    expect(await balance(db, user.walletAccountId)).toBe(700);

    // L0 would ask, but the envelope is pre-approved.
    const res = await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl });
    expect(res).toMatchObject({ status: "ok", chargedCents: 100 });
    expect(await balance(db, user.walletAccountId)).toBe(700);
    const [e] = await listEnvelopes(db, user.id);
    expect(e.balanceCents).toBe(200);

    expect(await closeEnvelope(db, user.id, e.id)).toEqual({ returnedCents: 200 });
    expect(await balance(db, user.walletAccountId)).toBe(900);
    // Closed: the next call asks again.
    expect((await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl })).status).toBe("pending_approval");
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("can't be approved without the money, and is closed with the money returned when it expires", async () => {
    const { user } = await setup(db, { credit: 100 });
    const big = await requestEnvelope(db, user.id, { name: "Too big", amountCents: 500, days: 1 });
    await expect(approve(db, user.id, big.approvalId, undefined, ok)).rejects.toMatchObject({ code: "insufficient_funds" });

    const small = await requestEnvelope(db, user.id, { name: "Small", amountCents: 60, days: 1 });
    await approve(db, user.id, small.approvalId, undefined, ok);
    await db.query("UPDATE envelopes SET expires_at = now() - interval '1 minute' WHERE id = $1", [small.envelopeId]);
    expect(await sweepEnvelopes(db)).toBeGreaterThanOrEqual(1);
    expect(await balance(db, user.walletAccountId)).toBe(100);
  });

  it("keeps the agent's daily cap across envelope and wallet when calls race", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 1000, limits: { dailyCapCents: 300 } });
    const e = await requestEnvelope(db, user.id, { name: "Half", amountCents: 300, days: 1 });
    await approve(db, user.id, e.approvalId, undefined, ok);
    const slow = fakeFetch({ delayMs: 30 }).impl;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => callPaidTool(db, agentKey, call(tool.slug), { fetchImpl: slow })));
    expect(results.filter((r) => r.status === "fulfilled" && r.value.status === "ok")).toHaveLength(3);
    expect(await ledgerTotal(db)).toBe(0);
  });
});

describe("kill switch", () => {
  it("blocks calls, declines pending approvals, pauses renewals, and needs a passkey to undo", async () => {
    const s = await setup(db, { credit: 5000 });
    const plan = await createPlan(db, s.provider.id, { slug: `ks-plan-${k++}`, name: "KS", description: "x", category: "ks", priceCents: 100, interval: "month" });
    const sub = await requestSubscription(db, s.user.id, s.agentKey, plan.slug);
    await approve(db, s.user.id, sub.approvalId, undefined, ok);
    const pending = await requestEnvelope(db, s.user.id, { name: "Pending", amountCents: 100, days: 1 });

    const f = await freeze(db, s.user.id, deny);
    expect(f.declined).toBe(1);
    expect((await listApprovals(db, s.user.id)).find((a) => a.id === pending.approvalId)?.status).toBe("denied");
    await expect(callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl })).rejects.toMatchObject({ code: "frozen", status: 423 });

    await db.query("UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE id = $1", [sub.subscriptionId]);
    expect((await renewDueSubscriptions(db)).find((o) => o.subscriptionId === sub.subscriptionId)).toBeUndefined();

    const u = await requestUnfreeze(db, s.user.id);
    await expect(approve(db, s.user.id, u.approvalId)).rejects.toMatchObject({ code: "passkey_required" });
    await approve(db, s.user.id, u.approvalId, undefined, ok);
    expect((await callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl })).status).toBe("ok");
  });
});

describe("vault", () => {
  it("locks money away; unlocking takes a passkey approval and a wait, and can be cancelled", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 300 });
    await lockInVault(db, user.id, 250);
    expect(await balance(db, user.walletAccountId)).toBe(50);
    // The vault isn't spendable: a 100c call fails for lack of funds.
    await expect(callPaidTool(db, agentKey, call(tool.slug), { fetchImpl })).rejects.toMatchObject({ code: "insufficient_funds" });

    const first = await requestVaultUnlock(db, user.id, 100);
    await approve(db, user.id, first.approvalId, undefined, ok);
    expect(await releaseVaultUnlocks(db)).toBe(0); // still waiting
    await cancelVaultUnlock(db, user.id, first.unlockId);

    const second = await requestVaultUnlock(db, user.id, 200);
    await approve(db, user.id, second.approvalId, undefined, ok);
    await db.query("UPDATE vault_unlocks SET available_at = now() - interval '1 second' WHERE id = $1", [second.unlockId]);
    await releaseVaultUnlocks(db);
    expect(await balance(db, user.walletAccountId)).toBe(250);
    expect((await vaultSummary(db, user.id)).balanceCents).toBe(50);
    expect(await ledgerTotal(db)).toBe(0);
  });
});

describe("why log", () => {
  it("records each decision with the agent's reason and detects tampering", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 1000 });
    await callPaidTool(db, agentKey, call(tool.slug, { reason: "compare prices", instruction: "find the cheapest flight" }), { fetchImpl });
    await lockInVault(db, user.id, 10);
    const entries = await listAudit(db, user.id);
    const paid = entries.find((e: { kind: string }) => e.kind === "call_paid");
    expect(paid).toMatchObject({ instruction: "find the cheapest flight", reason: "compare prices", summary: `Paid $1.00 for ${tool.slug}` });
    expect(paid.data).toMatchObject({ decision: "auto", decidedBecause: "within this agent's limits" });
    expect(await verifyAudit(db, user.id)).toMatchObject({ ok: true, entries: 2 });

    await expect(db.query("UPDATE audit_log SET summary = 'x' WHERE user_id = $1", [user.id])).rejects.toThrow(/append-only/);
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable");
    try {
      await db.query("UPDATE audit_log SET summary = 'Paid $0.01' WHERE user_id = $1 AND seq = 1", [user.id]);
    } finally {
      await db.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable");
    }
    expect(await verifyAudit(db, user.id)).toMatchObject({ ok: false, brokenAt: 1, problem: "an entry was changed" });
  });
});

describe("buy mandates", () => {
  it("lets the agent buy only within a signed mandate, with checkout permission, and records a breach", async () => {
    const { user, agentKey } = await setup(db);
    const { watch } = await addWatch(db, user.id, { url: "https://www.target.com/p/headphones/-/A-123", title: "Headphones", targetPriceCents: 4000 });
    expect((await checkMandate(db, user.id, { watchId: watch.id, priceCents: 3900, site: "target.com" })).status).toBe("no_mandate");

    const m = await requestMandate(db, user.id, agentKey, { watchId: watch.id, quantity: 1, days: 30 });
    const [a] = await listApprovals(db, user.id, "pending");
    expect(a.summary).toMatch(/^Let my agent buy "Headphones" on target\.com at up to \$40\.00 each \(at most 1\) until/);
    await approve(db, user.id, m.approvalId, undefined, ok);

    expect((await checkMandate(db, user.id, { watchId: watch.id, priceCents: 4100, site: "target.com" })).status).toBe("price_too_high");
    expect((await checkMandate(db, user.id, { watchId: watch.id, priceCents: 3900, site: "walmart.com" })).status).toBe("wrong_site");
    expect((await checkMandate(db, user.id, { watchId: watch.id, priceCents: 3900, site: "target.com" })).status).toBe("needs_browser_access");

    const c = await requestConsent(db, user.id);
    await approve(db, user.id, c.approvalId, undefined, ok);
    const g = await requestBrowserAccess(db, user.id, agentKey, { site: "target.com", actions: ["checkout_approved_order"], purpose: "buy the headphones on sale" });
    await approve(db, user.id, g.approvalId, undefined, ok);
    expect((await checkMandate(db, user.id, { watchId: watch.id, priceCents: 3900, site: "https://www.target.com/checkout" })).status).toBe("allowed");

    const bought = await markBought(db, user.id, watch.id, 4500, agentKey);
    expect(bought.mandate).toMatchObject({ within: false, maxPriceCents: 4000 });
    const [incident] = await listIncidents(db, user.id);
    expect(incident).toMatchObject({ kind: "condition_breach", amountCents: 500, reportedBy: "agent" });
  });
});

describe("price rises and reminders", () => {
  it("asks the owner to keep or cancel after a price rise the owner didn't enter", async () => {
    const { user } = await setup(db);
    const manual = { source: "manual" as const, agentKey: null };
    const s = await addExternal(db, user.id, { serviceSlug: "netflix", priceCents: 1799, nextRenewalOn: "2026-10-07" }, manual);
    let r = await reminders(db, user.id, "2026-10-05");
    expect(r[0]).toMatchObject({ type: "renewal", actions: ["request_cancel"] });

    await updateExternal(db, user.id, s.id, { priceCents: 1999 }); // reported by an agent or import
    r = await reminders(db, user.id, "2026-10-05");
    expect(r.find((x) => x.type === "price_rise")).toMatchObject({ actions: ["accept_price", "request_cancel"] });
    await acceptPrice(db, user.id, s.id);
    expect((await reminders(db, user.id, "2026-10-05")).find((x) => x.type === "price_rise")).toBeUndefined();

    await updateExternal(db, user.id, s.id, { priceCents: 2199 }, { byOwner: true }); // the owner typed it: accepted
    expect((await reminders(db, user.id, "2026-10-05")).find((x) => x.type === "price_rise")).toBeUndefined();
  });

  it("shows final-confirmation terms for subscriptions", async () => {
    const s = await setup(db, { credit: 5000 });
    const plan = await createPlan(db, s.provider.id, { slug: `terms-${k++}`, name: "Terms", description: "x", category: "t", priceCents: 999, interval: "month" });
    await requestSubscription(db, s.user.id, s.agentKey, plan.slug, { maxPriceCents: 1200 });
    const [a] = await listApprovals(db, s.user.id, "pending");
    expect(a.terms).toEqual([
      "$9.99 now, then $9.99 every month",
      "About $119.88 over 12 months",
      "Renews automatically from your wallet until you cancel",
      "If the price goes above $12.00, it stops until you approve the new price",
      "Cancel any time on the Subscriptions page; it runs to the end of the paid period, or choose End now",
    ]);
  });
});

describe("incidents", () => {
  it("classifies incidents and says plainly when no guarantee is offered", async () => {
    const { user, agentKey, tool } = await setup(db, { credit: 1000 });
    const res = (await callPaidTool(db, agentKey, call(tool.slug), { fetchImpl })) as { callId: string };
    const i = await reportIncident(db, user.id, { holdId: res.callId, description: "ran the same search twice" });
    expect(i).toMatchObject({ kind: "unclassified", amountCents: 100, agentKeyName: "test agent" });
    expect(i.guarantee).toMatchObject({ eligible: false, why: "no guarantee is offered yet" });
    expect(guaranteePolicy().offered).toBe(false);

    const saved = config.guaranteeMaxCents;
    config.guaranteeMaxCents = 5000;
    try {
      const u = await updateIncident(db, user.id, i.id, { kind: "system_bug" });
      expect(u.guarantee).toEqual({ eligible: true, upToCents: 100, why: "covered by the guarantee" });
      expect((await updateIncident(db, user.id, i.id, { kind: "misjudgment" })).guarantee.eligible).toBe(false);
    } finally {
      config.guaranteeMaxCents = saved;
    }
  });
});

describe("limits API shape", () => {
  it("stores level and rules on a key", async () => {
    const { user, agentKey } = await setup(db);
    const updated = await updateAgentKeyLimits(db, user.id, agentKey.id, { level: "rules", spendRules: [{ name: "r", tools: null, maxCents: 50, outcome: "auto" }] });
    expect(updated).toMatchObject({ level: "rules", spendRules: [{ name: "r", maxCents: 50 }] });
  });
});
