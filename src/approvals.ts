import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AgentKey } from "./auth.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { hasPasskey, startApprovalSignature, verifyApprovalSignature } from "./passkeys.js";
import type { Tool } from "./registry.js";
import { approveExternalCancel, denyExternalCancel } from "./external.js";
import { approveGroceryOrder, denyGroceryOrder } from "./grocery.js";
import { ACTION_LABELS, activateGrant, denyGrant, recordConsent, RISK_STATEMENT, type BrowserAction } from "./permissions.js";
import { activateSubscription, resumeSubscription } from "./subscriptions.js";
import { auditTx } from "./audit.js";
import { activateEnvelope, applyUnfreeze, approveVaultUnlock, denyEnvelope, denyVaultUnlock } from "./controls.js";
import { activateMandate, denyMandate } from "./mandates.js";
import { getProtection, helperOn, needsCosign } from "./helpers.js";
import { CHECKOUT_BUFFER } from "./grocery.js";

export type ApprovalKind =
  | "call" | "subscription" | "resume" | "external_cancel" | "grocery_order" | "risk_consent" | "browser_access"
  | "envelope" | "buy_mandate" | "unfreeze" | "vault_unlock";

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
  /** Why AgentPay asked, e.g. "no spending rule covers this call". */
  why: string | null;
  /** The agent's own reason. */
  agentReason: string | null;
  maxPriceCents: number | null;
  billedThrough: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const approvalColumns = `ap.id, ap.kind, ap.status, ap.amount_cents AS "amountCents", ap.input, t.slug AS tool,
  pl.slug AS plan, COALESCE(pl.interval, es.interval) AS interval, ap.subscription_id AS "subscriptionId",
  ap.external_subscription_id AS "externalSubscriptionId", es.name AS "externalName", ap.grocery_list_id AS "groceryListId", ap.agent_key_id AS "agentKeyId",
  k.name AS "agentKeyName", ap.why, ap.agent_reason AS "agentReason", s.max_price_cents AS "maxPriceCents", es.billed_through AS "billedThrough",
  ap.needs_cosign AS "needsCosign", ap.owner_signed_at AS "ownerSignedAt", ap.helper_signed_at AS "helperSignedAt", ap.cosign_due_at AS "cosignDueAt",
  ap.created_at AS "createdAt", ap.decided_at AS "decidedAt"`;
const approvalFrom = `approvals ap
  LEFT JOIN tools t ON t.id = ap.tool_id
  LEFT JOIN subscriptions s ON s.id = ap.subscription_id
  LEFT JOIN plans pl ON pl.id = s.plan_id
  LEFT JOIN external_subscriptions es ON es.id = ap.external_subscription_id
  LEFT JOIN agent_keys k ON k.id = ap.agent_key_id`;

/** Human-readable line shown on the approval screen and bound into the passkey challenge. */
export function describeApproval(a: Pick<Approval, "kind" | "amountCents" | "tool" | "plan" | "interval" | "externalName" | "input">): string {
  const dollars = `$${(a.amountCents / 100).toFixed(2)}`;
  if (a.kind === "risk_consent") return `I understand the risks: ${RISK_STATEMENT.title.toLowerCase()} (version ${(a.input as { version?: number }).version})`;
  if (a.kind === "browser_access") {
    const i = a.input as { site?: string; actions?: BrowserAction[]; days?: number };
    return `Let my agent use my signed-in ${i.site} to ${(i.actions ?? []).map((x) => ACTION_LABELS[x]).join(", ")}, for ${i.days} days`;
  }
  if (a.kind === "grocery_order") {
    const i = a.input as { title?: string; store?: string; items?: number; maxCents?: number };
    const store = i.store === "whole_foods" ? "Whole Foods" : "Walmart";
    return `Place ${store} order "${i.title}" (${i.items} items): about ${dollars}, up to $${((i.maxCents ?? a.amountCents) / 100).toFixed(2)} at checkout`;
  }
  if (a.kind === "external_cancel") {
    return `Cancel ${a.externalName}${a.amountCents > 0 ? ` (early termination fee about ${dollars})` : ""}`;
  }
  if (a.kind === "envelope") {
    const i = a.input as { name?: string; agent?: string | null; expiresOn?: string };
    return `Set aside ${dollars} in "${i.name}" for ${i.agent ?? "any of my agents"} until ${i.expiresOn}`;
  }
  if (a.kind === "buy_mandate") {
    const i = a.input as { title?: string; site?: string; maxPriceCents?: number; quantity?: number; expiresOn?: string };
    return `Let my agent buy "${i.title}" on ${i.site} at up to $${((i.maxPriceCents ?? 0) / 100).toFixed(2)} each (at most ${i.quantity}) until ${i.expiresOn}`;
  }
  if (a.kind === "unfreeze") return "Unfreeze my agents: they can spend again within their limits";
  if (a.kind === "vault_unlock") return `Move ${dollars} from my vault back to my wallet after a ${(a.input as { delayHours?: number }).delayHours}-hour wait`;
  if (a.kind === "call" && !a.tool) {
    const i = a.input as { protocol?: string; host?: string };
    return `Pay ${dollars} to ${i.host} (${i.protocol === "a2a" ? "an outside agent" : "x402"}), in USDC from AgentPay's wallet`;
  }
  if (a.kind === "call") return `Pay ${dollars} for one call to ${a.tool}`;
  if (a.kind === "subscription") return `Subscribe to ${a.plan} for ${dollars} per ${a.interval}, renewing automatically`;
  return `Renew ${a.plan} at ${dollars} per ${a.interval}`;
}

