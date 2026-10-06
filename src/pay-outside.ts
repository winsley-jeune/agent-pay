import { randomUUID } from "node:crypto";
import type { AgentKey } from "./auth.js";
import { createCallApproval } from "./approvals.js";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { decideCall, frozenAt, frozenError } from "./controls.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { captureHold, checkToolAllowed, holdByKey, placeHold, releaseHold, replay, type CallResult } from "./gateway.js";
import { balance } from "./ledger.js";
import { safeFetch, type OutboundOptions } from "./outbound.js";
import { refusalError, screen } from "./policy.js";
import type { Tool } from "./registry.js";
import { atomicToCents, configuredNetwork, parsePaymentRequired, parseSettlement, pickRequirement, signPayment, type PaymentRequired, type Requirement } from "./x402.js";

// Paying agents and APIs outside AgentPay: x402 over HTTP, and A2A agents with
// the x402 payments extension. Every payment goes through the owner's controls
// exactly like a marketplace call (kill switch, allow-list, level and rules,
// envelopes, per-call maximum, caps, approvals, the why log), then AgentPay's
// own USDC wallet signs the authorization and the owner's credits are charged.
//
// Once a signed authorization has been sent, the seller can settle it, so the
// hold is released only when the seller explicitly refuses the payment.

/** The allow-list and rules name outside payments by protocol: "x402" or "a2a". */
function pseudoTool(protocol: "x402" | "a2a"): Tool {
  return {
    id: null as unknown as string, providerId: "", providerName: protocol === "x402" ? "x402 seller" : "A2A agent", slug: protocol,
    name: protocol === "x402" ? "x402 payment" : "A2A agent payment", description: "", inputSchema: {}, pricingType: "per_call", priceCents: 0,
    mode: "sync", maxJobSeconds: null, unitsField: null, maxUnits: null, upstreamUrl: "", upstreamAuth: null, active: true,
  };
}

export interface OutsidePayment {
  protocol: "x402" | "a2a";
  target: string;
  host: string;
  requirement: Requirement;
  idempotencyKey: string;
  approvalId?: string;
  maxCents: number;
  reason?: string;
  instruction?: string;
}

export type SettleOutcome =
  | { outcome: "paid"; result: unknown; receipt: unknown }
  | { outcome: "refused"; error: string }
  /** The authorization was sent but the seller's answer is unclear: it may have settled, so the owner is charged and it's logged. */
  | { outcome: "unclear"; result: unknown; error: string };

/**
 * Run the owner's controls, hold the credits, call `settle` (which signs and
 * sends the authorization), then charge or release. Returns a CallResult.
 */
