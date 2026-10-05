import { randomBytes } from "node:crypto";
import { auditTx } from "./audit.js";
import { hashToken, updateAgentKeyLimits, type AgentKeyLimits } from "./auth.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { config } from "./config.js";
import { channelConfigured, DAILY_SEND_LIMIT, maskContact, normalizeEmail, normalizePhone, send, sentInLastDay, type Delivery } from "./notify.js";

// Protected accounts and trusted helpers, for people who want someone they
// trust (an adult child, a caregiver) watching over their agents' spending.
//
// The owner keeps their money. A helper can see the account, freeze it, and
// co-sign or object to big and sensitive approvals. A helper can never spend,
// move money, create agent keys, approve alone, unfreeze alone or lock the
// owner out. On a protected account, big approvals need the owner's passkey
// plus a helper's signature or a waiting period (scams run on urgency; the
// delay breaks it). Anything that weakens protection, like removing a helper
// or turning protection off, also waits out the delay, with helpers alerted.

export const MAX_HELPERS = 3;
const INVITE_DAYS = 7;

/** Approval kinds that always need a second signature or the delay on a protected account. */
export const COSIGN_KINDS = ["unfreeze", "vault_unlock", "browser_access", "risk_consent", "envelope", "buy_mandate"];

/** Why-log entries a helper is alerted to. */
const ALERT_KINDS = [
  "call_needs_approval", "call_refused", "freeze", "unfreeze", "approved", "denied", "cosign_waiting", "incident_reported",
  "envelope_funded", "vault_lock", "vault_unlock", "mandate_used", "protection_change", "helper_change", "agent_key_created", "agent_limits_change",
  "scam_check_flagged", "purchase_problem",
];

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface Protection {
  protectedAt: Date | null;
  cosignThresholdCents: number;
  cosignDelayHours: number;
}

export async function getProtection(q: Db | Tx, ownerId: string): Promise<Protection> {
  const { rows } = await q.query(
    `SELECT protected_at AS "protectedAt", cosign_threshold_cents AS "cosignThresholdCents", cosign_delay_hours AS "cosignDelayHours"
       FROM users WHERE id = $1`,
    [ownerId],
  );
  return rows[0];
}

/** Does this approval need a second signature (or the delay) before it takes effect? */
export function needsCosign(p: Protection, kind: string, amountCents: number): boolean {
  return !!p.protectedAt && (COSIGN_KINDS.includes(kind) || amountCents >= p.cosignThresholdCents);
}

// ---------------------------------------------------------------- helpers

/** The helper row if `userId` is an active helper on `ownerId`'s account (helpers being removed still help until it applies). */
export async function helperOn(q: Db | Tx, userId: string, ownerId: string) {
  const { rows } = await q.query(
    `SELECT id, label, last_seen_seq AS "lastSeenSeq" FROM helpers WHERE owner_id = $1 AND helper_id = $2 AND status IN ('active','removing')`,
    [ownerId, userId],
  );
  return (rows[0] as { id: string; label: string; lastSeenSeq: number } | undefined) ?? null;
}

async function activeHelperCount(q: Db | Tx, ownerId: string): Promise<number> {
  const { rows } = await q.query("SELECT count(*)::int AS n FROM helpers WHERE owner_id = $1 AND status IN ('invited','active','removing')", [ownerId]);
  return rows[0].n;
}

export interface InviteContact {
  email?: string;
  phone?: string;
}

/** The invitation text. The link uses the URL fragment (#), which browsers never send to a server. */
function inviteMessage(ownerName: string, code: string) {
  const link = `${config.publicUrl}/#accept=${code}`;
  return {
    subject: `${ownerName} invited you to be a trusted helper on AgentPay`,
    email:
      `${ownerName} invited you to be a trusted helper on their AgentPay account.\n\n` +
      `As a trusted helper you can see what their AI agents spend, freeze everything if something looks wrong, and co-sign or object to big payments. ` +
      `You can never spend their money or approve anything alone.\n\n` +
      `To accept, sign in to AgentPay (or create an account) and open:\n${link}\n\n` +
      `Or enter this code on the Family tab: ${code}\n\nThe invitation expires in ${INVITE_DAYS} days. ` +
      `If you don't know ${ownerName}, ignore this message.`,
    sms: `${ownerName} invited you to be a trusted helper on AgentPay (see and protect their agents' spending; you can't spend their money). Accept within ${INVITE_DAYS} days: ${link} If you don't know them, ignore this.`,
  };
}

