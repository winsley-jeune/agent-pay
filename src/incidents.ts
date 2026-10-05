import type { AgentKey } from "./auth.js";
import { auditTx } from "./audit.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";

// When an agent gets it wrong: every incident gets one of four kinds, which
// decides who should carry the loss, and the guarantee policy says in advance
// what AgentPay covers (Alipay's compensation promise and Ant's AgentSafePay,
// but with the limit written down).

export const INCIDENT_KINDS = ["misjudgment", "condition_breach", "system_bug", "hijacked", "unclassified"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const KIND_LABELS: Record<IncidentKind, string> = {
  misjudgment: "A mistake within the authority you gave (wrong item, wrong size, wrong date)",
  condition_breach: "The agent went outside the limits or conditions you set",
  system_bug: "AgentPay or a provider got it wrong",
  hijacked: "Someone else controlled the agent (stolen key, prompt injection)",
  unclassified: "Not sure yet",
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Which kinds AgentPay would cover, and up to how much. config.guaranteeMaxCents = 0 means no guarantee is offered yet. */
export function guaranteePolicy() {
  const max = config.guaranteeMaxCents;
  return {
    offered: max > 0,
    maxPerIncidentCents: max,
    coveredKinds: ["condition_breach", "system_bug", "hijacked"] as IncidentKind[],
    text:
      max > 0
        ? [
            `AgentPay refunds up to ${usd(max)} per incident when money left your wallet because a limit AgentPay enforces failed (condition_breach, system_bug), or because someone else used your agent's key before you could revoke it (hijacked, reported within 7 days).`,
            "Not covered: mistakes within the authority you gave (misjudgment), and purchases AgentPay didn't pay for, such as a store charging your own card. Those follow the store's refund policy.",
          ]
        : [
            "AgentPay doesn't offer a refund guarantee yet. Incidents are still recorded and classified, so the cause is clear when you ask a store or provider for a refund.",
          ],
    kinds: KIND_LABELS,
  };
}

function guaranteeFor(kind: IncidentKind, amountCents: number, createdAt: Date) {
  const p = guaranteePolicy();
  if (!p.offered) return { eligible: false, upToCents: 0, why: "no guarantee is offered yet" };
  if (!p.coveredKinds.includes(kind)) return { eligible: false, upToCents: 0, why: kind === "unclassified" ? "classify it first" : "this kind isn't covered" };
  if (kind === "hijacked" && Date.now() - new Date(createdAt).getTime() > 7 * 86_400_000) return { eligible: false, upToCents: 0, why: "reported more than 7 days later" };
  return { eligible: true, upToCents: Math.min(amountCents, p.maxPerIncidentCents), why: "covered by the guarantee" };
}

export async function reportIncidentTx(
  tx: Tx,
  userId: string,
  input: { description: string; kind?: IncidentKind; amountCents?: number; holdId?: string | null; agentKeyId?: string | null },
  reportedBy: "owner" | "agent",
) {
  let { amountCents, agentKeyId } = input;
  if (input.holdId) {
    const { rows } = await tx.query(
      `SELECT h.agent_key_id AS "agentKeyId", COALESCE(h.captured_cents, h.amount_cents) AS amount
         FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id WHERE h.id = $1 AND k.user_id = $2`,
      [input.holdId, userId],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "no call with that id");
    amountCents ??= rows[0].amount;
    agentKeyId ??= rows[0].agentKeyId;
  }
  const { rows } = await tx.query(
    `INSERT INTO incidents (user_id, agent_key_id, hold_id, kind, description, amount_cents, reported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, agentKeyId ?? null, input.holdId ?? null, input.kind ?? "unclassified", input.description.slice(0, 2000), amountCents ?? 0, reportedBy],
  );
  await auditTx(tx, userId, {
    actor: reportedBy, agentKeyId: reportedBy === "agent" ? agentKeyId : null, kind: "incident_reported",
    summary: `Incident: ${input.description.slice(0, 200)}`, result: input.kind ?? "unclassified", data: { incidentId: rows[0].id },
  });
  return rows[0].id as string;
}

export async function reportIncident(
  db: Db,
  userId: string,
  input: { description: string; kind?: IncidentKind; amountCents?: number; holdId?: string | null },
  agentKey: AgentKey | null = null,
) {
  const id = await withTx(db, (tx) => reportIncidentTx(tx, userId, { ...input, agentKeyId: agentKey?.id ?? null }, agentKey ? "agent" : "owner"));
  return getIncident(db, userId, id);
}

const incidentColumns = `i.id, i.kind, i.description, i.amount_cents AS "amountCents", i.status, i.resolution, i.reported_by AS "reportedBy",
  i.hold_id AS "holdId", k.name AS "agentKeyName", i.created_at AS "createdAt", i.resolved_at AS "resolvedAt"`;

function withGuarantee<T extends { kind: IncidentKind; amountCents: number; createdAt: Date }>(i: T) {
  return { ...i, kindLabel: KIND_LABELS[i.kind], guarantee: guaranteeFor(i.kind, i.amountCents, i.createdAt) };
}

export async function getIncident(db: Db, userId: string, id: string) {
  const { rows } = await db.query(`SELECT ${incidentColumns} FROM incidents i LEFT JOIN agent_keys k ON k.id = i.agent_key_id WHERE i.id = $1 AND i.user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "incident not found");
  return withGuarantee(rows[0]);
}

export async function listIncidents(db: Db, userId: string, opts: { includeResolved?: boolean } = {}) {
  const { rows } = await db.query(
    `SELECT ${incidentColumns} FROM incidents i LEFT JOIN agent_keys k ON k.id = i.agent_key_id
      WHERE i.user_id = $1 AND ($2 OR i.status = 'open') ORDER BY i.created_at DESC LIMIT 200`,
    [userId, !!opts.includeResolved],
  );
  return rows.map(withGuarantee);
}

/** The owner classifies or resolves an incident (e.g. "the store refunded it"). */
export async function updateIncident(db: Db, userId: string, id: string, input: { kind?: IncidentKind; resolution?: string; resolved?: boolean }) {
  const { rowCount } = await db.query(
    `UPDATE incidents SET kind = COALESCE($3, kind), resolution = COALESCE($4, resolution),
            status = CASE WHEN $5 THEN 'resolved' ELSE status END, resolved_at = CASE WHEN $5 THEN now() ELSE resolved_at END
      WHERE id = $1 AND user_id = $2`,
    [id, userId, input.kind ?? null, input.resolution?.slice(0, 1000) ?? null, !!input.resolved],
  );
  if (!rowCount) throw new AppError(404, "not_found", "incident not found");
  return getIncident(db, userId, id);
}
