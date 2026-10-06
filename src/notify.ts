import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { AppError } from "./errors.js";

// Sending email and text messages. Email goes through Resend and texts through
// Twilio, both over their HTTPS APIs. When a provider isn't configured, nothing
// is sent and the caller falls back (e.g. showing the owner an invite code to
// pass on). Every attempt is recorded in `notifications`, never with secrets.

export type Channel = "email" | "sms";
export type DeliveryStatus = "sent" | "not_configured" | "failed";
export interface Delivery {
  status: DeliveryStatus;
  providerId?: string;
  error?: string;
}

/** Messages an owner may cause in 24 hours, so invitations can't be used to spam people. */
export const DAILY_SEND_LIMIT = 10;

// ---------------------------------------------------------------- contacts

export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new AppError(400, "invalid_email", "give a valid email address");
  return email;
}

/** "(555) 123-4567" or "555.123.4567" -> "+15551234567"; "+44 20 7946 0958" -> "+442079460958". */
export function normalizePhone(input: string): string {
  const raw = input.trim();
  const digits = raw.replace(/[^\d]/g, "");
  let e164: string;
  if (raw.startsWith("+")) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else throw new AppError(400, "invalid_phone", "give a US number (10 digits) or an international number starting with +");
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new AppError(400, "invalid_phone", "that doesn't look like a valid phone number");
  return e164;
}

/** "maria@example.com" -> "m•••a@example.com"; "+15551234567" -> "•••• 4567". */
export function maskContact(channel: Channel | "phone", contact: string): string {
  if (channel === "email") {
    const [name, domain] = contact.split("@");
    return `${name[0]}•••${name.length > 1 ? name.at(-1) : ""}@${domain}`;
  }
  return `•••• ${contact.slice(-4)}`;
}

// ---------------------------------------------------------------- sending

export function channelConfigured(channel: Channel): boolean {
  return channel === "email"
    ? !!(config.resendApiKey && config.emailFrom)
    : !!(config.twilioAccountSid && config.twilioAuthToken && config.twilioFrom);
}

export async function sentInLastDay(q: Db | Tx, userId: string): Promise<number> {
  // Only invitations reach other people, so only they count toward the anti-spam limit.
  const { rows } = await q.query(
    "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND status = 'sent' AND purpose = 'helper_invite' AND created_at > now() - interval '1 day'",
    [userId],
  );
  return rows[0].n;
}

async function sendEmail(to: string, subject: string, text: string, fetchImpl: typeof fetch): Promise<Delivery> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  return res.ok ? { status: "sent", providerId: body.id } : { status: "failed", error: `Resend HTTP ${res.status}: ${body.message ?? ""}`.slice(0, 300) };
}

async function sendSms(to: string, text: string, fetchImpl: typeof fetch): Promise<Delivery> {
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: config.twilioFrom, Body: text }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  return res.ok ? { status: "sent", providerId: body.sid } : { status: "failed", error: `Twilio HTTP ${res.status}: ${body.message ?? ""}`.slice(0, 300) };
}

/**
 * Send one message and record the attempt. `text` may contain a secret (an
 * invite code); only `purpose`, the recipient and the outcome are stored.
 */
export async function send(
  db: Db,
  userId: string,
  msg: { channel: Channel; to: string; subject: string; text: string; purpose: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  let delivery: Delivery;
  if (!channelConfigured(msg.channel)) {
    delivery = { status: "not_configured" };
  } else if (msg.purpose === "helper_invite" && (await sentInLastDay(db, userId)) >= DAILY_SEND_LIMIT) {
    throw new AppError(429, "send_limit", `at most ${DAILY_SEND_LIMIT} messages a day; try again tomorrow`);
  } else {
    try {
      delivery = msg.channel === "email" ? await sendEmail(msg.to, msg.subject, msg.text, fetchImpl) : await sendSms(msg.to, msg.text, fetchImpl);
    } catch (err) {
      delivery = { status: "failed", error: String((err as Error).message).slice(0, 300) };
    }
  }
  await db.query(
    "INSERT INTO notifications (user_id, channel, recipient, purpose, status, provider_id, error) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [userId, msg.channel, msg.to, msg.purpose, delivery.status, delivery.providerId ?? null, delivery.error ?? null],
  );
  return delivery;
}
