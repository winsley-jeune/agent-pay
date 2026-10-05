# Design: virtual cards, so AgentPay can actually pay

Status: proposal, not built. Needs a business decision before any code (see "Before we build").

## Why

Today AgentPay only moves money for tools and plans sold inside its own marketplace. Everything else is tracked but paid elsewhere:

| Feature | What happens today | With virtual cards |
|---|---|---|
| Everyday subscriptions (Netflix, gym...) | Charged to the owner's own card; AgentPay reminds and guides | Each subscription gets its own card, funded from the wallet, with its own monthly limit |
| Grocery orders | Owner approves the total; the agent checks out with whatever card is saved at the store, and AgentPay can only *ask* it to stay within the total | A single-use card locked to the store, valid only up to the approved total. The limit is enforced by the card network, not by trust |
| Price watch | Alerts when the target is reached; the owner buys | "Buy now" approval issues a single-use card for that one purchase |

The idea is one card per purpose, so a leak, a price hike, or an agent mistake can only touch that one card's limit.

## How it fits what exists

The wallet ledger stays the source of truth for *policy* (who may spend what). The card issuer holds the *real money*. Every card event maps onto the hold/capture/release cycle that paid tool calls already use:

```
 Merchant charges card ──► Stripe Issuing ──► issuing_authorization.request (webhook, must answer in ~2s)
                                                │
                                                ▼
                              AgentPay decides with the existing wallet lock:
                              card active? right merchant? within card limit?
                              within wallet balance? ──► approve + ledger "card_hold"
                                                      └► decline (reason logged, owner notified)
                                                │
 Merchant settles ──► issuing_transaction.created ──► ledger "card_capture" (amount may differ from hold)
 Auth expires/reversed ──► issuing_authorization.updated ──► ledger "card_release"
 Refund ──► negative transaction ──► ledger "refund" back to the wallet
```

The 2-second answer window is the main engineering constraint: the decision path can only do the wallet lock, a few indexed reads and the ledger insert. That's already how `placeHold` in `src/gateway.ts` works. No calls to other services, no LLM, no passkey prompt in that path; anything that needs a human happens *before*, when the card is created or its limit raised.

Two layers of limits, on purpose:

1. **On the card at the issuer** (Stripe `spending_controls`: allowed merchant categories, per-authorization and monthly `spending_limits`). These hold even if AgentPay is down or buggy.
2. **In AgentPay's decision** (exact merchant match, wallet balance, subscription price ceiling, single-use flag). Finer-grained, and recorded in the ledger.

## Data model (new)

- `cards`: id, user_id, issuer_card_id, purpose (`subscription` | `grocery_order` | `purchase`), link to the `external_subscriptions` / `grocery_lists` / `price_watches` row, merchant lock (name pattern and category), `limit_cents` + interval (`per_month` or `single_use`), status (`active` | `paused` | `closed`), last4, created_at.
- `card_authorizations`: issuer authorization id (unique, for idempotency, since webhooks can arrive twice), card_id, amount, merchant as reported, decision, decline reason, hold_id.
- Ledger types: `card_hold`, `card_capture`, `card_release`; a `card_funding` system account for money moved to the issuer.
- Approval kinds: `card_create`, `card_limit_raise`. Signed with the owner's passkey like subscriptions. The summary states the ceiling: "Create a card for Netflix, up to $20.00 a month".

## Lifecycle

- **Create.** From a tracked subscription ("Pay Netflix with an AgentPay card"), an approved grocery order, or a price-watch "buy". Needs a passkey approval. Single-use cards close themselves after one capture or 7 days.
- **Using the card number.** Who types it into Netflix or Walmart is a policy choice (below). The number is shown with Stripe Issuing Elements, so it never touches AgentPay's servers or database.
- **Pause / resume.** Instantly stops new charges. **Pausing is not cancelling.** For contract services (phone carriers, gyms, Adobe) the app must repeat the contract warning AgentPay already shows, and ask the owner to confirm they understand the bill is still owed. Otherwise a paused AT&T card leads to late fees and collections.
- **Price above the ceiling.** If Netflix raises the price, the authorization is declined, and the owner gets "Netflix tried to charge $19.99; your limit is $17.99. Approve the new price?" This is the existing `price_above_owner_limit` flow, now enforced on real money.
- **Close.** When a subscription is cancelled, close its card. Any later charge is declined automatically, which also covers the "still charged after cancel" case the bank import detects today.

## Money and reconciliation

Card spending comes out of the issuer's balance, not out of our ledger. So:

- Card top-ups from owners (already Stripe) must be moved into the Issuing balance, either automatically above a threshold or on a schedule.
- A daily reconciliation job compares the sum of ledger `card_*` entries with the issuer's transactions and balance, and alerts on any difference. This is where the two systems can drift (late captures, partial captures, refunds, disputes). It needs to exist before real money flows.
- Disputes and chargebacks need a manual process at first.

## Policy decisions for you

1. **Can an agent see a card number?** Recommended: only for single-use cards (grocery and price-watch purchases), which are locked to one merchant and one approved amount, so the worst case is bounded. For subscription cards, the owner enters the number themselves, via the Issuing Elements view.
2. **Funding model.** Prepaid only, where the wallet must hold the money first (recommended, matches today), or allow a small overdraft for subscription renewals.
3. **Who is the cardholder?** Each owner as an individual cardholder (more KYC, cleaner liability) or the business as the cardholder (simpler; check whether the program allows it for consumer use).

## Before we build: things to confirm (can't be verified from here)

- **Stripe Issuing approval.** It needs an application and Stripe's approval. Availability is limited to certain countries and business types. Check Stripe's Issuing eligibility page and talk to Stripe sales.
- **Cost.** Per-card and per-transaction fees: Stripe Issuing pricing page. One card per subscription multiplies card count.
- **Compliance.**
  - Cardholder identity checks (KYC) and accepting the issuing bank's terms.
  - Holding customer money on prepaid balances can make AgentPay a money transmitter or stored-value provider in some places; this needs a lawyer's answer, not an engineering one. It's the same question as provider payouts.
- **Test mode.** Stripe offers Issuing in test mode once it's enabled on the account. Build and test entirely there first.
- **Webhook timeout behavior.** What Stripe does if we don't answer an authorization in time (approve or decline), and how to configure it. Confirm in Stripe's Issuing docs before designing the failure mode.

## Alternatives

- **Lithic or Marqeta.** The same model (issuing API plus real-time authorization webhook) from card-issuing platforms. Worth a quote comparison, since the design above transfers almost unchanged.
- **Privacy.com.** A consumer product for one person's own cards, not a platform for issuing cards to our users. Useful as a reference, not as a foundation.
- **No issuing.** Stay with track, remind, guide and approve. Zero compliance cost. The agent's spending outside the marketplace is then limited by trust and approvals, not by the card network.

## Suggested plan

1. Business: apply for Stripe Issuing, get the legal opinion on prepaid balances, and decide the three policy questions above.
2. Build in test mode: `cards` + `card_authorizations`, the authorization webhook reusing the wallet lock, capture/release/refund, reconciliation job, passkey-approved creation, pause with contract acknowledgment.
3. First real use: **single-use grocery cards.** Smallest blast radius, and the clearest benefit, because the approved total becomes a hard limit.
4. Then: subscription cards with move-a-subscription guidance, then price-watch purchases.
