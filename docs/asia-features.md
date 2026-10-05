# Asia, round 2: features that would make AgentPay more useful

Written 2026-10-05. This is the follow-up to [asia.md](asia.md), which led to the owner controls, the refusal rules and the trusted helpers. This round looks for **new** ideas for three audiences:
- **people** in their everyday money life
- **older adults and families**
- **developers**: agent builders and tool providers

Everything already built is left out.

> **How far to trust this round.** The research ran after this session's web-search allowance was used up, and many Chinese, Singaporean and Korean sites refused connections. Each finding is tagged:
> - **[V]** checked on a primary source this session (mostly GitHub, npm, Wikipedia, official pages)
> - **[R]** already sourced in [asia.md](asia.md)
> - **[S]** seen only in search snippets or secondary sources
> - **[K]** from the research model's background knowledge, not re-checked
>
> Treat every **[K]** item as a lead to verify, not a fact to quote. The feature ideas stand on their own merits for the US even where an Asian detail turns out slightly different.

## The short version

The first round took Asia's **controls**. This round's lesson is about what makes people **come back**: tools that get money back or stop a loss.
- Price protection that refunds a price drop.
- A recall window on payments to new payees.
- "Is someone on the phone with you?" before a big payment.
- Receipts that claim refunds and warranties on their own.
- For developers: test keys, signed requests and a way to sell any MCP server per call.

Each idea fits on top of what AgentPay already has (price watch, the why log, helpers, envelopes, the marketplace).

## For older adults and families

| Idea | From Asia | What AgentPay would do | Effort |
|---|---|---|---|
| **"Is someone on the phone with you?" check** | Interstitials in Chinese payment apps; Japanese bank tellers trained to intervene [K] | Before a large or unusual payment on a protected account, three plain questions: did someone call you, are you told to keep it secret, are you told it's urgent? Any "yes" stops the payment and sends it to the helpers | S |
| **Recall window for new payees** | Alipay and WeChat 延时到账 (2-hour or 24-hour delayed arrival) [K]; Korea 지연이체 (delayed transfer, at least 3 hours) [K] | A purchase from a first-time merchant waits 2 or 24 hours (the owner chooses) with a one-tap "Get it back". This works directly for AgentPay-paid tools and plans; for store purchases it becomes a reminder to cancel the order | S/M |
| **Care mode** | WeChat 关怀模式 (care mode), Alipay 长辈模式 (elder mode) [K] | Large type, high contrast, every approval read aloud in one plain sentence ("Pay Kroger $62.10 for 14 items?"), and a home screen with three things on it | S/M |
| **Routine-break watch** | Japanese 見守り (mimamori, watching-over) services [K] | Learn the normal pattern (weekly groceries, usual bills) and quietly tell helpers about breaks: nothing for N days, a 2 a.m. payment, a burst of new payees | S |
| **Identity-freeze helper** | Korea's 여신거래 안심차단 (block new loans in your name) [K] | A guided, tracked checklist to freeze credit at Equifax, Experian and TransUnion (plus ChexSystems and NCTUE), with thaw reminders and status visible to helpers | S |
| **Helper remote assist** | Alipay's family remote help [K] | A helper sees exactly what the owner sees and points or explains, but can never approve for them | M |
| **Family card** | Alipay 亲情卡 (family card) [K]; India's UPI Circle, *full* or *partial* delegation [V] | The reverse of trusted helpers: an adult child pays a parent's agent purchases up to a monthly limit, either alone or approving each one. **Caution:** if money moves between two people's wallets, that's the person-to-person transfer the US structure avoids. Keep it as "the child owns the wallet, the parent's agent has a key", which already works, and add a parent-friendly view | M |
| **Shared household pot** | KakaoBank 모임통장 (group account), Alipay AA收款 (split and collect) [K] | A shared envelope for, say, "Mom's care costs", visible to everyone in the family. Same caution: one owner funds it; others see it and can be reimbursed outside AgentPay | M |

## For everyone: getting money back

