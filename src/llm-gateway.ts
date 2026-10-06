import { randomUUID } from "node:crypto";
import type { AgentKey } from "./auth.js";
import { createCallApproval } from "./approvals.js";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { decideCall, frozenAt, frozenError } from "./controls.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { captureHold, checkToolAllowed, placeHold, releaseHold } from "./gateway.js";
import type { Tool } from "./registry.js";

// An OpenAI-compatible endpoint (POST /v1/chat/completions) that bills each
// model call to the agent's wallet, within its level, rules, envelopes and
// caps (ideas from ClawRouter, qntx/openai and Alephant; docs/landscape.md).
// Point any OpenAI client at it: baseURL = <AgentPay>/v1, apiKey = the agent key.
//
//   - The most a call can cost (prompt estimate + max_tokens) is held first;
//     the actual cost from the reply's usage is charged, the rest returned.
//   - X-AgentPay-Conversation + X-AgentPay-Max-Cents cap a whole conversation,
//     and a call that would cross the cap is refused before it's made.
//   - Model names "agentpay/eco", "agentpay/auto" and "agentpay/premium" pick the configured models.
// AgentPay calls the upstream provider with its own key (LLM_UPSTREAM_KEY), so the agent never holds one.

export interface ModelPrice {
  inCentsPerMillion: number;
  outCentsPerMillion: number;
}

export function models(): Record<string, ModelPrice> {
  try {
    return JSON.parse(config.llmModels || "{}");
  } catch {
    throw new AppError(503, "llm_not_configured", "LLM_MODELS isn't valid JSON");
  }
}
export function profiles(): Record<string, string> {
  try {
    return JSON.parse(config.llmProfiles || "{}");
  } catch {
    return {};
  }
}

const LLM_TOOL: Tool = {
  id: null as unknown as string, providerId: "", providerName: "LLM gateway", slug: "llm", name: "AI model calls", description: "", inputSchema: {},
  pricingType: "per_call", priceCents: 0, mode: "sync", maxJobSeconds: null, unitsField: null, maxUnits: null, upstreamUrl: "", upstreamAuth: null, active: true,
};

/** OpenAI-style error body, so clients show it properly. */
export class LlmError extends AppError {
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(status, code, message, details);
  }
}

function costCents(price: ModelPrice, inTokens: number, outTokens: number): number {
  return Math.max(1, Math.ceil((inTokens * price.inCentsPerMillion + outTokens * price.outCentsPerMillion) / 1_000_000));
}

/** A rough upper estimate of prompt tokens: 1 token per 3 characters, plus overhead per message. */
export function estimatePromptTokens(messages: unknown): number {
  const text = JSON.stringify(messages ?? []);
  return Math.ceil(text.length / 3) + (Array.isArray(messages) ? messages.length * 8 : 0);
}

export interface ChatRequest {
  body: Record<string, any>;
  conversationId?: string;
  conversationMaxCents?: number;
  approvalId?: string;
  idempotencyKey?: string;
}

