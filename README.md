# AgentPay

A prepaid wallet that lets AI agents pay for tools, API calls and subscriptions, with spending limits and passkey approvals that the human owner controls.

- **Owners** top up credits by card (Stripe), give each agent its own key with limits, and approve big spending with a passkey on their own device.
- **Agents** (Claude Code, Claude Desktop or any MCP client) call paid tools, request subscriptions, and get savings suggestions through an MCP server.
- **Providers** list APIs as paid tools (per call or per unit) and sell subscription plans that include calls, then request payouts of their earnings.

## Quick start

Needs Docker and Node 20+.

```sh
npm install
npm run db:up        # Postgres on localhost:5433
cp .env.example .env # then edit; Stripe keys are optional for local use
npm run seed         # demo provider, tools, plans, and a demo owner with $20 test credits
npm start            # http://localhost:8787
```

`npm run seed` writes the demo owner token and agent key to `.demo-credentials.json` (git-ignored). Open the dashboard and sign in with the owner token.

Connect an agent (the dashboard prints this command with a fresh key when you create one):

```sh
claude mcp add agentpay --scope user \
  -e AGENTPAY_URL=http://localhost:8787 -e AGENTPAY_AGENT_KEY=ap_agent_... \
  -- npx -y tsx /path/to/agent-pay/src/mcp.ts
```

Tests: `npm test` (needs the database running).

## How money moves

All amounts are integer cents in an append-only, double-entry ledger. A balance is always calculated from the ledger, never stored. Postgres rejects any transaction whose entries don't sum to zero, and rejects any update or delete.

A paid call:

1. **Quote**: price per call, or price × units for per-unit tools.
2. **Checks**: tool allowlist, per-call maximum, and approval threshold (above it, the agent gets `pending_approval` and retries with the `approvalId` once the owner approves).
3. **Hold**: under a lock on the wallet, check the 24h and 30-day caps and the balance, then move the price into escrow. Two parallel calls can never both spend the same money.
4. **Call** the provider: `POST {callId, input}` with the provider's `Authorization` header.
5. **Settle**:
   - If the provider succeeds, the amount is charged. The provider gets it minus the platform fee, and any unused part of the hold goes back to the wallet. Per-unit providers can report fewer units with `X-AgentPay-Units`.
   - If the provider fails or times out, the full hold is released.
   - Holds left open by a crash are released by a sweeper.

Every call has an idempotency key, so a retry returns the stored result and is never charged twice. Card top-ups are credited only from Stripe's signed webhook. Each Stripe event is recorded, so a redelivered event changes nothing.

## Subscriptions and passkeys

- **Requesting.** An agent calls `browse_plans` and then `subscribe` with a reason. Nothing is charged until the owner approves.
- **Approving.** The owner approves on the dashboard with a passkey (Windows Hello, Touch ID, a phone, or a security key). The WebAuthn challenge is derived from that specific approval and amount, so a signature can't be reused to approve anything else. Agents can request spending but can't approve it.
- **Spending ceiling.** Each subscription has its own price ceiling. If the provider raises the price above it, the subscription goes `past_due` until the owner re-approves with a passkey.
- **Renewals.** Renewals happen automatically from the wallet. If the wallet is short, the subscription goes `past_due`, renews by itself after a top-up, and is canceled after 7 unpaid days. After downtime, missed periods are not back-billed.
- **Cancelling.** Cancelling needs no passkey, and agents can do it. By default the subscription runs to the end of the paid period; "End now" stops it immediately.
- **Included calls.** Plans can include calls to a tool. Those calls cost nothing until the quota runs out, then normal per-call pricing applies.
- **Recommendations.** These compare the marketplace catalog with the owner's real usage:
  - duplicate plans in the same category
  - cheaper plans that cover the same need
  - underused plans where paying per call would cost less
  - tools where a plan would cost less than current pay-per-call spending

## MCP tools

| Tool | What it does |
|---|---|
| `list_paid_tools` | Tools this key may call, with prices and input schemas |
| `get_quote` | Price, whether approval is needed, remaining budget |
| `call_paid_tool` | Pay for and run a call |
| `get_balance` | Wallet, recent spend, limits |
| `check_approval` | Status of a pending approval |
| `browse_plans` | Catalog plus personalised savings suggestions |
| `subscribe` / `renew_subscription` | Request a subscription or renewal (owner approves with a passkey) |
| `list_subscriptions` / `cancel_subscription` | Manage subscriptions |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | local docker | |
| `PUBLIC_URL` | `http://localhost:8787` | Passkeys are bound to this origin; changing it invalidates registered passkeys |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | empty | Test keys only outside `NODE_ENV=production`. Forward webhooks locally with `stripe listen --forward-to localhost:8787/api/stripe/webhook` |
| `PLATFORM_FEE_BPS` | `1000` | Platform cut, 1000 = 10% |
| `REQUIRE_PASSKEY` | `true` | When `false`, owners without a passkey can approve with just their token |
| `ALLOW_DEV_CREDIT` | `false` | Free test credits from the dashboard. Never in production |

## Not production-ready yet

This is a working MVP. Before handling real money:

- **Owner login.** Owners sign in with a bearer token returned at sign-up. Replace this with real authentication (passkey login is the natural fit) and add rate limiting.
- **Payouts.** These are recorded in the ledger only. Sending money to providers (Stripe Connect) also raises money-transmission and KYC questions in many places; that's a legal step, not just an API call.
- **Provider secrets.** Upstream `Authorization` headers are stored in plain text. Encrypt them at rest.
- **Provider endpoints.** These aren't sandboxed. Block private/internal addresses before letting untrusted providers register (SSRF).
- **Hosting.** Run the API behind HTTPS. Passkeys need HTTPS everywhere except `localhost`.