const PER_YEAR: Record<string, number> = { week: 52, month: 12, year: 1 };

/**
 * The "final confirmation" lines shown with the summary before the owner signs
 * (modelled on Japan's 2022 rule for subscription order screens): what it costs
 * per period and over a year, when it renews, the most it can cost, and how to
 * undo it. Bound into the passkey challenge together with the summary.
 */
export function approvalTerms(
  a: Pick<Approval, "kind" | "amountCents" | "tool" | "plan" | "interval" | "externalName" | "input" | "maxPriceCents" | "billedThrough">,
): string[] {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const i = (a.input ?? {}) as Record<string, any>;
  switch (a.kind) {
    case "call":
      if (!a.tool) {
        return [
          `One charge of ${usd(a.amountCents)} from your prepaid wallet`,
          "AgentPay pays the seller in USDC from its own wallet once you approve; it can't be taken back after the seller settles it",
          "You get the money back only if the seller refuses the payment",
          "Can be used once, for this payment only",
        ];
      }
      return [`One charge of ${usd(a.amountCents)} from your prepaid wallet`, "Not charged if the provider fails or times out", "Can be used once, for this call only"];
    case "subscription":
    case "resume": {
      const perYear = PER_YEAR[a.interval ?? "month"] ?? 12;
      return [
        `${usd(a.amountCents)} now, then ${usd(a.amountCents)} every ${a.interval}`,
        `About ${usd(a.amountCents * perYear)} over 12 months`,
        "Renews automatically from your wallet until you cancel",
        ...(a.maxPriceCents ? [`If the price goes above ${usd(a.maxPriceCents)}, it stops until you approve the new price`] : []),
        "Cancel any time on the Subscriptions page; it runs to the end of the paid period, or choose End now",
      ];
    }
    case "grocery_order":
      return [
        `Estimated ${usd(a.amountCents)}; your agent may check out up to ${usd(i.maxCents ?? a.amountCents)} (${Math.round(CHECKOUT_BUFFER * 100)}% for weighed produce and fees)`,
        "One checkout only. If the cart changes, this approval is cancelled",
        "Refunds and substitutions follow the store's own policies",
      ];
    case "external_cancel":
      return [
        ...(a.amountCents > 0 ? [`Cancelling may cost about ${usd(a.amountCents)} (early termination fee or device balance)`] : []),
        a.billedThrough && a.billedThrough !== "direct" ? `Billed through ${a.billedThrough}: it has to be cancelled there` : "Cancelled with the company that bills it",
        "Your agent can record it as cancelled only after you approve",
      ];
    case "browser_access":
      return [
        ...(i.purpose ? [`Purpose: ${i.purpose}`] : []),
        `Ends after ${i.days} days; revoke any time on the Permissions page`,
        "Your agent never types passwords or sign-in codes and never sees payment details",
      ];
    case "envelope":
      return [
        `${usd(a.amountCents)} moves from your wallet now`,
        `Only for ${i.tools?.length ? `these tools: ${i.tools.join(", ")}` : "any paid tool"}${i.purpose ? ` (${i.purpose})` : ""}`,
        "Calls paid from it don't ask you again, within your agent's per-call limit and caps",
        `Ends on ${i.expiresOn}; whatever is left returns to your wallet. You can close it sooner`,
      ];
    case "buy_mandate":
      return [
        `At most ${i.quantity} at up to ${usd(i.maxPriceCents ?? 0)} each: ${usd(a.amountCents)} in total`,
        `Only on ${i.site}, only after your agent checks this mandate, until ${i.expiresOn}`,
        "AgentPay can't block the store's checkout yet: this is a rule your agent follows, logged and checked afterwards",
        "Revoke it any time on the Price watch page",
      ];
    case "unfreeze":
      return ["Agents can call paid tools again, within each one's level and limits", "AgentPay plan renewals resume"];
    case "vault_unlock":
      return [`The money moves after ${i.delayHours} hours`, "You can cancel during the wait", "Until then, no agent or approval can spend it"];
    default:
      return [];
  }
}

