import { config } from "./config.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { signBytes } from "./signing.js";

// Evidence bundles: a slice of the owner's hash-chained "why" log, exported
// with everything needed to check it independently, and signed by AgentPay.
// A bank, a store or the guarantee desk can verify it with
// `npx @winsley-jeune/agentpay-verify evidence bundle.json` (or the
// verifyEvidenceBundle function), without access to AgentPay's database.
// Ideas from askgrokwallet, Steward's audit bundles and the AEP dispute bundle.
//
// Checking a bundle:
//   1. each entry's hash = sha256(previous hash + JSON of its fields), as in src/audit.ts
//   2. the first entry's previous hash is the bundle's anchor; each next entry links to the one before
//   3. AgentPay's Ed25519 signature covers the header (owner, seq range, anchor, head hash, issuer, time)

export const EVIDENCE_FORMAT = "agentpay-evidence-v1";

export interface EvidenceEntry {
  seq: number;
  createdAt: string;
  actor: string;
  agentKeyId: string | null;
  kind: string;
  summary: string;
  instruction: string | null;
  reason: string | null;
  result: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** The exact bytes AgentPay signs for a bundle header. */
export function headerBytes(h: { format: string; issuer: string; userId: string; firstSeq: number; lastSeq: number; anchor: string; head: string; exportedAt: string; reason: string | null }) {
  return Buffer.from(JSON.stringify([h.format, h.issuer, h.userId, h.firstSeq, h.lastSeq, h.anchor, h.head, h.exportedAt, h.reason]));
}

export async function exportEvidence(db: Db, userId: string, opts: { from?: string; to?: string; incidentId?: string; reason?: string } = {}) {
  let from = opts.from ? new Date(opts.from) : new Date(Date.now() - 7 * 86_400_000);
  let to = opts.to ? new Date(opts.to) : new Date();
  let reason = opts.reason ?? null;
  if (opts.incidentId) {
    const { rows } = await db.query(`SELECT created_at AS at, description FROM incidents WHERE id = $1 AND user_id = $2`, [opts.incidentId, userId]);
    if (!rows[0]) throw new AppError(404, "not_found", "incident not found");
    from = new Date(new Date(rows[0].at).getTime() - 86_400_000);
    to = new Date(new Date(rows[0].at).getTime() + 3_600_000);
    reason ??= `incident ${opts.incidentId}: ${rows[0].description}`.slice(0, 300);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new AppError(400, "invalid_range", "give a valid from/to range");

  const { rows } = await db.query(
    `SELECT seq, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt", actor, agent_key_id AS "agentKeyId", kind, summary,
            instruction, reason, result, data, prev_hash AS "prevHash", hash
       FROM audit_log WHERE user_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY seq LIMIT 5000`,
    [userId, from, to],
  );
  const entries = rows as EvidenceEntry[];
  if (!entries.length) throw new AppError(404, "no_entries", "nothing in the log for that time");
  const header = {
    format: EVIDENCE_FORMAT, issuer: config.publicUrl, userId, firstSeq: entries[0].seq, lastSeq: entries.at(-1)!.seq,
    anchor: entries[0].prevHash, head: entries.at(-1)!.hash, exportedAt: new Date().toISOString(), reason,
  };
  const signature = await signBytes(db, headerBytes(header));
  return { ...header, entries, signature, verify: "npx @winsley-jeune/agentpay-verify evidence <this file>" };
}
