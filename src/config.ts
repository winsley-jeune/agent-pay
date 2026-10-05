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
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000),
};
