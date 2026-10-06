import type { AgentKey } from "./auth.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";
import { createCallApproval } from "./approvals.js";
import { audit } from "./audit.js";
import { decideCall, frozenAt, frozenError, LEVEL_LABELS, listEnvelopes, lockEnvelopeFor } from "./controls.js";
import { quote, toolById, toolBySlug, type Tool } from "./registry.js";
import { findCoverage } from "./subscriptions.js";
import { enforce } from "./policy.js";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_MAX_JOB_SECONDS } from "./registry.js";
import { signatureHeaders } from "./signing.js";
import { checkSafety } from "./safety.js";

export interface CallRequest {
  tool: string;
  input: Record<string, unknown>;
  /** Same key + same agent = same call. Retrying never charges twice. */
  idempotencyKey: string;
  approvalId?: string;
  /** For tools priced per task: the quote from request_task_quote. */
  quoteId?: string;
  /** Why the agent is making this call, and what the owner asked for. Kept in the owner's log. */
  reason?: string;
  instruction?: string;
}

export type CallResult =
  | {
      status: "ok";
      callId: string;
      chargedCents: number;
      balanceCents: number;
      result: unknown;
      replayed: boolean;
      /** Set when the call was free because a subscription included it. */
      coveredBySubscription?: string;
    }
  | { status: "failed"; callId: string; chargedCents: 0; balanceCents: number; error: string; replayed: boolean }
  /** An async job is running: the money is held until the provider reports back or the job times out. */
  | { status: "running"; callId: string; heldCents: number; balanceCents: number; message: string; replayed: boolean }
  | { status: "pending_approval"; approvalId: string; amountCents: number; approveUrl: string; message: string; why: string };

interface HoldRow {
  id: string;
  test: boolean;
  async: boolean;
  agentKeyId: string;
  walletAccountId: string;
  toolId: string;
  amountCents: number;
  capturedCents: number | null;
  status: "held" | "captured" | "released";
  result: unknown;
  error: string | null;
}

const holdColumns = `id, test, async, agent_key_id AS "agentKeyId", wallet_account_id AS "walletAccountId", tool_id AS "toolId",
  amount_cents AS "amountCents", captured_cents AS "capturedCents", status, result, error`;

export interface GatewayOptions {
  fetchImpl?: typeof fetch;
  platformFeeBps?: number;
}

export function checkToolAllowed(agentKey: AgentKey, tool: Tool) {
  if (agentKey.allowedToolSlugs && !agentKey.allowedToolSlugs.includes(tool.slug)) {
    throw new AppError(403, "tool_not_allowed", `this agent key is not allowed to use "${tool.slug}"`);
  }
}

export async function getToolForAgent(db: Db, agentKey: AgentKey, slug: string): Promise<Tool> {
  const tool = await toolBySlug(db, slug);
  if (!tool) throw new AppError(404, "unknown_tool", `no active tool named "${slug}"`);
  checkToolAllowed(agentKey, tool);
  return tool;
}

