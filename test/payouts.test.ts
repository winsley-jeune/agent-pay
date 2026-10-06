import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import { balance, systemAccount } from "../src/ledger.js";
import { connectOnboarding, connectStatus, handleConnectEvent, payOut, processPayout, runPayouts, setAutoPayout, type StripeConnect } from "../src/payouts.js";
import { fakeFetch, freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

let accountSeq = 0;
/** A pretend Stripe that records what it was asked to do. */
function fakeStripe(opts: { failTransfers?: number } = {}) {
  let failures = opts.failTransfers ?? 0;
  const calls = { accounts: [] as any[], links: [] as any[], transfers: [] as { params: any; options: any }[] };
  const client: StripeConnect = {
    accounts: { create: async (p) => (calls.accounts.push(p), { id: `acct_${++accountSeq}` }) },
    accountLinks: { create: async (p) => (calls.links.push(p), { url: `https://connect.stripe.com/setup/${p.account}` }) },
    transfers: {
      create: async (params, options) => {
        calls.transfers.push({ params, options });
        if (failures-- > 0) throw new Error("Your destination account needs to have at least one of the following capabilities enabled: transfers");
        return { id: `tr_${++accountSeq}` };
      },
    },
  };
  return { client, calls };
}

let n = 0;
/** A seller with $9 of earnings from 10 paid calls. */
async function sellerWithEarnings() {
  const s = await setup(db, { credit: 2000 });
  for (let i = 0; i < 10; i++) await callPaidTool(db, s.agentKey, { tool: s.tool.slug, input: {}, idempotencyKey: `earn-${++n}` }, { fetchImpl: fakeFetch().impl });
  expect(await balance(db, s.provider.accountId)).toBe(900);
  return s;
}

const enable = (accountId: string) =>
  handleConnectEvent(db, { id: `evt_${++n}`, type: "account.updated", data: { object: { id: accountId, payouts_enabled: true, details_submitted: true, capabilities: { transfers: "active" } } } });

describe("Stripe Connect payouts", () => {
  it("onboards the seller with Stripe, then transfers earnings once Stripe enables payouts", async () => {
    const s = await sellerWithEarnings();
    const stripe = fakeStripe();
    const onboarding = await connectOnboarding(db, s.provider, "seller@example.com", stripe.client);
    expect(onboarding).toEqual({ stripeAccountId: expect.stringMatching(/^acct_/), onboardingUrl: `https://connect.stripe.com/setup/${onboarding.stripeAccountId}` });
    expect(stripe.calls.accounts[0]).toMatchObject({ type: "express", country: "US", capabilities: { transfers: { requested: true } } });
    // Asking again reuses the same Stripe account.
    await connectOnboarding(db, s.provider, "seller@example.com", stripe.client);
    expect(stripe.calls.accounts).toHaveLength(1);

    const waiting = await payOut(db, s.provider, 500, stripe.client);
    expect(waiting).toMatchObject({ status: "requested", waitingFor: "the seller to finish Stripe onboarding" });
    expect(await balance(db, s.provider.accountId)).toBe(400);

    await enable(onboarding.stripeAccountId);
    expect(await connectStatus(db, s.provider.id)).toMatchObject({ payoutsEnabled: true, detailsSubmitted: true });
    expect(await runPayouts(db, stripe.client)).toBe(1);
    expect(stripe.calls.transfers[0]).toEqual({
      params: expect.objectContaining({ amount: 500, currency: "usd", destination: onboarding.stripeAccountId }),
      options: { idempotencyKey: `payout_${waiting.payout.id}` },
    });
    expect(await processPayout(db, waiting.payout.id, stripe.client)).toMatchObject({ status: "paid" }); // never sent twice
    expect(stripe.calls.transfers).toHaveLength(1);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("retries a refused transfer, then returns the earnings after the last attempt", async () => {
    const s = await sellerWithEarnings();
    const stripe = fakeStripe({ failTransfers: 99 });
    await enable((await connectOnboarding(db, s.provider, "seller@example.com", stripe.client)).stripeAccountId);
    const first = await payOut(db, s.provider, 900, stripe.client);
    expect(first).toMatchObject({ status: "requested", retrying: true });
    for (let i = 0; i < 4; i++) await processPayout(db, first.payout.id, stripe.client);
    const { rows } = await db.query("SELECT status, attempts, failure FROM payouts WHERE id = $1", [first.payout.id]);
    expect(rows[0]).toMatchObject({ status: "failed", attempts: 5, failure: expect.stringMatching(/capabilities/) });
    expect(await balance(db, s.provider.accountId)).toBe(900);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("puts the earnings back when Stripe reverses a transfer, and pays out automatically", async () => {
    const s = await sellerWithEarnings();
    const stripe = fakeStripe();
    const { stripeAccountId } = await connectOnboarding(db, s.provider, "seller@example.com", stripe.client);
    await enable(stripeAccountId);
    const paid = await payOut(db, s.provider, 900, stripe.client);
    expect(paid.status).toBe("paid");
    const reversed = await handleConnectEvent(db, { id: `evt_${++n}`, type: "transfer.reversed", data: { object: { id: (paid as { transferId: string }).transferId } } });
    expect(reversed).toBe("applied");
    expect(await balance(db, s.provider.accountId)).toBe(900);

    await setAutoPayout(db, s.provider.id, 500);
    await runPayouts(db, stripe.client);
    expect(await balance(db, s.provider.accountId)).toBe(0);
    expect(await balance(db, await systemAccount(db, "payouts"))).toBeGreaterThan(0);
    expect(await ledgerTotal(db)).toBe(0);
  });
});