export async function payOutside(db: Db, agentKey: AgentKey, p: OutsidePayment, settle: () => Promise<SettleOutcome>): Promise<CallResult & { priceCents?: number }> {
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const network = configuredNetwork();
  if (agentKey.test && !network.testnet) throw new AppError(403, "test_key_mainnet", "test keys can only pay outside sellers on a test network (X402_NETWORK=base-sepolia)");
  const tool = pseudoTool(p.protocol);
  checkToolAllowed(agentKey, tool);

  const existing = await holdByKey(db, agentKey.id, p.idempotencyKey);
  if (existing) return replay(db, existing, null);

  const amountCents = atomicToCents(p.requirement.amountAtomic);
  if (amountCents > p.maxCents) {
    throw new AppError(402, "over_max", `the seller asks ${amountCents}c, more than the ${p.maxCents}c you allowed for this payment`, { priceCents: amountCents });
  }
  if (amountCents > config.x402MaxCents) {
    throw new AppError(402, "over_server_max", `the seller asks ${amountCents}c; this server pays at most ${config.x402MaxCents}c per outside payment`, { priceCents: amountCents });
  }
  if (agentKey.perCallMaxCents !== null && amountCents > agentKey.perCallMaxCents) {
    throw new AppError(402, "per_call_max_exceeded", "this payment costs more than the agent's per-call limit", { amountCents, perCallMaxCents: agentKey.perCallMaxCents });
  }

  const input = { protocol: p.protocol, host: p.host, target: p.target, payTo: p.requirement.payTo, network: p.requirement.network, amountAtomic: p.requirement.amountAtomic.toString() };
  let decision: Parameters<typeof placeHold>[6];
  if (p.approvalId) {
    decision = { kind: "approved", reason: "approved by the owner with a passkey", envelopeId: null };
  } else {
    const d = await decideCall(db, agentKey, tool, amountCents);
    if (d.outcome === "approve") {
      const approvalId = await createCallApproval(db, agentKey, tool, amountCents, input, { why: d.reason, agentReason: p.reason });
      await log(db, agentKey, p, "call_needs_approval", `Asked the owner to approve $${(amountCents / 100).toFixed(2)} to ${p.host} (${p.protocol})`, d.reason, { approvalId });
      return {
        status: "pending_approval", approvalId, amountCents, approveUrl: `${config.publicUrl}/#approvals`, why: d.reason,
        message: `Paying ${p.host} ${amountCents}c needs the owner's approval (${d.reason}). Ask them, then retry with the same idempotency key and approvalId "${approvalId}".`,
      };
    }
    decision = { kind: d.outcome, reason: d.reason, envelopeId: d.envelopeId };
  }

  const hold = await placeHold(db, agentKey, tool, amountCents, { tool: p.protocol, input, idempotencyKey: p.idempotencyKey, approvalId: p.approvalId, reason: p.reason }, null, decision, {
    ttlSeconds: config.holdTtlSeconds, async: false, jobTokenHash: null, quoteId: null, external: { protocol: p.protocol, target: p.target },
  });

  let outcome: SettleOutcome;
  try {
    outcome = await settle();
  } catch (err) {
    // Failed before or while sending: if signing or the network failed, the authorization may not have left. Treat transport errors as unclear.
    const message = String((err as Error).message ?? err);
    outcome = (err as { beforeSend?: boolean }).beforeSend ? { outcome: "refused", error: message } : { outcome: "unclear", result: null, error: message };
  }

  if (outcome.outcome === "refused") {
    await releaseHold(db, hold.id, `seller refused the payment: ${outcome.error}`);
    await log(db, agentKey, p, "call_failed", `Payment to ${p.host} (${p.protocol}) refused; not charged`, outcome.error, { callId: hold.id });
    return { status: "failed", callId: hold.id, chargedCents: 0, balanceCents: await balance(db, agentKey.walletAccountId), error: outcome.error, replayed: false };
  }
  const result = outcome.outcome === "paid" ? { response: outcome.result, receipt: outcome.receipt } : { response: outcome.result, unclear: outcome.error };
  await captureHold(db, hold.id, amountCents, result);
  if (outcome.outcome === "paid") await db.query("UPDATE holds SET external_receipt = $2 WHERE id = $1", [hold.id, JSON.stringify(outcome.receipt ?? null)]);
  await log(
    db, agentKey, p, "call_paid", `Paid $${(amountCents / 100).toFixed(2)} to ${p.host} (${p.protocol}) in USDC`,
    outcome.outcome === "unclear" ? `the seller's answer was unclear (${outcome.error}); charged because it may have settled` : null,
    { callId: hold.id, receipt: outcome.outcome === "paid" ? outcome.receipt : null },
  );
  return { status: "ok", callId: hold.id, chargedCents: amountCents, balanceCents: await balance(db, agentKey.walletAccountId), result, replayed: false };
}

async function log(db: Db, agentKey: AgentKey, p: OutsidePayment, kind: string, summary: string, result: string | null, data: Record<string, unknown>) {
  await audit(db, agentKey.userId, {
    actor: "agent", agentKeyId: agentKey.id, kind, summary: agentKey.test ? `[test] ${summary}` : summary,
    instruction: p.instruction, reason: p.reason, result, data: { ...data, protocol: p.protocol, target: p.target, ...(agentKey.test ? { test: true } : {}) },
  }).catch((err) => console.error("audit log write failed", err));
}

/** Refuse what agents must never buy, from the seller's own description. */
function screenRequirement(pr: PaymentRequired, req: Requirement) {
  const r = screen(req.description) ?? screen(JSON.stringify(pr.resource ?? "")) ?? screen(pr.error);
  if (r) throw refusalError(r);
}

const host = (u: string) => new URL(u).hostname;
const beforeSend = (message: string) => Object.assign(new Error(message), { beforeSend: true });

// ---------------------------------------------------------------- x402 over HTTP

export interface X402Request {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  maxCents: number;
  idempotencyKey?: string;
  approvalId?: string;
  reason?: string;
  instruction?: string;
}

/**
 * Fetch an x402 resource, paying if it asks. A resource that doesn't answer
 * 402 is returned as is, at no charge.
 */