/** Cents this key has spent or has in flight over the last `days` days. */
async function spentSince(q: Db | Tx, agentKeyId: string, days: number): Promise<number> {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(COALESCE(captured_cents, amount_cents)), 0)::bigint AS s
       FROM holds
      WHERE agent_key_id = $1 AND status <> 'released' AND created_at > now() - make_interval(days => $2)`,
    [agentKeyId, days],
  );
  return rows[0].s;
}

export async function spendSummary(q: Db | Tx, agentKey: AgentKey) {
  const [last24h, last30d] = await Promise.all([spentSince(q, agentKey.id, 1), spentSince(q, agentKey.id, 30)]);
  const envelopes = (await listEnvelopes(q, agentKey.userId)).filter((e) => e.status === "active" && (!e.agentKeyId || e.agentKeyId === agentKey.id));
  return {
    frozen: (await frozenAt(q, agentKey.userId)) !== null,
    test: agentKey.test,
    level: agentKey.level,
    levelLabel: LEVEL_LABELS[agentKey.level],
    spendRules: agentKey.spendRules,
    observeAboveCents: agentKey.observeAboveCents,
    coolingOffUntil: agentKey.coolingOffUntil && new Date(agentKey.coolingOffUntil) > new Date() ? agentKey.coolingOffUntil : null,
    envelopes: envelopes.map((e) => ({ id: e.id, name: e.name, purpose: e.purpose, toolSlugs: e.toolSlugs, balanceCents: e.balanceCents, expiresAt: e.expiresAt })),
    walletBalanceCents: await balance(q, agentKey.walletAccountId),
    spentLast24hCents: last24h,
    spentLast30dCents: last30d,
    limits: {
      perCallMaxCents: agentKey.perCallMaxCents,
      dailyCapCents: agentKey.dailyCapCents,
      monthlyCapCents: agentKey.monthlyCapCents,
      approvalThresholdCents: agentKey.approvalThresholdCents,
      allowedToolSlugs: agentKey.allowedToolSlugs,
    },
  };
}

export async function holdByKey(q: Db | Tx, agentKeyId: string, idempotencyKey: string): Promise<HoldRow | null> {
  const { rows } = await q.query(`SELECT ${holdColumns} FROM holds WHERE agent_key_id = $1 AND idempotency_key = $2`, [
    agentKeyId,
    idempotencyKey,
  ]);
  return rows[0] ?? null;
}

export async function replay(db: Db, hold: HoldRow, toolId: string | null): Promise<CallResult> {
  if (hold.toolId !== toolId) {
    throw new AppError(422, "idempotency_conflict", "this idempotency key was already used for a different tool");
  }
  const balanceCents = await balance(db, hold.walletAccountId);
  if (hold.status === "held" && hold.async) return runningResult(hold, balanceCents, true);
  if (hold.status === "held") {
    throw new AppError(409, "call_in_progress", "a call with this idempotency key is still running; retry shortly");
  }
  if (hold.status === "captured") {
    return { status: "ok", callId: hold.id, chargedCents: hold.capturedCents!, balanceCents, result: hold.result, replayed: true };
  }
  return { status: "failed", callId: hold.id, chargedCents: 0, balanceCents, error: hold.error ?? "call failed", replayed: true };
}

function runningResult(hold: Pick<HoldRow, "id" | "amountCents">, balanceCents: number, replayed: boolean): CallResult {
  return {
    status: "running", callId: hold.id, heldCents: hold.amountCents, balanceCents, replayed,
    message: `The provider is working on it. ${hold.amountCents}c is held, not charged; it's charged only when the result arrives, and returned if the job fails or times out. Check with get_job using callId "${hold.id}".`,
  };
}

/** Stable JSON (sorted keys), so the same input always hashes the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const inputHash = (input: unknown) => createHash("sha256").update(stableJson(input ?? {})).digest("hex");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Reserve funds for one call. Takes the wallet lock so that balance and
 * budget checks cannot race with another call from the same wallet.
 */
