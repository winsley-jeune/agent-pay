import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentKey, createUser } from "./auth.js";
import { syncCatalog } from "./catalog.js";
import { createPool } from "./db.js";
import { addExternal } from "./external.js";
import { migrate } from "./migrate.js";
import { addWatch, recordPrice } from "./pricewatch.js";
import { devCredit } from "./wallet.js";

// Demo owner "Maria" with typical everyday subscriptions, and a sample bank
// statement (examples/maria-statement.csv) to try the import. Dates are
// relative to today so the reminders always have something to show.

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const monthsAgo = (n: number, dayOfMonth: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(Math.min(dayOfMonth, 28));
  return d.toISOString().slice(0, 10);
};

const db = createPool();
await migrate(db);
await syncCatalog(db);

const email = "maria@agentpay.local";

/** Maria is waiting for a sale on headphones; prices from the last few weeks, as her agent saw them. */
async function seedPriceWatch(userId: string) {
  if ((await db.query("SELECT 1 FROM price_watches WHERE user_id = $1", [userId])).rowCount) return;
  const { watch } = await addWatch(db, userId, {
    url: "https://www.amazon.com/Sony-WH-1000XM5-Canceling-Headphones-Hands-Free/dp/B09XS7JWHH/ref=sr_1_1?tag=example-20",
    title: "Sony WH-1000XM5 headphones",
    targetPriceCents: 27_900,
    notes: "For her birthday in December",
  });
  const seen: [number, number, string?][] = [[-21, 39_999], [-14, 34_800, "Limited time deal"], [-7, 39_999], [-1, 32_999]];
  for (const [d, price, note] of seen) {
    await recordPrice(db, userId, watch.id, { priceCents: price, source: "agent", note, observedAt: new Date(Date.now() + d * 86_400_000).toISOString() });
  }
}

const existing = await db.query("SELECT id FROM users WHERE email = $1", [email]);
if (existing.rowCount) {
  await seedPriceWatch(existing.rows[0].id);
  console.log("Maria already exists (added her price watch if missing). To start over: npm run db:down -- -v && npm run db:up && npm run seed && npm run seed:maria");
  await db.end();
  process.exit(0);
}

const { user, token } = await createUser(db, email);
await devCredit(db, user.walletAccountId, 1000);
const { key } = await createAgentKey(db, user.id, "Maria's assistant", { perCallMaxCents: 100, dailyCapCents: 300, approvalThresholdCents: 50 });
const m = { source: "manual" as const };

await addExternal(db, user.id, { serviceSlug: "netflix", planName: "Standard", priceCents: 1549, nextRenewalOn: day(2), paymentMethod: "Visa ending 4417", lastUsedOn: day(-1) }, m);
await addExternal(db, user.id, { serviceSlug: "apple-tv", priceCents: 1299, billedThrough: "apple", nextRenewalOn: day(11), lastUsedOn: day(-20) }, m);
await addExternal(db, user.id, {
  serviceSlug: "paramount-plus", planName: "Premium", priceCents: 1299, billedThrough: "apple", nextRenewalOn: day(16), lastUsedOn: day(-70),
  notes: "Subscribed from the iPhone app",
}, m);
await addExternal(db, user.id, { serviceSlug: "disney-plus", planName: "Premium", priceCents: 1899, nextRenewalOn: day(19), paymentMethod: "Visa ending 4417", lastUsedOn: day(-9) }, m);
await addExternal(db, user.id, { serviceSlug: "hulu", planName: "No ads", priceCents: 1899, status: "trial", trialEndsOn: day(4), paymentMethod: "Visa ending 4417" }, m);
await addExternal(db, user.id, {
  serviceSlug: "att-wireless", planName: "Unlimited Extra, 1 line", priceCents: 8500, nextRenewalOn: day(13), contractUntil: day(22),
  earlyTerminationFeeCents: 32000, paymentMethod: "AutoPay, checking", notes: "Device installment: iPhone, about $320 left",
}, m);
await addExternal(db, user.id, {
  serviceSlug: "planet-fitness", planName: "Black Card", priceCents: 2999, nextRenewalOn: day(7), paymentMethod: "Mastercard ending 0932",
  lastUsedOn: day(-3), notes: "Annual fee $49 charged in February",
}, m);
await addExternal(db, user.id, { serviceSlug: "spotify", priceCents: 1199, nextRenewalOn: day(24), paymentMethod: "Visa ending 4417", lastUsedOn: day(0) }, m);
await seedPriceWatch(user.id);

// A statement with the charges above, a Netflix price rise, and two subscriptions Maria forgot about.
const lines = [["Date", "Description", "Amount"]];
for (let i = 3; i >= 1; i--) {
  lines.push([monthsAgo(i, 7), "NETFLIX.COM 866-579-7172 CA", i === 1 ? "-17.99" : "-15.49"]);
  lines.push([monthsAgo(i, 12), "PLANET FITNESS CLUB 0412", "-29.99"]);
  lines.push([monthsAgo(i, 18), "ATT*BILL PAYMENT 800-331-0500", "-85.00"]);
  lines.push([monthsAgo(i, 21), "APPLE.COM/BILL 866-712-7753 CA", "-25.98"]);
  lines.push([monthsAgo(i, 24), "SPOTIFY USA 877-778-1161", "-11.99"]);
  lines.push([monthsAgo(i, 2), "NYTIMES DIGITAL SUB NYTIMES.COM", "-25.00"]);
  lines.push([monthsAgo(i, 15), "AUDIBLE*MEMBERSHIP AMZN.COM/BILL", "-14.95"]);
  lines.push([monthsAgo(i, 9), "WHOLE FOODS MARKET #10233", `-${(60 + i * 13.37).toFixed(2)}`]);
  lines.push([monthsAgo(i, 26), "SHELL OIL 57444", `-${(38 + i * 4.1).toFixed(2)}`]);
}
lines.push([monthsAgo(2, 4), "TARGET 00012345", "-64.20"]);
lines.push([monthsAgo(1, 1), "PAYROLL DIRECT DEPOSIT", "3150.00"]);
lines.sort((a, b) => (a[0] === "Date" ? -1 : b[0] === "Date" ? 1 : a[0].localeCompare(b[0])));
const examples = fileURLToPath(new URL("../examples/", import.meta.url));
mkdirSync(examples, { recursive: true });
writeFileSync(examples + "maria-statement.csv", lines.map((l) => l.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n") + "\n");

const credsPath = fileURLToPath(new URL("../.demo-credentials.json", import.meta.url));
let creds: Record<string, unknown> = {};
try {
  creds = JSON.parse(readFileSync(credsPath, "utf8"));
} catch {
  // first seed
}
writeFileSync(credsPath, JSON.stringify({ ...creds, maria: { email, ownerToken: token, agentKey: key } }, null, 2));
console.log(`Maria created with 8 everyday subscriptions. Credentials in ${credsPath}; sample statement in examples/maria-statement.csv`);
await db.end();
