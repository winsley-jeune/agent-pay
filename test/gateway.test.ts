import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKeyById } from "../src/auth.js";
import type { Db } from "../src/db.js";
import { approve } from "../src/approvals.js";
import { callPaidTool, sweepExpiredHolds } from "../src/gateway.js";
import { balance, systemAccount } from "../src/ledger.js";
import { fakeFetch, freshDb, ledgerTotal, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const call = (tool: string, idempotencyKey: string, input: Record<string, unknown> = {}, approvalId?: string) => ({
  tool,
  input,
  idempotencyKey,
  approvalId,
});

describe("paid calls", () => {
  it("charges the wallet and pays the provider minus the platform fee", async () => {
    const { agentKey, tool, provider, user } = await setup(db, { credit: 1000 });
    const { impl, calls } = fakeFetch({ body: { answer: 42 } });
    const res = await callPaidTool(db, agentKey, call(tool.slug, "k1"), { fetchImpl: impl, platformFeeBps: 1000 });

    expect(res).toMatchObject({ status: "ok", chargedCents: 100, balanceCents: 900, result: { answer: 42 } });
    expect(calls).toHaveLength(1);
    expect(await balance(db, user.walletAccountId)).toBe(900);
    expect(await balance(db, provider.accountId)).toBe(90);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("only lets one of two parallel calls through when the balance covers one", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 100 });
    const { impl, calls } = fakeFetch({ delayMs: 50 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => callPaidTool(db, agentKey, call(tool.slug, `race-${i}`), { fetchImpl: impl })),
    );

    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === "ok");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect((r as PromiseRejectedResult).reason.code).toBe("insufficient_funds");
    expect(calls).toHaveLength(1);
    expect(await balance(db, user.walletAccountId)).toBe(0);
  });

  it("returns the stored result on retry with the same idempotency key, without charging again", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000 });
    const { impl, calls } = fakeFetch({ body: { v: 1 } });
    const first = await callPaidTool(db, agentKey, call(tool.slug, "same"), { fetchImpl: impl });
    const second = await callPaidTool(db, agentKey, call(tool.slug, "same"), { fetchImpl: impl });

    expect(first.status).toBe("ok");
    expect(second).toMatchObject({ status: "ok", replayed: true, result: { v: 1 }, chargedCents: 100 });
    expect(calls).toHaveLength(1);
    expect(await balance(db, user.walletAccountId)).toBe(900);
  });

  it("charges once when the same idempotency key arrives twice at the same time", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000 });
    const { impl, calls } = fakeFetch({ delayMs: 50 });
    const results = await Promise.allSettled([
      callPaidTool(db, agentKey, call(tool.slug, "dup"), { fetchImpl: impl }),
      callPaidTool(db, agentKey, call(tool.slug, "dup"), { fetchImpl: impl }),
    ]);
    expect(calls).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.status === "ok")).toHaveLength(1);
    expect(await balance(db, user.walletAccountId)).toBe(900);
  });

  it("leaves the balance unchanged when the provider fails", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000 });
    const res = await callPaidTool(db, agentKey, call(tool.slug, "fail-500"), { fetchImpl: fakeFetch({ status: 500 }).impl });
    expect(res).toMatchObject({ status: "failed", chargedCents: 0, balanceCents: 1000 });

    const thrown = await callPaidTool(db, agentKey, call(tool.slug, "fail-net"), {
      fetchImpl: fakeFetch({ throws: new Error("ECONNREFUSED") }).impl,
    });
    expect(thrown).toMatchObject({ status: "failed", error: "ECONNREFUSED" });
    expect(await balance(db, user.walletAccountId)).toBe(1000);
    expect(await balance(db, await systemAccount(db, "holds"))).toBe(0);
  });

  it("charges only the units the provider reports for per-unit tools", async () => {
    const { agentKey, tool, user, provider } = await setup(db, {
      credit: 1000,
      tool: { pricingType: "per_unit", priceCents: 10, unitsField: "pages", maxUnits: 50 },
    });
    const res = await callPaidTool(db, agentKey, call(tool.slug, "units", { pages: 20 }), {
      fetchImpl: fakeFetch({ units: 7 }).impl,
      platformFeeBps: 0,
    });
    expect(res).toMatchObject({ status: "ok", chargedCents: 70 });
    expect(await balance(db, user.walletAccountId)).toBe(930);
    expect(await balance(db, provider.accountId)).toBe(70);
  });

  it("never charges more than was held even if the provider over-reports units", async () => {
    const { agentKey, tool, user } = await setup(db, {
      credit: 1000,
      tool: { pricingType: "per_unit", priceCents: 10, unitsField: "pages" },
    });
    const res = await callPaidTool(db, agentKey, call(tool.slug, "over", { pages: 5 }), { fetchImpl: fakeFetch({ units: 999 }).impl });
    expect(res).toMatchObject({ status: "ok", chargedCents: 50 });
    expect(await balance(db, user.walletAccountId)).toBe(950);
  });
});