export async function placeHold(
  db: Db,
  agentKey: AgentKey,
  tool: Tool,
  amountCents: number,
  req: CallRequest,
  subscriptionId: string | null,
  decision: { kind: "auto" | "observe" | "approved" | "covered"; reason: string; envelopeId: string | null },
  job: {
    ttlSeconds: number;
    async: boolean;
    jobTokenHash: string | null;
    quoteId: string | null;
    /** A payment outside AgentPay (x402, A2A, the LLM gateway): there's no marketplace tool. */
    external?: { protocol: "x402" | "a2a" | "llm"; target: string };
    /** Same payee, amount and input: used to spot duplicates. */
    fingerprint?: string;
    conversationId?: string;
  } = { ttlSeconds: config.holdTtlSeconds, async: false, jobTokenHash: null, quoteId: null },
): Promise<HoldRow> {
  return withTx(db, async (tx) => {
    // Always the owner's wallet first, then any envelope: per-agent caps count holds from both.
    await lockAccount(tx, agentKey.walletAccountId);
    if (await frozenAt(tx, agentKey.userId)) throw frozenError();
    const funding = decision.envelopeId ? await lockEnvelopeFor(tx, agentKey, decision.envelopeId, tool, amountCents) : agentKey.walletAccountId;

    if (subscriptionId) {
      // Re-check quota under the wallet lock so parallel calls can't overspend it.
      const coverage = await findCoverage(tx, agentKey.userId, tool);
      if (coverage?.subscriptionId !== subscriptionId) {
        throw new AppError(409, "quota_changed", "the subscription's included calls just ran out; retry to pay per call");
      }
    }

    if (agentKey.dailyCapCents !== null) {
      const spent = await spentSince(tx, agentKey.id, 1);
      if (spent + amountCents > agentKey.dailyCapCents) {
        throw new AppError(402, "daily_cap_exceeded", "this call would exceed the agent's 24-hour spending cap", {
          capCents: agentKey.dailyCapCents,
          spentCents: spent,
          amountCents,
        });
      }
    }
    if (agentKey.monthlyCapCents !== null) {
      const spent = await spentSince(tx, agentKey.id, 30);
      if (spent + amountCents > agentKey.monthlyCapCents) {
        throw new AppError(402, "monthly_cap_exceeded", "this call would exceed the agent's 30-day spending cap", {
          capCents: agentKey.monthlyCapCents,
          spentCents: spent,
          amountCents,
        });
      }
    }

    if (req.approvalId) {
      const { rowCount } = await tx.query(
        `UPDATE approvals SET status = 'used'
          WHERE id = $1 AND agent_key_id = $2 AND tool_id IS NOT DISTINCT FROM $3 AND status = 'approved' AND amount_cents >= $4`,
        [req.approvalId, agentKey.id, tool.id || null, amountCents],
      );
      if (!rowCount) {
        throw new AppError(403, "approval_invalid", "approval not found, not approved yet, already used, or for a smaller amount");
      }
    }

    if (job.quoteId) {
      // A quote pays for one call only.
      const used = await tx.query(
        "UPDATE task_quotes SET status = 'used' WHERE id = $1 AND agent_key_id = $2 AND tool_id = $3 AND status = 'open' AND expires_at > now()",
        [job.quoteId, agentKey.id, tool.id],
      );
      if (!used.rowCount) throw new AppError(409, "quote_invalid", "this quote was already used or has expired; ask for a new one");
    }

    const available = await balance(tx, funding);
    if (available < amountCents) {
      throw new AppError(402, "insufficient_funds", "not enough credits; ask the owner to top up", {
        balanceCents: available,
        amountCents,
      });
    }

    const { rows } = await tx.query(
      `INSERT INTO holds (agent_key_id, wallet_account_id, tool_id, idempotency_key, amount_cents, expires_at, subscription_id,
                          decision, decision_reason, agent_reason, test, async, job_token_hash, quote_id, external_protocol, external_target,
                          fingerprint, conversation_id)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING ${holdColumns}`,
      [agentKey.id, funding, tool.id || null, req.idempotencyKey, amountCents, job.ttlSeconds, subscriptionId,
       decision.kind, decision.reason.slice(0, 300), req.reason?.slice(0, 500) ?? null, agentKey.test, job.async, job.jobTokenHash, job.quoteId,
       job.external?.protocol ?? null, job.external?.target.slice(0, 500) ?? null, job.fingerprint ?? null, job.conversationId?.slice(0, 200) ?? null],
    );
    const hold: HoldRow = rows[0];
    if (amountCents > 0) {
      await post(
        tx,
        "hold",
        [
          { accountId: funding, amountCents: -amountCents },
          { accountId: await systemAccount(tx, "holds"), amountCents },
        ],
        `hold ${hold.id} for ${tool.slug}`,
      );
    }
    return hold;
  });
}

/** Lock a hold and return it only if it is still open. */
async function lockOpenHold(tx: Tx, holdId: string): Promise<HoldRow | null> {
  const { rows } = await tx.query(`SELECT ${holdColumns} FROM holds WHERE id = $1 FOR UPDATE`, [holdId]);
  return rows[0]?.status === "held" ? rows[0] : null;
}

/**
 * Charge `capturedCents` (≤ the held amount) to the provider, minus the platform
 * fee, and return any remainder to the wallet. No-op if the hold already settled.
 */
