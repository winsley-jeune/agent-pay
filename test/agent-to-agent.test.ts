import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAgentPayRequest, type AgentPayKey } from "../packages/verify/src/index.js";
import { approve } from "../src/approvals.js";
import type { Db } from "../src/db.js";
import { callPaidTool, completeJob, failJob, getJob, requestTaskQuote, sweepExpiredHolds } from "../src/gateway.js";
import { balance } from "../src/ledger.js";
import { createTool } from "../src/registry.js";
import { createApp } from "../src/server.js";
import { publicKeys } from "../src/signing.js";
import { freshDb, ledgerTotal, setup } from "./helpers.js";

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

type Seen = { headers: Record<string, string>; body: string };
/** A provider that records what it receives and answers with `respond`. */
function provider(respond: (body: any, headers: Record<string, string>) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    seen.push({ headers, body });
    const r = respond(JSON.parse(body), headers);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

let k = 0;
const call = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, input: { topic: "solar panels" }, idempotencyKey: `a2a-${++k}`, ...extra });

describe("signed requests", () => {
  it("lets the provider verify who pays and how much is held, and detects tampering", async () => {
    const s = await setup(db, { credit: 1000 });
    const p = provider(() => ({ json: { report: "ok" } }));
    await callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl: p.impl });
    const { keys } = await publicKeys(db);
    const v = verifyAgentPayRequest({ headers: p.seen[0].headers, rawBody: p.seen[0].body, keys: keys as AgentPayKey[], expectedTool: s.tool.slug });
    expect(v).toMatchObject({ phase: "call", tool: s.tool.slug, heldCents: 100, agentId: s.agentKey.id, test: false });
    expect(() => verifyAgentPayRequest({ headers: p.seen[0].headers, rawBody: p.seen[0].body.replace("solar", "wind"), keys: keys as AgentPayKey[] })).toThrow(/doesn't match/);
    expect(() => verifyAgentPayRequest({ headers: { ...p.seen[0].headers, "x-agentpay-held-cents": "9999" }, rawBody: p.seen[0].body, keys: keys as AgentPayKey[] })).toThrow(/doesn't match/);
    expect(() => verifyAgentPayRequest({ headers: p.seen[0].headers, rawBody: p.seen[0].body, keys: keys as AgentPayKey[], now: Math.floor(Date.now() / 1000) + 3600 })).toThrow(/too old/);

    const res = await fetch(`${base}/.well-known/agentpay-keys.json`);
    expect((await res.json()).keys[0]).toMatchObject({ alg: "Ed25519", kid: keys[0].kid });
  });
});

describe("async jobs", () => {
  async function asyncTool(priceCents = 500) {
    const s = await setup(db, { credit: 2000 });
    const tool = await createTool(db, s.provider.id, {
      slug: `report-agent-${++k}`, name: "Research agent", description: "writes a research report", pricingType: "per_call", priceCents,
      upstreamUrl: "https://agent.example/jobs", mode: "async", maxJobSeconds: 600,
    });
    return { ...s, tool };
  }

  it("holds the money while the agent works, charges when the result arrives", async () => {
    const s = await asyncTool();
    const p = provider(() => ({ status: 202, json: { accepted: true } }));
    const first = call(s.tool.slug);
    const started = await callPaidTool(db, s.agentKey, first, { fetchImpl: p.impl });
    expect(started).toMatchObject({ status: "running", heldCents: 500, balanceCents: 1500 });
    const callId = (started as { callId: string }).callId;
    expect(JSON.parse(p.seen[0].body).callbackUrl).toBe(`http://localhost:8787/api/jobs/${callId}`);
    const token = p.seen[0].headers["x-agentpay-job-token"];
    expect(token).toMatch(/^ap_job_/);
    expect(await getJob(db, s.agentKey, callId)).toMatchObject({ status: "running", heldCents: 500 });
    // Retrying the same call doesn't start a second job.
    expect(await callPaidTool(db, s.agentKey, first, { fetchImpl: p.impl })).toMatchObject({ status: "running", replayed: true });
    expect(p.seen).toHaveLength(1);

    await expect(completeJob(db, callId, "ap_job_wrong", { result: {} })).rejects.toMatchObject({ code: "not_found" });
    // The provider reports back over HTTP with the job token.
    const res = await fetch(`${base}/api/jobs/${callId}/complete`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ result: { report: "Solar is cheap now." } }),
    });
    expect(await res.json()).toMatchObject({ status: "done", chargedCents: 500 });
    expect(await getJob(db, s.agentKey, callId)).toMatchObject({ status: "done", chargedCents: 500, result: { report: "Solar is cheap now." } });
    expect(await balance(db, s.provider.accountId)).toBe(450);
    await expect(completeJob(db, callId, token, { result: {} })).rejects.toMatchObject({ code: "job_closed" });
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("returns the money when the job fails or times out", async () => {
    const s = await asyncTool();
    const p = provider(() => ({ status: 202, json: {} }));
    const a = (await callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl: p.impl })) as { callId: string };
    await failJob(db, a.callId, p.seen[0].headers["x-agentpay-job-token"], "couldn't find sources");
    expect(await getJob(db, s.agentKey, a.callId)).toMatchObject({ status: "failed", chargedCents: 0, error: "provider reported failure: couldn't find sources" });

    const b = (await callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl: p.impl })) as { callId: string };
    await db.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1", [b.callId]);
    await sweepExpiredHolds(db);
    expect((await getJob(db, s.agentKey, b.callId)).status).toBe("failed");
    await expect(completeJob(db, b.callId, p.seen[1].headers["x-agentpay-job-token"], { result: {} })).rejects.toMatchObject({ code: "job_closed" });
    expect(await balance(db, s.user.walletAccountId)).toBe(2000);
  });
});

