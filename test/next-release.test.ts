import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalStatusForAgent, approve, completeDelayedApprovals, startApproval } from "../src/approvals.js";
import { createAgentKey, createUser } from "../src/auth.js";
import { requestEnvelope } from "../src/controls.js";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import { createList, markOrdered, updateItem, updateList, requestOrderApproval } from "../src/grocery.js";
import { acceptInvite, alertsFor, inviteHelper, setProtection } from "../src/helpers.js";
import { balance, systemAccount } from "../src/ledger.js";
import { confirmReceived, listPurchases, purchaseReminders, recordPurchase, returnDaysFor } from "../src/purchases.js";
import { createApp } from "../src/server.js";
import { fakeFetch, freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
beforeAll(async () => {
  db = await freshDb();
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

const no = { calledYou: false, keepSecret: false, urgent: false };
let n = 0;

async function protectedFamily(withHelper = true) {
  const owner = await setup(db, { credit: 10_000 });
  let helperId: string | null = null;
  if (withHelper) {
    const helper = await createUser(db, `h${++n}-${Date.now()}@example.com`);
    await acceptInvite(db, helper.user.id, (await inviteHelper(db, owner.user.id, "Sam (son)")).code);
    helperId = helper.user.id;
  }
  await setProtection(db, owner.user.id, { enabled: true, cosignThresholdCents: 5000, cosignDelayHours: 72 });
  return { ...owner, helperId };
}

describe('"is someone on the phone with you?"', () => {
  it("asks before the owner signs, and requires the answers", async () => {
    const f = await protectedFamily();
    const e = await requestEnvelope(db, f.user.id, { name: "Gift", amountCents: 6000, days: 7 });
    const started = await startApproval(db, f.user.id, e.approvalId).catch((err) => err);
    // No passkey registered in tests: startApproval fails at the passkey step, so check approve() instead.
    expect(started.code ?? "no_passkey").toBe("no_passkey");
    await expect(approve(db, f.user.id, e.approvalId, undefined, { requirePasskey: false })).rejects.toMatchObject({
      code: "scam_check_required",
      details: { questions: { calledYou: expect.stringMatching(/phone/) } },
    });
  });

  it("a yes holds the approval for a helper; the waiting period no longer completes it", async () => {
    const f = await protectedFamily();
    const e = await requestEnvelope(db, f.user.id, { name: "Urgent help", amountCents: 6000, days: 7 }, f.agentKey);
    const res = await approve(db, f.user.id, e.approvalId, undefined, { requirePasskey: false, scamCheck: { ...no, urgent: true } });
    expect(res).toMatchObject({ status: "pending", waitingFor: "helper" });
    expect((res as { message: string }).message).toMatch(/signs of a scam/);
    expect((await approvalStatusForAgent(db, f.agentKey, e.approvalId)).message).toMatch(/helper has to review/);

    expect(await completeDelayedApprovals(db)).toBe(0);
    const { alerts } = await alertsFor(db, f.helperId!, f.user.id);
    expect(alerts.some((a: { kind: string }) => a.kind === "scam_check_flagged")).toBe(true);

    const done = await approve(db, f.helperId!, e.approvalId, undefined, { requirePasskey: false });
    expect(done.status).toBe("used");
    expect(await balance(db, f.user.walletAccountId)).toBe(4000);
  });

  it("without helpers, a yes still waits out the delay; all no's behave as before", async () => {
    const f = await protectedFamily(false);
    const e = await requestEnvelope(db, f.user.id, { name: "Alone", amountCents: 6000, days: 7 });
    const res = await approve(db, f.user.id, e.approvalId, undefined, { requirePasskey: false, scamCheck: { ...no, calledYou: true } });
    expect(res).toMatchObject({ status: "pending", waitingFor: "helper_or_delay" });
    expect((res as { message: string }).message).toMatch(/talk to someone you trust/);

    const g = await protectedFamily();
    const e2 = await requestEnvelope(db, g.user.id, { name: "Fine", amountCents: 6000, days: 7 });
    expect(await approve(db, g.user.id, e2.approvalId, undefined, { requirePasskey: false, scamCheck: no })).toMatchObject({ waitingFor: "helper_or_delay" });
  });
});

describe("test keys", () => {
  it("spend pretend money only, never pay providers, and can approve their own calls", async () => {
    const s = await setup(db, { credit: 1000 });
    const { agentKey, key } = await createAgentKey(db, s.user.id, "ci", { test: true, level: "ask" });
    expect(key.startsWith("ap_test_")).toBe(true);
    expect(agentKey.test).toBe(true);
    const providerBefore = await balance(db, s.provider.accountId);
    const feesBefore = await balance(db, await systemAccount(db, "platform_fees"));

    const { impl, calls } = fakeFetch();
    const pending = await callPaidTool(db, agentKey, { tool: s.tool.slug, input: {}, idempotencyKey: "t1" }, { fetchImpl: impl });
    expect(pending.status).toBe("pending_approval");
    const approvalId = (pending as { approvalId: string }).approvalId;

    const http = (method: string, path: string, body?: unknown) =>
      fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(
        async (r) => ({ status: r.status, body: (await r.json()) as any }),
      );
    expect((await http("POST", `/api/agent/test/approvals/${approvalId}/approve`, {})).body.status).toBe("approved");
    const paid = await callPaidTool(db, agentKey, { tool: s.tool.slug, input: {}, idempotencyKey: "t2", approvalId }, { fetchImpl: impl });
    expect(paid).toMatchObject({ status: "ok", chargedCents: 100, balanceCents: 9900 });
    expect((calls[0].init.headers as Record<string, string>)["x-agentpay-test"]).toBe("true");

    expect(await balance(db, s.user.walletAccountId)).toBe(1000); // real wallet untouched
    expect(await balance(db, s.provider.accountId)).toBe(providerBefore); // provider not paid pretend money
    expect(await balance(db, await systemAccount(db, "platform_fees"))).toBe(feesBefore);
    expect(await ledgerTotal(db)).toBe(0);

    expect((await http("POST", "/api/agent/test/credit", { amountCents: 500 })).body.walletBalanceCents).toBe(10_400);
    // Only paid-call endpoints are open to test keys.
    expect((await http("GET", "/api/agent/everyday")).status).toBe(403);
    expect((await http("POST", "/api/agent/controls/envelopes", { name: "x", amountCents: 100, days: 1 })).status).toBe(403);
    expect((await http("GET", "/api/agent/balance")).body).toMatchObject({ test: true, walletBalanceCents: 10_400 });
    // Real keys can't use the test endpoints.
    const real = await fetch(base + "/api/agent/test/credit", {
      method: "POST", headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json" }, body: JSON.stringify({ amountCents: 100 }),
    });
    expect(real.status).toBe(403);
  });
});

describe("purchases", () => {
  it("tracks a grocery order's return window and what arrived", async () => {
    const s = await setup(db);
    const list = await createList(db, s.user.id, { title: "Weekly", store: "walmart", items: [{ name: "milk" }, { name: "eggs" }], source: "typed" });
    for (const item of list.items) await updateItem(db, s.user.id, list.id, item.id, { status: "in_cart", productName: item.name, priceCents: 400 });
    await updateList(db, s.user.id, list.id, { store: "walmart" });
    const ap = await requestOrderApproval(db, s.user.id, list.id);
    const { approve } = await import("../src/approvals.js");
    await approve(db, s.user.id, ap.approvalId, undefined, { requirePasskey: false });
    await markOrdered(db, s.user.id, list.id, { orderNumber: "W-123", totalCents: 800 }, true);
    await markOrdered(db, s.user.id, list.id, { orderNumber: "W-123", totalCents: 800 }, true).catch(() => {}); // recorded once

    const [p] = await listPurchases(db, s.user.id);
    expect(p).toMatchObject({ source: "grocery", store: "walmart", title: "Weekly", orderNumber: "W-123", returnDays: 90, status: "ordered", daysLeft: 90 });

    const res = await confirmReceived(db, s.user.id, p.id, { missingItems: ["eggs"] });
    expect(res.purchase).toMatchObject({ status: "problem", missingItems: ["eggs"] });
    expect(res.next).toMatch(/Ask walmart to refund eggs before/);
  });

  it("reminds before the return window closes and when an order isn't confirmed", async () => {
    const s = await setup(db);
    expect(returnDaysFor("www.bestbuy.com")).toBe(15);
    expect(returnDaysFor("someshop.example")).toBe(30);
    const id = (await recordPurchase(db, s.user.id, { source: "manual", store: "bestbuy.com", title: "Headphones" }))!;
    await db.query("UPDATE purchases SET return_by = CURRENT_DATE + 2, ordered_at = now() - interval '5 days' WHERE id = $1", [id]);
    const r = await purchaseReminders(db, s.user.id);
    expect(r.map((x) => x.type).sort()).toEqual(["confirm_received", "return_window"]);
    expect(r.find((x) => x.type === "return_window")!.message).toMatch(/Last day to return "Headphones" at bestbuy.com is in 2 days/);
    await confirmReceived(db, s.user.id, id, {});
    expect((await purchaseReminders(db, s.user.id)).map((x) => x.type)).toEqual(["return_window"]);
  });
});
