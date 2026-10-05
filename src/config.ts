import { readFileSync } from "node:fs";

// Minimal .env loader so the project has no dotenv dependency.
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env file; rely on the real environment
}

const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://agentpay:agentpay@localhost:5433/agentpay",
  port: Number(process.env.PORT ?? 8787),
  publicUrl,
  // WebAuthn: passkeys are bound to this host name and origin.
  publicOrigin: new URL(publicUrl).origin,
  rpId: process.env.PASSKEY_RP_ID ?? new URL(publicUrl).hostname,
  // When true, approvals always need a passkey, even before the owner has registered one.
  requirePasskey: process.env.REQUIRE_PASSKEY !== "false",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 1000),
  allowDevCredit: process.env.ALLOW_DEV_CREDIT === "true",
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 300),
  // Optional: automatic Amazon prices for price watches (https://keepa.com/#!api).
  keepaApiKey: process.env.KEEPA_API_KEY ?? "",
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000),
  // A new agent key only pays small calls on its own for its first hours (Singapore's cooling-off after a new device).
  coolingOffHours: Number(process.env.COOLING_OFF_HOURS ?? 12),
  coolingOffAutoMaxCents: Number(process.env.COOLING_OFF_AUTO_MAX_CENTS ?? 100),
  // Asks the owner when one agent's last hour of spending looks like the wallet being drained.
  drainGuard: process.env.DRAIN_GUARD !== "false",
  drainGuardMinCents: Number(process.env.DRAIN_GUARD_MIN_CENTS ?? 2000),
  // Money leaves the vault this long after the owner approves the unlock.
  vaultUnlockDelayHours: Number(process.env.VAULT_UNLOCK_DELAY_HOURS ?? 24),
  // The most AgentPay refunds per incident it covers. 0 = no guarantee published yet (a legal decision first).
  guaranteeMaxCents: Number(process.env.GUARANTEE_MAX_CENTS ?? 0),
};