export async function captureHold(
  db: Db,
  holdId: string,
  capturedCents: number,
  result: unknown,
  feeBps = config.platformFeeBps,
): Promise<boolean> {
  return withTx(db, async (tx) => {
    const hold = await lockOpenHold(tx, holdId);
    if (!hold) return false;
    const charged = Math.max(0, Math.min(hold.amountCents, Math.floor(capturedCents)));
    if (!hold.toolId) {
      // Paid outside AgentPay with the platform's own USDC: record it against external_settlement, no fee.
      const sink = hold.test ? await systemAccount(tx, "test_sink") : await systemAccount(tx, "external_settlement");
      if (hold.amountCents > 0) {
        await post(
          tx,
          "capture",
          [
            { accountId: await systemAccount(tx, "holds"), amountCents: -hold.amountCents },
            { accountId: sink, amountCents: charged },
            { accountId: hold.walletAccountId, amountCents: hold.amountCents - charged },
          ],
          `capture ${hold.id} (external payment): ${charged}c of ${hold.amountCents}c held`,
        );
      }
      await tx.query("UPDATE holds SET status = 'captured', captured_cents = $2, result = $3, settled_at = now() WHERE id = $1", [holdId, charged, JSON.stringify(result ?? null)]);
      return true;
    }
    const fee = Math.floor((charged * feeBps) / 10_000);
    const tool = (await toolById(tx, hold.toolId))!;
    const { rows } = await tx.query("SELECT account_id FROM providers WHERE id = $1", [tool.providerId]);
    // Pretend money from a test key never reaches a provider's earnings or the platform's fees.
    const testSink = hold.test ? await systemAccount(tx, "test_sink") : null;
    if (hold.amountCents > 0) {
      await post(
        tx,
        "capture",
        [
          { accountId: await systemAccount(tx, "holds"), amountCents: -hold.amountCents },
          { accountId: testSink ?? rows[0].account_id, amountCents: charged - fee },
          { accountId: testSink ?? (await systemAccount(tx, "platform_fees")), amountCents: fee },
          { accountId: hold.walletAccountId, amountCents: hold.amountCents - charged },
        ],
        `capture ${hold.id}: ${charged}c of ${hold.amountCents}c held`,
      );
    }
    await tx.query(
      "UPDATE holds SET status = 'captured', captured_cents = $2, result = $3, settled_at = now() WHERE id = $1",
      [holdId, charged, JSON.stringify(result ?? null)],
    );
    return true;
  });
}

/** Return the full held amount to the wallet. No-op if the hold already settled. */
export async function releaseHold(db: Db, holdId: string, error: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const hold = await lockOpenHold(tx, holdId);
    if (!hold) return false;
    if (hold.amountCents > 0) {
      await post(
        tx,
        "release",
        [
          { accountId: await systemAccount(tx, "holds"), amountCents: -hold.amountCents },
          { accountId: hold.walletAccountId, amountCents: hold.amountCents },
        ],
        `release ${hold.id}: ${error.slice(0, 200)}`,
      );
    }
    await tx.query("UPDATE holds SET status = 'released', error = $2, settled_at = now() WHERE id = $1", [holdId, error.slice(0, 2000)]);
    return true;
  });
}

/** Release holds whose call never settled (crash, lost process). Run periodically. */
export async function sweepExpiredHolds(db: Db): Promise<number> {
  const { rows } = await db.query("SELECT id FROM holds WHERE status = 'held' AND expires_at < now()");
  let released = 0;
  for (const { id } of rows) {
    if (await releaseHold(db, id, "hold expired before the call settled")) released++;
  }
  return released;
}

interface UpstreamOptions {
  db: Db;
  agentKey: AgentKey;
  heldCents: number;
  phase?: "call" | "quote";
  jobToken?: string | null;
  quote?: { id: string; ref: string | null } | null;
}

/**
 * Send one signed request to the provider. Calls carry `{ callId, input }`
 * (plus `quote` for quoted tools and `callbackUrl` for async jobs); quote
 * requests carry `{ phase: "quote", quoteRequestId, input }`.
 */
