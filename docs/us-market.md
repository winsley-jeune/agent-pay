# The US market: how AgentPay should behave to succeed

Written 2026-10-05, from three research passes: competitors, regulation, and demand and channels. This document is the US counterpart to [asia.md](asia.md) and builds on [distribution.md](distribution.md).

How to read it:
- **This is not legal advice.** Every legal point needs a lawyer before launch.
- **Source tags:** **[P]** primary source (company, regulator, court, SEC filing); **[M]** major press; **[B]** blog or aggregator only, so verify before quoting.

## The short version

1. **Sell control, not payments.** Americans use AI to shop but don't trust it to pay on its own.
   - Only 23% trust an AI assistant to handle payments [M, Visa via PYMNTS].
   - At most 11% would let AI make the purchase decision [M, Gartner].
   - Only 2% want full automation, while 28% say approval before purchase would raise their trust [M, PYMNTS].
   - The controls people ask for are AgentPay's: spending caps (30%), instant revoke (29%) and easy cancellation (28%) [P, Checkout.com].
   - Position AgentPay as **the owner's control panel for every agent's spending**, not as another wallet.
2. **Change the money structure before real money moves.** Today, credits paid to third-party providers look like *open-loop stored value*. That raises three problems at once: state money-transmitter licences, the CFPB prepaid-account rules (Reg E), and Stripe's restricted list. The low-risk structure is for AgentPay to be the **merchant of record**: credits are *AgentPay service credits*, and providers are AgentPay's vendors, paid through Stripe Connect. See [Legal structure](#legal-structure-for-the-us).
3. **Start with developers, then households, then caregivers.**
   - **Developers** already run agents and pay per call.
   - **Households** trust agents with groceries and subscriptions first.
   - **Caregivers** of aging parents fit AgentPay's approvals, caps and refusals better than any other segment.
4. **Don't fight the big rails; sit on top of them.**
   - Stripe's Link agent wallet claims 200M+ consumers [B].
   - Mastercard reportedly enabled agent payments on every US card [B].
   - Amex insures agent mistakes [P].
   - AgentPay wins by working across all of them, plus the everyday subscriptions none of them manage.
5. **Keep checkout on trusted merchant rails.** OpenAI shut down Instant Checkout in March 2026 after very few merchants went live [M]. People research in chat but pay where they already trust. AgentPay's design already does this: groceries are checked out on the store's own site, after the owner approves.

## What already exists in the US

| Who | What they do | Overlap with AgentPay | Their edge |
|---|---|---|---|
| **Stripe Link agent wallet** (2026-04) [P] | Consumers approve agent spending; see every purchase; revoke per agent | Approvals, per-agent revoke | 200M+ consumers [B]; spend limits only "planned" [B] |
| **Crossmint / lobster.cash** (2026-06) [P] | Agent cards on Visa and Mastercard; per-agent limits; works in Claude Code | Closest analog | Works at any merchant via card networks |
| **Coinbase Agentic Wallets** (2026-02) [P] | Wallets with per-session and per-transaction caps; MCP server; per-call payments over the x402 protocol | Per-call tool payments | Near-zero fees; crypto |
| **Amex ACE kit** (2026-04) [P] | **Agent Purchase Protection**: Amex covers eligible agent mistakes | Incidents and guarantee | Real insurance |
| **Mastercard Agent Pay / Visa Intelligent Commerce** [P][M] | Card tokens bound to one agent | The virtual-card design | Every US card |
| **Rocket Money** (10M+ members [P]) and **Rowan** (2026-08, built with Anthropic) [P] | Subscription tracking; a concierge that cancels for you; Rowan texts before a trial converts | Everyday subscriptions | Actually cancels; scale |
| **Capital One** [P] | Block recurring charges; a virtual card per merchant (Eno) | Subscriptions, card locking | Is the bank |
| **Amazon Alexa for Shopping, Walmart Sparky, Google AI Mode** [M][P] | Agents shopping inside one retailer or Google | Groceries, price watch | Each owns its store |
| **Paid-tool marketplaces** [B] | MCP Marketplace 15%, Apify 20%, RapidAPI 25%; Cloudflare's pay-per-call gateway (fees not public) | Marketplace | Catalogue size; x402 near-zero fees |

### Where AgentPay is ahead

None of the companies above combines all of these:
- one place for **every agent across hosts** (Claude, ChatGPT, Cursor, custom agents)
- **everyday subscriptions** alongside agent spending
- **graded autonomy** (L0/L1/L2 with rules)
- **envelopes, a kill switch and a vault**
- a **tamper-evident "why" log** and **incident classification**
- **refusal of restricted categories** on the agent side
- **signed buy mandates** that work at any store
- **grocery carts filled in the owner's own browser**

The last point got legal support in August 2026: the Ninth Circuit held that when Perplexity's Comet agent shops, *the user*, not the agent's maker, is the one accessing Amazon [M].

### Where AgentPay is outgunned

- **Distribution:** Stripe, Mastercard, Amazon and Rocket Money already reach the customers.
- **Liability:** Amex insures agent mistakes; AgentPay's guarantee is zero today.
- **Acceptance:** card tokens work at any merchant, while AgentPay credits pay only marketplace providers.
- **Executing cancellations:** Rocket Money and Rowan cancel for you; AgentPay guides and records.
- **Micropayment cost:** x402 per-call payments are nearly free.

## Who buys first, and what they need

| # | Segment | Evidence | What they want from AgentPay | Lead feature |
|---|---|---|---|---|
| 1 | **Developers and prosumers** running Claude Code, Cursor or custom agents | 31% of developers use agents, 14% daily [P, Stack Overflow 2025]; per-call x402 traffic is real (tens of millions of payments a month [B]) | Stop runaway spend; one key per agent; pay any tool | Levels and rules, envelopes, kill switch, why log |
| 2 | **Busy households, Gen Z and millennials** | 39% of Gen Z vs 15% of Boomers would let AI handle payment details [P, Synchrony]; 69% would let an agent spend up to $100 on groceries [P, Global Payments]; Americans spend about $1,100 a year on subscriptions, $200 of it wasted [M, CNET] | Subscriptions under control; groceries without surprises | Everyday subscriptions with one-tap cancel, groceries with approval |
| 3 | **Caregivers of aging parents** | 63M US caregivers, 39% help with finances [P, AARP / Pew]; losses to fraud for people 60+ were $7.7B in 2025 [P, FBI via AARP] | Delegated spending with limits, approvals, refused categories and a log they can read | Approvals, caps, refusals, kill switch, log. *Family delegation isn't built yet.* |
| 4 | Small businesses | 28% spend $25–99 a month on AI tools [M, Bluevine]; little evidence they want an agent wallet | Later | Later |

**Start with segment 1.** It is the fastest to reach (MCP directories, Claude Code plugins). It needs no consumer card program. And it fits today's code: paid tools, levels, envelopes.

**Build toward segment 3 as the long-term moat.** It is underserved, emotionally strong, and suited to distribution through banks and credit unions. Greenlight reached 200+ banks, credit unions and employers that way [P].

## How AgentPay should behave in the US

These are the product decisions the research points to.

### 1. Approve-first by default

- **Defaults for new agent keys:** L1 rules with a small "anything under $5 a call, flagged for review" rule, plus the 12-hour cooling-off.
- **Opting into L2** should be a deliberate choice, and the dashboard should say why.
- **Groceries always need an approval.** Comfort grows with experience: willingness to let an agent spend up to $50 on subscriptions rose from 27% to 69% in one year [P, Global Payments]. So **suggest** a higher level after a month without incidents, instead of starting there.
- **Show amounts in the ranges people accept:** under $50 to $100 for groceries and essentials. Nearly half avoid AI for purchases over $5,000 [P, Synchrony], so very large approvals should need a second confirmation or be blocked.

### 2. Make the kill switch and instant revoke the first thing people see

Caps, revoke and easy cancellation are the top three controls people ask for. The Control tab already leads with them; landing pages and onboarding should too.

### 3. Say plainly who pays when an agent gets it wrong, and offer something

- **Stores are moving the risk onto consumers.** Target's terms (April 2026) say agent purchases are "authorized by you," and Walmart changed its terms in a similar way [M].
- **Reg E probably doesn't help.** Under Reg E, a purchase the agent made within the authority it was given is probably *not* an "unauthorized" transfer, so the consumer carries the loss. This is the regulation text, and law firms call it unresolved.
- **Amex covers agent mistakes** [P].
- **Recommendation:** launch with a **small published guarantee**, for example up to $100 per incident and only for `system_bug` and `condition_breach` (when a limit AgentPay enforces failed). Fund it from the marketplace fee.
- **Why it's affordable:** prepaid caps and the log keep the exposure small and the cases provable.
- **Why it matters:** 67% would use AI more with fraud protection [P, Synchrony].
- The setting already exists: `GUARANTEE_MAX_CENTS`. It needs a lawyer and a reserve first.

### 4. Lead with subscriptions as the everyday hook, and actually cancel

- **Subscription managers are a proven product:** Rocket Money members pay about $7–14 a month [B].
- **AgentPay's edge:** it watches agent spending and everyday subscriptions together, and its Korea-style rule asks you before a subscription costs more.
- **Close the gap with Rowan:** after the owner approves a cancellation, the agent should *do* it in the owner's signed-in browser (the `manage_subscription` permission), not just show a guide.
- **Never promise a guaranteed cancellation or savings.** That is deceptive-practices risk.

### 5. Keep the refusal list, and match it to card and Stripe rules

- **The refusal list already matches** Stripe's restricted list (tobacco, card-not-present prescription drugs, gambling, adult) and the card networks' high-risk merchant codes (adult 5967, gambling 7995, pharmacy 5122/5912).
- **Say so publicly.** "Agents can't buy medicine, alcohol, weapons…" is a trust signal for parents and caregivers.
- **Add merchant-category blocking to the virtual cards** when they arrive.

### 6. Comply with the strictest state auto-renewal laws everywhere, for AgentPay's own plans

AgentPay's marketplace plans renew automatically, so California's AB 2863 and New York's law apply:
- **Express consent:** already a passkey approval with terms.
- **Cancel online, the same way you signed up:** already possible.
- **Keep consent records for 3 years:** approvals and the log already record consent; set the retention.
- **Annual reminders:** not built yet.
- **Consent to price increases, or a refund window:** the price ceiling already stops renewals at a higher price until the owner approves.
- **New York City's click-to-cancel rule** has applied since 2026-10-01.

Apply all of this nationwide, which is simpler and safer. The cancellation *helper* (everyday subscriptions) isn't covered by these laws; its risk is overpromising.

## Legal structure for the US

The research found one structural problem with today's design and a clear fix.

**The problem.** Owners top up credits, and the wallet pays *unaffiliated* providers. That looks like open-loop stored value, which can mean:
- **State money-transmitter licences** and FinCEN registration. 31 states have adopted the model money-transmission act [P, CSBS].
- **The Reg E prepaid-account rules.** The CFPB has shrunk but the prepaid rule hasn't been rescinded, and state attorneys general and private plaintiffs can still enforce it.
- **Stripe's restricted list** ("stored value issued by anyone other than the seller", payment facilitation) [P].

### Recommended launch structure

1. **AgentPay is the merchant of record.**
   - Credits are **AgentPay service credits**, redeemable only for services AgentPay sells.
   - Marketplace tools and plans are *resold* by AgentPay.
   - Providers are AgentPay's vendors, paid a revenue share through **Stripe Connect**.
   - The consumer contracts only with AgentPay.
   - This is the closed-loop, seller-maintained pattern that OpenRouter's credits follow.
2. **No cash-out and no transfers between users.** Refunds go only back to the original card. Keep balances small: per-account limits well under FinCEN's $2,000-a-day closed-loop threshold.
3. **Envelopes and the vault are partitions of the owner's own credits.** They're fine as long as nothing leaves AgentPay except as payment for AgentPay services.
4. **Don't let credits expire, and don't make them non-refundable, without legal review.** Federal gift-card rules and California's law may apply.
5. **Virtual cards later, two options:**
   - **Stripe consumer prepaid.** The bank issues and Stripe does KYC and Reg E. It is early access, and the contract must say who is the FinCEN provider of prepaid access.
   - **Network agentic tokens on the owner's own card,** where AgentPay supplies the approvals and policy. These carry much less regulation and are what Mastercard, Visa and Amex are pushing.
   - **Recommendation: tokens first,** prepaid cards only if owners demand them.
6. **Treat imported bank statements as regulated financial data.** Under the FTC Safeguards Rule (GLBA) that means:
   - a written security programme
   - notifying the FTC of breaches affecting 500+ people
   - CCPA obligations for the agent logs
   - never using statement data for advertising

### What to avoid at launch

- a "wallet pays any provider" flow
- payouts beyond a vendor revenue share
- peer-to-peer transfers or withdrawals
- reselling gift cards
- the restricted categories
- marketing "guaranteed" savings or cancellations
- "FDIC-insured" claims unless exact pass-through wording is confirmed (regulators are watching this after the Synapse collapse)

### Needs a lawyer

- a money-transmission opinion on the merchant-of-record and Connect flow
- whether the credits are a Reg E prepaid account or fall under gift-card rules, including expiry and unclaimed balances
- the Stripe Issuing or network-token agreements
- terms that allocate who bears agent mistakes
- the GLBA privacy notice
- automated browser actions under store terms and computer-access laws (the Ninth Circuit ruling helps but isn't the last word)

## Pricing

| Plan | Price | Includes | Why |
|---|---|---|---|
| **Free** | $0 | 1 agent, L0/L1, kill switch, subscription tracking (manual + CSV), refusals | The trust features must be free: they're the pitch |
| **Plus** | $6–8/month | Unlimited agents, envelopes, vault, buy mandates, groceries, why-log export, the guarantee | Below Rocket Money's $7–14 [B], with agent features on top |
| **Family / Caregiver** (once delegation exists) | $10–14/month | Several people and their agents, shared limits, a caregiver view | The segment that pays for peace of mind |
| **Marketplace fee** | 10% | — | Already below MCP Marketplace (15%), Apify (20%) and RapidAPI (25%) [B]. Don't raise it. x402 is near-zero, so compete on trust and controls, not price |

Don't take a cut of "savings" like Rocket Money's bill negotiation (35–60%): it creates an incentive to overpromise.

## Distribution, in order

1. **Hosted MCP server with OAuth sign-in**, as in [distribution.md](distribution.md). Then list it in the **Claude Connectors Directory** (about 1,250 connectors, growing fast) and the **ChatGPT apps directory** (about 2,300 apps) [B, an independent count from August 2026]. These directories are still young and uncrowded.
2. **A Claude Code plugin and the MCP Registry** for developers. Crossmint's lobster.cash is already there, so lead with what it lacks: levels, envelopes, the why log and the kill switch.
3. **Content for households:**
   - "What your agent will never buy"
   - "Approve before it pays"
   - "Find the $200 a year you're wasting on subscriptions" [M, CNET]
4. **Banks and credit unions for the caregiver product**, following Greenlight's model of 200+ partners [P]. Community banks are also where Payman pivoted [P].
5. **Integrations instead of competition:** let Stripe Link, Mastercard Agent Pay and Amex be the payment methods, with AgentPay as the policy and approval layer above them.

## Changes to the product, in order

| # | Change | Why (US evidence) | Work |
|---|---|---|---|
| 1 | Switch wording and terms to **AgentPay service credits, merchant of record**; providers become vendors; refunds only to card; no cash-out | Money transmission, Reg E prepaid, Stripe restricted list | Mostly legal and wording; payouts become vendor settlements |
| 2 | **Default new keys to L1** with a small observe rule; suggest L2 after a month without incidents | Only 2% want full automation; trust grows with use | Small |
| 3 | **Annual reminder and 3-year consent retention** for AgentPay plans | California AB 2863, New York | Small |
| 4 | **Second confirmation or block for very large approvals** | 46% avoid AI above $5,000 | Small |
| 5 | **Agent-executed cancellation** after approval, in the owner's browser | Rocket Money and Rowan cancel; a guide isn't enough | Medium |
| 6 | **Small funded guarantee** (`GUARANTEE_MAX_CENTS`, e.g. $100) plus a refund payout step | Amex covers agent errors; 67% want fraud protection | Medium plus legal |
| 7 | **Network agentic tokens** (Mastercard Agent Pay, Visa, Amex) as payment methods under AgentPay's approvals | Card networks are the rails; less regulation than issuing cards | Large |
| 8 | **Family and caregiver delegation** (built: protected accounts and trusted helpers, co-sign or wait, delayed weakening; gift cards, crypto and money transfers refused) | 63M caregivers, $7.7B in fraud losses for people 60+ | Done; next: email or text alerts |
| 9 | **GLBA Safeguards programme** and a privacy notice before importing real statements | FTC Safeguards Rule | Process |

## Risks to watch

- **Stripe Link adds spend limits** ("planned" [B]). If Link gets rules and caps, AgentPay's developer pitch must rest on working across rails and hosts, on everyday subscriptions, and on the why log.
- **Rocket Money's Rowan expands** beyond its limited group. Answer with agent spending and approvals, which Rowan doesn't do.
- **Federal rules arrive:**
  - Sen. Warner's draft AI AGENT Act would impose duties and require auditable records. AgentPay's hash-chained log is a head start.
  - The FTC is rewriting click-to-cancel.
- **The x402 volume figures vary by source** [B]. Check x402.org before citing them.

## Sources

**Competitors**
- [Everything we announced at Sessions 2026 — Stripe](https://stripe.com/blog/everything-we-announced-at-sessions-2026)
- [What is the Stripe Link wallet for AI agents — agenticplug.ai](https://agenticplug.ai/blog/what-is-stripe-link-wallet-for-ai-agents)
- [Agentic cards API launch — Crossmint](https://www.crossmint.com/announcement/agentic-cards-api-launch-visa-basistheory)
- [lobster.cash partners with Mastercard — Crossmint](https://www.crossmint.com/announcement/lobster-cash-partners-with-mastercard-ai-agent-payments)
- [Agentic Wallets — Coinbase](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)
- [Amex ACE developer kit — BusinessWire](https://www.businesswire.com/news/home/20260414231355/en/)
- [Visa Intelligent Commerce Connect — The Paypers](https://thepaypers.com/payments/news/visa-rolls-out-intelligent-commerce-connect-as-a-single-on-ramp-to-agentic-payments)
- [Rocket Money press](https://www.rocketmoney.com/press-inquiries)
- [Rocket Money's Rowan — Rocket Companies](https://www.rocketcompanies.com/press-release/rocket-moneys-rowan-rewrites-what-ai-can-do-in-personal-finance/)
- [Recurring transactions — Capital One](https://www.capitalone.com/help-center/credit-cards/recurring-transactions/)
- [OpenAI agentic shopping — CNBC](https://www.cnbc.com/2026/03/20/open-ai-agentic-shopping-etsy-shopify-walmart-amazon.html)
- [Amazon launches Alexa for Shopping — Digital Commerce 360](https://www.digitalcommerce360.com/2026/05/13/amazon-launches-ai-agent-alexa-for-shopping/)
- [Ninth Circuit narrows CFAA reach in Perplexity ruling — PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/ninth-circuit-narrows-cfaa-reach-in-perplexity-agentic-commerce-ruling/)
- [Monetization Gateway — Cloudflare](https://blog.cloudflare.com/monetization-gateway/)
- [State of MCP monetization 2026 — mcp-marketplace.io](https://mcp-marketplace.io/blog/state-of-mcp-monetization-2026)

**Demand**
- [Gartner consumer survey — BusinessWire](https://www.businesswire.com/news/home/20260527653273/en/)
- [Agentic AI commerce hinges on consumer trust — Bain](https://www.bain.com/insights/agentic-ai-commerce-hinges-on-consumer-trust/)
- [Consumers use AI assistants but hesitate to hand over their wallets — PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/consumers-use-ai-assistants-hesitate-hand-over-their-wallets/)
- [2026 AI in commerce study — Synchrony](https://www.synchrony.com/contenthub/newsroom/2026-ai-in-commerce-study.html)
- [Global Payments survey — BusinessWire](https://www.morningstar.com/news/business-wire/20260923900333/)
- [Consumer demand for AI shopping — Checkout.com](https://www.checkout.com/newsroom/consumer-demand-for-ai-shopping-is-forming-fast-but-trust-for-agentic-commerce-is-still-catching-up)
- [61% would let AI pick pay-later options — PYMNTS](https://www.pymnts.com/bnpl/2026/61percent-of-consumers-would-let-ai-pick-pay-later-options/)
- [Target's terms on AI agents — Futurism](https://futurism.com/artificial-intelligence/target-ai-agent-tos)
- [CNET subscription survey 2025 — The Desk](https://thedesk.net/2025/05/cnet-subscription-survey-2025/)
- [23% of developers regularly use AI agents — The New Stack](https://thenewstack.io/23-of-devs-regularly-use-ai-agents-per-stack-overflow-survey/)
- [MCP apps census 2026 — Nicolas Sitter](https://www.nicolassitter.com/research/mcp-apps-census-2026)
- [Greenlight credit union partners — BusinessWire](https://www.businesswire.com/news/home/20260709591083/en/)
- [Fraud awareness survey 2026 — AARP](https://www.aarp.org/money/scams-fraud/fraud-awareness-survey-2026/)
- [Family caregiving in an aging America — Pew](https://www.pewresearch.org/social-trends/2026/02/26/family-caregiving-in-an-aging-america/)

**Regulation**
- [Agentic payments and money transmitter licences — Astraea Law](https://astraea.law/insights/agentic-payments-money-transmitter-license)
- [Is 2026 the year of agentic payments? — Fenwick](https://www.fenwick.com/insights/publications/is-2026-the-year-of-agentic-payments)
- [How the payments law landscape will evolve in 2026 — Troutman](https://www.troutman.com/insights/how-payments-law-landscape-will-evolve-in-2026/)
- [Money Transmission Modernization Act — CSBS](https://www.csbs.org/csbs-money-transmission-modernization-act-mtma)
- [Agent-of-payee exemption for closed-loop stored value — California DFPI](https://dfpi.ca.gov/rules-enforcement/laws-and-regulations/opinion-letters-by-law-subject/agent-of-payee-exemption-payments-to-daily-fantasy-sports-providers-for-closed-loop-stored-value/)
- [Prepaid access FAQs — FinCEN](https://www.fincen.gov/resources/statutes-regulations/guidance/frequently-asked-questions-regarding-prepaid-access)
- [Terms — OpenRouter](https://openrouter.ai/terms)
- [Consumer prepaid debit cards — Stripe](https://docs.stripe.com/issuing/consumer-prepaid-debit-cards)
- [Restricted businesses — Stripe](https://stripe.com/legal/restricted-businesses)
- [Agentic commerce liability is still being written — Worldpay](https://www.worldpay.com/en/insights/articles/agentic-commerce-liability-is-still-being-written)
- [AI AGENT Act draft — DWT](https://www.dwt.com/blogs/artificial-intelligence-law-advisor/2026/07/ai-agent-act-consumer-ai-regulation)
- [FTC revives click-to-cancel — Jones Day](https://www.jonesday.com/en/insights/2026/05/ftc-revives-clicktocancel-rule-new-risks-for-subscription-businesses)
- [California expands automatic renewal law — Barnes & Thornburg](https://btlaw.com/en/insights/alerts/2025/california-expands-automatic-renewal-law-new-requirements-now-in-effect)
- [Cancellation settlements and New York auto-renewal updates — Hudson Cook](https://www.hudsoncook.com/article/keeping-your-eye-on-the-ball-federal-cancellation-policy-settlements-and-new-york-updates-to-auto-renewal-law/)
- [Visa Integrity Risk Program — LegitScript](https://www.legitscript.com/regulatory-and-card-brand-compliance/visa-integrity-risk-program/)
- [GLBA and fintech — Cooley](https://cdp.cooley.com/fintech-faces-expanded-applicability-of-glbas-privacy-and-security-requirements/)
