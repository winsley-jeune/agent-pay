# Asia: what agent payments look like there, and what to bring to the US

Written 2026-10-05. The research covers China, India, Japan, South Korea, Taiwan, Singapore, Hong Kong and Southeast Asia. Many 2026 facts come from trade press or Chinese and Korean search summaries, not primary documents. Tags: **[O]** official or primary source, **[P]** credible press, **[B]** blog or vendor only. Verify before quoting any figure externally.

**Status (2026-10-05):** the seven patterns below are built. See "Owner controls" in the [README](../README.md). Family-style delegation (row 9 of the build table) and a refund payout for the guarantee are not built.

## The short version

Asia is ahead of the US in two ways:

1. **Consumer agent payments are live at scale.** By February 2026 Alipay's AI Pay had 100M users and handled 120M transactions in one week [O]. WeChat Pay launched a dedicated AI card in June 2026 [P]. In India, UPI payments run inside ChatGPT and Claude [P][O].
2. **Rules for recurring payments are much stronger.**
   - India: notice 24 hours before every recurring debit.
   - China: notice 5 days before every renewal.
   - Korea: the consumer must consent before a price rise.
   - Korea's national clearing house runs a government-backed site that lists and cancels every auto-debit.
   - The US has no federal equivalent. The FTC's click-to-cancel rule was struck down on 2025-07-08, and its new rulemaking (2026-03-13) is only at the advance-notice stage. State auto-renewal laws (California's, for example) and card-network rules on trials and recurring billing cover parts of this, but none of them require notice before every debit, and none give one view across all merchants.

Several independent players reached the same designs, so these are strong signals. **None of them combines agent spending, everyday subscriptions and browser permissions in one place, which AgentPay does.** The opportunity is to bring Asia's controls to US consumers, who have no regulator providing them.

**Asia already confirms AgentPay's core design.** WeChat Pay's AI card is a separate balance the user tops up, walled off from the main account, with confirmation on every order. That is AgentPay's prepaid wallet plus approvals, now running at WeChat's scale.

## Seven patterns that keep coming up

### 1. A setting for how much each agent may do on its own

| Who | How it works |
|---|---|
| Alipay AI Wallet (2026-05) [P] | Three tiers: confirm each charge; custom rules ("physical goods under ¥200 go through"); or a fixed quota for each agent |
| JD A2P2 protocol (2026-06) [P] | Levels L0–L5: from "a human confirms every payment" to "the agent pays within preset bounds" |
| Singapore MAS SAFR (2026-07) [O] | Four outcomes for each action: **Auto-execute / Observe / Escalate / Deny** |
| India UPI [O][P] | UPI Lite: no PIN up to ₹1,000. Biometric approval up to ₹5,000. Anything above needs the PIN |
| India UPI Circle [P] | Two modes: **full delegation** (monthly cap) or **partial** (the primary user approves each payment) |

**AgentPay today:** each agent key has a per-call maximum, daily and monthly caps, and one approval threshold. Below the threshold a charge goes through; above it, the owner approves with a passkey.

**Missing:**
- a **rules tier** (category + merchant + amount + time window)
- an **Observe** outcome: the charge goes through but is flagged for the owner to review
- **one named level** per agent that owners can understand at a glance

### 2. Separate money set aside for one agent or one store

| Who | How it works |
|---|---|
| WeChat Pay AI card (2026-06) [P] | A separate balance the owner tops up; it is the agent's ceiling |
| UPI Reserve Pay (2024, extended 2025-10) [O] | One approval blocks up to ₹10,000 for up to 90 days for **one merchant**; the merchant charges against it many times; the user sees what's left and can revoke |
| Singapore Purpose Bound Money (2022–23) [O] | Money that can only be spent at named merchants before an expiry date; **unspent money goes back** to whoever set it aside |
| JD special account, Kakao Pay PoC (2026-09) [P] | A separate account for the agent, limited by amount, category, time and payee |
| e-CNY sub-wallets [P] | Sub-wallets with limits; prepaid class fees paid out lesson by lesson |

**AgentPay today:** one wallet per owner, with caps on each agent key.

