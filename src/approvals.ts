import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AgentKey } from "./auth.js";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { hasPasskey, startApprovalSignature, verifyApprovalSignature } from "./passkeys.js";
import type { Tool } from "./registry.js";
import { approveExternalCancel, denyExternalCancel } from "./external.js";
import { activateSubscription, resumeSubscription } from "./subscriptions.js";

export type ApprovalKind = "call" | "subscription" | "resume" | "external_cancel";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: "pending" | "approved" | "denied" | "used";
  amountCents: number;
  input: Record<string, unknown>;
  tool: string | null;
  plan: string | null;
  interval: string | null;
  subscriptionId: string | null;
  externalSubscriptionId: string | null;
  externalName: string | null;
  agentKeyId: string | null;
  agentKeyName: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const approvalColumns = `ap.id, ap.kind, ap.status, ap.amount_cents AS "amountCents", ap.input, t.slug AS tool,
  pl.slug AS plan, COALESCE(pl.interval, es.interval) AS interval, ap.subscription_id AS "subscriptionId",
  ap.external_subscription_id AS "externalSubscriptionId", es.name AS "externalName", ap.agent_key_id AS "agentKeyId",
  k.name AS "agentKeyName", ap.created_at AS "createdAt", ap.decided_at AS "decidedAt"`;
const approvalFrom = `approvals ap
  LEFT JOIN tools t ON t.id = ap.tool_id
  LEFT JOIN subscriptions s ON s.id = ap.subscription_id
  LEFT JOIN plans pl ON pl.id = s.plan_id
  LEFT JOIN external_subscriptions es ON es.id = ap.external_subscription_id
  LEFT JOIN agent_keys k ON k.id = ap.agent_key_id`;

/** Human-readable line shown on the approval screen and bound into the passkey challenge. */
export function describeApproval(a: Pick<Approval, "kind" | "amountCents" | "tool" | "plan" | "interval" | "externalName">): string {
  const dollars = `$${(a.amountCents / 100).toFixed(2)}`;
  if (a.kind === "external_cancel") {
    return `Cancel ${a.externalName}${a.amountCents > 0 ? ` (early termination fee about ${dollars})` : ""}`;
  }
  if (a.kind === "call") return `Pay ${dollars} for one call to ${a.tool}`;
  if (a.kind === "subscription") return `Subscribe to ${a.plan} for ${dollars} per ${a.interval}, renewing automatically`;
  return `Renew ${a.plan} at ${dollars} per ${a.interval}`;
}

export async function createCallApproval(db: Db, agentKey: AgentKey, tool: Tool, amountCents: number, input: unknown): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO approvals (kind, user_id, agent_key_id, tool_id, amount_cents, input)
     VALUES ('call', $1, $2, $3, $4, $5) RETURNING id`,
    [agentKey.userId, agentKey.id, tool.id, amountCents, JSON.stringify(input)],
  );
  return rows[0].id;
}

export async function getApproval(db: Db, userId: string, id: string): Promise<Approval> {
  const { rows } = await db.query(`SELECT ${approvalColumns} FROM ${approvalFrom} WHERE ap.id = $1 AND ap.user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "approval not found");
  return rows[0];
}

export async function listApprovals(db: Db, userId: string, status?: string) {
  const { rows } = await db.query(
    `SELECT ${approvalColumns} FROM ${approvalFrom}
      WHERE ap.user_id = $1 AND ($2::text IS NULL OR ap.status = $2)
      ORDER BY ap.created_at DESC LIMIT 100`,
    [userId, status ?? null],
  );
  return rows.map((a: Approval) => ({ ...a, summary: describeApproval(a) }));
}

/** What an agent may see about one of its own approvals. */
export async function approvalStatusForAgent(db: Db, agentKey: AgentKey, id: string) {
  const { rows } = await db.query(
    `SELECT ap.id, ap.kind, ap.status, ap.amount_cents AS "amountCents", ap.subscription_id AS "subscriptionId",
            ap.external_subscription_id AS "externalSubscriptionId"
       FROM approvals ap WHERE ap.id = $1 AND ap.agent_key_id = $2`,
    [id, agentKey.id],
  );
  if (!rows[0]) throw new AppError(404, "not_found", "approval not found");
  return rows[0];
}

/** Step 1 of approving: get WebAuthn options whose challenge is bound to this approval. */
export async function startApproval(db: Db, userId: string, id: string) {
  const approval = await getApproval(db, userId, id);
  if (approval.status !== "pending") throw new AppError(409, "not_pending", `this approval is already ${approval.status}`);
  const summary = describeApproval(approval);
  const options = await startApprovalSignature(db, userId, { id, amountCents: approval.amountCents, summary });
  return { summary, options };
}

/**
 * Step 2 of approving. With a passkey signature, verifies it and applies the
 * approval: marks a call approval usable, or charges and activates a
 * subscription. Without one, only allowed when passkeys are not required and
 * the owner has none registered yet.
 */
export async function approve(
  db: Db,
  userId: string,
  id: string,
  passkeyResponse?: AuthenticationResponseJSON,
  opts: { requirePasskey?: boolean } = {},
) {
  const requirePasskey = opts.requirePasskey ?? config.requirePasskey;
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, kind, status, amount_cents AS "amountCents", subscription_id AS "subscriptionId",
              external_subscription_id AS "externalSubscriptionId"
         FROM approvals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    const approval = rows[0];
    if (!approval) throw new AppError(404, "not_found", "approval not found");
    if (approval.status !== "pending") throw new AppError(409, "not_pending", `this approval is already ${approval.status}`);

    let passkeyId: string | null = null;
    if (passkeyResponse) {
      passkeyId = await verifyApprovalSignature(tx, userId, id, passkeyResponse);
    } else if (requirePasskey || (await hasPasskey(tx, userId))) {
      throw new AppError(401, "passkey_required", "approve this with your passkey");
    }

    // Single calls stay 'approved' until the agent retries and uses them; subscription approvals apply now.
    let newStatus = "approved";
    if (approval.kind === "subscription") {
      await activateSubscription(tx, approval.subscriptionId);
      newStatus = "used";
    } else if (approval.kind === "resume") {
      await resumeSubscription(tx, approval.subscriptionId, approval.amountCents);
      newStatus = "used";
    } else if (approval.kind === "external_cancel") {
      await approveExternalCancel(tx, approval.externalSubscriptionId);
      newStatus = "used";
    }
    await tx.query("UPDATE approvals SET status = $2, decided_at = now(), passkey_id = $3 WHERE id = $1", [id, newStatus, passkeyId]);
    return { id, status: newStatus, signedWithPasskey: passkeyId !== null };
  });
}

/** Saying no never spends money, so it needs no passkey. */
export async function deny(db: Db, userId: string, id: string) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE approvals SET status = 'denied', decided_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING kind, subscription_id AS "subscriptionId", external_subscription_id AS "externalSubscriptionId", input`,
      [id, userId],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "no pending approval with that id");
    if (rows[0].kind === "subscription") {
      await tx.query("UPDATE subscriptions SET status = 'denied' WHERE id = $1 AND status = 'pending_approval'", [rows[0].subscriptionId]);
    }
    if (rows[0].kind === "external_cancel") {
      await denyExternalCancel(tx, rows[0].externalSubscriptionId, rows[0].input?.previousStatus);
    }
  });
}
