# Self-hosting AgentPay

Running AgentPay for yourself is the simplest way to use it. It's your server, your Stripe account and your agents, so nobody is holding anyone else's money. Hosting it **for other people** is different: see [us-market.md](us-market.md#legal-structure-for-the-us) before you do.

## What you need

- Node 20+ and PostgreSQL 15+ (17 is what the repo uses)
- An HTTPS domain. Passkeys only work over HTTPS, except on `localhost`.
- A Stripe account. Use **test mode** until you've reviewed the legal side.
- Optional: an Anthropic API key (reading grocery-list photos) and a Keepa key (Amazon prices)

## Steps

1. **Database.** Create a database and user, then set `DATABASE_URL`. Migrations run automatically when the server starts.
2. **Configuration.** Copy `.env.example` to `.env` and set:
   - `PUBLIC_URL`: your HTTPS origin, e.g. `https://agentpay.example.com`. **Passkeys are bound to it.** Changing it later invalidates every registered passkey.
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Point a Stripe webhook at `https://<your domain>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`.
   - Leave `ALLOW_DEV_CREDIT` unset (false).
   - Keep `REQUIRE_PASSKEY=true`.
   - The owner controls: `COOLING_OFF_HOURS`, `DRAIN_GUARD`, `VAULT_UNLOCK_DELAY_HOURS`, `GUARANTEE_MAX_CENTS`. The defaults are safe.
3. **Run it.** Run `npm ci && npm start` behind a reverse proxy that terminates TLS (Caddy, nginx, a cloud load balancer). The server also runs the background jobs: hold sweeping, renewals, envelope expiry and vault unlocks.
4. **Sign up and set up** at `/` and keep the owner token safe. Then:
   - Register a passkey (Passkeys tab).
   - Read and sign the risk statement (Permissions tab).
   - Create an agent key per agent. New keys start in a 12-hour cooling-off.
5. **Connect your agents** with the [MCP server](../packages/mcp) or the [Claude Code plugin](../plugins/agentpay), using `AGENTPAY_URL=https://<your domain>`.

## Before trusting it with real money

Read **Not production-ready yet** in the [README](../README.md#not-production-ready-yet) and [SECURITY.md](../SECURITY.md). In particular:
- **Owner sign-in:** it's a bearer token. Keep it secret, and put the dashboard behind your own access control if you can.
- **Provider endpoints:** they aren't sandboxed. Only list providers you trust.
- **Imported bank statements:** they're financial data. Back up and encrypt the database accordingly.

## Upgrading

Pull and restart: new migrations apply on start. The ledger and the why log are append-only, so back up before any manual database work.
