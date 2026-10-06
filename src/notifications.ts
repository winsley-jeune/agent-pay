import { createHmac, randomBytes } from "node:crypto";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { reminders } from "./external.js";
import { ALERT_KINDS } from "./helpers.js";
import { normalizeEmail, normalizePhone, send } from "./notify.js";
import { safeFetch, type OutboundOptions } from "./outbound.js";
import { purchaseReminders } from "./purchases.js";

// Telling people things as they happen, on the channel they choose: email,
// text, Telegram, Discord or a signed webhook (Wallos-style; docs/landscape.md).
//   approvals  something waits for your approval or co-signature
//   alerts     freezes, refusals, scam warnings, incidents, protection changes
//              (helpers get these for the accounts they help)
//   reminders  a daily digest of renewals, trials and return deadlines
//   payments   every payment an agent makes (opt-in)
// Events come from the why log, so nothing is missed and nothing is sent twice.

export const KINDS = ["email", "sms", "telegram", "discord", "webhook"] as const;
export type ChannelKind = (typeof KINDS)[number];
export const EVENTS = ["approvals", "alerts", "reminders", "payments"] as const;
export type EventKind = (typeof EVENTS)[number];

const APPROVAL_KINDS = ["call_needs_approval", "cosign_waiting", "scam_check_flagged"];
const OWNER_ALERT_KINDS = [
  "freeze", "unfreeze", "call_refused", "incident_reported", "scam_check_flagged", "protection_change", "helper_change", "payout_failed", "payout_reversed", "purchase_problem",
];

export interface Message {
  event: EventKind;
  title: string;
  text: string;
}

export async function listChannels(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT id, kind, target, events, active, created_at AS "createdAt" FROM notification_channels WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map((r) => ({ ...r, target: r.kind === "webhook" || r.kind === "discord" ? r.target.replace(/(https:\/\/[^/]+\/).*/, "$1…") : r.target }));
}

/** Add a channel. A webhook gets a signing secret, shown once. */
export async function addChannel(db: Db, userId: string, input: { kind: ChannelKind; target: string; events?: EventKind[] }) {
  let target = input.target.trim();
  if (input.kind === "email") target = normalizeEmail(target);
  else if (input.kind === "sms") target = normalizePhone(target);
  else if (input.kind === "telegram") {
    if (!/^-?\d{4,20}$|^@[A-Za-z0-9_]{5,32}$/.test(target)) throw new AppError(400, "invalid_target", "give your Telegram chat id (a number) or @channel name");
  } else if (input.kind === "discord") {
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(target)) throw new AppError(400, "invalid_target", "give a Discord webhook URL (Server Settings → Integrations → Webhooks)");
  } else if (!/^https:\/\//.test(target)) throw new AppError(400, "invalid_target", "webhooks must be https:// addresses");
  const events = input.events?.length ? [...new Set(input.events)] : ["approvals", "alerts", "reminders"];
  const secret = input.kind === "webhook" ? `whsec_ap_${randomBytes(24).toString("base64url")}` : null;
  const { rows } = await db.query(
    "INSERT INTO notification_channels (user_id, kind, target, secret, events) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [userId, input.kind, target, secret, events],
  );
  return { id: rows[0].id as string, kind: input.kind, events, ...(secret ? { signingSecret: secret, note: "Shown once. Check X-AgentPay-Signature (HMAC-SHA256 of the body, hex) with it." } : {}) };
}

