import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, deny } from "../src/approvals.js";
import type { Db } from "../src/db.js";
import {
  addExternal,
  allSubscriptions,
  cancelGuide,
  externalSuggestions,
  getExternal,
  importStatement,
  markExternalCanceled,
  parseStatementCsv,
  reminders,
  requestExternalCancel,
  rollRenewalDates,
} from "../src/external.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const manual = { source: "manual" as const };

describe("statement import", () => {
  it("parses common bank CSV layouts", () => {
    const signed = parseStatementCsv(
      ["Date,Description,Amount", "09/01/2026,NETFLIX.COM 866-579-7172 CA,-17.99", "09/02/2026,PAYROLL DEPOSIT,2500.00", '09/03/2026,"COFFEE, INC",-4.50'].join("\n"),
    );
    expect(signed).toEqual([
      { date: "2026-09-01", description: "NETFLIX.COM 866-579-7172 CA", amountCents: 1799 },
      { date: "2026-09-03", description: "COFFEE, INC", amountCents: 450 },
    ]);
    const debitCredit = parseStatementCsv(["Posted Date,Payee,Debit,Credit", "2026-09-05,SPOTIFY USA,11.99,", "2026-09-06,REFUND,,5.00"].join("\n"));
    expect(debitCredit).toEqual([{ date: "2026-09-05", description: "SPOTIFY USA", amountCents: 1199 }]);
    // Card exports where purchases are positive and payments negative.
    const card = parseStatementCsv(["Transaction Date,Description,Amount", "2026-09-01,HULU 877-8244858,11.99", "2026-09-02,ONLINE PAYMENT THANK YOU,-500.00", "2026-09-03,SHOP,20.00"].join("\n"));
    expect(card.map((l) => l.amountCents)).toEqual([1199, 2000]);
  });

  it("finds monthly and yearly subscriptions and ignores one-off purchases", async () => {
    const { user } = await setup(db);
    const csv = [
      "Date,Description,Amount",
      "2026-06-03,NETFLIX.COM,-17.99", "2026-07-03,NETFLIX.COM,-17.99", "2026-08-03,NETFLIX.COM,-17.99", "2026-09-03,NETFLIX.COM,-17.99",
      "2025-09-15,AMAZON PRIME*AB12C,-139.00", "2026-09-15,AMAZON PRIME*ZX98Y,-139.00",
      "2026-07-10,PLANET FITNESS CLUB 0412,-15.00", "2026-08-10,PLANET FITNESS CLUB 0412,-15.00", "2026-09-10,PLANET FITNESS CLUB 0412,-15.00",
      "2026-07-21,APPLE.COM/BILL 866-712-7753,-12.99", "2026-08-21,APPLE.COM/BILL 866-712-7753,-12.99", "2026-09-21,APPLE.COM/BILL 866-712-7753,-12.99",
      "2026-08-14,BEST BUY 00123,-349.99", "2026-09-02,WHOLE FOODS #123,-82.10", "2026-09-19,WHOLE FOODS #123,-45.33",
    ].join("\n");
    const res = await importStatement(db, user.id, parseStatementCsv(csv));
    expect(res.imported).toBe(15);

    const bySlug = Object.fromEntries(res.proposals.map((p) => [p.serviceSlug ?? p.merchantKey, p]));
    expect(bySlug.netflix).toMatchObject({ interval: "month", priceCents: 1799, confidence: "high", nextRenewalOn: "2026-10-03" });
    expect(bySlug["amazon-prime"]).toMatchObject({ interval: "year", priceCents: 13900, nextRenewalOn: "2027-09-15" });
    expect(bySlug["planet-fitness"]).toMatchObject({ interval: "month", category: "fitness" });
    expect(bySlug["store:apple"]).toMatchObject({ billedThrough: "apple", interval: "month" });
    expect(bySlug["store:apple"].note).toMatch(/several subscriptions/);
    // One-off and irregular purchases are not subscriptions.
    expect(res.proposals.map((p) => p.name).join(" ")).not.toMatch(/Best Buy|Whole Foods/i);

    // Importing the same file twice adds nothing.
    const again = await importStatement(db, user.id, parseStatementCsv(csv));
    expect(again.imported).toBe(0);
  });

  it("flags a price increase and charges after cancelling", async () => {
    const { user } = await setup(db);
    const netflix = await addExternal(db, user.id, { serviceSlug: "netflix", priceCents: 1549, interval: "month" }, manual);
    const spotify = await addExternal(db, user.id, { serviceSlug: "spotify", priceCents: 1199, interval: "month" }, manual);
    await markExternalCanceled(db, user.id, spotify.id, { confirmation: "SP-123" });
    await db.query("UPDATE external_subscriptions SET canceled_at = '2026-08-15' WHERE id = $1", [spotify.id]);

    const csv = ["Date,Description,Amount", "2026-08-01,NETFLIX.COM,-15.49", "2026-09-01,NETFLIX.COM,-17.99", "2026-08-05,SPOTIFY USA,-11.99", "2026-09-05,SPOTIFY USA,-11.99"].join("\n");
    const { alerts, proposals } = await importStatement(db, user.id, parseStatementCsv(csv));

    expect(alerts).toContainEqual(expect.objectContaining({ type: "price_increase", subscriptionId: netflix.id, fromCents: 1549, toCents: 1799 }));
    expect(alerts).toContainEqual(expect.objectContaining({ type: "still_charged_after_cancel", subscriptionId: spotify.id, chargedOn: "2026-09-05" }));
    expect(alerts.filter((a) => a.type === "still_charged_after_cancel")).toHaveLength(1); // the 08-05 charge was before cancelling
    // Tracked merchants are not proposed again.
    expect(proposals.find((p) => p.serviceSlug === "netflix" || p.serviceSlug === "spotify")).toBeUndefined();

    const updated = await getExternal(db, user.id, netflix.id);
    expect(updated).toMatchObject({ priceCents: 1799, nextRenewalOn: "2026-10-01" });
    expect(updated.priceHistory).toContainEqual({ date: "2026-09-01", fromCents: 1549, toCents: 1799 });
  });
});

