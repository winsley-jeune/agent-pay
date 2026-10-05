# AgentPay

[![CI](https://github.com/winsley-jeune/agent-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/winsley-jeune/agent-pay/actions/workflows/ci.yml)
[![License: AGPL-3.0 / MIT](https://img.shields.io/badge/license-AGPL--3.0%20%2F%20MIT-blue)](LICENSING.md)
[![MCP](https://img.shields.io/badge/MCP-server-black)](packages/mcp)

**The open-source control panel for your AI agents' spending.** Claude Code, Cursor or any MCP agent pays for tools, APIs and subscriptions from a prepaid wallet. You decide how far each agent can go.

- **Levels per agent:**
  - L0: asks before every paid call
  - L1: pays only what your rules allow
  - L2: pays on its own within its limits
- **Envelopes**: money set aside for one agent or task, returned when it ends.
- **Passkey approvals** on your own device, with the full terms shown before you sign.
- **A kill switch** that stops every agent at once, and a **vault** no agent can touch.
- **A tamper-evident "why" log**: what each agent did, what you asked for, and why it was allowed.
- **Hard refusals**: agents never buy adult content, medicine, weapons, drugs, alcohol, tobacco or gambling.
- Also: everyday subscriptions (Netflix, phone, gym) in one list with one-tap cancel, price watch with signed buy mandates, and grocery carts filled in your own browser with approval before checkout.

Self-host it in a few minutes, or use the [MCP server](packages/mcp) and [Claude Code plugin](plugins/agentpay) against your own server.

> **Status: working MVP, not a licensed money service.** Use Stripe **test mode** unless you've done your own legal review. See [Not production-ready yet](#not-production-ready-yet) and [docs/us-market.md](docs/us-market.md).

**Who it's for:**
- **Owners** top up credits by card (Stripe), give each agent its own key, level and limits, and approve with a passkey.
- **Agents** (Claude Code, Claude Desktop, Cursor or any MCP client) call paid tools, request subscriptions and envelopes, and log why they act, through the MCP server.
- **Providers** list APIs as paid tools (per call or per unit) and sell subscription plans that include calls.

## Quick start

Needs Docker and Node 20+.

```sh
git clone https://github.com/winsley-jeune/agent-pay && cd agent-pay
npm install
npm run db:up        # Postgres on localhost:5433
cp .env.example .env # then edit; Stripe keys are optional for local use
npm run seed         # demo provider, tools, plans, and a demo owner with $20 test credits
npm start            # http://localhost:8787
```

`npm run seed` writes the demo owner token and agent key to `.demo-credentials.json` (git-ignored). Open the dashboard and sign in with the owner token. For a real deployment, see [docs/self-hosting.md](docs/self-hosting.md).

Connect an agent. The dashboard prints this command with a fresh key when you create one:

```sh
claude mcp add agentpay --scope user   -e AGENTPAY_URL=http://localhost:8787 -e AGENTPAY_AGENT_KEY=ap_agent_...   -- npx -y @winsley-jeune/agentpay-mcp
```

Or install the Claude Code plugin, which adds the MCP server and a skill with the spending rules:

```sh
claude plugin marketplace add winsley-jeune/agent-pay
claude plugin install agentpay@agentpay
```

Working from this repo, you can run the MCP server from source with `npx -y tsx packages/mcp/src/index.ts`. Configs for Cursor and Claude Desktop are in [packages/mcp](packages/mcp#install).

Tests: `npm test` (needs the database running).

## How money moves

All amounts are integer cents in an append-only, double-entry ledger. A balance is always calculated from the ledger, never stored. Postgres rejects any transaction whose entries don't sum to zero, and rejects any update or delete.

A paid call:

1. **Quote**: price per call, or price × units for per-unit tools.
2. **Checks**: restricted categories, tool allowlist, per-call maximum, then the agent's level and rules decide: pay, pay and flag for review, or ask the owner (the agent gets `pending_approval` with the reason, and retries with the `approvalId` once the owner approves). See [Owner controls](#owner-controls).
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

## Everyday subscriptions (Netflix, phone, gym...)

The **All subscriptions** tab, and the `list_all_subscriptions` MCP tool, put everything in one list: everyday subscriptions billed by the merchant plus AgentPay plans, with a monthly total by category. AgentPay does not pay these merchants; it tracks them, reminds you, helps you cancel, and finds savings.

- **Adding.** Add by hand, by an agent, or from a bank or card CSV export. The import finds recurring charges (weekly, monthly, yearly), ignores one-off and varying purchases like groceries or fuel, and links charges to known services.
  - Apple, Google and Amazon combine several subscriptions into one statement line, so you add each one yourself.
  - Importing the same file twice adds nothing new.
- **Alerts.** Price increases from the statement, and charges that keep coming after you cancelled.
- **Reminders.** Before renewals (3 days, or 14 for yearly plans), before a free trial ends, and before a contract ends.
- **Cancelling.** The steps depend on who bills it: Paramount+ bought on an iPhone is cancelled in Apple settings, not on Paramount's site.
  - Phone carriers, gyms and Adobe warn about contracts, device balances and fees, and that blocking the card or not paying isn't cancelling.
  - An agent must `request_cancel` first. You approve it (with your passkey), and only then can the agent record it as cancelled.
- **Savings ideas.**
  - bundles (Disney+ and Hulu, Apple One)
  - paying separately for something a bundle you have already includes
  - cheaper ad-supported tiers
  - yearly plans
  - services you haven't used in 45 days
  - rotating streaming services
  - trials and contracts ending soon

Catalog prices (`src/catalog.ts`) are approximate US list prices as of the date in that file, used only for comparisons. Update them as prices change; the price you enter for your own subscription is always what's used for your totals.

Try it with the demo: `npm run seed:maria` creates Maria (Netflix, Apple TV+, Paramount+ billed through Apple, Disney+, a Hulu trial, AT&T with a device balance, Planet Fitness, Spotify) and `examples/maria-statement.csv`. Her credentials are in `.demo-credentials.json`.

## Price watch

Paste a product link (Amazon or any store) and a target price. AgentPay **never scrapes stores, signs in to them, or buys**. Your agent buys only under a buy mandate you signed (see [Owner controls](#owner-controls)).

- **Where prices come from.**
  - The owner's agent reads the page in the owner's own browser and calls `record_price`.
  - The owner enters a price.
  - Keepa supplies prices automatically when `KEEPA_API_KEY` is set. The Keepa parsing is tested against sample responses only, not a live key.
- **Alerts.** Target reached (once each time the price crosses it), a new lowest price, a drop of 10% or more from the previous price, and the deal ending.
- **Timing advice.** Black Friday and Cyber Monday dates are calculated. Prime Day and Prime Big Deal Days are shown only as typical windows, because Amazon announces them each year.
- **Links.** Amazon links are cleaned up to `/dp/ASIN`, without tracking or affiliate parameters.

## Groceries

Take a photo of a handwritten list (Claude Opus 5.5 reads it; needs `ANTHROPIC_API_KEY`) or type it.

1. The owner's agent fills the cart at Walmart or Whole Foods in the owner's own browser. It reports each product and price, or what it swapped or couldn't find.
2. When everything is accounted for, the owner approves the total with their passkey (up to +15% for weighed produce and fees).
3. The agent may then check out and record the order, but only within the approved total.

Changing the cart after asking for approval cancels that request. AgentPay has no store account. "Don't check out before approval" is a rule the agent follows; AgentPay can't block a store's checkout. Single-use virtual cards would make it a hard limit; see [docs/design/virtual-cards.md](docs/design/virtual-cards.md).

Try it with `examples/grocery-list.png`.

## Permissions: agents in your own browser

- **The risk statement.** Before an agent may act on any website, the owner reads it on the Permissions page and signs it with their passkey. It says plainly:
  - what's protected: passkey approvals, prepaid limits, merchant-locked cards, instant revoke
  - what isn't: mistakes the agent makes inside a site you allowed, and a charge to a personal card the store also has saved
- **Per-site permission.** The owner then allows each site separately (`walmart.com`, subdomains included) for specific actions: browse, fill the cart, check out approved orders, manage subscriptions. Each permission has an expiry, can be revoked any time, and withdrawing the statement revokes them all. Every agent action is logged, including attempts that weren't allowed.
- **Signed-in sessions only.** Agents use sessions the owner is already signed in to. They never type passwords or sign-in codes, never see payment details (not even the last four digits), and never change the payment method. AgentPay stores none of these.
- **A rule, not a lock.** AgentPay can't see or block what happens in the browser; a permission is a recorded consent the agent must check (`check_browser_access`) before acting. The hard limits come from approvals and, later, prepaid cards ([design](docs/design/virtual-cards.md)).

**Choosing products.** When a store shows many versions of an item, the agent sends what it sees to `pick_product`. For "2 lb carrots", the options might be 1 lb, 2 lb or 5 lb bags, baby carrots, organic carrots, or carrot cake. AgentPay picks using:
- the quantity on the list and the price per unit
- the owner's preferences: organic, store brand, size strategy, brands, dietary needs, minimum rating
- what the owner bought before at that store, remembered after each order

It never picks a different product, so carrot cake is out, and it reports what it skipped and why.

## Owner controls

Ideas from agent payments in Asia ([docs/asia.md](docs/asia.md)), built for one owner and all their agents.

- **Levels.** Each agent key has a level:
  - **L0, ask** (`ask`): every paid call needs your passkey.
  - **L1, rules** (`rules`): calls go through only when one of your rules covers them. A rule names tools (or any), a maximum per call, and whether matching calls simply pay (`auto`) or pay and get flagged for you to review (`observe`). Anything else asks.
  - **L2, budget** (`budget`): the original behaviour. Calls pay on their own within the caps and below the approval threshold.
  - On any level, calls above **observe above** pay but are flagged on the Control tab, and the approval threshold always asks.
- **Safety checks** that turn "pay" into "ask":
  - **Cooling-off**: a new key pays at most `COOLING_OFF_AUTO_MAX_CENTS` per call on its own for its first `COOLING_OFF_HOURS`.
  - **Drain guard**: asks when one agent's last hour of spending would be more than half the wallet (and over `DRAIN_GUARD_MIN_CENTS`).
- **Envelopes.** Money moved out of the wallet for one agent (or any), for some tools (or any), until a date (at most 90 days).
  - You approve it with your passkey, and calls it covers are then paid from it without asking again.
  - Per-call limits and caps still apply.
  - Close it any time; when it ends, what's left returns to the wallet.
  - Agents can ask for one (`request_envelope`).
- **Kill switch.** "Freeze everything" needs no passkey. At once:
  - every agent request is refused (HTTP 423)
  - pending approvals are declined
  - AgentPay plan renewals wait

  Unfreezing is a passkey approval.
- **Vault.** Money you lock in the vault can't be spent by any agent or approval. Getting it back takes a passkey approval, then a wait (`VAULT_UNLOCK_DELAY_HOURS`, 24 by default), which you can cancel.
- **Final confirmation.** Every approval shows the "before you approve" terms under its summary: per-period and 12-month cost, renewal, the price ceiling, how to cancel, and what it can't enforce. The terms are bound into the passkey challenge together with the summary.
- **Renewals and price rises.**
  - Every renewal and trial reminder has a one-tap **Cancel…**, which starts `request_cancel`.
  - When an everyday subscription's price goes up and you didn't type the new price yourself, it waits for your decision: **Keep new price** or **Cancel…**.
- **Buy mandates.** "Buy this when it drops under $40, at most one, on target.com, until Dec 1", signed with your passkey.
  - Right before checkout, the agent calls `check_buy_mandate` with the price and site. It also needs a browser permission to check out on that site.
  - Recording the purchase uses up the mandate. A price above it is recorded as an incident.
  - AgentPay doesn't pay the store, so this is a rule the agent follows, checked afterwards, until AgentPay cards can refuse the charge themselves.
- **Purpose on permissions.** Browser permissions can carry a purpose ("weekly groceries"), shown on the approval and kept with the permission.
- **Why log.** Every paid call (paid, flagged, asked, refused), approval, browser action, envelope, vault move and freeze is logged in one list per owner.
  - Each entry has the owner's instruction, the agent's reason, AgentPay's reason and the result.
  - The list is append-only and hash-chained: **Verify chain** on the Control tab recomputes it and names the first entry that was changed or removed.
- **Incidents.** You or the agent can record an incident, and flagged calls can be reported from the review list. Each incident gets one of four kinds:
  - **misjudgment**: a mistake within the authority given
  - **condition_breach**: the agent went past a limit
  - **system_bug**
  - **hijacked**: a stolen key or prompt injection

  The guarantee policy says what AgentPay would refund. It offers nothing until `GUARANTEE_MAX_CENTS` is set, which is a legal and financial decision, not a code one. AgentPay has no refund payout step yet; incidents are records.
- **One board.** The Control tab lists everything that can spend your money, each with a Stop button:
  - agents with their levels
  - envelopes and the vault
  - browser permissions and buy mandates
  - every subscription
  - calls to review, open incidents and reminders

## Protected accounts and trusted helpers

For people who want someone they trust watching over their agents' spending: an older parent and an adult child, someone recovering from illness, anyone who has been targeted by scams.

- **Inviting a helper.** Invite them **by email or by text message** (or just get a code to pass on).
  - **How it's sent:** email goes through [Resend] and texts through [Twilio] once configured (see Configuration). Without them, the owner gets the code to share.
  - **The link:** it carries the code in the `#` part of the address, which browsers never send to a server.
  - **Who can accept:** an email invitation only from the AgentPay account with that email address. A text invitation works for whoever holds the code.
  - **Limits:** invitations expire after 7 days; "Resend" issues a new code and the old one stops working; owners can cause at most 10 messages a day.
  - **What's stored:** every send is recorded without the code.
- **The owner keeps their money.** A **trusted helper** (up to 3) accepts an invitation from their own AgentPay account. A helper can:
  - see the account: Control board, why log, approvals, subscriptions
  - freeze it
  - co-sign or object to big approvals

  A helper can never spend, move money, create agent keys, change settings, approve alone, unfreeze alone, or lock the owner out. Helpers act on the owner's account with the `X-AgentPay-Account` header, which is limited to those actions.
- **Protection is opt-in**, on the Family tab. On a protected account, the following need the owner's passkey **plus** a helper's co-signature, **or** a waiting period (72 hours by default) that any helper can stop by objecting:
  - approvals from the co-sign threshold ($50 by default)
  - envelopes, browser permissions, buy mandates, unfreezing, vault unlocks and the risk statement, at any amount

  Scams run on urgency, and the wait breaks it. An unreachable helper only delays things; it never blocks the owner for good.
- **Weakening protection waits too.** Turning it off, raising the threshold, shortening the wait, removing a helper, or loosening an agent's limits only takes effect after the waiting period, and helpers see it in their alerts. The owner can cancel it in the meantime. Tightening is immediate, and so is revoking an agent key.
- **New agents start at L0** (ask before every paid call) on a protected account.
- **Alerts.** Each helper sees what's new on the accounts they help: approvals asked for, refusals, freezes, co-signatures, incidents, protection changes. **They appear on the dashboard only; nothing sends an email or a text yet.**
- **"Is someone on the phone with you?"** Before signing a big or sensitive approval on a protected account, the owner answers three plain questions:
  - Did someone phone or message you about this?
  - Were you told to keep it secret?
  - Were you told it's urgent?

  Any "yes" holds the approval until a trusted helper reviews it (the waiting period no longer completes it) and alerts the helpers. Without helpers, the waiting period still applies, with a warning.
- **An allowance instead.** If the caregiver should hold the money, the caregiver is the owner: give the other person's agent its own key with a monthly cap at L0 or L1. AgentPay never moves money between people.
- **Agents are told.** If an approval waits for a co-signature, `check_approval` says so, and agents must wait rather than ask again. They must never pressure the owner to hurry or to remove a helper.

## Orders and returns

Every order the agent places becomes a **purchase** with a return deadline: grocery orders, and items bought under a buy mandate. Agents record other orders with `record_purchase`.
- **Return deadlines** follow typical store policies (Walmart and Target 90 days, Amazon 30, Best Buy 15, others 30). The owner can correct the date.
- **Reminders** come three days before the window closes, and for orders not confirmed two days after ordering.
- **Confirming delivery.** The order stays open until the owner confirms what arrived (`confirm_received`). Missing items mark it as a problem and say what refund to ask the store for. The agent may draft the request, but sends it only with the owner's go-ahead.

## Agents paying agents

An agent that sells its work is listed like any paid tool, by its developer as a provider. Another agent buys from it with `call_paid_tool`, inside its own owner's levels, rules, envelopes and approvals. AgentPay holds the money, calls the selling agent, and charges only if it delivers. There's no transfer from one wallet to another: the buyer pays AgentPay for a service, and the seller is AgentPay's vendor.

- **Signed requests.** Every request to a provider is signed with Ed25519. The signature covers the call, the tool, the cents held, the paying agent's id, a timestamp and the body. Providers check it with [`@winsley-jeune/agentpay-verify`](packages/verify) against `/.well-known/agentpay-keys.json`.
- **Long-running jobs.** A tool can answer `202` and report later.
  - The call returns `running` with the money **held, not charged** (up to the tool's `maxJobSeconds`, 1 hour by default).
  - The provider posts the result to the callback URL with the job token, and AgentPay charges then. A failure, or no answer in time, returns the money.
  - Agents follow progress with `get_job`.
- **Prices quoted per task.** A tool priced `quoted` lists a maximum.
  - The buying agent asks for a price with `request_task_quote`; this is free and nothing is held.
  - It then calls with the `quoteId`. A quote is good once, for the same input, until it expires, and never above the listed maximum.
  - The owner's rules apply to the quoted price.

The full provider guide is in [docs/providers.md](docs/providers.md). Not built yet: paying out providers' earnings (Stripe Connect plus legal review), and paying agents outside AgentPay (x402, A2A).

## Test keys for developers

Create an agent key with **Test key** ticked (or `"test": true`), and it starts with `ap_test_`. A test key:
- spends **pretend credits** from a separate test wallet, starting at $100 (`add_test_credits` adds more)
- sends providers an `X-AgentPay-Test: true` header; they're never paid pretend money, and neither is the platform fee
- follows its level and rules like a real key, and can **approve its own call approvals** (`approve_test_call`), so automated tests run end to end without a passkey
- reaches only the paid-call endpoints, because subscriptions, envelopes, shopping and the owner's real subscriptions all involve real money

## What agents refuse

Agents never buy, pay for, add to a cart, or act on websites for:
- pornography and adult content
- medicines (prescription and over the counter), pharmacies and medical devices
- firearms, ammunition and weapons
- controlled or illegal drugs
- alcohol
- tobacco, nicotine and vaping
- gambling
- gift cards, prepaid cards, crypto purchases and money transfers (the way most scams take money)

The owner can't turn this off; they buy these themselves.

- **Where it's enforced:**
  - listing a tool or plan
  - a paid call
  - subscribing
  - watching a price and signing a buy mandate
  - picking a product
  - grocery items: a restricted item stays on the list as **refused** and can't be put in the cart
  - browser permissions: pharmacy, liquor, gun, adult, vape, gambling, crypto-exchange, gift-card and money-transfer sites, by a list of known stores and words in the site name (e.g. `walgreens.com`, `cvs.com`, `totalwine.com`, `…pharmacy.com`)
- **The agent also refuses on its own.** The MCP instructions say so, and `check_purchase_policy` checks anything it's unsure about.
- **Matching is by words**, so it can miss things. It errs toward refusing, for example non-alcoholic beer, and leaves everyday items such as root beer, wine vinegar, kale and glue guns alone. See `src/policy.ts`.

## MCP tools

| Tool | What it does |
|---|---|
| `list_paid_tools` | Tools this key may call, with prices and input schemas |
| `get_quote` | Price, whether approval is needed and why, remaining budget |
| `call_paid_tool` | Pay for and run a call, with the agent's reason and the owner's instruction |
| `get_balance` | Wallet, recent spend, limits, level, rules, envelopes, frozen or not |
| `check_approval` | Status of a pending approval |
| `browse_plans` | Catalog plus personalised savings suggestions |
| `subscribe` / `renew_subscription` | Request a subscription or renewal (owner approves with a passkey) |
| `list_subscriptions` / `cancel_subscription` | Manage AgentPay plans |
| `list_all_subscriptions` | Everything in one list, with totals and reminders |
| `find_service` / `add_subscription` / `update_subscription` | Track everyday subscriptions |
| `import_bank_statement` | Find subscriptions, price increases and charges after cancelling in a CSV |
| `savings_ideas` | Bundles, cheaper tiers, unused services and more |
| `cancel_guide` / `request_cancel` / `mark_canceled` | Cancel safely, with the owner's approval |
| `watch_price` / `list_price_watches` / `record_price` / `mark_bought` / `stop_watch` | Wait for a sale |
| `request_buy_mandate` / `check_buy_mandate` | Buy a watched item only within a mandate the owner signed |
| `create_grocery_list` (items, text or photo) / `get_grocery_list` / `list_grocery_lists` / `set_grocery_store` | Grocery lists |
| `update_grocery_item` / `request_order_approval` / `mark_grocery_ordered` | Fill the cart, get approval, record the order |
| `check_browser_access` / `request_browser_access` / `log_browser_activity` | Act in the owner's signed-in browser only with permission |
| `pick_product` / `get_shopping_preferences` | Choose among versions of an item |
| `check_purchase_policy` | Is this item, tool or site something agents must refuse? |
| `list_purchases` / `record_purchase` / `confirm_received` | Orders, return deadlines and what arrived |
| `request_task_quote` / `get_job` | Agents selling to agents: get a price per task, follow a long-running job |
| `approve_test_call` / `add_test_credits` | Test keys only: approve your own calls, add pretend credits |
| `request_envelope` | Ask the owner to set money aside for this agent |
| `report_mistake` | Record an incident the agent caused |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | local docker | |
| `PUBLIC_URL` | `http://localhost:8787` | Passkeys are bound to this origin; changing it invalidates registered passkeys |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | empty | Test keys only outside `NODE_ENV=production`. Forward webhooks locally with `stripe listen --forward-to localhost:8787/api/stripe/webhook` |
| `PLATFORM_FEE_BPS` | `1000` | Platform cut, 1000 = 10% |
| `REQUIRE_PASSKEY` | `true` | When `false`, owners without a passkey can approve with just their token |
| `ALLOW_DEV_CREDIT` | `false` | Free test credits from the dashboard. Never in production |
| `COOLING_OFF_HOURS` / `COOLING_OFF_AUTO_MAX_CENTS` | `12` / `100` | A new agent key only pays calls up to this much on its own for its first hours |
| `DRAIN_GUARD` / `DRAIN_GUARD_MIN_CENTS` | `true` / `2000` | Ask when an hour of one agent's spending would be more than half the wallet |
| `VAULT_UNLOCK_DELAY_HOURS` | `24` | Wait between approving a vault unlock and the money moving |
| `GUARANTEE_MAX_CENTS` | `0` | Refund guarantee per incident. 0 = none offered |
| `RESEND_API_KEY` / `EMAIL_FROM` | empty | Send helper invitations by email ([Resend]); `EMAIL_FROM` like `AgentPay <hello@yourdomain.com>` on a domain verified with Resend |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | empty | Send helper invitations by text message ([Twilio]); `TWILIO_FROM` is your Twilio number in +1… form. US texting needs A2P 10DLC registration with Twilio |

## Not production-ready yet

This is a working MVP. Before handling real money:

- **Owner login.** Owners sign in with a bearer token returned at sign-up. Replace this with real authentication (passkey login is the natural fit) and add rate limiting.
- **Payouts.** These are recorded in the ledger only. Sending money to providers (Stripe Connect) also raises money-transmission and KYC questions in many places; that's a legal step, not just an API call.
- **Provider secrets.** Upstream `Authorization` headers are stored in plain text. Encrypt them at rest.
- **Provider endpoints.** These aren't sandboxed. Block private/internal addresses before letting untrusted providers register (SSRF).
- **Hosting.** Run the API behind HTTPS. Passkeys need HTTPS everywhere except `localhost`.

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, and the rules for changes that touch money
- [SECURITY.md](SECURITY.md): report vulnerabilities privately
- [LICENSING.md](LICENSING.md): the server and dashboard are [AGPL-3.0](LICENSE); the MCP server, Claude Code plugin and policy rules are [MIT](LICENSE-MIT)

[Resend]: https://resend.com
[Twilio]: https://www.twilio.com