describe("budgets", () => {
  it("enforces the per-call maximum", async () => {
    const { agentKey, tool } = await setup(db, { credit: 1000, limits: { perCallMaxCents: 50 } });
    await expect(callPaidTool(db, agentKey, call(tool.slug, "big"), { fetchImpl: fakeFetch().impl })).rejects.toMatchObject({
      code: "per_call_max_exceeded",
    });
  });

  it("enforces the daily cap, counting completed calls", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000, limits: { dailyCapCents: 250 } });
    const { impl } = fakeFetch();
    await callPaidTool(db, agentKey, call(tool.slug, "d1"), { fetchImpl: impl });
    await callPaidTool(db, agentKey, call(tool.slug, "d2"), { fetchImpl: impl });
    await expect(callPaidTool(db, agentKey, call(tool.slug, "d3"), { fetchImpl: impl })).rejects.toMatchObject({ code: "daily_cap_exceeded" });
    expect(await balance(db, user.walletAccountId)).toBe(800);
  });

  it("does not count failed calls toward the cap", async () => {
    const { agentKey, tool } = await setup(db, { credit: 1000, limits: { dailyCapCents: 100 } });
    await callPaidTool(db, agentKey, call(tool.slug, "f1"), { fetchImpl: fakeFetch({ status: 503 }).impl });
    const res = await callPaidTool(db, agentKey, call(tool.slug, "f2"), { fetchImpl: fakeFetch().impl });
    expect(res.status).toBe("ok");
  });

  it("blocks tools outside the allowlist", async () => {
    const { agentKey, tool } = await setup(db, { credit: 1000, limits: { allowedToolSlugs: ["something-else"] } });
    await expect(callPaidTool(db, agentKey, call(tool.slug, "x"), { fetchImpl: fakeFetch().impl })).rejects.toMatchObject({
      code: "tool_not_allowed",
    });
  });
});

describe("approvals", () => {
  it("asks for approval above the threshold and runs once approved", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000, limits: { approvalThresholdCents: 50 } });
    const { impl, calls } = fakeFetch();

    const pending = await callPaidTool(db, agentKey, call(tool.slug, "a1"), { fetchImpl: impl });
    expect(pending.status).toBe("pending_approval");
    expect(calls).toHaveLength(0);
    const approvalId = (pending as { approvalId: string }).approvalId;

    await expect(callPaidTool(db, agentKey, call(tool.slug, "a1", {}, approvalId), { fetchImpl: impl })).rejects.toMatchObject({
      code: "approval_invalid",
    });

    await approve(db, user.id, approvalId, undefined, { requirePasskey: false });
    const ok = await callPaidTool(db, agentKey, call(tool.slug, "a1", {}, approvalId), { fetchImpl: impl });
    expect(ok.status).toBe("ok");

    // An approval is single-use.
    await expect(callPaidTool(db, agentKey, call(tool.slug, "a2", {}, approvalId), { fetchImpl: impl })).rejects.toMatchObject({
      code: "approval_invalid",
    });
  });

  it("does not let one owner approve another owner's request", async () => {
    const a = await setup(db, { credit: 1000, limits: { approvalThresholdCents: 50 } });
    const b = await setup(db);
    const pending = await callPaidTool(db, a.agentKey, call(a.tool.slug, "x"), { fetchImpl: fakeFetch().impl });
    await expect(approve(db, b.user.id, (pending as { approvalId: string }).approvalId, undefined, { requirePasskey: false })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("hold sweeper", () => {
  it("returns money from holds that expired without settling", async () => {
    const { agentKey, tool, user } = await setup(db, { credit: 1000 });
    const key = (await agentKeyById(db, agentKey.id))!;
    // Simulate a crash mid-call: a hold exists but nothing settles it.
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const fetchImpl = (async () => {
      await stuck;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const inflight = callPaidTool(db, key, call(tool.slug, "stuck"), { fetchImpl });
    await new Promise((r) => setTimeout(r, 100));
    expect(await balance(db, user.walletAccountId)).toBe(900);

    await db.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE status = 'held' AND agent_key_id = $1", [agentKey.id]);
    expect(await sweepExpiredHolds(db)).toBe(1);
    expect(await balance(db, user.walletAccountId)).toBe(1000);

    // The late provider response must not charge a hold that was already released.
    release();
    await inflight;
    expect(await balance(db, user.walletAccountId)).toBe(1000);
    expect(await ledgerTotal(db)).toBe(0);
  });
});