export async function removeChannel(db: Db, userId: string, id: string) {
  const { rowCount } = await db.query("DELETE FROM notification_channels WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!rowCount) throw new AppError(404, "not_found", "no such channel");
}

interface Channel {
  id: string;
  userId: string;
  kind: ChannelKind;
  target: string;
  secret: string | null;
  events: EventKind[];
}

/** Send one message on one channel, and record it. */
export async function deliver(db: Db, ch: Channel, msg: Message, out: OutboundOptions = {}): Promise<"sent" | "failed" | "not_configured"> {
  const fetchImpl = out.fetchImpl ?? fetch;
  if (ch.kind === "email" || ch.kind === "sms") {
    const d = await send(db, ch.userId, { channel: ch.kind, to: ch.target, subject: msg.title, text: `${msg.title}\n\n${msg.text}`, purpose: `notify_${msg.event}` }, out);
    return d.status;
  }
  let status: "sent" | "failed" | "not_configured" = "sent";
  let error: string | null = null;
  try {
    if (ch.kind === "telegram") {
      if (!config.telegramBotToken) {
        status = "not_configured";
      } else {
        const res = await fetchImpl(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ch.target, text: `${msg.title}\n${msg.text}` }), signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) [status, error] = ["failed", `Telegram HTTP ${res.status}`];
      }
    } else if (ch.kind === "discord") {
      const res = await safeFetch(ch.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${msg.title}**\n${msg.text}`.slice(0, 1900) }) }, out);
      if (res.status >= 300) [status, error] = ["failed", `Discord HTTP ${res.status}`];
    } else {
      const body = JSON.stringify({ event: msg.event, title: msg.title, text: msg.text, at: new Date().toISOString() });
      const signature = createHmac("sha256", ch.secret ?? "").update(body).digest("hex");
      const res = await safeFetch(ch.target, { method: "POST", headers: { "content-type": "application/json", "x-agentpay-signature": signature }, body }, out);
      if (res.status >= 300) [status, error] = ["failed", `HTTP ${res.status}`];
    }
  } catch (err) {
    [status, error] = ["failed", String((err as Error).message).slice(0, 300)];
  }
  await db.query(
    "INSERT INTO notifications (user_id, channel, recipient, purpose, status, error) VALUES ($1, $2, $3, $4, $5, $6)",
    [ch.userId, ch.kind, ch.kind === "telegram" ? ch.target : ch.target.replace(/(https:\/\/[^/]+\/).*/, "$1…"), `notify_${msg.event}`, status, error],
  );
  return status;
}

async function channelsOf(db: Db, userId: string): Promise<Channel[]> {
  const { rows } = await db.query(
    `SELECT id, user_id AS "userId", kind, target, secret, events FROM notification_channels WHERE user_id = $1 AND active`,
    [userId],
  );
  return rows;
}

async function sendTo(db: Db, userId: string, msg: Message, out: OutboundOptions) {
  let sent = 0;
  for (const ch of await channelsOf(db, userId)) {
    if (ch.events.includes(msg.event) && (await deliver(db, ch, msg, out)) === "sent") sent++;
  }
  return sent;
}

export async function sendTest(db: Db, userId: string, id: string, out: OutboundOptions = {}) {
  const ch = (await channelsOf(db, userId)).find((c) => c.id === id);
  if (!ch) throw new AppError(404, "not_found", "no such channel");
  return { status: await deliver(db, ch, { event: ch.events[0] ?? "alerts", title: "AgentPay test", text: "Notifications from AgentPay will arrive here." }, out) };
}

/** New why-log entries for one recipient about one account, after their cursor. The first run only sets the cursor. */
async function newEntries(db: Db, recipientId: string, accountId: string, kinds: string[]) {
  const { rows: cur } = await db.query("SELECT last_seq FROM notification_cursors WHERE recipient_id = $1 AND account_id = $2", [recipientId, accountId]);
  const { rows: max } = await db.query("SELECT COALESCE(max(seq), 0) AS m FROM audit_log WHERE user_id = $1", [accountId]);
  if (!cur[0]) {
    await db.query("INSERT INTO notification_cursors (recipient_id, account_id, last_seq) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [recipientId, accountId, max[0].m]);
    return [];
  }
  const { rows } = await db.query(
    "SELECT seq, kind, summary, result FROM audit_log WHERE user_id = $1 AND seq > $2 AND kind = ANY($3) ORDER BY seq LIMIT 50",
    [accountId, cur[0].last_seq, kinds],
  );
  await db.query("UPDATE notification_cursors SET last_seq = $3 WHERE recipient_id = $1 AND account_id = $2", [recipientId, accountId, max[0].m]);
  return rows as { seq: number; kind: string; summary: string; result: string | null }[];
}

const lines = (rows: { summary: string; result: string | null }[]) => rows.map((r) => `• ${r.summary}${r.result ? ` (${r.result})` : ""}`).join("\n");

/** Send what's new to everyone with a channel. Run periodically. */
export async function runNotifications(db: Db, out: OutboundOptions = {}, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const { rows: users } = await db.query(`SELECT DISTINCT user_id AS id FROM notification_channels WHERE active`);
  let sent = 0;
  for (const { id } of users) {
    const chans = await channelsOf(db, id);
    const wants = (e: EventKind) => chans.some((c) => c.events.includes(e));
    const own = await newEntries(db, id, id, [...new Set([...APPROVAL_KINDS, ...OWNER_ALERT_KINDS, "call_paid"])]);
    const approvals = own.filter((r) => APPROVAL_KINDS.includes(r.kind));
    const alerts = own.filter((r) => OWNER_ALERT_KINDS.includes(r.kind) && !APPROVAL_KINDS.includes(r.kind));
    const payments = own.filter((r) => r.kind === "call_paid");
    if (approvals.length && wants("approvals")) {
      sent += await sendTo(db, id, { event: "approvals", title: `${approvals.length} waiting for you`, text: `${lines(approvals)}\n\nOpen ${config.publicUrl}/#approvals` }, out);
    }
    if (alerts.length && wants("alerts")) sent += await sendTo(db, id, { event: "alerts", title: "AgentPay alert", text: lines(alerts) }, out);
    if (payments.length && wants("payments")) sent += await sendTo(db, id, { event: "payments", title: `${payments.length} payment${payments.length === 1 ? "" : "s"} by your agents`, text: lines(payments) }, out);

    // Helpers hear about the accounts they help.
    if (wants("alerts")) {
      const { rows: helped } = await db.query(
        `SELECT h.owner_id AS "ownerId", COALESCE(u.display_name, u.email) AS name FROM helpers h JOIN users u ON u.id = h.owner_id
          WHERE h.helper_id = $1 AND h.status IN ('active','removing')`,
        [id],
      );
      for (const a of helped) {
        const entries = await newEntries(db, id, a.ownerId, ALERT_KINDS);
        if (entries.length) {
          sent += await sendTo(db, id, { event: "alerts", title: `About ${a.name}'s account`, text: `${lines(entries)}\n\nOpen ${config.publicUrl}/#family` }, out);
        }
      }
    }

    // Once a day: renewals, trials, contracts and return deadlines.
    if (wants("reminders")) {
      const { rows: u } = await db.query("SELECT last_digest_on::text AS d FROM users WHERE id = $1", [id]);
      if (u[0].d !== today) {
        const items = [...(await reminders(db, id, today)).map((r) => r.message), ...(await purchaseReminders(db, id)).map((r) => r.message)];
        if (items.length) sent += await sendTo(db, id, { event: "reminders", title: "Coming up", text: items.map((m) => `• ${m}`).join("\n") }, out);
        await db.query("UPDATE users SET last_digest_on = $2 WHERE id = $1", [id, today]);
      }
    }
  }
  return sent;
}
