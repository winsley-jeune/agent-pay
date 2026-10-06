// SPDX-License-Identifier: MIT
import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Verify that a request to your paid tool or agent comes from AgentPay.
 *
 * AgentPay signs every request it sends you with Ed25519. The signature covers
 * the phase (call or quote), the call id, your tool's slug, the cents held for
 * the call, the paying agent's id, a timestamp and a hash of the exact body.
 *
 *   const keys = await fetchAgentPayKeys("https://agentpay.example.com");
 *   const call = verifyAgentPayRequest({ headers: req.headers, rawBody, keys });
 *   // call.heldCents is guaranteed to be held for you; call.agentId says who is paying.
 */

export interface AgentPayKey {
  kid: string;
  alg: "Ed25519";
  publicKeyPem: string;
}

export interface VerifiedRequest {
  phase: "call" | "quote";
  /** The call id (or quote request id). Use it to make your handling idempotent. */
  id: string;
  tool: string;
  /** Cents AgentPay holds for this call; you're paid up to this when it succeeds. 0 for quote requests. */
  heldCents: number;
  /** A stable id for the paying agent. */
  agentId: string;
  /** True for test keys: the money is pretend and you won't be paid. */
  test: boolean;
  timestamp: number;
  keyId: string;
}

export class AgentPayVerificationError extends Error {
  constructor(public reason: "missing_header" | "unknown_key" | "bad_signature" | "stale" | "wrong_tool", message: string) {
    super(message);
  }
}

type Headers = Record<string, string | string[] | undefined> | { get(name: string): string | null };