async function callUpstream(tool: Tool, callId: string, input: unknown, fetchImpl: typeof fetch, o: UpstreamOptions) {
  const phase = o.phase ?? "call";
  const callbackUrl = o.jobToken ? `${config.publicUrl}/api/jobs/${callId}` : undefined;
  const body = JSON.stringify(
    phase === "quote" ? { phase, quoteRequestId: callId, input } : { callId, input, ...(o.quote ? { quote: o.quote } : {}), ...(callbackUrl ? { callbackUrl } : {}) },
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-agentpay-call-id": callId,
    // Providers can return sample data for test calls; they aren't paid for them.
    ...(o.agentKey.test ? { "x-agentpay-test": "true" } : {}),
    // Who is paying and how much is held, signed by AgentPay (docs/providers.md).
    ...(await signatureHeaders(o.db, { phase, id: callId, tool: tool.slug, heldCents: o.heldCents, agentId: o.agentKey.id, body })),
    ...(o.jobToken ? { "x-agentpay-job-token": o.jobToken, "x-agentpay-callback-url": callbackUrl! } : {}),
  };
  if (tool.upstreamAuth) headers.authorization = tool.upstreamAuth;
  const res = await fetchImpl(tool.upstreamUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`provider returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // plain-text result is fine
  }
  const unitsHeader = res.headers.get("x-agentpay-units");
  return { status: res.status, body: parsed, unitsUsed: unitsHeader !== null && /^\d+$/.test(unitsHeader) ? Number(unitsHeader) : null };
}

/**
 * The paid call: quote → decision (level, rules, envelope) → hold → upstream →
 * capture or release. Every path that places a hold settles it before
 * returning. Each outcome is written to the owner's "why" log.
 */
export async function callPaidTool(db: Db, agentKey: AgentKey, req: CallRequest, opts: GatewayOptions = {}): Promise<CallResult> {
  let result: CallResult;
  try {
    result = await runPaidCall(db, agentKey, req, opts);
  } catch (err) {
    if (err instanceof AppError && err.status !== 400) {
      await logCall(agentKey, req, "call_refused", `Refused a call to ${req.tool}`, err.message, { code: err.code, ...(err.details as object) }, db);
    }
    throw err;
  }
  if (result.status === "pending_approval") {
    await logCall(agentKey, req, "call_needs_approval", `Asked the owner to approve ${usd(result.amountCents)} for ${req.tool}`, result.why, { approvalId: result.approvalId }, db);
  } else if (result.status === "running") {
    if (!result.replayed) await logCall(agentKey, req, "job_started", `Started a job with ${req.tool}; ${usd(result.heldCents)} held until it finishes`, null, { callId: result.callId }, db);
  } else if (!result.replayed) {
    const summary = result.status === "ok" ? `Paid ${usd(result.chargedCents)} for ${req.tool}` : `Call to ${req.tool} failed; not charged`;
    await logCall(agentKey, req, result.status === "ok" ? "call_paid" : "call_failed", summary, result.status === "ok" ? null : result.error, { callId: result.callId }, db);
  }
  return result;
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function logCall(agentKey: AgentKey, req: CallRequest, kind: string, summary: string, result: string | null, data: Record<string, unknown>, db: Db) {
  // (summary and data are reassigned below for test keys)
  const reason = req.reason ?? null;
  if (agentKey.test) {
    summary = `[test] ${summary}`;
    data = { ...data, test: true };
  }
  if (kind === "call_paid" && data.callId) {
    const { rows } = await db.query(`SELECT decision, decision_reason AS "decisionReason" FROM holds WHERE id = $1`, [data.callId]);
    if (rows[0]) data = { ...data, decision: rows[0].decision, decidedBecause: rows[0].decisionReason };
  }
  // The money has already moved; a failure to log must not turn a paid call into an error.
  await audit(db, agentKey.userId, { actor: "agent", agentKeyId: agentKey.id, kind, summary, instruction: req.instruction, reason, result, data }).catch((err) =>
    console.error("audit log write failed", err),
  );
}

async function runPaidCall(db: Db, agentKey: AgentKey, req: CallRequest, opts: GatewayOptions): Promise<CallResult> {
  if (!req.idempotencyKey || req.idempotencyKey.length > 200) {
    throw new AppError(400, "invalid_idempotency_key", "idempotencyKey is required (max 200 chars)");
  }
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const tool = await getToolForAgent(db, agentKey, req.tool);
  enforce(tool.slug, tool.name, tool.description);

  const existing = await holdByKey(db, agentKey.id, req.idempotencyKey);
  if (existing) return replay(db, existing, tool.id);

  // A subscription with included calls left makes this call free; budgets and approvals don't apply.
  // Test keys never use the owner's real subscriptions.
  const coverage = agentKey.test || tool.pricingType === "quoted" ? null : await findCoverage(db, agentKey.userId, tool);
  let quoted: { id: string; ref: string | null } | null = null;
  let amountCents: number;
  if (tool.pricingType === "quoted") {
    if (!req.quoteId) quote(tool, req.input); // throws quote_required
    const { rows } = await db.query(
      `SELECT id, price_cents AS "priceCents", provider_ref AS ref, input_hash AS "inputHash", status, expires_at AS "expiresAt"
         FROM task_quotes WHERE id = $1 AND agent_key_id = $2 AND tool_id = $3`,
      [req.quoteId, agentKey.id, tool.id],
    );
    const q = rows[0];
    if (!q || q.status !== "open" || new Date(q.expiresAt) <= new Date()) throw new AppError(409, "quote_invalid", "this quote was already used or has expired; ask for a new one");
    if (q.inputHash !== inputHash(req.input)) throw new AppError(409, "quote_mismatch", "the quote was for a different input; ask for a new quote");
    quoted = { id: q.id, ref: q.ref };
    amountCents = q.priceCents;
  } else {
    amountCents = coverage ? 0 : quote(tool, req.input).amountCents;
  }

  if (!coverage && agentKey.perCallMaxCents !== null && amountCents > agentKey.perCallMaxCents) {
    throw new AppError(402, "per_call_max_exceeded", "this call costs more than the agent's per-call limit", {
      amountCents,
      perCallMaxCents: agentKey.perCallMaxCents,
    });
  }

  // Price jumps and duplicates go to the owner even when the agent's level would pay on its own.
  const safety = coverage ? null : await checkSafety(db, agentKey, { target: tool.id, outside: false, amountCents, input: req.input, checkDuplicates: tool.pricingType === "quoted" });
  let decision: Parameters<typeof placeHold>[6];
  if (coverage) {
    decision = { kind: "covered", reason: "included in a subscription", envelopeId: null };
  } else if (req.approvalId) {
    decision = { kind: "approved", reason: "approved by the owner with a passkey", envelopeId: null };
  } else {
    const d = safety?.ask ? ({ outcome: "approve", reason: safety.ask, envelopeId: null } as const) : await decideCall(db, agentKey, tool, amountCents);
    if (d.outcome === "approve") {
      const approvalId = await createCallApproval(db, agentKey, tool, amountCents, req.input, { why: d.reason, agentReason: req.reason });
      return {
        status: "pending_approval",
        approvalId,
        amountCents,
        approveUrl: `${config.publicUrl}/#approvals`,
        why: d.reason,
        message:
          `This call costs ${amountCents}c and needs the owner's approval (${d.reason}). ` +
          `Ask the owner to approve it with their passkey, then retry with the same input and approvalId "${approvalId}".`,
      };
    }
    decision = { kind: d.outcome, reason: d.reason, envelopeId: d.envelopeId };
  }

  const jobToken = tool.mode === "async" ? `ap_job_${randomBytes(24).toString("base64url")}` : null;
  const job = {
    ttlSeconds: tool.mode === "async" ? (tool.maxJobSeconds ?? DEFAULT_MAX_JOB_SECONDS) : config.holdTtlSeconds,
    async: tool.mode === "async",
    jobTokenHash: jobToken ? tokenHash(jobToken) : null,
    quoteId: quoted?.id ?? null,
    fingerprint: safety?.fingerprint,
  };
  let hold: HoldRow;
  try {
    hold = await placeHold(db, agentKey, tool, amountCents, { ...req, approvalId: coverage ? undefined : req.approvalId }, coverage?.subscriptionId ?? null, decision, job);
  } catch (err: any) {
    // Lost a race with a concurrent call using the same idempotency key.
    if (err?.code === "23505") {
      const winner = await holdByKey(db, agentKey.id, req.idempotencyKey);
      if (winner) return replay(db, winner, tool.id);
    }
    throw err;
  }

  let upstream: Awaited<ReturnType<typeof callUpstream>>;
  try {
    upstream = await callUpstream(tool, hold.id, req.input, opts.fetchImpl ?? fetch, { db, agentKey, heldCents: amountCents, jobToken, quote: quoted });
  } catch (err: any) {
    const message = err?.name === "TimeoutError" ? "provider timed out" : String(err?.message ?? err);
    await releaseHold(db, hold.id, message);
    return {
      status: "failed",
      callId: hold.id,
      chargedCents: 0,
      balanceCents: await balance(db, agentKey.walletAccountId),
      error: message,
      replayed: false,
    };
  }

  // An async job the provider accepted: keep the money held until it reports back.
  if (tool.mode === "async" && upstream.status === 202) return runningResult(hold, await balance(db, agentKey.walletAccountId), false);

  const charge =
    tool.pricingType === "per_unit" && upstream.unitsUsed !== null
      ? Math.min(amountCents, upstream.unitsUsed * tool.priceCents)
      : amountCents;
  try {
    const captured = await captureHold(db, hold.id, charge, upstream.body, opts.platformFeeBps);
    if (!captured) {
      // The sweeper released this hold while the provider was still working; the call is free.
      return {
        status: "failed",
        callId: hold.id,
        chargedCents: 0,
        balanceCents: await balance(db, agentKey.walletAccountId),
        error: "hold expired before the provider answered; you were not charged",
        replayed: false,
      };
    }
  } catch (err) {
    // Couldn't record the charge: give the money back rather than leave it held. The sweeper is the backstop.
    await releaseHold(db, hold.id, "gateway error while settling").catch(() => {});
    throw err;
  }
  return {
    status: "ok",
    callId: hold.id,
    chargedCents: charge,
    balanceCents: await balance(db, agentKey.walletAccountId),
    result: upstream.body,
    replayed: false,
    ...(coverage ? { coveredBySubscription: coverage.subscriptionId } : {}),
  };
}