describe("cancelling", () => {
  it("sends you to Apple when Paramount+ is billed through Apple, not to Paramount", async () => {
    const { user } = await setup(db);
    const viaApple = await addExternal(db, user.id, { serviceSlug: "paramount-plus", priceCents: 1299, billedThrough: "apple" }, manual);
    const direct = await addExternal(db, user.id, { serviceSlug: "paramount-plus", name: "Paramount+ (2nd)", priceCents: 1299 }, manual);

    const g1 = cancelGuide(viaApple);
    expect(g1.url).toBe("https://apps.apple.com/account/subscriptions");
    expect(g1.steps.join(" ")).toMatch(/Settings/);
    expect(g1.warnings.join(" ")).toMatch(/through Apple/);

    const g2 = cancelGuide(direct);
    expect(g2.url).toBe("https://www.paramountplus.com/account/");
    expect(g2.warnings.join(" ")).not.toMatch(/through Apple/);
  });

  it("warns that a phone contract or gym can cost money and that blocking the card isn't cancelling", async () => {
    const { user } = await setup(db);
    const att = await addExternal(
      db, user.id, { serviceSlug: "att-wireless", priceCents: 8500, contractUntil: "2027-03-01", earlyTerminationFeeCents: 32000, nextRenewalOn: "2026-10-12" }, manual,
    );
    expect(att.billedThrough).toBe("carrier");
    const g = cancelGuide(att);
    const w = g.warnings.join(" ");
    expect(w).toMatch(/device balance/);
    expect(w).toMatch(/2027-03-01/);
    expect(w).toMatch(/\$320\.00/);
    expect(w).toMatch(/does not cancel/);
    expect(g.cancelBy).toBe("2026-10-12");

    const gym = await addExternal(db, user.id, { serviceSlug: "planet-fitness", priceCents: 1500 }, manual);
    expect(cancelGuide(gym).warnings.join(" ")).toMatch(/in-person or written/);
    const netflix = await addExternal(db, user.id, { serviceSlug: "netflix", priceCents: 1799 }, manual);
    expect(cancelGuide(netflix).warnings.join(" ")).not.toMatch(/contract/i);
  });

  it("lets an agent request a cancel, needs the owner to approve, and only then lets the agent mark it done", async () => {
    const { user, agentKey } = await setup(db);
    const att = await addExternal(db, user.id, { serviceSlug: "att-wireless", priceCents: 8500, earlyTerminationFeeCents: 32000 }, { source: "agent", agentKey });

    const req = await requestExternalCancel(db, user.id, att.id, agentKey, "switching to a cheaper carrier");
    expect(req.guide.warnings.length).toBeGreaterThan(0);
    expect((await getExternal(db, user.id, att.id)).status).toBe("cancel_requested");
    await expect(markExternalCanceled(db, user.id, att.id, { byAgent: true })).rejects.toMatchObject({ code: "not_approved" });

    await expect(approve(db, user.id, req.approvalId)).rejects.toMatchObject({ code: "passkey_required" });
    await approve(db, user.id, req.approvalId, undefined, { requirePasskey: false });
    expect((await getExternal(db, user.id, att.id)).status).toBe("cancel_approved");

    const done = await markExternalCanceled(db, user.id, att.id, { byAgent: true, confirmation: "ATT-778812" });
    expect(done).toMatchObject({ status: "canceled", cancelConfirmation: "ATT-778812" });
  });

  it("puts it back how it was when the owner says no", async () => {
    const { user, agentKey } = await setup(db);
    const trial = await addExternal(db, user.id, { serviceSlug: "peacock", priceCents: 1099, status: "trial", trialEndsOn: "2026-12-01" }, manual);
    const req = await requestExternalCancel(db, user.id, trial.id, agentKey);
    await deny(db, user.id, req.approvalId);
    expect((await getExternal(db, user.id, trial.id)).status).toBe("trial");
  });
});

