import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Db } from "./db.js";

// AgentPay signs every request it sends to a provider (paid calls, job
// requests, quote requests) with an Ed25519 key. Providers verify the
// signature with AgentPay's public keys (/.well-known/agentpay-keys.json) or
// the @winsley-jeune/agentpay-verify package, so they know the request really
// comes from AgentPay, which agent is paying, and how much is held for it.
//
// What's signed, one value per line:
//   agentpay-v1, phase (call | quote), call or quote id, tool slug,
//   cents held, agent id, unix timestamp, sha256 of the exact body (hex)

export interface SignedFields {
  phase: "call" | "quote";
  id: string;
  tool: string;
  heldCents: number;
  agentId: string;
  timestamp: number;
  body: string;
}

export function canonical(f: SignedFields): string {
  return ["agentpay-v1", f.phase, f.id, f.tool, String(f.heldCents), f.agentId, String(f.timestamp), createHash("sha256").update(f.body).digest("hex")].join("\n");
}

let cached: { kid: string; key: KeyObject } | null = null;

/** Forget the cached key (tests recreate the database). */
export function resetSigningKeyCache() {
  cached = null;
}

const kidFor = (publicPem: string) => `ap-${createHash("sha256").update(publicPem).digest("hex").slice(0, 16)}`;

/** The active signing key: AGENTPAY_SIGNING_KEY (an Ed25519 private key in PEM) if set, else one kept in the database, created on first use. */
async function signingKey(db: Db): Promise<{ kid: string; key: KeyObject }> {
  if (cached) return cached;
  const fromEnv = process.env.AGENTPAY_SIGNING_KEY;
  if (fromEnv) {
    const key = createPrivateKey(fromEnv.replace(/\\n/g, "\n"));
    const publicPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    cached = { kid: kidFor(publicPem), key };
    return cached;
  }
  let { rows } = await db.query("SELECT kid, private_pem AS pem FROM signing_keys WHERE active ORDER BY created_at DESC LIMIT 1");
  if (!rows[0]) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await db.query("INSERT INTO signing_keys (kid, private_pem, public_pem) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [kidFor(publicPem), privatePem, publicPem]);
    ({ rows } = await db.query("SELECT kid, private_pem AS pem FROM signing_keys WHERE active ORDER BY created_at DESC LIMIT 1"));
  }
  cached = { kid: rows[0].kid, key: createPrivateKey(rows[0].pem) };
  return cached;
}

/** Headers to add to a request to a provider. */
export async function signatureHeaders(db: Db, f: Omit<SignedFields, "timestamp">): Promise<Record<string, string>> {
  const { kid, key } = await signingKey(db);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(null, Buffer.from(canonical({ ...f, timestamp })), key).toString("base64url");
  return {
    "x-agentpay-phase": f.phase,
    "x-agentpay-id": f.id,
    "x-agentpay-tool": f.tool,
    "x-agentpay-held-cents": String(f.heldCents),
    "x-agentpay-agent": f.agentId,
    "x-agentpay-timestamp": String(timestamp),
    "x-agentpay-key-id": kid,
    "x-agentpay-signature": signature,
  };
}

/** Public keys providers verify with. */
export async function publicKeys(db: Db) {
  await signingKey(db); // make sure one exists
  const keys: { kid: string; alg: "Ed25519"; publicKeyPem: string }[] = [];
  if (process.env.AGENTPAY_SIGNING_KEY) {
    const pub = createPublicKey(cached!.key).export({ type: "spki", format: "pem" }).toString();
    keys.push({ kid: cached!.kid, alg: "Ed25519", publicKeyPem: pub });
  } else {
    const { rows } = await db.query("SELECT kid, public_pem AS pem FROM signing_keys WHERE active ORDER BY created_at DESC");
    for (const r of rows) keys.push({ kid: r.kid, alg: "Ed25519", publicKeyPem: r.pem });
  }
  return { keys, signed: ["agentpay-v1", "phase", "id", "tool", "heldCents", "agentId", "timestamp", "sha256(body)"] };
}

/** Sign arbitrary bytes with AgentPay's key (evidence bundles). */
export async function signBytes(db: Db, bytes: Buffer): Promise<{ kid: string; signature: string }> {
  const { kid, key } = await signingKey(db);
  return { kid, signature: sign(null, bytes, key).toString("base64url") };
}
