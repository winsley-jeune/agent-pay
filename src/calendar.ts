import { randomBytes } from "node:crypto";
import { hashToken } from "./auth.js";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";

// A calendar feed (iCal) of what's coming: renewals, trial ends, contract ends,
// AgentPay plan renewals, return deadlines, envelope ends, vault unlocks and
// approvals waiting for a co-signature (Wallos-style; docs/landscape.md).
// Calendar apps can't send a token header, so the feed URL carries its own
// secret; it shows dates and names only, never amounts paid or card details.

export async function createCalendarToken(db: Db, userId: string) {
  const token = `ap_cal_${randomBytes(24).toString("base64url")}`;
  await db.query("UPDATE users SET calendar_token_hash = $2 WHERE id = $1", [userId, hashToken(token)]);
  return { url: `${config.publicUrl}/api/calendar/${token}.ics`, note: "Add this address to your calendar app as a subscription. Making a new one stops the old one." };
}

export async function revokeCalendarToken(db: Db, userId: string) {
  await db.query("UPDATE users SET calendar_token_hash = NULL WHERE id = $1", [userId]);
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const day = (d: string | Date) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10).replace(/-/g, "");
/** Lines longer than 75 octets are folded, as RFC 5545 asks. */
const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");

export async function calendarFeed(db: Db, token: string): Promise<string> {
  const { rows: u } = await db.query("SELECT id FROM users WHERE calendar_token_hash = $1", [hashToken(token)]);
  if (!u[0]) throw new AppError(404, "not_found", "no calendar at this address");
  const userId: string = u[0].id;
  const events: { uid: string; date: string | Date; summary: string; description: string }[] = [];

  const ext = await db.query(
    `SELECT id, name, to_char(next_renewal_on, 'YYYY-MM-DD') AS renew, to_char(trial_ends_on, 'YYYY-MM-DD') AS trial,
            to_char(contract_until, 'YYYY-MM-DD') AS contract, status FROM external_subscriptions WHERE user_id = $1 AND status IN ('active','trial')`,
    [userId],
  );
  for (const s of ext.rows) {
    if (s.status === "trial" && s.trial) events.push({ uid: `trial-${s.id}`, date: s.trial, summary: `${s.name}: free trial ends`, description: "Cancel before today if you don't want to pay." });
    else if (s.renew) events.push({ uid: `renew-${s.id}-${s.renew}`, date: s.renew, summary: `${s.name} renews`, description: "Cancel from AgentPay if you no longer use it." });
    if (s.contract) events.push({ uid: `contract-${s.id}`, date: s.contract, summary: `${s.name}: contract ends`, description: "A good time to switch without a fee." });
  }
  const plans = await db.query(
    `SELECT s.id, pl.name, s.current_period_end AS d FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND NOT s.cancel_at_period_end`,
    [userId],
  );
  for (const p of plans.rows) events.push({ uid: `plan-${p.id}-${day(p.d)}`, date: p.d, summary: `${p.name} renews (AgentPay)`, description: "Paid from your AgentPay wallet." });
  const purchases = await db.query(
    `SELECT id, title, store, to_char(return_by, 'YYYY-MM-DD') AS d FROM purchases WHERE user_id = $1 AND status IN ('ordered','received','problem')`,
    [userId],
  );
  for (const p of purchases.rows) events.push({ uid: `return-${p.id}`, date: p.d, summary: `Last day to return: ${p.title}`, description: `At ${p.store}.` });
  const envelopes = await db.query(`SELECT id, name, expires_at AS d FROM envelopes WHERE user_id = $1 AND status = 'active'`, [userId]);
  for (const e of envelopes.rows) events.push({ uid: `envelope-${e.id}`, date: e.d, summary: `Envelope "${e.name}" ends`, description: "What's left returns to your wallet." });
  const unlocks = await db.query(`SELECT id, available_at AS d FROM vault_unlocks WHERE user_id = $1 AND status = 'waiting'`, [userId]);
  for (const v of unlocks.rows) events.push({ uid: `vault-${v.id}`, date: v.d, summary: "Vault unlock goes through", description: "Cancel it before today if you didn't ask for it." });
  const cosign = await db.query(
    `SELECT id, kind, cosign_due_at AS d FROM approvals WHERE user_id = $1 AND status = 'pending' AND needs_cosign AND cosign_due_at IS NOT NULL`,
    [userId],
  );
  for (const a of cosign.rows) events.push({ uid: `cosign-${a.id}`, date: a.d, summary: `Approval goes through unless a helper objects (${String(a.kind).replaceAll("_", " ")})`, description: "Protected account waiting period." });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AgentPay//Calendar//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:AgentPay", "METHOD:PUBLISH"];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT", fold(`UID:${e.uid}@agentpay`), `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(e.date)}`,
      fold(`SUMMARY:${esc(e.summary)}`), fold(`DESCRIPTION:${esc(e.description)}`), "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