**Missing:** **envelopes**. An envelope is "$100 for groceries agent, walmart.com only, until Nov 30". When it expires, what's left goes back to the main wallet. The ledger already supports this: an envelope is just another account, and moving money in and out is an ordinary balanced transaction.

### 3. Mandates that can be checked by a machine

| Who | How it works |
|---|---|
| JD "task delegation credential" [P] | Turns a plain-language instruction into a mandate (amount, category, payee) that is checked before each charge |
| Alipay ACT "delegated" mode (2026-01) [P] | The user sets a time window, amount cap and merchants once; the agent can then **watch a product and buy it while the user is offline** |
| India Account Aggregator [O] | A signed consent record: purpose, scope, how often, how long, how long data may be kept, and always revocable |

**AgentPay today:**
- Approvals are bound to one amount by the passkey challenge.
- Price watch never buys.
- Browser permissions record site, actions and expiry, but not purpose or a per-use cap.

**Missing:**
- **A purpose and an amount cap on every permission.**
- Later, **opt-in automatic buying on price watch** within a signed mandate ("buy if under $40, at most one, at Target, before Dec 1").

Automatic buying should wait until the virtual cards are built. Until then AgentPay cannot block a checkout in the browser, so a mandate would be a promise the agent keeps, not a limit AgentPay enforces.

### 4. Notice before every recurring charge, and consent before a price rise

| Who | Rule |
|---|---|
| India, RBI e-mandate rules (2026-04) [P] | Notice **at least 24 hours before every** recurring debit, giving merchant, amount, date and reference, with an option to skip that one payment or cancel the mandate |
| China, pricing rules (in force 2026-04-10) [O] | Notice of date, amount and how to cancel before each debit; Alipay has put a **one-tap "cancel auto-debit"** button on every debit notice since 2022 |
| Korea, e-commerce decree (2025-02-14) [O] | A price rise or a trial turning paid needs the consumer's **consent** within 30 days beforehand |
| Japan, 2022 law on commercial transactions [O] | The **final confirmation screen** must show the per-period price, the total, when a trial converts and at what price, and how to cancel |

**AgentPay today:**
- Renewal reminders 3 days ahead (14 days for yearly plans).
- Alerts when a bank statement shows a price increase.
- AgentPay's own plans already stop and wait for a new passkey approval when the price goes above the ceiling. That is Korea's rule, already built.

**Missing:**
- Every renewal reminder carries **one-tap cancel**, which opens `request_cancel`.
- Japan's final-confirmation fields on **every** approval screen: for plans, the per-period price, the 12-month total, when a trial converts and how to cancel; for grocery orders, the approved maximum and what it includes.
- For everyday subscriptions, AgentPay can't block the merchant's charge. When a price rises, it can ask the owner to **"accept the new price or start cancelling"** instead of only showing an alert.

### 5. One place for everything that can take your money

| Who | How it works |
|---|---|
| Korea Payinfo, run by the national clearing house KFTC (since 2016; cards since 2020) [O] | A public site that shows **every** auto-debit on every bank account and card, and cancels or moves each one |
| India, NPCI (2025-10 circular) [P] | Every UPI app must show and manage mandates created in **any other app**. NPCI's "My Mandates" portal and the MyUPI assistant do the same |
| Alipay [P] | Every password-free and auto-debit agreement listed by merchant, in one settings page |

**AgentPay today:** the "All subscriptions" tab already joins everyday subscriptions with AgentPay plans.

**Missing:** add **agent keys, browser permissions and envelopes** to that same list, so it becomes one board of everything allowed to spend the owner's money, each item with pause and revoke. Nobody in the US offers this.

### 6. Who did it, why, and how to stop it