export async function payX402(db: Db, agentKey: AgentKey, r: X402Request, opts: OutboundOptions = {}) {
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const outbound = { allowLocalHttp: config.allowLocalHttpOutbound, ...opts };
  const idempotencyKey = r.idempotencyKey ?? randomUUID();
  const existing = await holdByKey(db, agentKey.id, idempotencyKey);
  if (existing) return replay(db, existing, null);

  const init: RequestInit = {
    method: r.method ?? "GET",
    headers: { accept: "application/json", ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
  };
  const first = await safeFetch(r.url, init, outbound);
  if (first.status !== 402) return { status: "free" as const, httpStatus: first.status, result: first.json ?? first.text.slice(0, 20_000), chargedCents: 0 };

  const pr = parsePaymentRequired({ header: first.headers.get("payment-required"), body: first.json });
  if (!pr) throw new AppError(502, "x402_invalid", "the address answered 402 but didn't say what it accepts");
  const req = pickRequirement(pr);
  screenRequirement(pr, req);

  return payOutside(db, agentKey, { protocol: "x402", target: first.url, host: host(first.url), requirement: req, idempotencyKey, approvalId: r.approvalId, maxCents: r.maxCents, reason: r.reason, instruction: r.instruction }, async () => {
    let signed;
    try {
      signed = await signPayment(req, pr.version);
    } catch (err) {
      throw beforeSend(String((err as Error).message));
    }
    const header = pr.version === 2 ? "payment-signature" : "x-payment";
    const paid = await safeFetch(first.url, { ...init, headers: { ...(init.headers as Record<string, string>), [header]: signed.header } }, outbound);
    const settlement = parseSettlement(paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response"));
    if (paid.status >= 200 && paid.status < 300) return { outcome: "paid", result: paid.json ?? paid.text.slice(0, 20_000), receipt: settlement };
    if (paid.status === 402 || settlement?.success === false) {
      return { outcome: "refused", error: settlement?.errorReason ?? parsePaymentRequired({ header: paid.headers.get("payment-required"), body: paid.json })?.error ?? "payment refused" };
    }
    return { outcome: "unclear", result: paid.json ?? paid.text.slice(0, 2000), error: `HTTP ${paid.status} after the payment was sent` };
  });
}

// ---------------------------------------------------------------- A2A agents

const A2A_X402_EXTENSION = "https://github.com/google-a2a/a2a-x402/v0.1";

export interface AgentCard {
  name: string;
  description: string | null;
  url: string;
  skills: { id?: string; name?: string; description?: string }[];
  acceptsX402: boolean;
}

/** Fetch an A2A agent's card (/.well-known/agent-card.json, or the older agent.json). */
export async function discoverAgent(agentUrl: string, opts: OutboundOptions = {}): Promise<AgentCard> {
  const outbound = { allowLocalHttp: config.allowLocalHttpOutbound, ...opts };
  const base = new URL(agentUrl);
  let card: any = null;
  for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    const res = await safeFetch(new URL(path, base).toString(), { headers: { accept: "application/json" } }, outbound).catch(() => null);
    if (res?.status === 200 && res.json && typeof res.json === "object") {
      card = res.json;
      break;
    }
  }
  if (!card || typeof card.url !== "string") throw new AppError(502, "a2a_no_card", "couldn't find an A2A agent card at that address");
  const text = [card.name, card.description, ...(card.skills ?? []).flatMap((s: any) => [s?.name, s?.description])].filter(Boolean).join(" ");
  const refused = screen(text);
  if (refused) throw refusalError(refused);
  const extensions: any[] = card.capabilities?.extensions ?? [];
  return {
    name: String(card.name ?? "A2A agent"), description: typeof card.description === "string" ? card.description : null, url: card.url,
    skills: (card.skills ?? []).slice(0, 50).map((s: any) => ({ id: s?.id, name: s?.name, description: s?.description })),
    acceptsX402: extensions.some((e) => typeof e?.uri === "string" && e.uri.includes("a2a-x402")),
  };
}

async function rpc(endpoint: string, method: string, params: unknown, opts: OutboundOptions) {
  const res = await safeFetch(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-a2a-extensions": A2A_X402_EXTENSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    },
    { allowLocalHttp: config.allowLocalHttpOutbound, ...opts },
  );
  const body = res.json as { result?: any; error?: { message?: string } } | null;
  if (!body) throw new AppError(502, "a2a_error", `the agent answered HTTP ${res.status} without JSON-RPC`);
  if (body.error) throw new AppError(502, "a2a_error", `the agent returned an error: ${body.error.message ?? "unknown"}`);
  return body.result;
}

/** A short, readable view of an A2A task or message. */
function snapshot(result: any) {
  const textOf = (parts: any[] | undefined) => (parts ?? []).filter((p) => p?.kind === "text" || typeof p?.text === "string").map((p) => p.text).join("\n");
  if (result?.kind === "message") return { kind: "message", text: textOf(result.parts).slice(0, 20_000) };
  const meta = result?.status?.message?.metadata ?? {};
  return {
    kind: "task", taskId: result?.id, contextId: result?.contextId, state: result?.status?.state,
    text: textOf(result?.status?.message?.parts).slice(0, 20_000),
    artifacts: (result?.artifacts ?? []).map((a: any) => ({ name: a?.name, text: textOf(a?.parts).slice(0, 20_000) })),
    sellerPaymentStatus: meta["x402.payment.status"] ? { status: meta["x402.payment.status"], receipts: meta["x402.payment.receipts"] ?? [] } : undefined,
  };
}

export interface A2ASend {
  agentUrl: string;
  text: string;
  taskId?: string;
  contextId?: string;
  maxCents: number;
  idempotencyKey?: string;
  approvalId?: string;
  reason?: string;
  instruction?: string;
}

/**
 * Send a message to an A2A agent. If it answers that payment is required
 * (x402 extension), pay within the owner's controls and send the signed
 * authorization; the agent's next answer is returned.
 */
export async function a2aSend(db: Db, agentKey: AgentKey, m: A2ASend, opts: OutboundOptions = {}) {
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const idempotencyKey = m.idempotencyKey ?? randomUUID();
  const existing = await holdByKey(db, agentKey.id, idempotencyKey);
  if (existing) return { payment: await replay(db, existing, null) };
  const refusedText = screen(m.text);
  if (refusedText) throw refusalError(refusedText);

  const card = await discoverAgent(m.agentUrl, opts);
  const first = await rpc(card.url, "message/send", {
    message: { kind: "message", role: "user", messageId: randomUUID(), parts: [{ kind: "text", text: m.text }], ...(m.taskId ? { taskId: m.taskId } : {}), ...(m.contextId ? { contextId: m.contextId } : {}) },
  }, opts);
  const meta = first?.status?.message?.metadata ?? {};
  if (!(first?.kind === "task" && first.status?.state === "input-required" && meta["x402.payment.status"] === "payment-required")) {
    return { agent: card.name, chargedCents: 0, ...snapshot(first) };
  }

  const pr = parsePaymentRequired({ body: meta["x402.payment.required"] });
  if (!pr) throw new AppError(502, "x402_invalid", "the agent asked for payment but didn't say what it accepts");
  const req = pickRequirement(pr);
  screenRequirement(pr, req);
  let after: any = null;
  const payment = await payOutside(
    db, agentKey,
    { protocol: "a2a", target: card.url, host: host(card.url), requirement: req, idempotencyKey, approvalId: m.approvalId, maxCents: m.maxCents, reason: m.reason, instruction: m.instruction },
    async () => {
      let signed;
      try {
        signed = await signPayment(req, pr.version);
      } catch (err) {
        throw beforeSend(String((err as Error).message));
      }
      after = await rpc(card.url, "message/send", {
        message: {
          kind: "message", role: "user", messageId: randomUUID(), taskId: first.id, ...(first.contextId ? { contextId: first.contextId } : {}),
          parts: [{ kind: "text", text: "Payment authorization attached." }],
          metadata: { "x402.payment.status": "payment-submitted", "x402.payment.payload": signed.payload },
        },
      }, opts);
      const status = after?.status?.message?.metadata?.["x402.payment.status"];
      const receipts = after?.status?.message?.metadata?.["x402.payment.receipts"] ?? [];
      if (status === "payment-failed" || status === "payment-rejected") {
        return { outcome: "refused", error: receipts.at?.(-1)?.errorReason ?? after?.status?.message?.metadata?.["x402.payment.error"] ?? status };
      }
      return { outcome: "paid", result: snapshot(after), receipt: receipts.at?.(-1) ?? null };
    },
  );
  return { agent: card.name, payment, ...(after ? snapshot(after) : { ...snapshot(first), priceCents: atomicToCents(req.amountAtomic) }) };
}

/** Check on an A2A task (no payment). */
export async function a2aGetTask(agentUrl: string, taskId: string, opts: OutboundOptions = {}) {
  const card = await discoverAgent(agentUrl, opts);
  return { agent: card.name, ...snapshot(await rpc(card.url, "tasks/get", { id: taskId }, opts)) };
}