describe("prices quoted per task", () => {
  async function quotedTool() {
    const s = await setup(db, { credit: 2000, limits: { approvalThresholdCents: 1000 } });
    const tool = await createTool(db, s.provider.id, {
      slug: `design-agent-${++k}`, name: "Logo agent", description: "designs a logo", pricingType: "quoted", priceCents: 800, upstreamUrl: "https://agent.example/logo",
    });
    let price = 300;
    const p = provider((body) => (body.phase === "quote" ? { json: { priceCents: price, description: "3 logo drafts", ref: "Q-77", expiresInSeconds: 600 } } : { json: { drafts: 3 } }));
    return { ...s, tool, p, setPrice: (c: number) => (price = c) };
  }

  it("quotes for free, then charges exactly the quote, once, for the same input", async () => {
    const s = await quotedTool();
    await expect(callPaidTool(db, s.agentKey, call(s.tool.slug), { fetchImpl: s.p.impl })).rejects.toMatchObject({ code: "quote_required" });
    const q = await requestTaskQuote(db, s.agentKey, s.tool.slug, { topic: "solar panels" }, { fetchImpl: s.p.impl });
    expect(q).toMatchObject({ priceCents: 300, description: "3 logo drafts", needsApproval: false });
    expect(s.p.seen[0].headers["x-agentpay-phase"]).toBe("quote");
    expect(await balance(db, s.user.walletAccountId)).toBe(2000);

    await expect(callPaidTool(db, s.agentKey, { ...call(s.tool.slug), input: { topic: "wind" }, quoteId: q.quoteId }, { fetchImpl: s.p.impl })).rejects.toMatchObject({ code: "quote_mismatch" });
    const paid = await callPaidTool(db, s.agentKey, call(s.tool.slug, { quoteId: q.quoteId }), { fetchImpl: s.p.impl });
    expect(paid).toMatchObject({ status: "ok", chargedCents: 300 });
    expect(JSON.parse(s.p.seen.at(-1)!.body).quote).toEqual({ id: q.quoteId, ref: "Q-77" });
    await expect(callPaidTool(db, s.agentKey, call(s.tool.slug, { quoteId: q.quoteId }), { fetchImpl: s.p.impl })).rejects.toMatchObject({ code: "quote_invalid" });
  });

  it("applies the owner's rules to the quoted price, and refuses quotes over the listed maximum", async () => {
    const s = await quotedTool();
    await db.query("UPDATE agent_keys SET approval_threshold_cents = 200 WHERE id = $1", [s.agentKey.id]);
    const key = { ...s.agentKey, approvalThresholdCents: 200 };
    const q = await requestTaskQuote(db, key, s.tool.slug, { topic: "solar panels" }, { fetchImpl: s.p.impl });
    expect(q.needsApproval).toBe(true);
    const pending = await callPaidTool(db, key, call(s.tool.slug, { quoteId: q.quoteId }), { fetchImpl: s.p.impl });
    expect(pending.status).toBe("pending_approval");
    await approve(db, s.user.id, (pending as { approvalId: string }).approvalId, undefined, { requirePasskey: false });
    const paid = await callPaidTool(db, key, call(s.tool.slug, { quoteId: q.quoteId, approvalId: (pending as { approvalId: string }).approvalId }), { fetchImpl: s.p.impl });
    expect(paid).toMatchObject({ status: "ok", chargedCents: 300 });

    s.setPrice(900);
    await expect(requestTaskQuote(db, key, s.tool.slug, { topic: "x" }, { fetchImpl: s.p.impl })).rejects.toMatchObject({ code: "quote_over_ceiling" });
  });
});
