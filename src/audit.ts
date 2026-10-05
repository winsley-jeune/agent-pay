import { createHash } from "node:crypto";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";

// The "why" log: one append-only, hash-chained list per owner of what agents
// and AgentPay did, the instruction it came from, why, and what happened.
// Each entry's hash covers the previous one, so a changed or missing entry
// shows up when the chain is verified.

export interface AuditEntry {
  actor: "agent" | "owner" | "system" | "helper";
  agentKeyId?: string | null;
  kind: string;
  summary: string;
  instruction?: string | null;
  reason?: string | null;
  result?: string | null;
  data?: Record<string, unknown>;
}

const GENESIS = "0".repeat(64);

/** JSON with sorted keys: jsonb doesn't keep key order, and the hash must survive the round trip. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

function entryHash(prevHash: string, userId: string, seq: number, createdAt: string, e: AuditEntry): string {
  return createHash("sha256")
    .update(prevHash)
    .update(
      JSON.stringify([
        userId,
        seq,
        createdAt,
        e.actor,
        e.agentKeyId ?? null,
        e.kind,
        e.summary,
        e.instruction ?? null,
        e.reason ?? null,
        e.result ?? null,
        canonical(e.data ?? {}),
      ]),
    )
    .digest("hex");
}

const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.slice(0, n));

/** Append to the owner's chain inside the caller's transaction. */
export async function auditTx(tx: Tx, userId: string, e: AuditEntry): Promise<void> {
  // One writer per owner at a time, so two entries never claim the same seq or previous hash.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${userId}`]);
  const { rows } = await tx.query("SELECT seq, hash FROM audit_log WHERE user_id = $1 ORDER BY seq DESC LIMIT 1", [userId]);
  const seq = (rows[0]?.seq ?? 0) + 1;
  const prevHash = rows[0]?.hash ?? GENESIS;
  // Millisecond ISO time, stored as given, so verification hashes the same string.
  const createdAt = new Date().toISOString();
  const entry: AuditEntry = {
    ...e,
    summary: e.summary.slice(0, 500),
    instruction: clip(e.instruction, 500),
    reason: clip(e.reason, 500),
    result: clip(e.result, 500),
    data: e.data ?? {},
  };
  await tx.query(
    `INSERT INTO audit_log (user_id, seq, actor, agent_key_id, kind, summary, instruction, reason, result, data, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      userId, seq, entry.actor, entry.agentKeyId ?? null, entry.kind, entry.summary, entry.instruction, entry.reason, entry.result,
      JSON.stringify(entry.data), prevHash, entryHash(prevHash, userId, seq, createdAt, entry), createdAt,
    ],
  );
}

export async function audit(db: Db, userId: string, e: AuditEntry): Promise<void> {
  await withTx(db, (tx) => auditTx(tx, userId, e));
}

export async function listAudit(db: Db, userId: string, limit = 200) {
  const { rows } = await db.query(
    `SELECT a.seq, a.actor, a.kind, a.summary, a.instruction, a.reason, a.result, a.data, a.hash,
            a.created_at AS "createdAt", k.name AS "agentKeyName"
       FROM audit_log a LEFT JOIN agent_keys k ON k.id = a.agent_key_id
      WHERE a.user_id = $1 ORDER BY a.seq DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Recompute the whole chain. `ok: false` names the first entry that doesn't match. */
export async function verifyAudit(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT seq, actor, agent_key_id AS "agentKeyId", kind, summary, instruction, reason, result, data,
            prev_hash AS "prevHash", hash, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
       FROM audit_log WHERE user_id = $1 ORDER BY seq`,
    [userId],
  );
  let prev = GENESIS;
  for (const [i, r] of rows.entries()) {
    if (r.seq !== i + 1) return { ok: false as const, entries: rows.length, brokenAt: i + 1, problem: "an entry is missing" };
    if (r.prevHash !== prev || entryHash(prev, userId, r.seq, r.createdAt, r) !== r.hash) {
      return { ok: false as const, entries: rows.length, brokenAt: r.seq, problem: "an entry was changed" };
    }
    prev = r.hash;
  }
  return { ok: true as const, entries: rows.length, lastHash: prev };
}