export async function createCallApproval(
  db: Db,
  agentKey: AgentKey,
  tool: Tool,
  amountCents: number,
  input: unknown,
  meta: { why?: string; agentReason?: string } = {},
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO approvals (kind, user_id, agent_key_id, tool_id, amount_cents, input, why, agent_reason)
     VALUES ('call', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [agentKey.userId, agentKey.id, tool.id, amountCents, JSON.stringify(input), meta.why ?? null, meta.agentReason?.slice(0, 500) ?? null],
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
  return rows.map((a: Approval) => ({ ...a, summary: describeApproval(a), terms: approvalTerms(a) }));
}

/** What an agent may see about one of its own approvals, including whether it waits for a second signature. */
export async function approvalStatusForAgent(db: Db, agentKey: AgentKey, id: string) {
  const { rows } = await db.query(
    `SELECT ap.id, ap.kind, ap.status, ap.amount_cents AS "amountCents", ap.subscription_id AS "subscriptionId",
            ap.external_subscription_id AS "externalSubscriptionId", ap.grocery_list_id AS "groceryListId",
            ap.needs_cosign AS "needsCosign", ap.owner_signed_at AS "ownerSignedAt", ap.helper_signed_at AS "helperSignedAt",
            ap.cosign_due_at AS "cosignDueAt"
       FROM approvals ap WHERE ap.id = $1 AND ap.agent_key_id = $2`,
    [id, agentKey.id],
  );
  const a = rows[0];
  if (!a) throw new AppError(404, "not_found", "approval not found");
  let message: string | undefined;
  if (a.status === "pending" && a.needsCosign) {
    message = a.ownerSignedAt
      ? a.cosignDueAt
        ? `The owner approved. This is a protected account, so it also needs a trusted helper's signature, or it goes through on ${new Date(a.cosignDueAt).toISOString()} unless a helper objects. Wait; don't ask the owner to approve again.`
        : "The owner approved, but a trusted helper has to review it first. Wait; don't ask the owner again or urge them to hurry."
      : "Waiting for the owner. This is a protected account: after the owner approves, it also needs a helper's signature or a waiting period.";
  }
  return { ...a, ...(message ? { message } : {}) };
}

/**
 * Asked before the owner signs a big or sensitive approval on a protected
 * account (payment apps in China ask this; Japanese bank tellers are trained
 * to). Scammers phone their targets, demand secrecy and create urgency.
 */
export const SCAM_QUESTIONS = {
  calledYou: "Did someone phone, text or message you and ask you to do this?",
  keepSecret: "Were you told to keep it secret, or not to tell your family or bank?",
  urgent: "Were you told it has to happen right now, or something bad will happen?",
} as const;
export type ScamAnswers = Record<keyof typeof SCAM_QUESTIONS, boolean>;

/** Load an approval for someone who may act on it: its owner, or a trusted helper on the owner's account. */
async function approvalForSigner(q: Db | Tx, signerId: string, id: string, lock = false) {
  const { rows } = await q.query(
    `SELECT id, user_id AS "ownerId", kind, status, amount_cents AS "amountCents", subscription_id AS "subscriptionId",
            external_subscription_id AS "externalSubscriptionId", grocery_list_id AS "groceryListId", browser_grant_id AS "browserGrantId", input,
            envelope_id AS "envelopeId", buy_mandate_id AS "buyMandateId", vault_unlock_id AS "vaultUnlockId",
            owner_signed_at AS "ownerSignedAt", owner_passkey_id AS "ownerPasskeyId", helper_signed_at AS "helperSignedAt", cosign_due_at AS "cosignDueAt"
       FROM approvals WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  const approval = rows[0];
  if (!approval) throw new AppError(404, "not_found", "approval not found");
  if (approval.ownerId === signerId) return { approval, role: "owner" as const, helperLabel: null };
  const helper = await helperOn(q, signerId, approval.ownerId);
  if (!helper) throw new AppError(404, "not_found", "approval not found");
  return { approval, role: "helper" as const, helperLabel: helper.label };
}

/** Step 1 of approving: get WebAuthn options whose challenge is bound to this approval. The signer is the owner or a helper. */
export async function startApproval(db: Db, signerId: string, id: string) {
  const { approval: row, role } = await approvalForSigner(db, signerId, id);
  const approval = await getApproval(db, row.ownerId, id);
  if (approval.status !== "pending") throw new AppError(409, "not_pending", `this approval is already ${approval.status}`);
  if (role === "helper" && !needsCosign(await getProtection(db, row.ownerId), approval.kind, approval.amountCents)) {
    throw new AppError(403, "owner_only", "only the owner approves this; helpers co-sign the approvals that need a second signature");
  }
  const summary = describeApproval(approval);
  const terms = approvalTerms(approval);
  const options = await startApprovalSignature(db, signerId, { id, amountCents: approval.amountCents, summary, terms });
  const askScam = role === "owner" && !(approval as any).ownerSignedAt && needsCosign(await getProtection(db, row.ownerId), approval.kind, approval.amountCents);
  return { summary, terms, options, signingAs: role, ...(askScam ? { scamCheck: SCAM_QUESTIONS } : {}) };
}

/**
 * Step 2 of approving. `signerId` is whoever signs: the owner, or a trusted
 * helper co-signing on a protected account. With a passkey signature, verifies
 * it; without one, only allowed when passkeys are not required and the signer
 * has none registered yet.
 *
 * On a protected account, big and sensitive approvals need the owner's
 * signature plus a helper's, or the owner's signature and the waiting period
 * (completeDelayedApprovals). Helpers never approve alone.
 */
export async function approve(
  db: Db,
  signerId: string,
  id: string,
  passkeyResponse?: AuthenticationResponseJSON,
  opts: { requirePasskey?: boolean; scamCheck?: ScamAnswers } = {},
) {
  const requirePasskey = opts.requirePasskey ?? config.requirePasskey;
  return withTx(db, async (tx) => {
    const { approval, role, helperLabel } = await approvalForSigner(tx, signerId, id, true);
    const cosignNeeded = role === "owner" && needsCosign(await getProtection(tx, approval.ownerId), approval.kind, approval.amountCents);
    const answers = opts.scamCheck;
    if (cosignNeeded && !approval.ownerSignedAt && (!answers || Object.keys(SCAM_QUESTIONS).some((k) => typeof (answers as any)[k] !== "boolean"))) {
      throw new AppError(400, "scam_check_required", "answer the three safety questions before approving", { questions: SCAM_QUESTIONS });
    }
    if (approval.status !== "pending") throw new AppError(409, "not_pending", `this approval is already ${approval.status}`);
    const ownerId: string = approval.ownerId;

    let passkeyId: string | null = null;
    if (passkeyResponse) {
      passkeyId = await verifyApprovalSignature(tx, signerId, id, passkeyResponse);
    } else if (requirePasskey || (await hasPasskey(tx, signerId))) {
      throw new AppError(401, "passkey_required", "approve this with your passkey");
    }

    const protection = await getProtection(tx, ownerId);
    const cosign = needsCosign(protection, approval.kind, approval.amountCents);
    if (role === "helper" && !cosign) {
      throw new AppError(403, "owner_only", "only the owner approves this; helpers co-sign the approvals that need a second signature");
    }
    if (!cosign) return applyApproval(tx, approval, ownerId, passkeyId, "owner");

    let flagged = false;
    if (role === "owner") {
      flagged = !!answers && Object.values(answers).some(Boolean);
      const helpers = flagged ? (await tx.query("SELECT count(*)::int AS n FROM helpers WHERE owner_id = $1 AND status IN ('active','removing')", [ownerId])).rows[0].n : 0;
      // A "yes" with helpers: only a helper's signature, given after this, lets it through. Without helpers, the waiting period still applies.
      const helperOnly = flagged && helpers > 0;
      await tx.query(
        `UPDATE approvals SET needs_cosign = true, owner_signed_at = now(), owner_passkey_id = $2, scam_answers = $4, scam_flagged = $5,
                cosign_due_at = CASE WHEN $6 THEN NULL ELSE COALESCE(cosign_due_at, now() + make_interval(hours => $3)) END,
                helper_signed_by = CASE WHEN $5 THEN NULL ELSE helper_signed_by END,
                helper_signed_at = CASE WHEN $5 THEN NULL ELSE helper_signed_at END
          WHERE id = $1`,
        [id, passkeyId, protection.cosignDelayHours, answers ? JSON.stringify(answers) : null, flagged, helperOnly],
      );
      if (flagged) {
        await auditTx(tx, ownerId, {
          actor: "owner", kind: "scam_check_flagged",
          summary: `Possible scam: the owner said yes to a safety question before approving ${approval.kind.replaceAll("_", " ")}${approval.amountCents ? ` for $${(approval.amountCents / 100).toFixed(2)}` : ""}`,
          result: helperOnly ? "held until a trusted helper reviews it" : "no helpers: held for the waiting period",
          data: { approvalId: id, answers },
        });
      } else if (approval.helperSignedAt) {
        return applyApproval(tx, { ...approval, ownerPasskeyId: passkeyId }, ownerId, passkeyId, "owner and helper");
      }
    } else {
      await tx.query("UPDATE approvals SET needs_cosign = true, helper_signed_by = $2, helper_signed_at = now(), helper_passkey_id = $3 WHERE id = $1", [id, signerId, passkeyId]);
      if (approval.ownerSignedAt) return applyApproval(tx, approval, ownerId, approval.ownerPasskeyId, "owner and helper");
    }
    const { rows } = await tx.query(`SELECT cosign_due_at AS "dueAt" FROM approvals WHERE id = $1`, [id]);
    const dueAt: Date | null = rows[0].dueAt;
    const waitingFor = role === "owner" ? (dueAt ? "helper_or_delay" : "helper") : "owner";
    await auditTx(tx, ownerId, {
      actor: role, kind: "cosign_waiting",
      summary: `${role === "owner" ? "Owner" : helperLabel} signed: ${approval.kind.replaceAll("_", " ")} ${approval.amountCents ? `for $${(approval.amountCents / 100).toFixed(2)}` : ""}`.trim(),
      result: waitingFor === "owner" ? "waiting for the owner" : `waiting for a helper's signature, or goes through ${dueAt?.toISOString()}`,
      data: { approvalId: id },
    });
    return {
      id, status: "pending" as const, waitingFor, completesAt: waitingFor === "owner" ? null : dueAt, signedWithPasskey: passkeyId !== null,
      message:
        waitingFor === "owner"
          ? "Your co-signature is recorded. It takes effect once the owner approves."
          : waitingFor === "helper"
            ? "This has the signs of a scam, so a trusted helper has to look at it first. Talk to them before doing anything else. Real banks, police and companies never ask you to keep a payment secret or to hurry."
            : `Signed. This is a protected account: it takes effect when a trusted helper co-signs, or on ${dueAt?.toISOString()} if no helper objects.${flagged ? " Because you answered yes to a safety question, please talk to someone you trust before then." : ""}`,
    };
  });
}

