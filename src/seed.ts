import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentKey, createUser } from "./auth.js";
import { config } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { createProvider, createTool, toolBySlug } from "./registry.js";
import { SAMPLE_SECRET } from "./sample.js";
import { createPlan, planBySlug } from "./subscriptions.js";
import { devCredit } from "./wallet.js";

// Creates a demo provider with real tools and plans, plus a demo owner with
// $20 of test credits and an agent key. Safe to run more than once.

const db = createPool();
await migrate(db);

const existing = await toolBySlug(db, "weather-now", { includeInactive: true });
if (existing) {
  console.log("Demo data already exists. To start over: npm run db:down -- -v && npm run db:up && npm run seed");
  await db.end();
  process.exit(0);
}

const { user: providerUser } = await createUser(db, "demo-provider@agentpay.local");
const provider = await createProvider(db, providerUser.id, "AgentPay Demo Provider");
const auth = `Bearer ${SAMPLE_SECRET}`;

await createTool(db, provider.id, {
  slug: "weather-now",
  name: "Current weather",
  description: "Current temperature, humidity and wind for any city (Open-Meteo data).",
  pricingType: "per_call",
  priceCents: 2,
  upstreamUrl: `${config.publicUrl}/sample/weather`,
  upstreamAuth: auth,
  inputSchema: { type: "object", properties: { city: { type: "string", description: "City name, e.g. Montreal" } }, required: ["city"] },
});
await createTool(db, provider.id, {
  slug: "dice",
  name: "Fair dice",
  description: "Rolls dice with a cryptographic RNG. Billed per die actually rolled (stops early at stopAt).",
  pricingType: "per_unit",
  priceCents: 1,
  unitsField: "dice",
  maxUnits: 100,
  upstreamUrl: `${config.publicUrl}/sample/dice`,
  upstreamAuth: auth,
  inputSchema: {
    type: "object",
    properties: {
      dice: { type: "integer", minimum: 1, maximum: 100, description: "Maximum dice to roll" },
      sides: { type: "integer", minimum: 2, maximum: 1000, default: 6 },
      stopAt: { type: "integer", description: "Stop rolling when this value comes up" },
    },
    required: ["dice"],
  },
});

const plans = [
  { slug: "weather-basic", name: "Weather Basic", category: "weather", priceCents: 300, interval: "month", toolSlug: "weather-now", includedCalls: 300, features: ["300 calls/month", "Current conditions"] },
  { slug: "weather-pro", name: "Weather Pro", category: "weather", priceCents: 900, interval: "month", toolSlug: "weather-now", includedCalls: 2000, features: ["2,000 calls/month", "Priority support"] },
  { slug: "weather-annual", name: "Weather Annual", category: "weather", priceCents: 3000, interval: "year", toolSlug: "weather-now", includedCalls: 4000, features: ["4,000 calls/year", "Best value"] },
  { slug: "dice-club", name: "Dice Club", category: "games", priceCents: 100, interval: "week", features: ["Members-only dice art", "Weekly newsletter"] },
] as const;
for (const p of plans) {
  if (!(await planBySlug(db, p.slug, { includeInactive: true }))) {
    await createPlan(db, provider.id, { ...p, description: p.features.join(" · "), features: [...p.features] });
  }
}

const { user, token } = await createUser(db, "demo-owner@agentpay.local");
await devCredit(db, user.walletAccountId, 2000);
const { key } = await createAgentKey(db, user.id, "Claude Code (demo)", {
  perCallMaxCents: 100,
  dailyCapCents: 500,
  approvalThresholdCents: 50,
});

const out = fileURLToPath(new URL("../.demo-credentials.json", import.meta.url));
writeFileSync(out, JSON.stringify({ ownerEmail: user.email, ownerToken: token, agentKey: key, url: config.publicUrl }, null, 2));
console.log(`Demo data created. Credentials written to ${out} (git-ignored).`);
console.log(`  Owner token: ${token}`);
console.log(`  Agent key:   ${key}`);
await db.end();