| Who | How it works |
|---|---|
| Korea, financial regulator FSC plan (2026-08) [P] | Agents must **log each step and explain why they acted** and what happened (decree change targeted for H1 2027) |
| Singapore SAFR [O][B] | Agents registered by identity; an append-only, tamper-evident audit log |
| Hong Kong, HKT "Agentic ID" (2026-08) [P]; Mastercard Agentic Tokens [P] | One credential per agent, tied to a verified owner; revoking it doesn't touch the account or the other agents |
| JD "ARI" [P] | Binds user, agent and runtime environment at the moment of payment |
| OCBC kill switch (2022); DBS digiVault and OCBC Money Lock (2023) [P] | One action freezes everything. A locked balance can't be moved digitally at all |
| Singapore scam framework, SRF (2024-12) [O] | **12-hour cooling-off** after a new device is set up; a **24-hour hold** on spending that looks like a rapid drain |
| NPCI chairman (2026-09) [P] | "AI may recommend; authentication and settlement must follow deterministic, auditable rules" |

**AgentPay today:**
- An activity log, including actions that were refused.
- One key per agent, revocable.
- Passkey approvals.

**Missing:**
- A **"why" field** on each log entry: the owner instruction it came from, the reason and the result, which can be exported.
- A **hash chain** that makes the log tamper-evident.
- A **kill switch** that freezes all keys, envelopes, permissions and pending approvals at once.
- A **cooling-off** period for a new agent key: lower limits for its first 12 hours.
- An optional **locked vault**: a balance no approval can spend; unlocking it needs a second device and a delay.

### 7. Saying up front who pays when the agent gets it wrong

| Who | What they offer |
|---|---|
| Alipay [P] | "You dare to pay, we dare to compensate" (你敢付我敢赔), with full-compensation account protection for AI Pay |
| Ant International AgentSafePay (2026-09-18) [O] | "100% fund guarantee" against prompt injection and misread intent. The terms and limits **aren't published**, and critics have pointed that out |
| A Japanese law-firm analysis [B] | Four kinds of incident: a mistake within the authority given; a breach of the set conditions; a system bug; a hijacked agent |
| EPAA–HSBC working group (2026-07) [P] | Working out liability for agents that go beyond their mandate; reports by November 2027 |

**AgentPay today:** the risk statement explains what's protected and what isn't.

**Missing:**
- Label every dispute with one of those four kinds.
- Later, a **published guarantee with a clear limit**, for example a refund of up to $X when an agent breaks a rule AgentPay enforces. This needs a legal and financial decision, not only code.

## What to build, in order

Ranked by value to US users against the work involved, given the current code.

| # | Feature | Comes from | Work | Notes |
|---|---|---|---|---|
| 1 | **Kill switch** | OCBC | Small | One endpoint, one dashboard button, one MCP refusal. Easy to demo |
| 2 | **One-tap cancel on every renewal reminder**, plus "accept new price or cancel" | India, China, Korea | Small | Reminders and price-rise detection exist (`src/external.ts`); this adds the action |
| 3 | **Final-confirmation fields on approval screens** | Japan | Small | Shown in the passkey dialog and on the dashboard |
| 4 | **Rules tier and Observe tier on each agent key**, with a named level (L0–L3) | Alipay, JD, SAFR | Medium | New columns on `agent_keys`; `gateway.ts` decides auto / observe / approve / deny |
| 5 | **Envelopes**: per agent or per store, with merchant list, expiry and automatic return | WeChat, UPI Reserve Pay, PBM | Medium | A ledger account per envelope, plus a sweeper that returns money at expiry. Becomes the money behind the virtual cards later |
| 6 | **"Why" log with hash chain, and cooling-off for new keys** | Korea FSC, SAFR, SRF | Medium | Extends `agent_activity` |
| 7 | **One board of everything that can spend** | Korea Payinfo, NPCI | Medium | Merges subscriptions, keys, permissions and envelopes |
| 8 | **Purpose and cap on browser permissions**, then opt-in automatic buying on price watch | JD, Alipay ACT, Account Aggregator | Large | Automatic buying waits for the virtual cards |
| 9 | **Family-style delegation**: monthly allowances for family members and their agents | WeChat family card, UPI Circle | Large | Needs several users per wallet |
| 10 | **Published guarantee with a limit** | Alipay, Ant | Legal | A legal and financial decision first |

Items 1–4 make a demo that's easy to show and hard for US competitors to match quickly: **"Every agent has a level, every dollar has an envelope, every renewal has a cancel button, and one tap stops everything."**

## A lesson about launching