async function deliverInvite(db: Db, ownerId: string, helperRowId: string, contactType: "email" | "phone", contact: string, code: string): Promise<Delivery> {
  const { rows } = await db.query("SELECT COALESCE(display_name, email) AS name FROM users WHERE id = $1", [ownerId]);
  const msg = inviteMessage(rows[0].name, code);
  const delivery = await send(db, ownerId, {
    channel: contactType === "email" ? "email" : "sms", to: contact, subject: msg.subject, text: contactType === "email" ? msg.email : msg.sms, purpose: "helper_invite",
  });
  await db.query(
    "UPDATE helpers SET delivery_status = $2, delivered_at = CASE WHEN $2 = 'sent' THEN now() END, delivery_error = $3 WHERE id = $1",
    [helperRowId, delivery.status, delivery.error ?? null],
  );
  return delivery;
}

function inviteResult(helperRowId: string, code: string, contactType: "email" | "phone" | null, contact: string | null, delivery: Delivery | null) {
  const to = contactType && contact ? maskContact(contactType, contact) : null;
  const note =
    delivery?.status === "sent"
      ? `Invitation sent to ${to}. You can also give them this code; it works once.`
      : delivery?.status === "failed"
        ? `Couldn't send to ${to} (${delivery.error}). Give them this code yourself; it works once and is shown only now.`
        : contactType
          ? `Sending ${contactType === "email" ? "email" : "text messages"} isn't set up on this server. Give ${to} this code yourself; it works once and is shown only now.`
          : "Give this code to your helper; it works once and is shown only now.";
  return { helperRowId, code, expiresInDays: INVITE_DAYS, sentTo: delivery?.status === "sent" ? to : null, delivery: delivery?.status ?? null, note };
}

/**
 * Invite someone to help, optionally by email or phone number. AgentPay sends
 * the invitation when that channel is configured; the code is also returned
 * once, so the owner can pass it on themselves. An email invitation can only
 * be accepted from an AgentPay account with that email address.
 */
export async function inviteHelper(db: Db, ownerId: string, label: string, contact: InviteContact = {}) {
  if (contact.email && contact.phone) throw new AppError(400, "one_contact", "give an email address or a phone number, not both");
  const contactType = contact.email ? "email" : contact.phone ? "phone" : null;
  const value = contact.email ? normalizeEmail(contact.email) : contact.phone ? normalizePhone(contact.phone) : null;
  if ((await activeHelperCount(db, ownerId)) >= MAX_HELPERS) throw new AppError(409, "too_many_helpers", `an account can have at most ${MAX_HELPERS} helpers`);
  if (value) {
    const self = await db.query("SELECT 1 FROM users WHERE id = $1 AND email = $2", [ownerId, value]);
    if (self.rowCount) throw new AppError(400, "own_account", "you can't be a helper on your own account");
    const dup = await db.query("SELECT 1 FROM helpers WHERE owner_id = $1 AND contact = $2 AND status IN ('invited','active','removing')", [ownerId, value]);
    if (dup.rowCount) throw new AppError(409, "already_invited", "you already invited this person; resend the invitation instead");
    // Check the daily limit before creating anything, so a refused send leaves no half-made invitation.
    if (channelConfigured(contactType === "email" ? "email" : "sms") && (await sentInLastDay(db, ownerId)) >= DAILY_SEND_LIMIT) {
      throw new AppError(429, "send_limit", `at most ${DAILY_SEND_LIMIT} messages a day; try again tomorrow`);
    }
  }
  const code = `ap_invite_${randomBytes(18).toString("base64url")}`;
  const { rows } = await db.query(
    `INSERT INTO helpers (owner_id, label, invite_hash, invite_expires_at, contact_type, contact)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6) RETURNING id`,
    [ownerId, label.slice(0, 80), hashToken(code), INVITE_DAYS, contactType, value],
  );
  const id: string = rows[0].id;
  const delivery = contactType && value ? await deliverInvite(db, ownerId, id, contactType, value, code) : null;
  return inviteResult(id, code, contactType, value, delivery);
}

