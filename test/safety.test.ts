import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";
import { setProtection } from "../src/helpers.js";
import { balance } from "../src/ledger.js";
import { payX402 } from "../src/pay-outside.js";
import { listUnclear, resolveUnclear } from "../src/safety.js";
import { NETWORKS } from "../src/x402.js";
import { freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());
const saved = { ...config };
afterEach(() => Object.assign(config, saved));
const dns = { resolve: async () => ["93.184.216.34"] };
const sepolia = NETWORKS["base-sepolia"];
const A = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const B = "0x1111111111111111111111111111111111111111";

/** A pretend x402 seller whose price, address and answer to the paid request can change between calls. */
function seller() {
  const state = { cents: 25, payTo: A, paidStatus: 200 };
  const impl = (async (_url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    if (!h["x-payment"]) {
      return new Response(JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: String(state.cents * 10_000), resource: "https://api.data.example/q", description: "data",
          payTo: state.payTo, asset: sepolia.usdc, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
      }), { status: 402 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: state.paidStatus });
  }) as unknown as typeof fetch;
  return { impl, state };
}

let k = 0;
const pay = (key: any, s: ReturnType<typeof seller>, maxCents = 1000) =>
  payX402(db, key, { url: "https://api.data.example/q", maxCents, idempotencyKey: `s-${++k}` }, { fetchImpl: s.impl, ...dns });

describe("payment safety", () => {
  it("asks the owner when a seller's payment address changes; protected accounts refuse it", async () => {
    Object.assign(config, { x402PrivateKey: generatePrivateKey(), x402Network: "base-sepolia" });
    const a = await setup(db, { credit: 5000 });
    const s = seller();
    expect((await pay(a.agentKey, s)).status).toBe("ok");
    s.state.payTo = B;
    const changed = await pay(a.agentKey, s);
    expect(changed).toMatchObject({ status: "pending_approval", why: expect.stringMatching(/different address/) });

    await setProtection(db, a.user.id, { enabled: true });
    await expect(pay(a.agentKey, s)).rejects.toMatchObject({ code: "payee_changed" });
  });

  it("asks on a big price jump and on a repeated payment, even when the level would pay", async () => {
    Object.assign(config, { x402PrivateKey: generatePrivateKey(), x402Network: "base-sepolia" });
    const a = await setup(db, { credit: 5000 });
    const s = seller();
    expect((await pay(a.agentKey, s)).status).toBe("ok");
    const again = await pay(a.agentKey, s);
    expect(again).toMatchObject({ status: "pending_approval", why: expect.stringMatching(/looks like a duplicate/) });

    s.state.cents = 300;
    expect(await pay(a.agentKey, s)).toMatchObject({ status: "pending_approval", why: expect.stringMatching(/12\.0× the last payment/) });
  });

  it("holds further payments to a seller after an unclear one, until the owner resolves it", async () => {
    Object.assign(config, { x402PrivateKey: generatePrivateKey(), x402Network: "base-sepolia" });
    const a = await setup(db, { credit: 5000 });
    const s = seller();
    s.state.paidStatus = 500;
    const unclear = await pay(a.agentKey, s);
    expect(unclear).toMatchObject({ status: "ok", chargedCents: 25 });
    expect(await listUnclear(db, a.user.id)).toHaveLength(1);
    await expect(pay(a.agentKey, s)).rejects.toMatchObject({ code: "possibly_paid" });

    // The owner checks: it didn't go through. The credits come back and paying works again.
    await resolveUnclear(db, a.user.id, (unclear as { callId: string }).callId, false);
    expect(await balance(db, a.user.walletAccountId)).toBe(5000);
    s.state.paidStatus = 200;
    expect((await pay(a.agentKey, s)).status).toBe("ok");
    expect(await ledgerTotal(db)).toBe(0);
  });
});
