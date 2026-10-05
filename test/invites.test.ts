import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createUser } from "../src/auth.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";
import { acceptInvite, inviteHelper, listHelpers, resendInvite } from "../src/helpers.js";
import { DAILY_SEND_LIMIT, maskContact, normalizeEmail, normalizePhone } from "../src/notify.js";
import { freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const saved = { ...config };
afterEach(() => {
  Object.assign(config, saved);
  vi.unstubAllGlobals();
});

/** Pretend Resend and Twilio, capturing what would be sent. */
function fakeProviders(ok = true) {
  Object.assign(config, { resendApiKey: "re_test", emailFrom: "AgentPay <hello@agentpay.example>", twilioAccountSid: "AC123", twilioAuthToken: "tok", twilioFrom: "+15550001111" });
  const sent: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify(ok ? { id: "msg_1", sid: "SM1" } : { message: "bad number" }), { status: ok ? 200 : 400 });
  });
  return sent;
}

let n = 0;
async function user(email?: string) {
  return (await createUser(db, email ?? `u${++n}-${Date.now()}@example.com`)).user;
}

describe("contacts", () => {
  it("normalises emails and US or international phone numbers", () => {
    expect(normalizeEmail(" Maria@Example.COM ")).toBe("maria@example.com");
    expect(() => normalizeEmail("maria@")).toThrow(/valid email/);
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(() => normalizePhone("12345")).toThrow(/US number/);
    expect(maskContact("email", "maria@example.com")).toBe("m•••a@example.com");
    expect(maskContact("phone", "+15551234567")).toBe("•••• 4567");
  });
});

describe("inviting helpers by email or phone", () => {
  it("sends an email invitation with a link the helper's own account must match", async () => {
    const sent = fakeProviders();
    const owner = await user();
    await db.query("UPDATE users SET display_name = 'Rosa' WHERE id = $1", [owner.id]);
    const helperEmail = `maria${++n}@example.com`;
    const inv = await inviteHelper(db, owner.id, "Maria (daughter)", { email: helperEmail.toUpperCase() });
    expect(inv).toMatchObject({ delivery: "sent", sentTo: expect.stringMatching(/@example\.com$/) });
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(sent[0].body);
    expect(body.to).toEqual([helperEmail]);
    expect(body.subject).toBe("Rosa invited you to be a trusted helper on AgentPay");
    expect(body.text).toContain(`/#accept=${inv.code}`);

    // The code is never stored, only what was sent where.
    const { rows } = await db.query("SELECT * FROM notifications WHERE user_id = $1", [owner.id]);
    expect(rows[0]).toMatchObject({ channel: "email", recipient: helperEmail, purpose: "helper_invite", status: "sent", provider_id: "msg_1" });
    expect(JSON.stringify(rows)).not.toContain(inv.code);

    // Someone else holding the code can't use it.
    const stranger = await user();
    await expect(acceptInvite(db, stranger.id, inv.code)).rejects.toMatchObject({ code: "wrong_account" });
    const maria = await user(helperEmail);
    expect(await acceptInvite(db, maria.id, inv.code)).toMatchObject({ ownerId: owner.id });
    expect((await listHelpers(db, owner.id))[0]).toMatchObject({ status: "active", contactType: "email", deliveryStatus: "sent" });
  });

  it("texts a phone invitation through Twilio; the code is the proof", async () => {
    const sent = fakeProviders();
    const owner = await user();
    const inv = await inviteHelper(db, owner.id, "Sam (son)", { phone: "(555) 987-6543" });
    expect(inv).toMatchObject({ delivery: "sent", sentTo: "•••• 6543" });
    expect(sent[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const form = new URLSearchParams(sent[0].body);
    expect(form.get("To")).toBe("+15559876543");
    expect(form.get("From")).toBe("+15550001111");
    expect(form.get("Body")).toContain(`#accept=${inv.code}`);
    expect(await acceptInvite(db, (await user()).id, inv.code)).toMatchObject({ ownerId: owner.id });
  });

  it("without a provider, returns the code for the owner to pass on", async () => {
    const owner = await user();
    const inv = await inviteHelper(db, owner.id, "Neighbour", { phone: "555-222-3333" });
    expect(inv).toMatchObject({ delivery: "not_configured", sentTo: null });
    expect(inv.note).toMatch(/isn't set up on this server. Give •••• 3333 this code yourself/);
    expect(inv.code).toMatch(/^ap_invite_/);
  });

  it("reports a failed send, resends with a new code, and refuses duplicates", async () => {
    fakeProviders(false);
    const owner = await user();
    const inv = await inviteHelper(db, owner.id, "Ana", { email: "ana@example.com" });
    expect(inv.delivery).toBe("failed");
    expect(inv.note).toMatch(/Couldn't send to a•••a@example.com \(Resend HTTP 400: bad number\)/);
    await expect(inviteHelper(db, owner.id, "Ana again", { email: "ana@example.com" })).rejects.toMatchObject({ code: "already_invited" });

    fakeProviders(true);
    const again = await resendInvite(db, owner.id, inv.helperRowId);
    expect(again.delivery).toBe("sent");
    expect(again.code).not.toBe(inv.code);
    const ana = await user("ana@example.com");
    await expect(acceptInvite(db, ana.id, inv.code)).rejects.toMatchObject({ code: "invite_invalid" });
    expect(await acceptInvite(db, ana.id, again.code)).toMatchObject({ ownerId: owner.id });
  });

  it("caps how many messages an owner can cause in a day", async () => {
    fakeProviders();
    const owner = await user();
    await db.query(
      "INSERT INTO notifications (user_id, channel, recipient, purpose, status) SELECT $1, 'sms', '+15550000000', 'helper_invite', 'sent' FROM generate_series(1, $2)",
      [owner.id, DAILY_SEND_LIMIT],
    );
    await expect(inviteHelper(db, owner.id, "One more", { phone: "555-444-5555" })).rejects.toMatchObject({ code: "send_limit", status: 429 });
    expect(await listHelpers(db, owner.id)).toEqual([]); // nothing half-made
  });
});