// ---------------------------------------------------------------- async jobs

/** Where an agent's job stands. */
export async function getJob(db: Db, agentKey: AgentKey, callId: string) {
  const { rows } = await db.query(
    `SELECT h.id, h.status, h.async, h.amount_cents AS "heldCents", h.captured_cents AS "chargedCents", h.result, h.error,
            h.expires_at AS "expiresAt", h.created_at AS "startedAt", h.settled_at AS "finishedAt", COALESCE(t.slug, h.external_protocol) AS tool
       FROM holds h LEFT JOIN tools t ON t.id = h.tool_id WHERE h.id = $1 AND h.agent_key_id = $2`,
    [callId, agentKey.id],
  );
  const h = rows[0];
  if (!h) throw new AppError(404, "not_found", "no call with that id for this agent");
  const status = h.status === "held" ? "running" : h.status === "captured" ? "done" : "failed";
  return {
    callId: h.id, tool: h.tool, status, startedAt: h.startedAt, finishedAt: h.finishedAt,
    ...(status === "running" ? { heldCents: h.heldCents, timesOutAt: h.expiresAt } : {}),
    ...(status === "done" ? { chargedCents: h.chargedCents, result: h.result } : {}),
    ...(status === "failed" ? { chargedCents: 0, error: h.error } : {}),
  };
}

