import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKeyById } from "../src/auth.js";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import { dryRun, parsePolicy, simulate } from "../src/policy-language.js";
import { fakeFetch, freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const tools = [{ slug: "weather-now", name: "Current weather" }, { slug: "web-search", name: "Web search" }];

describe("plain-English rules", () => {
  it("turns a sentence into levels, rules and limits", () => {
    const p = parsePolicy("Payments under $5 go through on their own. Over $50 ask me; $200 a day, and never pay more than $100 for one payment. Flag anything over $20.", tools);
    expect(p.notUnderstood).toEqual([]);
    expect(p.limits).toMatchObject({
      level: "rules",
      spendRules: [{ tools: null, maxCents: 500, outcome: "auto" }],
      approvalThresholdCents: 5000,
      dailyCapCents: 20000,
      perCallMaxCents: 10000,
      observeAboveCents: 2000,
    });
    expect(p.understood.map((u) => u.meaning)).toContain("Ask me for anything over $50.00");
  });

  it("understands tool-specific rules, tool allow-lists, monthly budgets and 'always ask'", () => {
    const p = parsePolicy("Web search is fine up to 10 cents\nonly use web search and current weather\n$30 a month", tools);
    expect(p.limits).toMatchObject({ level: "rules", spendRules: [{ tools: ["web-search"], maxCents: 10 }], monthlyCapCents: 3000 });
    expect([...p.limits.allowedToolSlugs!].sort()).toEqual(["weather-now", "web-search"]);
    expect(parsePolicy("Always ask me first.").limits.level).toBe("ask");
  });

  it("lists what it didn't understand instead of guessing", () => {
    const p = parsePolicy("Under $5 is fine. Don't buy anything my wife wouldn't like.", tools);
    expect(p.notUnderstood).toEqual(["Don't buy anything my wife wouldn't like"]);
  });

  it("simulates caps in order, counting only what would have been paid", () => {
    const limits = parsePolicy("under $5 is fine. $6 a day").limits;
    const day = new Date("2026-10-01T10:00:00Z").getTime();
    const r = simulate(limits, [
      { at: new Date(day), tool: "x", amountCents: 400 },
      { at: new Date(day + 1000), tool: "x", amountCents: 300 },
      { at: new Date(day + 2000), tool: "x", amountCents: 700 },
      { at: new Date(day + 3000), tool: "x", amountCents: 100 },
    ]);
    // 400 + 300 is over $6 in a day; 700 is over it on its own; 100 still fits.
    expect(r.map((x) => x.outcome)).toEqual(["auto", "blocked", "blocked", "auto"]);
  });

  it("dry-runs the agent's real last 30 days over HTTP-free data", async () => {
    const s = await setup(db, { credit: 2000, tool: { priceCents: 300 } });
    for (let i = 0; i < 3; i++) await callPaidTool(db, s.agentKey, { tool: s.tool.slug, input: {}, idempotencyKey: `d-${i}` }, { fetchImpl: fakeFetch().impl });
    const key = (await agentKeyById(db, s.agentKey.id))!;
    const run = await dryRun(db, key, parsePolicy("under $2 go through on their own").limits);
    expect(run).toMatchObject({ payments: 3, wouldPayOnItsOwn: 0, wouldAsk: 3, spentOnItsOwnCents: 0 });
    expect(run.changed[0]).toMatchObject({ before: "auto", after: "ask", why: "no rule covers it" });
  });
});