export async function chatCompletion(db: Db, agentKey: AgentKey, r: ChatRequest, fetchImpl: typeof fetch = fetch) {
  if (!config.llmUpstreamUrl || !config.llmUpstreamKey) throw new LlmError(503, "llm_not_configured", "the AI model gateway isn't set up on this server (LLM_UPSTREAM_URL, LLM_UPSTREAM_KEY)");
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  if (agentKey.test) throw new LlmError(403, "test_key", "test keys can't call paid AI models: the cost is real");
  checkToolAllowed(agentKey, LLM_TOOL);
  if (r.body.stream) throw new LlmError(400, "stream_unsupported", "streaming isn't supported yet; send stream: false");

  const requested = String(r.body.model ?? "agentpay/auto");
  const model = requested.startsWith("agentpay/") ? profiles()[requested.slice(9)] : requested;
  const price = model ? models()[model] : undefined;
  if (!model || !price) throw new LlmError(400, "unknown_model", `model "${requested}" isn't offered here; GET /v1/models lists what is`);

  const maxOut = Math.min(Number(r.body.max_completion_tokens ?? r.body.max_tokens ?? config.llmDefaultMaxTokens) || config.llmDefaultMaxTokens, config.llmMaxTokens);
  const inEstimate = estimatePromptTokens(r.body.messages);
  const holdCents = costCents(price, inEstimate, maxOut);

  if (agentKey.perCallMaxCents !== null && holdCents > agentKey.perCallMaxCents) {
    throw new LlmError(402, "per_call_max_exceeded", `this call could cost up to ${holdCents}c, over the agent's ${agentKey.perCallMaxCents}c per-call limit; lower max_tokens`);
  }
  // Stop before a conversation crosses its cap, using the most this call could cost.
  if (r.conversationId && r.conversationMaxCents !== undefined) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(COALESCE(captured_cents, amount_cents)), 0)::bigint AS s FROM holds WHERE agent_key_id = $1 AND conversation_id = $2 AND status <> 'released'`,
      [agentKey.id, r.conversationId],
    );
    const spent: number = rows[0].s;
    if (spent + holdCents > r.conversationMaxCents) {
      throw new LlmError(402, "conversation_cap", `this conversation has used ${spent}c of its ${r.conversationMaxCents}c cap, and this call could cost up to ${holdCents}c; stopping before it goes over`, {
        spentCents: spent, capCents: r.conversationMaxCents, callCouldCostCents: holdCents,
      });
    }
  }

  const input = { model, maxTokens: maxOut, estimatedPromptTokens: inEstimate };
  let decision: Parameters<typeof placeHold>[6];
  if (r.approvalId) {
    decision = { kind: "approved", reason: "approved by the owner with a passkey", envelopeId: null };
  } else {
    const d = await decideCall(db, agentKey, LLM_TOOL, holdCents);
    if (d.outcome === "approve") {
      const approvalId = await createCallApproval(db, agentKey, LLM_TOOL, holdCents, { ...input, protocol: "llm", host: model }, { why: d.reason });
      throw new LlmError(402, "approval_required", `this AI model call (up to ${holdCents}c) needs the owner's approval (${d.reason}); retry with header X-AgentPay-Approval-Id: ${approvalId} once approved`, {
        approvalId,
      });
    }
    decision = { kind: d.outcome, reason: d.reason, envelopeId: d.envelopeId };
  }

  const hold = await placeHold(db, agentKey, LLM_TOOL, holdCents, { tool: "llm", input, idempotencyKey: r.idempotencyKey ?? randomUUID(), approvalId: r.approvalId }, null, decision, {
    ttlSeconds: config.holdTtlSeconds, async: false, jobTokenHash: null, quoteId: null, external: { protocol: "llm", target: model }, conversationId: r.conversationId,
  });

  let res: Response;
  let json: any;
  try {
    res = await fetchImpl(`${config.llmUpstreamUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llmUpstreamKey}` },
      body: JSON.stringify({ ...r.body, model, max_tokens: undefined, max_completion_tokens: maxOut, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    await releaseHold(db, hold.id, `model provider unreachable: ${(err as Error).message}`);
    throw new LlmError(502, "upstream_error", "the AI model provider couldn't be reached; nothing was charged");
  }
  if (!res.ok || !json) {
    await releaseHold(db, hold.id, `model provider returned HTTP ${res.status}`);
    throw new LlmError(res.status >= 400 && res.status < 600 ? res.status : 502, "upstream_error", json?.error?.message ?? `the model provider returned HTTP ${res.status}; nothing was charged`);
  }
  const usage = json.usage ?? {};
  const inTokens = Number(usage.prompt_tokens ?? inEstimate);
  const outTokens = Number(usage.completion_tokens ?? maxOut);
  const charged = Math.min(holdCents, costCents(price, inTokens, outTokens));
  await captureHold(db, hold.id, charged, { model, usage });
  await audit(db, agentKey.userId, {
    actor: "agent", agentKeyId: agentKey.id, kind: "call_paid", summary: `AI model ${model}: ${inTokens}+${outTokens} tokens, $${(charged / 100).toFixed(2)}`,
    data: { callId: hold.id, model, conversation: r.conversationId ?? null },
  }).catch((err) => console.error("audit log write failed", err));
  return { body: json, chargedCents: charged, heldCents: holdCents, callId: hold.id };
}

/** GET /v1/models: what this server offers, with prices. */
export function listModels() {
  const p = profiles();
  return {
    object: "list",
    data: [
      ...Object.entries(models()).map(([id, price]) => ({ id, object: "model", owned_by: "agentpay", pricing: price })),
      ...Object.entries(p).map(([name, id]) => ({ id: `agentpay/${name}`, object: "model", owned_by: "agentpay", alias_for: id })),
    ],
  };
}
