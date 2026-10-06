import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { approve } from "../src/approvals.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";
import { balance, systemAccount } from "../src/ledger.js";
import { assertPublicUrl } from "../src/outbound.js";
import { a2aSend, discoverAgent, payX402 } from "../src/pay-outside.js";
import { NETWORKS } from "../src/x402.js";
import { freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const saved = { ...config };
const key = generatePrivateKey();
const payer = privateKeyToAccount(key).address;
const SELLER = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const sepolia = NETWORKS["base-sepolia"];
afterEach(() => Object.assign(config, saved));
function configure(network = "base-sepolia") {
  Object.assign(config, { x402PrivateKey: key, x402Network: network, x402MaxCents: 2000 });
}
const publicDns = { resolve: async () => ["93.184.216.34"] };

/** Check a signed EIP-3009 authorization the way a seller's facilitator would. */
async function verifies(payload: any, chainId = sepolia.chainId) {
  const a = payload.payload.authorization;
  return verifyTypedData({
    address: payer,
    domain: { name: "USDC", version: "2", chainId, verifyingContract: sepolia.usdc },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: payload.payload.signature,
  });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const requirementV1 = (cents: number, extra: Record<string, unknown> = {}) => ({
  x402Version: 1,
  accepts: [{
    scheme: "exact", network: "base-sepolia", maxAmountRequired: String(cents * 10_000), resource: "https://api.weather.example/today",
    description: "Today's weather", payTo: SELLER, asset: sepolia.usdc, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...extra,
  }],
});

/** A pretend x402 seller: 402 first, then answers the paid request with `paid`. */
function x402Seller(opts: { v2?: boolean; cents?: number; paid?: (payment: any) => Response } = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    const sent = headers["x-payment"] ?? headers["payment-signature"];
    if (!sent) {
      if (opts.v2) {
        const pr = { x402Version: 2, resource: { url, description: "Today's weather" }, accepts: [{ ...requirementV1(opts.cents ?? 25).accepts[0], network: "eip155:84532", amount: String((opts.cents ?? 25) * 10_000), maxAmountRequired: undefined }] };
        return new Response("{}", { status: 402, headers: { "payment-required": b64(pr) } });
      }
      return new Response(JSON.stringify(requirementV1(opts.cents ?? 25)), { status: 402 });
    }
    const payment = JSON.parse(Buffer.from(sent, "base64").toString());
    return opts.paid?.(payment) ?? new Response(JSON.stringify({ temperature: 21 }), { status: 200, headers: { "x-payment-response": b64({ success: true, transaction: "0xabc", network: "base-sepolia", payer }), "payment-response": b64({ success: true, transaction: "0xabc" }) } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("safety of outside addresses", () => {
  it("only reaches public https addresses outside restricted categories", async () => {
    await expect(assertPublicUrl("http://api.example.com/x", publicDns)).rejects.toMatchObject({ code: "https_only" });
    await expect(assertPublicUrl("https://internal.example.com", { resolve: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "private_address" });
    await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data", publicDns)).rejects.toMatchObject({ code: "private_address" });
    await expect(assertPublicUrl("https://[::1]/", publicDns)).rejects.toMatchObject({ code: "private_address" });
    await expect(assertPublicUrl("https://www.coinbase.com/buy", publicDns)).rejects.toMatchObject({ code: "restricted_category" });
    await expect(assertPublicUrl("https://api.example.com/v1/weather", publicDns)).resolves.toBeInstanceOf(URL);
  });
});

describe("x402", () => {
  it("pays a v1 seller within the owner's controls, with a valid USDC authorization", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const seller = x402Seller();
    const res = await payX402(db, s.agentKey, { url: "https://api.weather.example/today", maxCents: 50, idempotencyKey: "w1", reason: "user asked for the weather" }, { fetchImpl: seller.impl, ...publicDns });
    expect(res).toMatchObject({ status: "ok", chargedCents: 25, balanceCents: 975, result: { response: { temperature: 21 }, receipt: { success: true, transaction: "0xabc" } } });

    const payment = JSON.parse(Buffer.from(seller.seen[1].headers["x-payment"], "base64").toString());
    expect(payment).toMatchObject({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { authorization: { from: payer, to: SELLER, value: "250000" } } });
    expect(await verifies(payment)).toBe(true);
    expect(await balance(db, await systemAccount(db, "external_settlement"))).toBe(25);

    // Retrying with the same key returns the stored result without paying again.
    expect(await payX402(db, s.agentKey, { url: "https://api.weather.example/today", maxCents: 50, idempotencyKey: "w1" }, { fetchImpl: seller.impl, ...publicDns })).toMatchObject({ status: "ok", replayed: true });
    expect(seller.seen).toHaveLength(2);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("speaks x402 v2 headers", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const seller = x402Seller({ v2: true, cents: 10 });
    const res = await payX402(db, s.agentKey, { url: "https://api.weather.example/today", maxCents: 50 }, { fetchImpl: seller.impl, ...publicDns });
    expect(res).toMatchObject({ status: "ok", chargedCents: 10 });
    const payment = JSON.parse(Buffer.from(seller.seen[1].headers["payment-signature"], "base64").toString());
    expect(payment).toMatchObject({ x402Version: 2, accepted: { network: "eip155:84532", amount: "100000" } });
    expect(await verifies(payment)).toBe(true);
  });

  it("returns the money when the seller refuses, charges when its answer is unclear", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const refusing = x402Seller({ paid: () => new Response("{}", { status: 402, headers: { "x-payment-response": b64({ success: false, errorReason: "insufficient_funds" }) } }) });
    const refused = await payX402(db, s.agentKey, { url: "https://api.weather.example/today", maxCents: 50 }, { fetchImpl: refusing.impl, ...publicDns });
    expect(refused).toMatchObject({ status: "failed", chargedCents: 0, error: "insufficient_funds" });

    const broken = x402Seller({ paid: () => new Response("oops", { status: 500 }) });
    const unclear = await payX402(db, s.agentKey, { url: "https://api.weather.example/today", maxCents: 50 }, { fetchImpl: broken.impl, ...publicDns });
    expect(unclear).toMatchObject({ status: "ok", chargedCents: 25, result: { unclear: "HTTP 500 after the payment was sent" } });
    expect(await balance(db, s.user.walletAccountId)).toBe(975);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("enforces max_cents, the allow-list, levels and approvals, and test keys stay on test networks", async () => {
    configure();
    const s = await setup(db, { credit: 1000, limits: { level: "ask" } });
    const seller = x402Seller({ cents: 25 });
    const url = "https://api.weather.example/today";
    await expect(payX402(db, s.agentKey, { url, maxCents: 20 }, { fetchImpl: seller.impl, ...publicDns })).rejects.toMatchObject({ code: "over_max" });

    const pending = await payX402(db, s.agentKey, { url, maxCents: 50, idempotencyKey: "ask-1" }, { fetchImpl: seller.impl, ...publicDns });
    expect(pending).toMatchObject({ status: "pending_approval", amountCents: 25 });
    await approve(db, s.user.id, (pending as { approvalId: string }).approvalId, undefined, { requirePasskey: false });
    const paid = await payX402(db, s.agentKey, { url, maxCents: 50, idempotencyKey: "ask-1", approvalId: (pending as { approvalId: string }).approvalId }, { fetchImpl: seller.impl, ...publicDns });
    expect(paid).toMatchObject({ status: "ok", chargedCents: 25 });

    const limited = await setup(db, { credit: 1000, limits: { allowedToolSlugs: ["some-tool"] } });
    await expect(payX402(db, limited.agentKey, { url, maxCents: 50 }, { fetchImpl: seller.impl, ...publicDns })).rejects.toMatchObject({ code: "tool_not_allowed" });

    configure("base");
    await expect(payX402(db, s.agentKey, { url, maxCents: 50 }, { fetchImpl: seller.impl, ...publicDns })).rejects.toMatchObject({ code: "x402_unsupported" });
    const testKey = { ...s.agentKey, test: true, level: "budget" as const };
    const mainnetSeller = x402Seller();
    const mainnetReq = (async (u: string, init: RequestInit) => {
      const r = await mainnetSeller.impl(u, init);
      if (r.status !== 402) return r;
      return new Response(JSON.stringify(requirementV1(25, { network: "base", asset: NETWORKS.base.usdc })), { status: 402 });
    }) as unknown as typeof fetch;
    await expect(payX402(db, testKey, { url, maxCents: 50 }, { fetchImpl: mainnetReq, ...publicDns })).rejects.toMatchObject({ code: "test_key_mainnet" });
  });

  it("returns free resources at no charge", async () => {
    configure();
    const s = await setup(db, { credit: 100 });
    const free = (async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })) as unknown as typeof fetch;
    expect(await payX402(db, s.agentKey, { url: "https://api.example.com/free", maxCents: 10 }, { fetchImpl: free, ...publicDns })).toEqual({
      status: "free", httpStatus: 200, result: { hello: "world" }, chargedCents: 0,
    });
  });
});

describe("A2A agents with the x402 extension", () => {
  /** A pretend A2A agent that asks to be paid before doing the work. */
  function a2aAgent(opts: { description?: string; refuse?: boolean } = {}) {
    const rpcs: any[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/.well-known/agent-card.json")) {
        return new Response(JSON.stringify({
          name: "Logo Studio", description: opts.description ?? "Designs logos", url: "https://agent.example/a2a",
          skills: [{ id: "logo", name: "Logo design" }], capabilities: { extensions: [{ uri: "https://github.com/google-a2a/a2a-x402/v0.1" }] },
        }), { status: 200 });
      }
      const rpc = JSON.parse(String(init.body));
      rpcs.push({ rpc, headers: init.headers });
      const meta = rpc.params?.message?.metadata;
      if (!meta) {
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
          kind: "task", id: "task-1", contextId: "ctx-1",
          status: { state: "input-required", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "That's $0.40." }],
            metadata: { "x402.payment.status": "payment-required", "x402.payment.required": { x402Version: 2, resource: { url: "https://agent.example/logo", description: "A logo" },
              accepts: [{ scheme: "exact", network: "eip155:84532", amount: "400000", asset: sepolia.usdc, payTo: SELLER, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } }] } } } },
        } });
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
        kind: "task", id: "task-1", contextId: "ctx-1",
        status: { state: opts.refuse ? "failed" : "completed", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: opts.refuse ? "Payment failed." : "Here's your logo." }],
          metadata: opts.refuse
            ? { "x402.payment.status": "payment-failed", "x402.payment.receipts": [{ success: false, errorReason: "invalid_signature" }] }
            : { "x402.payment.status": "payment-completed", "x402.payment.receipts": [{ success: true, transaction: "0xdef", network: "eip155:84532" }] } } },
        artifacts: opts.refuse ? [] : [{ name: "logo.svg", parts: [{ kind: "text", text: "<svg/>" }] }],
      } });
    }) as unknown as typeof fetch;
    return { impl, rpcs };
  }

  it("discovers the agent, pays when asked and returns its answer", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const agent = a2aAgent();
    expect(await discoverAgent("https://agent.example", { fetchImpl: agent.impl, ...publicDns })).toMatchObject({ name: "Logo Studio", acceptsX402: true });

    const res = await a2aSend(db, s.agentKey, { agentUrl: "https://agent.example", text: "A logo for my bakery", maxCents: 100 }, { fetchImpl: agent.impl, ...publicDns });
    expect(res).toMatchObject({
      agent: "Logo Studio", state: "completed", text: "Here's your logo.", artifacts: [{ name: "logo.svg", text: "<svg/>" }],
      payment: { status: "ok", chargedCents: 40 },
    });
    const submitted = agent.rpcs[1].rpc.params.message;
    expect(submitted).toMatchObject({ taskId: "task-1", metadata: { "x402.payment.status": "payment-submitted" } });
    expect(await verifies(submitted.metadata["x402.payment.payload"])).toBe(true);
    expect(agent.rpcs[0].headers["x-a2a-extensions"]).toBe("https://github.com/google-a2a/a2a-x402/v0.1");
    expect(await balance(db, s.user.walletAccountId)).toBe(960);
  });

  it("returns the money when the agent reports the payment failed, and refuses restricted agents", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const res = await a2aSend(db, s.agentKey, { agentUrl: "https://agent.example", text: "A logo", maxCents: 100 }, { fetchImpl: a2aAgent({ refuse: true }).impl, ...publicDns });
    expect(res.payment).toMatchObject({ status: "failed", chargedCents: 0 });
    expect(await balance(db, s.user.walletAccountId)).toBe(1000);

    await expect(a2aSend(db, s.agentKey, { agentUrl: "https://agent.example", text: "x", maxCents: 100 }, { fetchImpl: a2aAgent({ description: "Delivers cigarettes" }).impl, ...publicDns })).rejects.toMatchObject({
      code: "restricted_category",
    });
    expect(await ledgerTotal(db)).toBe(0);
  });
});