| Idea | From Asia | What AgentPay would do | Effort |
|---|---|---|---|
| **Price-drop clawback** | JD 价格保护 (price protection): 7–365-day windows, one-click claims [V]; the 京价保 extension that filed JD claims automatically [S] | After a purchase, keep watching the price while the retailer's adjustment window is open. On a drop, draft the claim and file it in the owner's own browser **after a passkey approval**, then log it. Most US card issuers dropped price protection around 2018–2020 [K], so this is new value | M |
| **Return-window tracker** | China's 7-day no-reason returns (Consumer Rights Protection Law, art. 25) [K]; Shopee's 15-day guarantee [S] | Every order gets its return deadline. Remind three days before, and prepare the return | S |
| **Receipt and warranty vault** | Taiwan's e-invoice carrier (all receipts in one place, lottery prizes paid automatically) [V partial]; China's invoice folder in Alipay and WeChat [K] | Collect receipts from orders the agent places, store warranty terms and serial numbers, remind before expiry, and track rebates and price adjustments | S/M |
| **Fake-discount detector** | China's 2022 rule against fictitious "original prices" (SAMR Order 56) [S] | Use price-watch history to flag a "was $X" that never actually happened in the last 30–90 days. The US basis is the FTC's pricing guides (16 CFR 233) and California's 90-day former-price rule [K]. Feeds `pick_product` | S |
| **Late or missing delivery claims** | Meituan's on-time guarantee 准时宝 [K]; Swiggy and Instacart refund flows [K] | Compare promised and actual delivery, and missing items against the cart, then draft a credit request for the owner to approve | M |
| **"Confirm received" before closing an order** | Alipay's escrow: money released on 确认收货, confirm receipt [V partial] | Grocery and mandate orders stay open until the owner confirms the items arrived. Missing items prompt a refund request | S |
| **Merchant track record** | SMZDM's community "值不值" (worth it / not worth it) votes [K] | Privately record whether each merchant honoured adjustments, returns and refunds, and use it when picking products | S |
| **Bill hub for utilities** | India's Bharat Connect (one network for all bills, with autopay) [V] | Read utility, insurance and tax bills from email or PDF. Flag one 30% above normal. Pay on approval before the due date | M/L |
| **Loyalty points nudges** | Japan's point economies (expiry warnings, "best card here") [K] | Warn before store points expire and suggest using them at checkout. Payment cards stay untouched | S |

**The lesson from China's refund-only reversal.** Pinduoduo let buyers get refunds without returning items. Taobao and JD followed, then all of them rolled it back in 2025 after merchants complained of abuse [V, Caixin]. Every claim AgentPay files must be well-founded, approved by the owner and written to the why log. Never let agents file claims in bulk.

## For developers

| Idea | From Asia | What AgentPay would do | Effort |
|---|---|---|---|
| **Sandbox with test keys** | The Alipay MCP server's `AP_CURRENT_ENV=sandbox\|prod` switch [V] | `ap_test_` keys with a fake wallet and automatic approvals, and a "test call" button for providers. It removes the fear of a first real charge | S |
| **Signed requests and a verify SDK** | Ant's open-source AMP protocol, where the agent signs every payment request with its own key [V] | AgentPay signs each provider call (call ID, amount held, units cap, agent ID, time). Providers check it with a few lines of code (`verifyAgentPay()`), so they can trust the billing and see which agent is calling. Today AgentPay just forwards the provider's own secret | S/M |
| **Provider webhooks** | Merchant notification patterns (Alipay, WeChat Pay) [K] | Signed, idempotent events: `call.completed`, `subscription.*`, `refund.issued` | S |
| **Provider revenue dashboard** | — | Calls, gross, fee, net, refunds and errors per tool, with CSV and webhook export | S |
| **Free-call grants** | ModelScope's free hosting and Kakao's PlayMCP contest credits [V/K] | Providers fund "first N calls free" from their own earnings. Agents see `free_remaining` in `get_quote`, which helps them discover new tools | S |
| **Sell any MCP server per call** | Asia's MCP plazas (ModelScope, Bailian) list thousands of servers but don't pay third parties per call [V/K] | One command, e.g. `npx agentpay-provider wrap ./my-mcp-server --price 2c/call`, lists the server's tools and meters them | M |
| **Portable mandates** | AMP's three signed layers (user–agent binding, signed mandate, agent-signed request) [V]; JD's task credential [R] | Turn owner approvals and envelopes into signed tokens a provider can verify independently. Compatible with Google's AP2 | M |
| **Pricing manifest and registry sync** | — | `/.well-known/agentpay.json` with prices, units, plans and refund policy, synced to the official MCP Registry | M |
| **x402 bridge** | Community Chinese and US middleware converging on HTTP 402 (`paypack`, `goldbean`) [V] | Let the wallet pay x402-priced endpoints, with AgentPay's levels, envelopes and kill switch in front | M |
| **Conformance kit** | The Alipay MCP server's MCP Inspector debugging [V] | `npx agentpay-conformance` checks a provider's idempotency, units header, timeouts and refunds | M |
| **"Charge your users" for agent builders** | Alipay's `create-alipay-payment-agent`: individual developers can collect payment without a business licence [V] | Agent builders get pay links for their own users and resell tools at a markup. **Caution:** paying out to developers is the money-transmission question in [us-market.md](us-market.md); it needs the legal work first | M + legal |