describe("one view of everything", () => {
  it("totals marketplace and everyday subscriptions per month, leaving out trials and cancelled ones", async () => {
    const { user } = await setup(db);
    await addExternal(db, user.id, { serviceSlug: "netflix", priceCents: 1799, interval: "month" }, manual);
    await addExternal(db, user.id, { serviceSlug: "amazon-prime", priceCents: 13900, interval: "year" }, manual);
    await addExternal(db, user.id, { serviceSlug: "peacock", priceCents: 1099, status: "trial", trialEndsOn: "2030-01-01" }, manual);
    const gone = await addExternal(db, user.id, { serviceSlug: "hulu", priceCents: 1199 }, manual);
    await markExternalCanceled(db, user.id, gone.id);

    const all = await allSubscriptions(db, user.id);
    expect(all.items.map((i) => i.name).sort()).toEqual(["Amazon Prime", "Netflix", "Peacock"]);
    expect(all.totals.monthlyCents).toBe(1799 + Math.round(13900 / 12));
    expect(all.totals.byCategory).toEqual({ streaming: 1799, shopping: Math.round(13900 / 12) });
  });

  it("reminds before renewals, trial ends and contract ends, and keeps renewal dates current", async () => {
    const { user } = await setup(db);
    await addExternal(db, user.id, { serviceSlug: "netflix", priceCents: 1799, nextRenewalOn: "2026-10-07" }, manual);
    await addExternal(db, user.id, { serviceSlug: "peacock", priceCents: 1099, status: "trial", trialEndsOn: "2026-10-09" }, manual);
    await addExternal(db, user.id, { serviceSlug: "att-wireless", priceCents: 8500, contractUntil: "2026-10-30", nextRenewalOn: "2026-10-20" }, manual);
    const r = await reminders(db, user.id, "2026-10-05");
    expect(r.map((x) => [x.type, x.name, x.daysLeft])).toEqual([
      ["renewal", "Netflix", 2],
      ["trial_ending", "Peacock", 4],
      ["contract_ending", "AT&T Wireless", 25],
    ]);

    const old = await addExternal(db, user.id, { serviceSlug: "spotify", priceCents: 1199, nextRenewalOn: "2026-07-05" }, manual);
    await rollRenewalDates(db, "2026-10-05");
    expect((await getExternal(db, user.id, old.id)).nextRenewalOn).toBe("2026-10-05");
  });
});

describe("everyday savings ideas", () => {
  it("spots bundles, double-paying, ad tiers, unused services and too many streaming services", async () => {
    const { user } = await setup(db);
    const add = (input: Parameters<typeof addExternal>[2]) => addExternal(db, user.id, input, manual);
    await add({ serviceSlug: "disney-plus", priceCents: 1899 });
    await add({ serviceSlug: "hulu", priceCents: 1899 });
    await add({ serviceSlug: "netflix", priceCents: 2499, lastUsedOn: "2026-06-01" });
    await add({ serviceSlug: "paramount-plus", priceCents: 1299, billedThrough: "apple" });
    await add({ name: "Apple One Individual", category: "bundle", priceCents: 1995, billedThrough: "apple" });
    await add({ serviceSlug: "apple-tv", priceCents: 1299, billedThrough: "apple" });

    const s = await externalSuggestions(db, user.id, "2026-10-05");
    const types = s.map((x) => x.type);
    expect(s.find((x) => x.type === "already_in_bundle")?.message).toMatch(/Apple One Individual already includes Apple TV\+/);
    expect(s.find((x) => x.type === "bundle")?.message).toMatch(/Disney\+ \+ Hulu/);
    expect(s.find((x) => x.type === "cheaper_tier" && x.message.startsWith("Netflix"))).toMatchObject({ monthlySavingsCents: 2499 - 799, approximate: true });
    expect(s.find((x) => x.type === "unused")?.message).toMatch(/Netflix since 2026-06-01/);
    expect(types).toContain("rotate_streaming");
    expect(types).toContain("annual_plan"); // Paramount+ annual
    // Biggest savings first.
    expect(s.map((x) => x.monthlySavingsCents)).toEqual([...s.map((x) => x.monthlySavingsCents)].sort((a, b) => b - a));
  });
});