async function jobForProvider(db: Db, callId: string, token: string) {
  const { rows } = await db.query(
    `SELECT h.id, h.amount_cents AS "amountCents", h.job_token_hash AS "tokenHash", h.status, h.agent_key_id AS "agentKeyId", k.user_id AS "userId",
            t.slug, t.pricing_type AS "pricingType", t.price_cents AS "priceCents"
       FROM holds h JOIN tools t ON t.id = h.tool_id JOIN agent_keys k ON k.id = h.agent_key_id
      WHERE h.id = $1 AND h.async`,
    [callId],
  );
  const h = rows[0];
  // Same answer for "no such job" and "wrong token", so job ids can't be probed.
  if (!h || !token || h.tokenHash !== tokenHash(token)) throw new AppError(404, "not_found", "no job with that id and token");
  return h;
}

/**
 * The provider reports an async job's result (authenticated by the job token
 * sent with the call). Charges up to the held amount, fewer units if reported.
 */
export async function completeJob(db: Db, callId: string, token: string, input: { result: unknown; units?: number }) {
  const h = await jobForProvider(db, callId, token);
  if (h.status !== "held") throw new AppError(409, "job_closed", h.status === "captured" ? "this job is already complete" : "this job already failed or timed out; it can't be charged");
  const charge = h.pricingType === "per_unit" && Number.isInteger(input.units) && input.units! >= 0 ? Math.min(h.amountCents, input.units! * h.priceCents) : h.amountCents;
  const captured = await captureHold(db, callId, charge, input.result ?? null);
  if (!captured) throw new AppError(409, "job_closed", "this job already finished or timed out");
  await audit(db, h.userId, {
    actor: "system", agentKeyId: h.agentKeyId, kind: "call_paid", summary: `Job with ${h.slug} finished; paid ${usd(charge)}`, data: { callId, async: true },
  }).catch((err) => console.error("audit log write failed", err));
  return { callId, status: "done" as const, chargedCents: charge };
}