## What to build first

Ranked by usefulness against effort. All of these sit on code that exists.

| # | Feature | Audience | Effort | Builds on |
|---|---|---|---|---|
| 1 | "Is someone on the phone with you?" check | Older adults, families | S | Protected accounts, helpers |
| 2 | Sandbox with test keys | Developers | S | Agent keys, dev credit |
| 3 | Return-window tracker and "confirm received" | Everyone | S | Groceries, mandates |
| 4 | Signed provider requests and verify SDK, plus webhooks | Developers | S/M | Gateway, provider registry |
| 5 | Routine-break watch | Families | S | Why log, helper alerts |
| 6 | Price-drop clawback | Everyone | M | Price watch, mandates, browser permissions |
| 7 | Recall window for new payees | Older adults | S/M | Holds, approvals |
| 8 | Fake-discount detector | Everyone | S | Price history, `pick_product` |
| 9 | Provider revenue dashboard and free-call grants | Developers | S | Ledger, marketplace |
| 10 | Care mode | Older adults | S/M | Dashboard |

Items 1, 2 and 3 make a good next release: one for each audience, all small.

## Cautions

- **Retailer terms.** Many stores forbid automated agents (Amazon's Conditions of Use, for example) [K]. Keep to the owner's own signed-in session and the retailer's published policies, never get around bot protection, and have the owner approve every claim. The 2026 Ninth Circuit ruling helps (the user is the one accessing the site) but isn't the last word.
- **Money between people.** A family card, a shared pot and "charge your users" all risk money moving between people or to developers, which the US structure avoids. Design them so that one owner holds the money.
- **Insurance.** Return-shipping cover like Taobao's 运费险 would be insurance; it needs a licensed partner.
- **Verify the [K] items** before using any of this externally. Raising the session's web-search limit and getting access to Chinese and Korean sites would allow a proper check.

## Sources checked this session

- [@alipay/mcp-server-alipay — npm](https://www.npmjs.com/package/@alipay/mcp-server-alipay)
- [alipay/global-alipayplus-mcp — GitHub](https://github.com/alipay/global-alipayplus-mcp)
- [ant-intl/AMP — GitHub](https://github.com/ant-intl/AMP)
- [beckn/protocol-specifications-v2 — GitHub](https://github.com/beckn/protocol-specifications-v2)
- [beckn/beckn-onix — GitHub](https://github.com/beckn/beckn-onix)
- [coze-dev/coze-studio — GitHub](https://github.com/coze-dev/coze-studio)
- [modelscope/mcp-central — GitHub](https://github.com/modelscope/mcp-central)
- [JD price protection rules — JD help centre](https://help.jd.com/user/issue/291-4537.html)
- [E-commerce giants' refund U-turn — Caixin](https://www.caixinglobal.com/2025-04-23/cx-briefing-e-commerce-giants-refund-u-turn-102312487.html)
- [Unified Payments Interface — Wikipedia](https://en.wikipedia.org/wiki/Unified_Payments_Interface)
- [Bharat Bill Payment System — Wikipedia](https://en.wikipedia.org/wiki/Bharat_Bill_Payment_System)
- [Uniform Invoice lottery — Wikipedia](https://en.wikipedia.org/wiki/Uniform_Invoice_lottery)
- [Chakshu — Sanchar Saathi](https://sancharsaathi.gov.in/sfc/)
- [Qualified invoice system — Japan National Tax Agency](https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice_about.htm)
- [Kakaku.com — Wikipedia](https://en.wikipedia.org/wiki/Kakaku.com)
- [Coupang — Wikipedia](https://en.wikipedia.org/wiki/Coupang)
