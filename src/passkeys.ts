import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { AppError } from "./errors.js";

const CHALLENGE_TTL_SECONDS = 300;

export interface Passkey {
  id: string;
  deviceName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listPasskeys(q: Db | Tx, userId: string): Promise<Passkey[]> {
  const { rows } = await q.query(
    `SELECT id, device_name AS "deviceName", created_at AS "createdAt", last_used_at AS "lastUsedAt"
       FROM passkeys WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows;
}

export async function hasPasskey(q: Db | Tx, userId: string): Promise<boolean> {
  const { rowCount } = await q.query("SELECT 1 FROM passkeys WHERE user_id = $1 LIMIT 1", [userId]);
  return !!rowCount;
}

export async function deletePasskey(db: Db, userId: string, id: string): Promise<void> {
  const { rowCount } = await db.query("DELETE FROM passkeys WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!rowCount) throw new AppError(404, "not_found", "passkey not found");
}

async function storeChallenge(db: Db, userId: string, challenge: string, purpose: "register" | "approve", approvalId?: string) {
  await db.query(
    `INSERT INTO passkey_challenges (challenge, user_id, purpose, approval_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [challenge, userId, purpose, approvalId ?? null, CHALLENGE_TTL_SECONDS],
  );
}

/** Mark a challenge used. Returns false if it is unknown, expired, already used or for something else. */
async function consumeChallenge(q: Db | Tx, userId: string, challenge: string, purpose: string, approvalId?: string) {
  const { rowCount } = await q.query(
    `UPDATE passkey_challenges SET used_at = now()
      WHERE challenge = $1 AND user_id = $2 AND purpose = $3 AND used_at IS NULL AND expires_at > now()
        AND approval_id IS NOT DISTINCT FROM $4`,
    [challenge, userId, purpose, approvalId ?? null],
  );
  return !!rowCount;
}

function challengeFromResponse(response: { response: { clientDataJSON: string } }): string {
  try {
    return JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")).challenge;
  } catch {
    throw new AppError(400, "bad_passkey_response", "could not read clientDataJSON");
  }
}

export async function startRegistration(db: Db, user: { id: string; email: string }) {
  const existing = await db.query("SELECT id, transports FROM passkeys WHERE user_id = $1", [user.id]);
  const options = await generateRegistrationOptions({
    rpName: "AgentPay",
    rpID: config.rpId,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.rows.map((r) => ({ id: r.id, transports: r.transports ?? undefined })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await storeChallenge(db, user.id, options.challenge, "register");
  return options;
}

export async function finishRegistration(db: Db, userId: string, response: RegistrationResponseJSON, deviceName: string) {
  const challenge = challengeFromResponse(response);
  if (!(await consumeChallenge(db, userId, challenge, "register"))) {
    throw new AppError(400, "challenge_invalid", "registration challenge expired or already used; start again");
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.publicOrigin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  }).catch((err) => {
    throw new AppError(400, "passkey_rejected", `passkey registration failed: ${err.message}`);
  });
  if (!verification.verified) throw new AppError(400, "passkey_rejected", "passkey registration could not be verified");
  const { credential } = verification.registrationInfo;
  await db.query(
    "INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_name) VALUES ($1, $2, $3, $4, $5, $6)",
    [credential.id, userId, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? null, deviceName.slice(0, 80) || "Passkey"],
  );
  return { id: credential.id, deviceName };
}

/**
 * The challenge for approving something is derived from what is being
 * approved, plus randomness. The signed challenge is then a record that the
 * owner, on their own device, agreed to exactly this approval and amount.
 */
function approvalChallenge(approval: { id: string; amountCents: number; summary: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ approval: approval.id, amountCents: approval.amountCents, summary: approval.summary }))
    .update(randomBytes(16))
    .digest("base64url");
}

export async function startApprovalSignature(
  db: Db,
  userId: string,
  approval: { id: string; amountCents: number; summary: string },
) {
  const { rows } = await db.query("SELECT id, transports FROM passkeys WHERE user_id = $1", [userId]);
  if (!rows.length) throw new AppError(400, "no_passkey", "register a passkey before approving");
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    challenge: approvalChallenge(approval),
    userVerification: "required",
    allowCredentials: rows.map((r) => ({ id: r.id, transports: r.transports ?? undefined })),
  });
  await storeChallenge(db, userId, options.challenge, "approve", approval.id);
  return options;
}

/**
 * Check a passkey signature for one approval, inside the caller's
 * transaction. Returns the id of the passkey that signed.
 */
export async function verifyApprovalSignature(
  tx: Tx,
  userId: string,
  approvalId: string,
  response: AuthenticationResponseJSON,
): Promise<string> {
  const challenge = challengeFromResponse(response);
  if (!(await consumeChallenge(tx, userId, challenge, "approve", approvalId))) {
    throw new AppError(400, "challenge_invalid", "approval challenge expired, already used, or for a different request");
  }
  const { rows } = await tx.query(
    "SELECT id, public_key, counter, transports FROM passkeys WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [response.id, userId],
  );
  const stored = rows[0];
  if (!stored) throw new AppError(400, "passkey_unknown", "that passkey is not registered to this account");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.publicOrigin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    credential: {
      id: stored.id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports ?? undefined,
    },
  }).catch((err) => {
    throw new AppError(400, "passkey_rejected", `passkey check failed: ${err.message}`);
  });
  if (!verification.verified) throw new AppError(400, "passkey_rejected", "passkey signature did not verify");
  await tx.query("UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [
    stored.id,
    verification.authenticationInfo.newCounter,
  ]);
  return stored.id;
}
