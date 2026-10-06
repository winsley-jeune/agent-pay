import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approve } from "../src/approvals.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";
import { balance } from "../src/ledger.js";
import { chatCompletion, estimatePromptTokens } from "../src/llm-gateway.js";
import { createApp } from "../src/server.js";
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
const saved = { ...config };
afterEach(() => Object.assign(config, saved));

function configure() {
  Object.assign(config, {
    llmUpstreamUrl: "https://llm.example/v1", llmUpstreamKey: "sk-upstream",
    // 100c per million in, 400c per million out: 10k in + 1k out = 1c + 0.4c → 2c
    llmModels: JSON.stringify({ "small-model": { inCentsPerMillion: 100_000, outCentsPerMillion: 400_000 } }),
    llmProfiles: JSON.stringify({ eco: "small-model", auto: "small-model" }),
  });
}

/** A pretend OpenAI-compatible provider reporting the given usage. */
function upstream(usage = { prompt_tokens: 20, completion_tokens: 10 }) {
  const seen: { url: string; headers: any; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
    return Response.json({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }], usage });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const messages = [{ role: "user", content: "Say hi" }];

describe("OpenAI-compatible gateway", () => {
  it("holds the most a call can cost, charges the actual usage, and never shows the agent the provider key", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const up = upstream();
    const r = await chatCompletion(db, s.agentKey, { body: { model: "agentpay/eco", messages, max_tokens: 100 } }, up.impl);
    // In: estimate ~ 31 tokens; out: 100 max → hold ceil(31*0.1 + 100*0.4) = 44c. Actual: 20*0.1 + 10*0.4 = 6c.
    expect(r.heldCents).toBe(Math.ceil((estimatePromptTokens(messages) * 100_000 + 100 * 400_000) / 1_000_000));
    expect(r.chargedCents).toBe(6);
    expect(r.body.choices[0].message.content).toBe("Hi!");
    expect(up.seen[0]).toMatchObject({ url: "https://llm.example/v1/chat/completions", headers: { authorization: "Bearer sk-upstream" }, body: { model: "small-model", max_completion_tokens: 100, stream: false } });
    expect(await balance(db, s.user.walletAccountId)).toBe(994);
    expect(await ledgerTotal(db)).toBe(0);
  });

  it("stops a conversation before it crosses its cap", async () => {
    configure();
    const s = await setup(db, { credit: 1000 });
    const up = upstream();
    const conv = { conversationId: "c-1", conversationMaxCents: 60 };
    await chatCompletion(db, s.agentKey, { body: { model: "small-model", messages, max_tokens: 100 }, ...conv }, up.impl); // 6c spent
    await expect(chatCompletion(db, s.agentKey, { body: { model: "small-model", messages, max_tokens: 200 }, ...conv }, up.impl)).rejects.toMatchObject({
      code: "conversation_cap", details: { spentCents: 6, capCents: 60 },
    });
    expect(up.seen).toHaveLength(1); // the second call never reached the provider
  });

  it("follows the agent's level and allow-list, and speaks OpenAI over HTTP", async () => {
    configure();
    const s = await setup(db, { credit: 1000, limits: { level: "ask" } });
    const up = upstream();
    const pending = await chatCompletion(db, s.agentKey, { body: { model: "small-model", messages } }, up.impl).catch((e) => e);
    expect(pending).toMatchObject({ code: "approval_required", status: 402 });
    await approve(db, s.user.id, pending.details.approvalId, undefined, { requirePasskey: false });
    expect((await chatCompletion(db, s.agentKey, { body: { model: "small-model", messages }, approvalId: pending.details.approvalId }, up.impl)).chargedCents).toBe(6);

    const limited = await setup(db, { credit: 1000, limits: { allowedToolSlugs: ["something-else"] } });
    await expect(chatCompletion(db, limited.agentKey, { body: { model: "small-model", messages } }, up.impl)).rejects.toMatchObject({ code: "tool_not_allowed" });

    // Over HTTP, errors come back in OpenAI's shape.
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${s.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "nope", messages }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ type: "unknown_model", message: expect.stringMatching(/isn't offered here/) });
    const list = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${s.key}` } })).json();
    expect(list.data.map((m: { id: string }) => m.id)).toEqual(["small-model", "agentpay/eco", "agentpay/auto"]);
  });
});