Swiggy's MCP server launched in January 2026 with **cash on delivery only**, on purpose to limit risk, and added in-chat UPI only in July [P]. AgentPay is in a similar spot with groceries: the agent follows the approval rule, but nothing enforces it until the virtual cards exist. Saying so openly, as the README already does, is the right approach. New stores and new agents should start at the strictest level.

## What doesn't carry over

- **Super-app closed loops.** Alipay, WeChat and Paytm own the wallet, the merchants and the agent all at once. In the US, AgentPay sits on top of other companies' rails, so whatever it adds has to work with whichever payment method the merchant accepts.
- **Stablecoin settlement** (Kakao Pay, Ant's agent-to-agent payments, x402). It raises the same compliance questions as in [distribution.md](distribution.md).
- **Rules that rely on a national network.** India's 24-hour notice and Korea's Payinfo work because NPCI and KFTC see every mandate. AgentPay sees only what owners import or connect, so in the US these become a product promise rather than an infrastructure guarantee.

## Sources

**China**
- [Alipay launches MCP server for AI agents — FFNews](https://ffnews.com/newsarticle/alipay-launches-mcp-server-to-enable-payment-services-for-ai-agents/)
- [Alipay rolls out the Agentic Commerce Trust Protocol — The Paypers](https://thepaypers.com/payments/news/alipay-rolls-out-the-agentic-commerce-trust-protocol-in-china)
- [ACT — InfoQ](https://www.infoq.cn/article/DE0ifdKyd4Oevz5Bgr3X)
- [Alipay AI payment exceeds 120 million transactions in one week — BusinessWire](https://www.morningstar.com/news/business-wire/20260213770962/alipay-ai-payment-exceeds-120-million-transactions-in-one-week-as-agentic-commerce-accelerates-in-china)
- [Alipay AI Pay for OpenClaw-type agents — The Paypers](https://thepaypers.com/payments/news/alipay-extends-ai-pay-to-enable-autonomous-agent-payments-for-openclaw-type-ai-tools)
- [Alipay debuts AI Wallet — PYMNTS](https://www.pymnts.com/news/payment-methods/2026/alipay-debuts-ai-wallet-as-part-of-new-payments-infrastructure/)
- [AI Wallet tiers — BBT News](https://www.bbtnews.com.cn/2026/0527/594487.shtml)
- [Tencent lets AI agent make purchases through WeChat Pay — Caixin](https://www.caixinglobal.com/2026-06-17/tencent-lets-ai-agent-make-purchases-through-wechat-pay-102455141.html)
- [WeChat AI card — Sina](https://finance.sina.com.cn/tech/roll/2026-06-17/doc-inictnum7013236.shtml)
- [WeChat family card — The Paper](https://www.thepaper.cn/newsDetail_forward_2192205)
- [JD A2P2 — Sina](https://finance.sina.com.cn/tech/shenji/2026-06-17/doc-inicsrqu5791587.shtml)
- [Alibaba links Taobao to Qwen app — Bloomberg](https://www.bloomberg.com/news/articles/2026-01-15/alibaba-takes-major-step-to-link-taobao-shopping-to-main-ai-app)
- [e-CNY smart-contract prepayments — Economic Information Daily](http://www.jjckb.cn/2022-09/16/c_1310663173.htm)
- [Internet platform pricing rules — CAC](https://www.cac.gov.cn/2025-12/20/c_1767870953332182.htm)
- [Online Trading Measures — Ministry of Justice](https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202104/t20210423_357848.html)
- [One-tap cancel on Alipay auto-debit notices — Sina](https://finance.sina.cn/tech/2022-07-28/detail-imizmscv3886441.d.html)

**India**
- [India pilots AI chatbot-led e-commerce — TechCrunch](https://techcrunch.com/2025/10/09/india-pilots-ai-chatbot-led-e-commerce-with-chatgpt-gemini-claude-in-the-mix)
- [Agentic payments and NPCI — Razorpay](https://razorpay.com/blog/agentic-payments-and-npci/)
- [Unified Agent Protocol — Outlook Business](https://www.outlookbusiness.com/news/india-plans-ai-powered-upi-payments-framework-through-unified-agent-protocol)
- [GFF 2026: NPCI's AI push — Inc42](https://inc42.com/buzz/gff-2026-npci-launches-instant-card-issuing-atms-deepens-ai-push/)
- [UPI Reserve Pay — Pine Labs](https://www.pinelabs.com/docs/online-payments/upi-reserve-pay)
- [Delegated UPI payments (UPI Circle) — Outlook Money](https://www.outlookmoney.com/banking/bhim-rolls-out-delegated-upi-payments-with-spending-caps-and-long-validity)
- [RBI e-mandate framework — PolicyEdge](https://www.policyedge.in/p/rbi-standardises-recurring-payment-rules-with-revised-e-mandate-framework)
- [UPI AutoPay interoperability — MediaNama](https://www.medianama.com/2026/08/223-npci-upi-autopay-interoperability/)
- [Account Aggregator FAQ — Sahamati](https://sahamati.org.in/faq/)
- [Swiggy MCP payments with UPI](https://mcp.swiggy.com/builders/blog/2026-07-10-mcp-payments-upi/)

**Japan, Korea, Taiwan**
- [Final confirmation screen guideline — Consumer Affairs Agency](https://www.no-trouble.caa.go.jp/pdf/20220601la02_07.pdf)
- [Agentic payments under Japanese law — innovationlaw.jp](https://innovationlaw.jp/en/agentic-payments-japan-law/)
- [Payinfo — KFTC](https://www.payinfo.or.kr)
- [Korea dark-pattern rules — Korea.kr](https://www.korea.kr/news/policyNewsView.do?newsId=148939436)
- [Korea dark-pattern rules — Kim & Chang](https://www.kimchang.com/en/insights/detail.kc?sch_section=4&idx=31410)
- [Kakao Pay agentic payment PoC — MT](https://www.mt.co.kr/finance/2026/09/15/2026091509403982410)
- [FSC "My AI Agent" plan — Newspim](https://www.newspim.com/news/view/20260825000822)
- [KFTC agent payment platform — Seoul Economic Daily](https://en.sedaily.com/finance/2026/05/03/kftc-to-launch-ai-agent-payment-platform-for-financial)

**Singapore, Hong Kong, Southeast Asia**
- [Project Orchid whitepaper — MAS](https://www.mas.gov.sg/publications/monographs-or-information-paper/2022/project-orchid-whitepaper)
- [SAFR — MAS](https://www.mas.gov.sg/news/media-releases/2026/mas-partners-industry-to-develop-safeguards-for-ai-agents-in-finance)
- [SAFR explained — Ashurst Perkins Coie](https://www.ashurstperkinscoie.com/en/insights/mas-safr-explained-singapores-runtime-governance-standard-for-agentic-ai-in-finance/)
- [Shared Responsibility Framework — HSF Kramer](https://www.hsfkramer.com/notes/data/2024-posts/financial-institutions-and-telcos-required-to-share-responsibility-for-phishing-scams-in-singapore)
- [OCBC kill switch](https://www.ocbc.com/personal-banking/security/secure-banking-ways/ocbc-killswitch.page)
- [Mastercard live agentic transaction in Singapore — The Paypers](https://thepaypers.com/payments/news/mastercard-completes-first-live-agentic-transaction-in-singapore-with-dbs-and-uob)
- [Hong Kong "know your agent" controls — PYMNTS](https://www.pymnts.com/news/banking/2026/hong-kong-tests-know-your-agent-controls-in-payment-workflows/)
- [EPAA–HSBC liability working group — The Asian Banker](https://www.theasianbanker.com/press-releases/epaa-and-hsbc-launch-working-group-on-ai-agent-payment-liability)
- [Ant International AI-native solutions — PRNewswire](https://www.prnewswire.com/apac/news-releases/ant-international-launches-industrys-first-full-stack-ai-native-solutions-for-payment-account-fx-treasury-and-growth-operations-for-global-businesses-302883018.html)

**US**
- [FTC restarts negative-option rulemaking — Gibson Dunn](https://www.gibsondunn.com/ftc-restarts-negative-option-rulemaking-after-eighth-circuit-vacatur-enforcement-under-rosca-continues/)
