import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalStatusForAgent, approve, completeDelayedApprovals, deny, listApprovals } from "../src/approvals.js";
import { createUser } from "../src/auth.js";
import { listEnvelopes, requestEnvelope } from "../src/controls.js";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import {
  acceptInvite,
  alertsFor,
  applyDueChanges,
  cancelChange,
  getProtection,
  inviteHelper,
  leave,
  listHelpers,
  listHelping,
  removeHelper,
  setProtection,
} from "../src/helpers.js";
import { balance } from "../src/ledger.js";
import { createApp } from "../src/server.js";
import { fakeFetch, freshDb, setup } from "./helpers.js";

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

const ok = { requirePasskey: false };
let n = 0;

/** An owner with credit and an agent, plus a helper who accepted an invitation. */
async function family(opts: { protect?: boolean; credit?: number } = {}) {
  const owner = await setup(db, { credit: opts.credit ?? 10_000 });
  const helper = await createUser(db, `helper${++n}-${Date.now()}@example.com`);
  const invite = await inviteHelper(db, owner.user.id, "Maria (daughter)");
  await acceptInvite(db, helper.user.id, invite.code);
  if (opts.protect) await setProtection(db, owner.user.id, { enabled: true, cosignThresholdCents: 5000, cosignDelayHours: 72 });
  return { ...owner, helper: helper.user, helperToken: helper.token };
}