/** Send a fresh invitation: a new code and a new expiry (the old code stops working). */
export async function resendInvite(db: Db, ownerId: string, helperRowId: string) {
  const { rows } = await db.query(
    `SELECT id, contact_type AS "contactType", contact FROM helpers WHERE id = $1 AND owner_id = $2 AND status = 'invited'`,
    [helperRowId, ownerId],
  );
  const h = rows[0];
  if (!h) throw new AppError(404, "not_found", "no open invitation with that id");
  const code = `ap_invite_${randomBytes(18).toString("base64url")}`;
  await db.query("UPDATE helpers SET invite_hash = $2, invite_expires_at = now() + make_interval(days => $3) WHERE id = $1", [h.id, hashToken(code), INVITE_DAYS]);
  const delivery = h.contactType ? await deliverInvite(db, ownerId, h.id, h.contactType, h.contact, code) : null;
  return inviteResult(h.id, code, h.contactType, h.contact, delivery);
}

/** Which invitation channels this server can send on. */
export function inviteChannels() {
  return { email: channelConfigured("email"), sms: channelConfigured("sms") };
}

export async function acceptInvite(db: Db, helperUserId: string, code: string) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, owner_id AS "ownerId", label, contact_type AS "contactType", contact FROM helpers
        WHERE invite_hash = $1 AND status = 'invited' AND invite_expires_at > now() FOR UPDATE`,
      [hashToken(code.trim())],
    );
    const h = rows[0];
    if (!h) throw new AppError(404, "invite_invalid", "this invite code is wrong, used or expired");
    if (h.ownerId === helperUserId) throw new AppError(400, "own_account", "you can't be a helper on your own account");
    // An email invitation is for that person: only their AgentPay account can accept it.
    if (h.contactType === "email") {
      const me = await tx.query("SELECT email FROM users WHERE id = $1", [helperUserId]);
      if (me.rows[0].email !== h.contact) {
        throw new AppError(403, "wrong_account", `this invitation was sent to ${maskContact("email", h.contact)}; sign in with that email address to accept it`);
      }
    }
    if (await helperOn(tx, helperUserId, h.ownerId)) throw new AppError(409, "already_helping", "you already help on this account");
    await tx.query("UPDATE helpers SET helper_id = $2, status = 'active', invite_hash = NULL, accepted_at = now() WHERE id = $1", [h.id, helperUserId]);
    await auditTx(tx, h.ownerId, { actor: "helper", kind: "helper_change", summary: `${h.label} accepted the invitation and can now see and protect this account` });
    return { ownerId: h.ownerId as string, label: h.label as string };
  });
}

export async function listHelpers(q: Db | Tx, ownerId: string) {
  const { rows } = await q.query(
    `SELECT h.id, h.label, h.status, u.email, h.contact_type AS "contactType", h.contact, h.delivery_status AS "deliveryStatus",
            h.delivered_at AS "deliveredAt", h.created_at AS "createdAt", h.accepted_at AS "acceptedAt", h.invite_expires_at AS "inviteExpiresAt",
            (SELECT effective_at FROM account_changes c WHERE c.target_id = h.id AND c.kind = 'remove_helper' AND c.status = 'scheduled' LIMIT 1) AS "removingAt"
       FROM helpers h LEFT JOIN users u ON u.id = h.helper_id
      WHERE h.owner_id = $1 AND h.status <> 'removed' ORDER BY h.created_at`,
    [ownerId],
  );
  return rows;
}

/** Accounts this user helps, with how many alerts they haven't seen. */
export async function listHelping(q: Db | Tx, helperUserId: string) {
  const { rows } = await q.query(
    `SELECT h.owner_id AS "ownerId", COALESCE(u.display_name, u.email) AS name, u.email, h.label AS "youAre", h.status,
            u.frozen_at AS "frozenAt", u.protected_at AS "protectedAt",
            (SELECT count(*)::int FROM audit_log a WHERE a.user_id = h.owner_id AND a.seq > h.last_seen_seq AND a.kind = ANY($2)) AS "unseenAlerts",
            (SELECT count(*)::int FROM approvals ap WHERE ap.user_id = h.owner_id AND ap.status = 'pending' AND ap.needs_cosign) AS "waitingForCosign"
       FROM helpers h JOIN users u ON u.id = h.owner_id
      WHERE h.helper_id = $1 AND h.status IN ('active','removing') ORDER BY name`,
    [helperUserId, ALERT_KINDS],
  );
  return rows;
}

export async function alertsFor(db: Db, helperUserId: string, ownerId: string) {
  const h = await helperOn(db, helperUserId, ownerId);
  if (!h) throw new AppError(403, "not_helper", "you don't help on this account");
  const { rows } = await db.query(
    `SELECT seq, actor, kind, summary, reason, result, data, created_at AS "createdAt" FROM audit_log
      WHERE user_id = $1 AND kind = ANY($2) AND (kind <> 'browser_activity' OR data->>'allowed' = 'false')
      ORDER BY seq DESC LIMIT 100`,
    [ownerId, ALERT_KINDS],
  );
  return { alerts: rows.map((r) => ({ ...r, unseen: r.seq > h.lastSeenSeq })), lastSeenSeq: h.lastSeenSeq };
}

export async function markAlertsSeen(db: Db, helperUserId: string, ownerId: string) {
  await db.query(
    `UPDATE helpers SET last_seen_seq = COALESCE((SELECT max(seq) FROM audit_log WHERE user_id = $1), 0)
      WHERE owner_id = $1 AND helper_id = $2 AND status IN ('active','removing')`,
    [ownerId, helperUserId],
  );
}

/** A helper can always step back, at once. */
export async function leave(db: Db, helperUserId: string, ownerId: string) {
  await withTx(db, async (tx) => {
    const { rows } = await tx.query(
      "UPDATE helpers SET status = 'removed', removed_at = now() WHERE owner_id = $1 AND helper_id = $2 AND status IN ('active','removing') RETURNING id, label",
      [ownerId, helperUserId],
    );
    if (!rows[0]) throw new AppError(404, "not_helper", "you don't help on this account");
    await tx.query("UPDATE account_changes SET status = 'canceled' WHERE target_id = $1 AND kind = 'remove_helper' AND status = 'scheduled'", [rows[0].id]);
    await auditTx(tx, ownerId, { actor: "helper", kind: "helper_change", summary: `${rows[0].label} stopped helping on this account` });
  });
}

/** Remove a helper: at once on an unprotected account, after the delay on a protected one. */
export async function removeHelper(db: Db, ownerId: string, helperRowId: string) {
  const { rows } = await db.query("SELECT id, label, status FROM helpers WHERE id = $1 AND owner_id = $2 AND status IN ('invited','active')", [helperRowId, ownerId]);
  const h = rows[0];
  if (!h) throw new AppError(404, "not_found", "no such helper");
  const p = await getProtection(db, ownerId);
  if (h.status === "invited" || !p.protectedAt) {
    await withTx(db, async (tx) => {
      await tx.query("UPDATE helpers SET status = 'removed', removed_at = now(), invite_hash = NULL WHERE id = $1", [h.id]);
      await auditTx(tx, ownerId, { actor: "owner", kind: "helper_change", summary: `Removed helper ${h.label}` });
    });
    return { removed: true as const };
  }
  return scheduleChange(db, ownerId, { kind: "remove_helper", targetId: h.id, summary: `Remove helper ${h.label}` }, async (tx) => {
    await tx.query("UPDATE helpers SET status = 'removing' WHERE id = $1", [h.id]);
  });
}

// ---------------------------------------------------------------- protection settings

export async function setDisplayName(db: Db, ownerId: string, name: string) {
  await db.query("UPDATE users SET display_name = $2 WHERE id = $1", [ownerId, name.trim().slice(0, 80) || null]);
}

/**
 * Turning protection on, lowering the co-sign threshold or lengthening the
 * delay is immediate. Turning it off, raising the threshold or shortening the
 * delay is scheduled after the current delay.
 */
export async function setProtection(db: Db, ownerId: string, input: { enabled?: boolean; cosignThresholdCents?: number; cosignDelayHours?: number }) {
  const p = await getProtection(db, ownerId);
  const threshold = input.cosignThresholdCents ?? p.cosignThresholdCents;
  const delay = input.cosignDelayHours ?? p.cosignDelayHours;
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new AppError(400, "invalid_threshold", "cosignThresholdCents must be 0 or more");
  if (!Number.isInteger(delay) || delay < 1 || delay > 720) throw new AppError(400, "invalid_delay", "cosignDelayHours must be 1 to 720");
  const enabled = input.enabled ?? !!p.protectedAt;

  if (!p.protectedAt) {
    await withTx(db, async (tx) => {
      await tx.query(
        "UPDATE users SET protected_at = CASE WHEN $2 THEN now() ELSE NULL END, cosign_threshold_cents = $3, cosign_delay_hours = $4 WHERE id = $1",
        [ownerId, enabled, threshold, delay],
      );
      if (enabled) {
        await auditTx(tx, ownerId, {
          actor: "owner", kind: "protection_change",
          summary: `Turned on protection: approvals from ${usd(threshold)} need a helper's signature or a ${delay}-hour wait`,
        });
      }
    });
    return { applied: true as const, protection: await getProtection(db, ownerId) };
  }
  if (!enabled) {
    return scheduleChange(db, ownerId, { kind: "unprotect", summary: "Turn off protection" });
  }
  const tighter = threshold <= p.cosignThresholdCents && delay >= p.cosignDelayHours;
  if (tighter) {
    await withTx(db, async (tx) => {
      await tx.query("UPDATE users SET cosign_threshold_cents = $2, cosign_delay_hours = $3 WHERE id = $1", [ownerId, threshold, delay]);
      await auditTx(tx, ownerId, { actor: "owner", kind: "protection_change", summary: `Protection tightened: from ${usd(threshold)}, ${delay}-hour wait` });
    });
    return { applied: true as const, protection: await getProtection(db, ownerId) };
  }
  return scheduleChange(db, ownerId, {
    kind: "settings", payload: { cosignThresholdCents: threshold, cosignDelayHours: delay },
    summary: `Change protection to approvals from ${usd(threshold)}, ${delay}-hour wait`,
  });
}