/** The provider reports that an async job failed: the held money goes back. */
export async function failJob(db: Db, callId: string, token: string, error: string) {
  const h = await jobForProvider(db, callId, token);
  if (h.status !== "held") throw new AppError(409, "job_closed", "this job already finished");
  await releaseHold(db, callId, `provider reported failure: ${error}`.slice(0, 2000));
  await audit(db, h.userId, {
    actor: "system", agentKeyId: h.agentKeyId, kind: "call_failed", summary: `Job with ${h.slug} failed; not charged`, result: error.slice(0, 300), data: { callId, async: true },
  }).catch((err) => console.error("audit log write failed", err));
  return { callId, status: "failed" as const, chargedCents: 0 };
}

// ---------------------------------------------------------------- quotes

const MAX_QUOTE_SECONDS = 3600;

/**
 * Ask a provider to price a task. The provider answers `{ priceCents,
 * description?, expiresInSeconds?, ref? }`; the price can't exceed the tool's
 * ceiling. Free, and nothing is held. The agent then calls with the quoteId,
 * and the owner's level, rules and limits apply to the quoted price as usual.
 */
export async function requestTaskQuote(db: Db, agentKey: AgentKey, slug: string, input: Record<string, unknown>, opts: GatewayOptions = {}) {
  if (await frozenAt(db, agentKey.userId)) throw frozenError();
  const tool = await getToolForAgent(db, agentKey, slug);
  enforce(tool.slug, tool.name, tool.description);
  if (tool.pricingType !== "quoted") throw new AppError(400, "not_quoted", `"${tool.slug}" has a fixed price; use get_quote`);
  const quoteRequestId = randomBytes(12).toString("hex");
  let upstream: Awaited<ReturnType<typeof callUpstream>>;
  try {
    upstream = await callUpstream(tool, quoteRequestId, input, opts.fetchImpl ?? fetch, { db, agentKey, heldCents: 0, phase: "quote" });
  } catch (err: any) {
    throw new AppError(502, "quote_failed", `the provider couldn't quote: ${err?.name === "TimeoutError" ? "timed out" : String(err?.message ?? err)}`.slice(0, 500));
  }
  const b = (upstream.body ?? {}) as { priceCents?: unknown; description?: unknown; expiresInSeconds?: unknown; ref?: unknown };
  if (!Number.isSafeInteger(b.priceCents) || (b.priceCents as number) < 0) throw new AppError(502, "quote_failed", "the provider's quote has no valid priceCents");
  if ((b.priceCents as number) > tool.priceCents) {
    throw new AppError(502, "quote_over_ceiling", `the provider quoted ${b.priceCents}c, above this tool's listed maximum of ${tool.priceCents}c`);
  }
  const seconds = Math.min(Math.max(Number.isInteger(b.expiresInSeconds) ? (b.expiresInSeconds as number) : 900, 60), MAX_QUOTE_SECONDS);
  const { rows } = await db.query(
    `INSERT INTO task_quotes (agent_key_id, tool_id, input_hash, price_cents, description, provider_ref, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING id, expires_at AS "expiresAt"`,
    [agentKey.id, tool.id, inputHash(input), b.priceCents, typeof b.description === "string" ? b.description.slice(0, 500) : null, typeof b.ref === "string" ? b.ref.slice(0, 200) : null, seconds],
  );
  const decision = await decideCall(db, agentKey, tool, b.priceCents as number);
  return {
    quoteId: rows[0].id as string, tool: tool.slug, priceCents: b.priceCents as number,
    description: typeof b.description === "string" ? b.description.slice(0, 500) : null, expiresAt: rows[0].expiresAt as Date,
    needsApproval: decision.outcome === "approve", why: decision.reason,
    overPerCallMax: agentKey.perCallMaxCents !== null && (b.priceCents as number) > agentKey.perCallMaxCents,
    next: `Call ${tool.slug} with the same input and quoteId "${rows[0].id}" before it expires.`,
  };
}