/** Apply an approval's effect, as the owner. */
async function applyApproval(tx: Tx, approval: any, ownerId: string, passkeyId: string | null, signedBy: string) {
  const id = approval.id;
  // Single calls stay 'approved' until the agent retries and uses them; everything else applies now.
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
  } else if (approval.kind === "risk_consent") {
    await recordConsent(tx, ownerId, approval.input?.version, passkeyId);
    newStatus = "used";
  } else if (approval.kind === "browser_access") {
    await activateGrant(tx, ownerId, approval.browserGrantId);
    newStatus = "used";
  } else if (approval.kind === "grocery_order") {
    await approveGroceryOrder(tx, approval.groceryListId, approval.input ?? {});
    newStatus = "used";
  } else if (approval.kind === "envelope") {
    await activateEnvelope(tx, ownerId, approval.envelopeId);
    newStatus = "used";
  } else if (approval.kind === "buy_mandate") {
    await activateMandate(tx, approval.buyMandateId);
    newStatus = "used";
  } else if (approval.kind === "unfreeze") {
    await applyUnfreeze(tx, ownerId);
    newStatus = "used";
  } else if (approval.kind === "vault_unlock") {
    await approveVaultUnlock(tx, approval.vaultUnlockId);
    newStatus = "used";
  }
  await tx.query("UPDATE approvals SET status = $2, decided_at = now(), passkey_id = $3 WHERE id = $1", [id, newStatus, passkeyId]);
  await auditTx(tx, ownerId, {
    actor: signedBy === "the waiting period" ? "system" : "owner", kind: "approved", summary: `Approved: ${approval.kind.replaceAll("_", " ")}`,
    result: `${passkeyId ? "signed with a passkey" : "approved without a passkey"}; by ${signedBy}`, data: { approvalId: id, amountCents: approval.amountCents },
  });
  return { id, status: newStatus, signedWithPasskey: passkeyId !== null };
}