/** On a protected account, an agent key's limits change only after the delay (revoking is always immediate). */
export async function scheduleAgentLimits(db: Db, ownerId: string, agentKeyId: string, limits: AgentKeyLimits) {
  const { rows } = await db.query("SELECT name FROM agent_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [agentKeyId, ownerId]);
  if (!rows[0]) throw new AppError(404, "not_found", "agent key not found");
  return scheduleChange(db, ownerId, { kind: "agent_limits", targetId: agentKeyId, payload: limits as Record<string, unknown>, summary: `Change limits of agent "${rows[0].name}"` });
}

async function scheduleChange(
  db: Db,
  ownerId: string,
  c: { kind: "unprotect" | "remove_helper" | "settings" | "agent_limits"; targetId?: string; payload?: Record<string, unknown>; summary: string },
  alsoInTx?: (tx: Tx) => Promise<void>,
) {
  return withTx(db, async (tx) => {
    const p = await getProtection(tx, ownerId);
    const { rows } = await tx.query(
      `INSERT INTO account_changes (owner_id, kind, target_id, payload, summary, effective_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING id, effective_at AS "effectiveAt"`,
      [ownerId, c.kind, c.targetId ?? null, JSON.stringify(c.payload ?? {}), c.summary, p.cosignDelayHours],
    );
    if (alsoInTx) await alsoInTx(tx);
    await auditTx(tx, ownerId, {
      actor: "owner", kind: c.kind === "remove_helper" ? "helper_change" : c.kind === "agent_limits" ? "agent_limits_change" : "protection_change",
      summary: `Scheduled: ${c.summary}`, result: `takes effect ${new Date(rows[0].effectiveAt).toISOString()} (protected account delay)`,
    });
    return {
      scheduled: true as const, changeId: rows[0].id as string, effectiveAt: rows[0].effectiveAt as Date,
      message: `This weakens protection, so it takes effect after ${p.cosignDelayHours} hours. Your helpers are told. You can cancel it until then.`,
    };
  });
}

export async function listChanges(q: Db | Tx, ownerId: string) {
  const { rows } = await q.query(
    `SELECT id, kind, summary, effective_at AS "effectiveAt", created_at AS "createdAt" FROM account_changes
      WHERE owner_id = $1 AND status = 'scheduled' ORDER BY effective_at`,
    [ownerId],
  );
  return rows;
}

/** The owner can cancel a scheduled change (keeping protection is always allowed). */
export async function cancelChange(db: Db, ownerId: string, changeId: string) {
  await withTx(db, async (tx) => {
    const { rows } = await tx.query(
      "UPDATE account_changes SET status = 'canceled' WHERE id = $1 AND owner_id = $2 AND status = 'scheduled' RETURNING kind, target_id AS \"targetId\", summary",
      [changeId, ownerId],
    );
    if (!rows[0]) throw new AppError(404, "not_found", "no scheduled change with that id");
    if (rows[0].kind === "remove_helper") await tx.query("UPDATE helpers SET status = 'active' WHERE id = $1 AND status = 'removing'", [rows[0].targetId]);
    await auditTx(tx, ownerId, { actor: "owner", kind: "protection_change", summary: `Canceled: ${rows[0].summary}` });
  });
}

/** Apply scheduled changes whose delay is over. Run periodically. */
export async function applyDueChanges(db: Db): Promise<number> {
  const { rows } = await db.query(`SELECT id FROM account_changes WHERE status = 'scheduled' AND effective_at <= now()`);
  let applied = 0;
  for (const { id } of rows) {
    const change = await withTx(db, async (tx) => {
      const { rows: r } = await tx.query(
        `SELECT id, owner_id AS "ownerId", kind, target_id AS "targetId", payload, summary FROM account_changes
          WHERE id = $1 AND status = 'scheduled' FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const c = r[0];
      if (!c) return null;
      if (c.kind === "unprotect") await tx.query("UPDATE users SET protected_at = NULL WHERE id = $1", [c.ownerId]);
      if (c.kind === "settings") {
        await tx.query("UPDATE users SET cosign_threshold_cents = $2, cosign_delay_hours = $3 WHERE id = $1", [
          c.ownerId, c.payload.cosignThresholdCents, c.payload.cosignDelayHours,
        ]);
      }
      if (c.kind === "remove_helper") await tx.query("UPDATE helpers SET status = 'removed', removed_at = now() WHERE id = $1", [c.targetId]);
      await tx.query("UPDATE account_changes SET status = 'applied', applied_at = now() WHERE id = $1", [c.id]);
      await auditTx(tx, c.ownerId, {
        actor: "system", kind: c.kind === "remove_helper" ? "helper_change" : c.kind === "agent_limits" ? "agent_limits_change" : "protection_change",
        summary: `Applied after the waiting period: ${c.summary}`,
      });
      return c;
    });
    // Agent key limits go through the normal update, outside the change's transaction.
    if (change?.kind === "agent_limits") await updateAgentKeyLimits(db, change.ownerId, change.targetId, change.payload).catch((err) => console.error("agent limits change failed", err));
    if (change) applied++;
  }
  return applied;
}