async function http(method: string, path: string, token: string, opts: { account?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.account ? { "x-agentpay-account": opts.account } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("trusted helpers", () => {
  it("invites with a one-time code and lists both sides", async () => {
    const f = await family();
    expect((await listHelpers(db, f.user.id))[0]).toMatchObject({ label: "Maria (daughter)", status: "active", email: f.helper.email });
    expect((await listHelping(db, f.helper.id))[0]).toMatchObject({ ownerId: f.user.id, youAre: "Maria (daughter)" });

    const again = await inviteHelper(db, f.user.id, "Sam");
    await acceptInvite(db, f.helper.id, again.code).catch(() => {}); // already helping
    await expect(acceptInvite(db, f.user.id, again.code)).rejects.toMatchObject({ code: "own_account" });
    await expect(acceptInvite(db, f.helper.id, "ap_invite_wrong-code-123")).rejects.toMatchObject({ code: "invite_invalid" });
  });

  it("lets a helper see and freeze the account over HTTP, and nothing else", async () => {
    const f = await family();
    const as = { account: f.user.id };
    const board = await http("GET", "/api/controls/board", f.helperToken, as);
    expect(board.status).toBe(200);
    expect(board.body.agents[0].name).toBe("test agent");
    expect((await http("GET", "/api/me", f.helperToken, as)).body).toMatchObject({ user: { id: f.user.id }, actingAs: "helper", signer: { id: f.helper.id } });

    for (const [method, path, body] of [
      ["POST", "/api/dev/credit", { amountCents: 100 }],
      ["POST", "/api/agent-keys", { name: "sneaky" }],
      ["POST", "/api/controls/envelopes", { name: "x", amountCents: 100, days: 1 }],
      ["POST", "/api/controls/vault/unlock", { amountCents: 100 }],
      ["DELETE", `/api/agent-keys/${f.agentKey.id}`, undefined],
      ["POST", "/api/family/protection", { enabled: false }],
    ] as const) {
      expect((await http(method, path, f.helperToken, { ...as, body })).status, `${method} ${path}`).toBe(403);
    }
    // Not a helper on someone else's account.
    const stranger = await createUser(db, `stranger${++n}@example.com`);
    expect((await http("GET", "/api/controls/board", stranger.token, as)).status).toBe(403);

    expect((await http("POST", "/api/controls/freeze", f.helperToken, { ...as, body: {} })).status).toBe(200);
    await expect(callPaidTool(db, f.agentKey, { tool: f.tool.slug, input: {}, idempotencyKey: "after-freeze" }, { fetchImpl: fakeFetch().impl })).rejects.toMatchObject({
      code: "frozen",
    });
    const { alerts } = await alertsFor(db, f.helper.id, f.user.id);
    expect(alerts.some((a: { kind: string; summary: string }) => a.kind === "freeze" && a.summary === "Maria (daughter) froze all agent activity")).toBe(true);
  });

  it("can always step back, and the owner removes an unprotected helper at once", async () => {
    const f = await family();
    await leave(db, f.helper.id, f.user.id);
    expect(await listHelping(db, f.helper.id)).toEqual([]);
    const g = await family();
    const [h] = await listHelpers(db, g.user.id);
    expect(await removeHelper(db, g.user.id, h.id)).toEqual({ removed: true });
  });
});

describe("protected accounts", () => {
  it("needs the owner plus a helper for big approvals; small ones are unchanged", async () => {
    const f = await family({ protect: true });
    const small = await requestEnvelope(db, f.user.id, { name: "Small", amountCents: 100, days: 7, toolSlugs: ["some-other-tool"] });
    // Envelopes always need a second signature on a protected account; a helper can't approve alone.
    const helperFirst = await approve(db, f.helper.id, small.approvalId, undefined, ok);
    expect(helperFirst).toMatchObject({ status: "pending", waitingFor: "owner" });
    expect(await balance(db, f.user.walletAccountId)).toBe(10_000);
    const done = await approve(db, f.user.id, small.approvalId, undefined, ok);
    expect(done.status).toBe("used");
    expect(await balance(db, f.user.walletAccountId)).toBe(9_900);

    // A paid call under the threshold that needs approval: the owner alone, as before.
    await db.query("UPDATE agent_keys SET level = 'ask' WHERE id = $1", [f.agentKey.id]);
    const key = { ...f.agentKey, level: "ask" as const };
    const call = await callPaidTool(db, key, { tool: f.tool.slug, input: {}, idempotencyKey: "small-call" }, { fetchImpl: fakeFetch().impl });
    expect(call.status).toBe("pending_approval");
    const approvalId = (call as { approvalId: string }).approvalId;
    await expect(approve(db, f.helper.id, approvalId, undefined, ok)).rejects.toMatchObject({ code: "owner_only" });
    expect((await approve(db, f.user.id, approvalId, undefined, ok)).status).toBe("approved");
  });

  it("goes through after the waiting period if no helper objects, and tells the agent to wait", async () => {
    const f = await family({ protect: true });
    const e = await requestEnvelope(db, f.user.id, { name: "Big", amountCents: 6000, days: 7 }, f.agentKey);
    const signed = await approve(db, f.user.id, e.approvalId, undefined, ok);
    expect(signed).toMatchObject({ status: "pending", waitingFor: "helper_or_delay" });
    expect((await approvalStatusForAgent(db, f.agentKey, e.approvalId)).message).toMatch(/don't ask the owner to approve again/);
    expect(await completeDelayedApprovals(db)).toBe(0); // still waiting

    await db.query("UPDATE approvals SET cosign_due_at = now() - interval '1 second' WHERE id = $1", [e.approvalId]);
    expect(await completeDelayedApprovals(db)).toBeGreaterThanOrEqual(1);
    expect((await listEnvelopes(db, f.user.id)).find((x) => x.id === e.envelopeId)?.status).toBe("active");
    const [a] = (await listApprovals(db, f.user.id)).filter((x) => x.id === e.approvalId);
    expect(a.status).toBe("used");
  });

  it("lets a helper object, which declines it", async () => {
    const f = await family({ protect: true });
    const e = await requestEnvelope(db, f.user.id, { name: "Pressure", amountCents: 9000, days: 7 });
    await approve(db, f.user.id, e.approvalId, undefined, ok);
    await deny(db, f.helper.id, e.approvalId);
    await db.query("UPDATE approvals SET cosign_due_at = now() - interval '1 second' WHERE id = $1", [e.approvalId]);
    await completeDelayedApprovals(db);
    expect(await balance(db, f.user.walletAccountId)).toBe(10_000);
    const { alerts } = await alertsFor(db, f.helper.id, f.user.id);
    expect(alerts.some((x: { summary: string }) => x.summary === "Maria (daughter) objected: envelope was declined")).toBe(true);
  });

  it("delays anything that weakens protection, and the owner can cancel it", async () => {
    const f = await family({ protect: true });
    const off = await setProtection(db, f.user.id, { enabled: false });
    expect(off).toMatchObject({ scheduled: true });
    expect((await getProtection(db, f.user.id)).protectedAt).not.toBeNull();
    // Tightening is immediate.
    expect(await setProtection(db, f.user.id, { cosignThresholdCents: 2000 })).toMatchObject({ applied: true });

    const [h] = await listHelpers(db, f.user.id);
    const removal = await removeHelper(db, f.user.id, h.id);
    expect(removal).toMatchObject({ scheduled: true });
    expect((await listHelpers(db, f.user.id))[0].status).toBe("removing");
    await cancelChange(db, f.user.id, (removal as { changeId: string }).changeId);
    expect((await listHelpers(db, f.user.id))[0].status).toBe("active");

    // New keys start at L0; limit changes wait.
    const created = await http("POST", "/api/agent-keys", (await setupToken(f.user.id)), { body: { name: "new one", level: "budget" } });
    expect(created.body.agentKey.level).toBe("ask");
    const patched = await http("PATCH", `/api/agent-keys/${created.body.agentKey.id}`, await setupToken(f.user.id), { body: { level: "budget" } });
    expect(patched.body).toMatchObject({ scheduled: true });

    await db.query("UPDATE account_changes SET effective_at = now() - interval '1 second' WHERE owner_id = $1 AND status = 'scheduled'", [f.user.id]);
    expect(await applyDueChanges(db)).toBe(2);
    expect((await getProtection(db, f.user.id)).protectedAt).toBeNull();
    const { rows } = await db.query("SELECT level FROM agent_keys WHERE id = $1", [created.body.agentKey.id]);
    expect(rows[0].level).toBe("budget");
  });
});

/** setup() doesn't return the owner token, so mint a fresh one for HTTP calls. */
async function setupToken(userId: string) {
  const token = `ap_owner_test_${++n}_${Date.now()}`;
  const { hashToken } = await import("../src/auth.js");
  await db.query("UPDATE users SET token_hash = $2 WHERE id = $1", [userId, hashToken(token)]);
  return token;
}