function header(h: Headers, name: string): string | undefined {
  if (typeof (h as { get?: unknown }).get === "function") return (h as { get(n: string): string | null }).get(name) ?? undefined;
  const v = (h as Record<string, string | string[] | undefined>)[name] ?? (h as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Fetch AgentPay's public keys. Cache them; refetch when you see an unknown key id. */
export async function fetchAgentPayKeys(agentPayUrl: string, fetchImpl: typeof fetch = fetch): Promise<AgentPayKey[]> {
  const res = await fetchImpl(`${agentPayUrl.replace(/\/$/, "")}/.well-known/agentpay-keys.json`);
  if (!res.ok) throw new Error(`couldn't fetch AgentPay keys: HTTP ${res.status}`);
  return ((await res.json()) as { keys: AgentPayKey[] }).keys;
}

/**
 * Check a request's signature. Pass the raw body exactly as received (before
 * JSON parsing). Throws AgentPayVerificationError if anything doesn't match.
 */
export function verifyAgentPayRequest(opts: {
  headers: Headers;
  rawBody: string | Buffer;
  keys: AgentPayKey[];
  /** Reject requests older than this (default 300 seconds), to stop replays. */
  maxAgeSeconds?: number;
  /** If set, the request must be for this tool. */
  expectedTool?: string;
  now?: number;
}): VerifiedRequest {
  const get = (n: string) => {
    const v = header(opts.headers, n);
    if (v === undefined || v === "") throw new AgentPayVerificationError("missing_header", `missing ${n} header`);
    return v;
  };
  const phase = get("x-agentpay-phase") as "call" | "quote";
  const id = get("x-agentpay-id");
  const tool = get("x-agentpay-tool");
  const held = get("x-agentpay-held-cents");
  const agentId = get("x-agentpay-agent");
  const timestamp = get("x-agentpay-timestamp");
  const keyId = get("x-agentpay-key-id");
  const signature = get("x-agentpay-signature");

  const key = opts.keys.find((k) => k.kid === keyId);
  if (!key) throw new AgentPayVerificationError("unknown_key", `unknown AgentPay key ${keyId}; refetch the keys`);
  const body = typeof opts.rawBody === "string" ? Buffer.from(opts.rawBody) : opts.rawBody;
  const canonical = ["agentpay-v1", phase, id, tool, held, agentId, timestamp, createHash("sha256").update(body).digest("hex")].join("\n");
  const ok = verify(null, Buffer.from(canonical), createPublicKey(key.publicKeyPem), Buffer.from(signature, "base64url"));
  if (!ok) throw new AgentPayVerificationError("bad_signature", "signature doesn't match: the request wasn't signed by AgentPay or was changed");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (opts.maxAgeSeconds ?? 300)) throw new AgentPayVerificationError("stale", "request is too old (or the clocks are far apart)");
  if (opts.expectedTool && tool !== opts.expectedTool) throw new AgentPayVerificationError("wrong_tool", `request is for ${tool}, not ${opts.expectedTool}`);
  return {
    phase, id, tool, heldCents: Number(held), agentId, test: header(opts.headers, "x-agentpay-test") === "true", timestamp: Number(timestamp), keyId,
  };
}

// ---------------------------------------------------------------- evidence bundles

/** Sorted-key JSON, matching how AgentPay hashes an entry's data. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export interface EvidenceBundle {
  format: string;
  issuer: string;
  userId: string;
  firstSeq: number;
  lastSeq: number;
  anchor: string;
  head: string;
  exportedAt: string;
  reason: string | null;
  entries: {
    seq: number; createdAt: string; actor: string; agentKeyId: string | null; kind: string; summary: string;
    instruction: string | null; reason: string | null; result: string | null; data: Record<string, unknown>; prevHash: string; hash: string;
  }[];
  signature: { kid: string; signature: string };
}

export type EvidenceResult = { ok: true; entries: number; firstSeq: number; lastSeq: number; issuer: string } | { ok: false; problem: string; seq?: number };

/**
 * Check an evidence bundle exported by an AgentPay server: every entry's hash,
 * the chain from the anchor to the head, and AgentPay's signature on the header.
 * Pass the issuer's keys (fetchAgentPayKeys(bundle.issuer)), not keys taken from the bundle.
 */
export function verifyEvidenceBundle(bundle: EvidenceBundle, keys: AgentPayKey[]): EvidenceResult {
  if (bundle.format !== "agentpay-evidence-v1") return { ok: false, problem: `unknown format ${bundle.format}` };
  if (!bundle.entries?.length) return { ok: false, problem: "no entries" };
  let prev = bundle.anchor;
  let expectedSeq = bundle.firstSeq;
  for (const e of bundle.entries) {
    if (e.seq !== expectedSeq) return { ok: false, problem: "an entry is missing or out of order", seq: expectedSeq };
    if (e.prevHash !== prev) return { ok: false, problem: "the chain is broken", seq: e.seq };
    const hash = createHash("sha256")
      .update(prev)
      .update(JSON.stringify([bundle.userId, e.seq, e.createdAt, e.actor, e.agentKeyId ?? null, e.kind, e.summary, e.instruction ?? null, e.reason ?? null, e.result ?? null, canonical(e.data ?? {})]))
      .digest("hex");
    if (hash !== e.hash) return { ok: false, problem: "an entry was changed", seq: e.seq };
    prev = e.hash;
    expectedSeq++;
  }
  if (bundle.lastSeq !== expectedSeq - 1 || bundle.head !== prev) return { ok: false, problem: "the header doesn't match the entries" };
  const key = keys.find((k) => k.kid === bundle.signature?.kid);
  if (!key) return { ok: false, problem: `unknown AgentPay key ${bundle.signature?.kid}` };
  const header = Buffer.from(JSON.stringify([bundle.format, bundle.issuer, bundle.userId, bundle.firstSeq, bundle.lastSeq, bundle.anchor, bundle.head, bundle.exportedAt, bundle.reason]));
  if (!verify(null, header, createPublicKey(key.publicKeyPem), Buffer.from(bundle.signature.signature, "base64url"))) {
    return { ok: false, problem: "AgentPay's signature doesn't match: the bundle wasn't issued by this server or was changed" };
  }
  return { ok: true, entries: bundle.entries.length, firstSeq: bundle.firstSeq, lastSeq: bundle.lastSeq, issuer: bundle.issuer };
}
