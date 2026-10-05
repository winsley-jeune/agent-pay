import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { SAMPLE_SECRET } from "../src/sample.js";
import { createApp } from "../src/server.js";
import { freshDb, ledgerTotal } from "./helpers.js";

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

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function signup(email: string) {
  const r = await call("POST", "/api/signup", undefined, { email });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

describe("HTTP API", () => {
  it("requires the right kind of token", async () => {
    const owner = await signup("auth@example.com");
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("GET", "/api/me", "ap_owner_wrong")).status).toBe(401);
    expect((await call("GET", "/api/agent/balance", owner)).status).toBe(401);
    expect((await call("GET", "/api/me", owner)).body).toMatchObject({ balanceCents: 0, hasPasskey: false });
  });

  it("runs a full paid call through the sample provider, end to end", async () => {
    const providerOwner = await signup("seller@example.com");
    const { body: p } = await call("POST", "/api/providers", providerOwner, { name: "Dice Co" });
    const created = await call("POST", `/api/providers/${p.provider.id}/tools`, providerOwner, {
      slug: "dice-http",
      name: "Dice",
      description: "dice",
      pricingType: "per_unit",
      priceCents: 2,
      unitsField: "dice",
      upstreamUrl: `${base}/sample/dice`,
      upstreamAuth: `Bearer ${SAMPLE_SECRET}`,
    });
    expect(created.status).toBe(200);
    // Upstream credentials never leak into the public catalog.
    const catalog = await call("GET", "/api/catalog");
    expect(JSON.stringify(catalog.body)).not.toContain(SAMPLE_SECRET);

    const owner = await signup("buyer@example.com");
    await call("POST", "/api/dev/credit", owner, { amountCents: 1000 });
    const { body: k } = await call("POST", "/api/agent-keys", owner, { name: "bot", perCallMaxCents: 100 });

    const quote = await call("POST", "/api/agent/quote", k.key, { tool: "dice-http", input: { dice: 10 } });
    expect(quote.body).toMatchObject({ amountCents: 20, needsApproval: false, walletBalanceCents: 1000 });

    const res = await call("POST", "/api/agent/call", k.key, {
      tool: "dice-http",
      input: { dice: 10, sides: 6, stopAt: 99 },
      idempotencyKey: "http-1",
    });
    expect(res.body).toMatchObject({ status: "ok", chargedCents: 20, balanceCents: 980 });
    expect(res.body.result.rolls).toHaveLength(10);

    // Provider stopped early -> charged only for dice rolled.
    const early = await call("POST", "/api/agent/call", k.key, { tool: "dice-http", input: { dice: 50, sides: 2, stopAt: 1 }, idempotencyKey: "http-2" });
    expect(early.body.chargedCents).toBe(early.body.result.rolls.length * 2);

    const tooBig = await call("POST", "/api/agent/call", k.key, { tool: "dice-http", input: { dice: 60 }, idempotencyKey: "http-3" });
    expect(tooBig).toMatchObject({ status: 402, body: { error: { code: "per_call_max_exceeded" } } });

    expect((await call("GET", "/api/agent/tools", k.key)).body.tools.map((t: any) => t.slug)).toContain("dice-http");
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("rejects bad input with a clear message", async () => {
    const owner = await signup("bad@example.com");
    const { body: k } = await call("POST", "/api/agent-keys", owner, { name: "bot" });
    const r = await call("POST", "/api/agent/call", k.key, { tool: "x" });
    expect(r).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(r.body.error.message).toContain("idempotencyKey");
  });

  it("stops a revoked key immediately", async () => {
    const owner = await signup("revoke@example.com");
    const { body: k } = await call("POST", "/api/agent-keys", owner, { name: "bot" });
    expect((await call("GET", "/api/agent/balance", k.key)).status).toBe(200);
    await call("DELETE", `/api/agent-keys/${k.agentKey.id}`, owner);
    expect((await call("GET", "/api/agent/balance", k.key)).status).toBe(401);
  });

  it("requires a passkey to approve when REQUIRE_PASSKEY is on", async () => {
    const providerOwner = await signup("planseller@example.com");
    const { body: p } = await call("POST", "/api/providers", providerOwner, { name: "Plans Inc" });
    await call("POST", `/api/providers/${p.provider.id}/plans`, providerOwner, {
      slug: "news-daily",
      name: "News",
      description: "news",
      category: "news",
      priceCents: 500,
      interval: "month",
    });
    const owner = await signup("subscriber@example.com");
    await call("POST", "/api/dev/credit", owner, { amountCents: 1000 });
    const { body: k } = await call("POST", "/api/agent-keys", owner, { name: "bot" });
    const sub = await call("POST", "/api/agent/subscriptions", k.key, { plan: "news-daily", reason: "morning brief" });
    expect(sub.body.status).toBe("pending_approval");

    const r = await call("POST", `/api/approvals/${sub.body.approvalId}/approve`, owner, {});
    expect(r).toMatchObject({ status: 401, body: { error: { code: "passkey_required" } } });
    expect((await call("GET", "/api/me", owner)).body.balanceCents).toBe(1000);

    // Agents can see the status of their own request, and cancel it.
    expect((await call("GET", `/api/agent/approvals/${sub.body.approvalId}`, k.key)).body.status).toBe("pending");
    expect((await call("POST", `/api/agent/subscriptions/${sub.body.subscriptionId}/cancel`, k.key, {})).body.status).toBe("canceled");
  });
});

describe("Stripe webhook", () => {
  const stripe = new Stripe("sk_test_dummy");
  const secret = "whsec_test_secret";

  async function deliver(event: object, sig?: string) {
    const payload = JSON.stringify(event);
    const res = await fetch(`${base}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig ?? stripe.webhooks.generateTestHeaderString({ payload, secret }) },
      body: payload,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function pendingTopup(email: string, amountCents: number) {
    const token = await signup(email);
    const me = await call("GET", "/api/me", token);
    const { rows } = await db.query("INSERT INTO topups (user_id, amount_cents, checkout_session) VALUES ($1, $2, $3) RETURNING id", [
      me.body.user.id,
      amountCents,
      `cs_test_${email}`,
    ]);
    return { token, topupId: rows[0].id as string };
  }

  const completed = (id: string, topupId: string, amount: number, extra: object = {}) => ({
    id,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_x", object: "checkout.session", payment_status: "paid", amount_total: amount, currency: "usd", metadata: { topup_id: topupId }, ...extra } },
  });

  it("credits the wallet once, even when Stripe redelivers the event", async () => {
    const { token, topupId } = await pendingTopup("card@example.com", 2500);
    expect((await deliver(completed("evt_1", topupId, 2500))).body.result).toBe("applied");
    expect((await deliver(completed("evt_1", topupId, 2500))).body.result).toBe("duplicate");
    // A different event for the same top-up must not credit twice either.
    expect((await deliver(completed("evt_2", topupId, 2500))).body.result).toBe("ignored");
    expect((await call("GET", "/api/me", token)).body.balanceCents).toBe(2500);
  });

  it("rejects a forged signature", async () => {
    const { token, topupId } = await pendingTopup("forged@example.com", 2500);
    const r = await deliver(completed("evt_forged", topupId, 2500), "t=1,v1=deadbeef");
    expect(r).toMatchObject({ status: 400, body: { error: { code: "bad_signature" } } });
    expect((await call("GET", "/api/me", token)).body.balanceCents).toBe(0);
  });

  it("does not credit unpaid or mismatched sessions", async () => {
    const { token, topupId } = await pendingTopup("unpaid@example.com", 2500);
    expect((await deliver(completed("evt_unpaid", topupId, 2500, { payment_status: "unpaid" }))).body.result).toBe("ignored");
    expect((await deliver(completed("evt_wrong", topupId, 99_999))).status).toBe(422);
    expect((await call("GET", "/api/me", token)).body.balanceCents).toBe(0);
  });
});