/** Owner-signed approvals on protected accounts whose waiting period is over and that no helper objected to. Run periodically. */
export async function completeDelayedApprovals(db: Db): Promise<number> {
  const { rows } = await db.query(
    `SELECT id FROM approvals WHERE status = 'pending' AND needs_cosign AND owner_signed_at IS NOT NULL AND cosign_due_at <= now()`,
  );
  let done = 0;
  for (const { id } of rows) {
    try {
      await withTx(db, async (tx) => {
        const { rows: r } = await tx.query(`SELECT user_id AS "ownerId" FROM approvals WHERE id = $1`, [id]);
        const { approval } = await approvalForSigner(tx, r[0].ownerId, id, true);
        if (approval.status !== "pending" || !approval.ownerSignedAt) return;
        await applyApproval(tx, approval, approval.ownerId, approval.ownerPasskeyId, "the waiting period");
      });
      done++;
    } catch (err) {
      // e.g. the wallet no longer has the money for an envelope: it stays pending for the owner to deal with.
      console.error(`delayed approval ${id} could not complete:`, (err as Error).message);
    }
  }
  return done;
}

/**
 * Saying no never spends money, so it needs no passkey. A trusted helper can
 * object to (deny) an approval that needs a second signature, but not others.
 */
export async function deny(db: Db, signerId: string, id: string) {
  return withTx(db, async (tx) => {
    const { approval, role, helperLabel } = await approvalForSigner(tx, signerId, id, true);
    if (approval.status !== "pending") throw new AppError(404, "not_found", "no pending approval with that id");
    if (role === "helper" && !needsCosign(await getProtection(tx, approval.ownerId), approval.kind, approval.amountCents)) {
      throw new AppError(403, "owner_only", "helpers can only object to approvals that need a second signature");
    }
    const { rows } = await tx.query(
      `UPDATE approvals SET status = 'denied', decided_at = now(), denied_by = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING kind, subscription_id AS "subscriptionId", external_subscription_id AS "externalSubscriptionId",
                  grocery_list_id AS "groceryListId", browser_grant_id AS "browserGrantId", input,
                  envelope_id AS "envelopeId", buy_mandate_id AS "buyMandateId", vault_unlock_id AS "vaultUnlockId"`,
      [id, signerId],
    );
    if (rows[0].kind === "subscription") {
      await tx.query("UPDATE subscriptions SET status = 'denied' WHERE id = $1 AND status = 'pending_approval'", [rows[0].subscriptionId]);
    }
    if (rows[0].kind === "grocery_order") await denyGroceryOrder(tx, rows[0].groceryListId);
    if (rows[0].kind === "browser_access") await denyGrant(tx, rows[0].browserGrantId);
    if (rows[0].kind === "envelope") await denyEnvelope(tx, rows[0].envelopeId);
    if (rows[0].kind === "buy_mandate") await denyMandate(tx, rows[0].buyMandateId);
    if (rows[0].kind === "vault_unlock") await denyVaultUnlock(tx, rows[0].vaultUnlockId);
    if (rows[0].kind === "external_cancel") {
      await denyExternalCancel(tx, rows[0].externalSubscriptionId, rows[0].input?.previousStatus);
    }
    if (role === "helper") {
      await auditTx(tx, approval.ownerId, {
        actor: "helper", kind: "denied", summary: `${helperLabel} objected: ${approval.kind.replaceAll("_", " ")} was declined`, data: { approvalId: id },
      });
    }
  });
}
