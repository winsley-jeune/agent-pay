# Design: prepaid virtual cards, so AgentPay can actually pay

Status: decisions made (below); not built. Building waits on the Stripe Issuing application and a legal review (see "Before we build").

## Decisions (settled 2026-10-05)

1. **The agent never knows any payment information.** No card numbers, no expiry, no CVC, not even the last four digits. The agent never opens payment settings and never changes the payment method at checkout.
2. **Always prepaid.** A card can only spend credits already in the owner's wallet. No overdraft, no credit.
3. **The owner is the cardholder** of their AgentPay cards. This is the heavier identity-check (KYC) path, and it's accepted.
4. **The owner must understand the risk first.** Before any card or site permission, the owner reads a plain risk statement and signs it with their passkey. This is built: `src/permissions.ts` (`RISK_STATEMENT`, versioned). A lawyer should review the wording before launch.
5. **Agents use the owner's own signed-in browser, with per-site permission.** The owner allows a site and specific actions (browse, fill the cart, check out approved orders, manage subscriptions), with an expiry, revocable at any time. The agent never types passwords or sign-in codes; if a site isn't signed in, it stops and asks the owner. This is built: Permissions page, `check_browser_access` / `request_browser_access` MCP tools, activity log.

## The card model these decisions lead to

Because the agent can't type a card number, there are no "cards the agent fills in". Instead:

- **One persistent AgentPay card per store or subscription**, saved by the owner themselves. In the dashboard, Stripe Issuing Elements shows the number to the owner only, and the owner adds it to walmart.com, Netflix and so on, ideally named "AgentPay" at the store and set as the default.
  - The number never touches AgentPay's servers.
  - The agent never sees it.
- **Locked at the card network** to that merchant (`spending_controls`: allowed categories and merchant), with a spending limit.
- **Each charge is approved in real time only if something the owner approved matches it.** The card is persistent, but each authorization is effectively single-use:

| Card for | A charge is approved only if |
|---|---|
| A store (grocery orders, price-watch purchases) | It matches an order the owner approved with their passkey: same merchant, amount within the approved maximum (estimate + 15%), within 24 hours of approval. One charge per approval. |
| A subscription (Netflix, gym...) | It's within the subscription's price ceiling, at most once per billing period. A price increase is declined and the owner is asked to approve the new price. |

So even if the agent picked the wrong items or tried to check out twice, the card itself refuses anything the owner didn't approve. The wallet balance is a hard ceiling on top.

**At checkout, the agent's rule:** use the payment method the store already has selected. If the store asks for payment details, or the selected method isn't the owner's AgentPay card (shown by the nickname the owner chose, never by number), stop and ask the owner. This is a rule the agent follows, written into the MCP server instructions. The enforcement is the card: a charge on the owner's personal card doesn't go through AgentPay at all. That's the one gap: if the agent picks the owner's personal card at checkout, AgentPay can't stop it. Owners should make the AgentPay card the store's default and keep personal cards off stores they let agents use. The risk statement says this.

## How a charge flows

```
 Store charges the AgentPay card ──► Stripe Issuing ──► issuing_authorization.request (webhook, answer within ~2 s)
                                                          │
                                                          ▼
                                   AgentPay decides under the existing wallet lock:
                                   card active? merchant matches? an approved order / subscription
                                   period it matches? amount within approval? enough prepaid credit?
                                   ──► approve + ledger "card_hold" (mark the approval used)
                                   └─► decline (reason logged, owner notified)
                                                          │
 Store settles ──► issuing_transaction.created ──► ledger "card_capture" (amount can differ slightly)
 Auth expires / reversed ──► issuing_authorization.updated ──► ledger "card_release"
 Refund ──► negative transaction ──► ledger "refund" to the wallet
```

The ~2 second answer window means no human, no passkey and no outside calls in that path: just the wallet lock, indexed lookups and a ledger insert. That's already how `placeHold` in `src/gateway.ts` works. Everything human happens beforehand (approving the order, the subscription price, the card itself).

## Data model (new)

- `cards`: user_id, issuer_card_id, purpose (`store` | `subscription`), merchant lock (name pattern and category), link to the `external_subscriptions` row for subscription cards, owner's nickname, limit, status (`active` | `paused` | `closed`). **No card number, expiry or CVC columns, ever.**
- `card_authorizations`: issuer authorization id (unique, because webhooks can arrive twice), card_id, amount, merchant as reported, decision, decline reason, matched approval id, hold_id.
- Ledger types `card_hold`, `card_capture`, `card_release`; a `card_funding` system account for credits moved to the issuer.
- Approval kinds `card_create` and `card_limit_raise`, passkey-signed. Grocery-order and subscription approvals gain an "authorizes one card charge" meaning.

## Lifecycle

- **Create.** From the Permissions or subscriptions page. Needs the current risk consent and a passkey approval that states the merchant and limit ("AgentPay card for walmart.com, prepaid, up to $150 per approved order").
- **Pause / resume.** Instantly stops new charges. **Pausing is not cancelling.** For contract services (phone carriers, gyms, Adobe) the app repeats the contract warning AgentPay already shows and asks the owner to confirm the bill is still owed. Otherwise a paused AT&T card leads to late fees and collections.
- **Close.** When a subscription is cancelled, close its card. Later charges are declined, which also catches the "still charged after cancel" case the bank import detects today.

## Money and reconciliation

- Owners' prepaid top-ups (already through Stripe) are moved into the Issuing balance, either automatically above a threshold or on a schedule.
- A daily reconciliation job compares ledger `card_*` entries with the issuer's transactions and balance, and alerts on any difference (late or partial captures, refunds, disputes). It must exist before real money flows.
- Disputes and chargebacks: a manual process at first.

## Before we build: things to confirm (can't be verified from here)

- **Stripe Issuing.**
  - Needs an application and Stripe's approval. Availability is limited by country and business type, so check Stripe's Issuing eligibility page and talk to Stripe.
  - Confirm that consumer cardholders (decision 3) are allowed under the program Stripe offers.
- **Cost.** Per-card and per-transaction fees: Stripe Issuing pricing page.
- **Legal.**
  - Holding customers' prepaid money can make AgentPay a money transmitter or stored-value provider in some places.
  - Cardholder KYC and terms.
  - The risk statement's wording.
  - These need a lawyer, not an engineer.
- **Test mode.** Issuing has a test mode once enabled on the account. Build and test entirely there first.
- **Webhook timeout behavior.** What Stripe does if we don't answer an authorization in time, and how to configure it. Confirm in the Issuing docs before designing the failure mode.

## Alternatives

- **Lithic or Marqeta.** Same model (issuing API plus real-time authorization webhook). Worth a quote comparison; the design transfers almost unchanged.
- **No issuing.** Stay with track, remind, guide and approve. No compliance cost. Agent spending outside the marketplace is then limited by rules and approvals, not by the card network.

## Plan

1. Business: Stripe Issuing application and legal opinion.
2. Done already: risk consent, per-site browser permissions, activity log, grocery order approvals, subscription price ceilings, product picking.
3. Build in Stripe test mode: `cards` + `card_authorizations`, the authorization webhook matching approvals under the wallet lock, capture/release/refund, reconciliation, passkey-approved card creation, pause with contract acknowledgment.
4. First real use: **store cards for grocery orders**, where the approved total becomes a hard limit. Then subscription cards.
