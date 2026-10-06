# Funding opportunities for AgentPay (to be renamed)

Researched 2026-10-06. This updates the shortlist in [sponsors-and-traction.md](sponsors-and-traction.md), whose items marked [K] were checked against live sources.

Companion to [marketplaces.md](marketplaces.md), the list of places to publish.

**What the labels mean**
- **[V]**: read on the program's own page today.
- **[V2]**: from a 2026 secondary source (news, aggregators, the program's posts on X). Probably right; check before applying.
- **[K]**: background knowledge only.

**Fit** is out of 5 stars, judged for this project as it stands today: one person, US-based, no company yet, open source (AGPL plus MIT), chain-agnostic x402/A2A USDC payments, and protections for older adults. **"Indiv OK"** means you can apply as a person, without an LLC or C-corp.

**AI-generated-code policies.** Only one funder publishes a restrictive one: **NLnet**. Its proposal page says "We are not interested in AI-generated projects or proposals." Its GenAI policy (v1.1, 26 Jan 2026) allows disclosed AI use only with a prompt provenance log (model, timestamps, prompts, unedited outputs), and "purely AI-generated" work can't be paid for under a grant. Every other program in this report says nothing on the subject that I could find. Two cautions:
- Funders with human-authorship-style terms (Prototype Fund, OTF) are worth checking yourself. Prototype Fund's page returned 403, so I couldn't read it.
- Hackathons almost always require the code to be written during the event. That's a separate rule from AI policy: an older repo has to be presented as a new extension, not resubmitted.

---

## Corrections to the existing shortlist

| Old claim | Status today |
|---|---|
| Circle Developer Grants: $5k–$100k USDC, open | **Confirmed [V]**. Open, individuals eligible, milestone-paid. **New:** projects where Circle's **Arc** chain is "core to your flow of value" are *strongly prioritized*. AgentPay doesn't use Arc yet, so fit drops from ★★★★ to ★★★ unless you add an Arc settlement path. |
| GitHub Secure Open Source Fund: $10k + Azure credits, rolling | **Confirmed [V]**: $10k, paid $6k / $2k / $2k at the program, 6 months and 12 months. About 20 hours of commitment. Rolling, considered for "all Program Sessions". Session 4 ran May 2026 [V2]. **Needs "demonstrated community adoption"**, so apply after launch. The Azure credits and the extra $150k through Microsoft weren't on the page today [K]. |
| x402 Foundation: no grant program | **Confirmed.** Nothing about grants on x402.org [V]. The foundation launched operationally under the Linux Foundation on 2026-07-14 with about 40 founding members [V2]. Membership is for organizations. |
| AARP AgeTech Collaborative: not a direct funder | **Updated [V]**: there is a **$10k pitch prize at AgeTech After Dark @ CES 2027, deadline Oct 12 2026**, and finalists can be invited into the 8-week accelerator. |
| FIDO paid tiers [K] | **[V2]** Associate dues were $2,750 a year for ≤100 employees (as of 2023). Membership is organizational. |
| Base Batches: $100k | Base Batches 004 **closed Sep 9 2026** [V2]. No 005 has been announced. The Base Ecosystem Fund takes applications on a rolling basis [V]. |
| Anthropic Claude for Open Source | **Still open [V]**: the terms say "open until Anthropic closes it". A blog post claiming a June 30 2026 end is contradicted by the terms. The thresholds now include an extra route: **20+ unique outside contributors with merged PRs in 12 months**, OR **100+ PRs you got merged into repos you don't own**, OR 200k monthly downloads, among others. |
| NIA SBIR deadlines (Jan 5 / Apr 5 / Sep 5) [K] | **Confirmed [V2]**. SBIR/STTR lapsed in Oct 2025 and was **reauthorized through 2031 on 2026-04-13**. NIH reissued its parent announcements with a first receipt date of Sep 5 2026, so the **next is Jan 5 2027**. |
| YC W27: Nov 2, 8 pm PT; standard deal [K] | **Deadline confirmed [V]**: decisions by Dec 11; batch runs Jan–Mar in SF; $12M+ in credits. The deal ($125k for 7% plus $375k uncapped MFN SAFE) is [V2/K]: the apply page doesn't show terms. |
| Gitcoin GG24 OSS round: cheap to try | **Stale.** GG24 ran in **Oct 2025** ($1.8M total; the OSS QF round gave $300k to 64 projects) [V2]. GG25 was "targeted for Q2 2026", but I found **no 2026 round confirmed**. Watch gov.gitcoin.co. |
| Cloudflare credits $10k–$350k | **Now [V2]: $5k / $25k / $100k / $250k tiers**, and a company is needed. |
| NLnet: AI-generated projects not accepted | **Confirmed [V]**, with more detail (see above). Next call deadline **Nov 3 2026 12:00 CET**. Effectively **out** for this repo. |
| Sovereign Tech Agency: not apps | **Confirmed [V]**: the Fund is rolling, minimum €50k, global, "no prototypes, no user-facing applications". Only the verify SDK could ever fit. |
| FINRA Foundation: nonprofits and universities only | Unchanged [K/V2]. It funds fraud-prevention research and education. |

---

## 1. Non-dilutive grants

### 1a. Open source / public-interest tech

| Program | What you get | Eligibility | Next deadline | Fit | AI policy | Mark |
|---|---|---|---|---|---|---|
| [GitHub Secure Open Source Fund](https://github.com/open-source/github-secure-open-source-fund) | $10k cash (6/2/2) + a 3-week security course | Indiv OK (18+, Sponsors region, max 2 people); needs a license and **adoption** | Rolling | ★★★★: security plus money-handling is their sweet spot; apply post-launch with downloads/stars | None found | [V] |
| [Sovereign Tech Fund](https://www.sovereign.tech/programs/fund) | ≥€50k service contract | Global; "base technologies" only, no apps or prototypes | Rolling (~6 months to contract) | ★: maybe the verify SDK or a hash-chained audit-log library later | None found | [V] |
| [Sovereign Tech Fellowship](https://www.sovereign.tech/programs/fellowship) | Paid fellowship (up to 12 fellows) for maintainers / community / docs | Maintainers of *critical* OSS | 2026 round closed Apr 6 2026; says it will "regularly recruit" | ★: needs critical-infra status | None found | [V2] |
| [NLnet / NGI Zero](https://nlnet.nl/propose/) | €5k–€50k (first-timers) | Global but needs a "European dimension" | **Nov 3 2026** | ✗: repo shows Claude co-authorship and there's no provenance log; "not interested in AI-generated projects" | **Restrictive** (see top) | [V] |
| [Prototype Fund (Germany)](https://prototypefund.de/en/apply) | Up to €95k (6 months) / €158k (10 months) | German residence/tax liability [K] | Window **Oct 1 – Nov 30 2026** [V2] | ✗ for a US person | Unknown (page 403) | [V2/K] |
| Prototype Fund Switzerland | Up to CHF 50k | Swiss focus | Closed Sep 7 2026 | ✗ | Unknown | [V2] |
| [Alpha-Omega](https://alpha-omega.dev) / OpenSSF | Grants from a $12.5M pool (Anthropic, AWS, GitHub, Google, MS, OpenAI; Mar 2026) for OSS security | Mostly invited, critical projects | Not an open call | ★: too early; relationship target later | None found | [V2] |
| [Mozilla Technology Fund / Builders / Democracy x AI](https://www.mozillafoundation.org) | Democracy x AI: $50k, up to $300k | Teams with a tested product | Democracy x AI closed Mar 16 2026; no open MTF call found | ★★: watch for consumer-protection / "trustworthy AI" calls | None found | [V2] |
| [Open Technology Fund](https://www.opentech.fund/funds/) | FOSS Sustainability, Internet Freedom Fund | Internet-freedom / anti-censorship scope | Some "Apply" buttons live, but US funding was largely cut in 2025 (litigation ongoing) | ✗: out of scope and unstable | Unknown | [V]/[V2] |
| [a16z Open Source AI Grant](https://a16z.com/supporting-the-open-source-ai-community/) | Grant (no equity) [K] | By selection | No 2026 cohort found | ★: the program looks dormant; watch | None found | [V2] |
| GitHub Accelerator | Was $20k–$40k plus mentoring | — | **Dormant**: no cohort since 2024 | — | — | [V2] |

### 1b. Crypto / stablecoin ecosystem

| Program | What you get | Eligibility | Next deadline | Fit | AI policy | Mark |
|---|---|---|---|---|---|---|
| [Circle Developer Grants](https://www.circle.com/en/usdc-grant-program) (apply: circle.questbook.app) | $5k–$100k USDC, milestones, co-marketing | Indiv OK; "agentic economic activity" is a named focus | Rolling, open now | ★★★ (★★★★★ with an Arc integration): USDC is central; Arc is prioritized | None found | [V] |
| [Base Builder Grants](https://docs.base.org/get-started/get-funded) | 1–5 ETH, retroactive | Indiv OK; must be **deployed on Base mainnet** | Rolling cohorts (20+ so far) | ★★★: cheap win if the x402 path settles on Base | None found | [V2] |
| [Coinbase CDP Builder Grants](https://www.coinbase.com/developer-platform/discover/launches/builder-grants-round2) | Past rounds: 5 × $5k | Indiv OK; build on the CDP SDK / x402 | **No 2026 round found**; watch the CDP Discord / X | ★★★ when it reopens | None found | [V2] |
| [x402 Foundation](https://x402.org/) | No grants; ecosystem listing and visibility | Org membership | — | ★★★★ for distribution, ★ for money | — | [V] |
| [Stellar Community Fund (SCF #46)](https://communityfund.stellar.org/) | Build Award up to **$150k in XLM**, in tranches | Indiv/teams; must build on Stellar/Soroban; interest form first | **Build submission Nov 8 2026** (abstract dates TBD) | ★★★: Stellar is an x402 Foundation premier member; needs a Stellar USDC rail | None found | [V] for the program, [V2] for the date |
| [Solana Foundation grants](https://solana.org/grants-funding) | Milestone grants and convertible grants; $10M set aside for AI | Indiv OK [K]; Solana integration | Rolling | ★★★: Solana carries about 65% of x402 volume; add a Solana USDC facilitator | None found | [V2] |
| [Celo Prezenti S3: Frontier pool](https://frontier.prezenti.xyz/) | Grant (amount not stated; S2 gave $130k across 19 projects) | Needs **Celo mainnet deployment**, ERC-8004 registration and Self Agent ID | **Window Aug 12 – Dec 29 2026** | ★★★: agent identity / A2A payments is literally the brief, but integration is real work | None found | [V] |
| [Polygon Community Grants S2](https://polygon.technology/blog/polygon-community-grants-program-announces-season-2-with-35m-pol-and-ai-leading-the-pack) + PIP-82 | POL grants via allocators (Crossmint, elizaOS…) + a $1M x402 gas rebate | Polygon deployment | Allocator-specific, rolling | ★★ | None found | [V2] |
| [Arbitrum D.A.O. grants](https://arbitrum.questbook.app/) | Milestone grants (Dev Tooling domain) | Arbitrum integration | Program ran to Mar 2026; **renewal unknown** | ★★ | None found | [V2] |
| [Optimism Retro Funding](https://retrofunding.optimism.io/) | — | — | **Paused** (Jan 8 2026, "at least 12 months") | ✗ for now | — | [V2] |
| [Optimism Grants S9](https://www.opgrants.io/) | Governance-fund missions | Superchain projects | Check season page | ★★ | None found | [V2] |
| [Ethereum Foundation ESP](https://esp.ethereum.foundation/applicants/open-rounds) | Wishlist / RFP grants only | — | Open applications **paused**; RFPs only | ★ | None found | [V2] |
| [Avalanche Retro9000](https://www.avax.network/about/blog/retro9000-a-usd40m-grant-program-rewards-developers-driving-avalanche) | Retroactive, usage-based (gas burned) | Avalanche C-Chain/L1 | Rolling rounds | ★ | None found | [V2] |
| NEAR AI Agent Fund | Investment-style ($20M liquid fund), agent tokens | NEAR | — | ★: token-centric | — | [V2] |
| Sui Foundation / Aptos ($50M AI commit) | Developer grants | Chain-specific | Rolling | ★ | — | [V2] |
| XRPL / Ripple | XRPL AI Starter Kit (Jun 2026); no grant call found | — | — | ★ | — | [V2] |
| Tempo (Stripe / Paradigm) | No grant program found; MPP standard for agent payments | — | — | ★★★ as a partner / standards target, not money | — | [V2] |
| [Gitcoin Grants](https://gitcoin.co/) | Quadratic-funding matching | Indiv OK | **No 2026 round confirmed** | ★★ when one runs | None found | [V2] |
| [Drips](https://www.drips.network) / Octant | Dependency streaming; funding any GitHub repo | Indiv OK | Ongoing | ★ (passive) | — | [V2] |

### 1c. Government (US)

| Program | What you get | Eligibility | Next deadline | Fit | AI policy | Mark |
|---|---|---|---|---|---|---|
| [NSF America's Seed Fund SBIR/STTR](https://seedfund.nsf.gov/) | Phase I to ~$305k [K], up to $2M total; **no equity** | **US for-profit small business**, majority US-owned; Project Pitch first | Pitches **open (reopened Jun 2 2026)**; full proposals **Nov 4 2026**, then **Mar 4 2027** | ★★★★ *with an LLC/C-corp*: AI plus cybersecurity topics; target Mar 4 | None found | [V] for the program, [V2] for dates |
| NIA SBIR/STTR (NIH) | Phase I ~$300k, Phase II ~$2M [K]; no equity | US small business | **Jan 5 2027**, then Apr 5, Sep 5 | ★★★★ with a company: elder financial-exploitation protection fits "aging in place" / caregiving; consider a university STTR partner | None found | [V2] |
| CFPB | Not a grant-maker; gutted in 2025 [K] | — | — | ✗ | — | [K] |
| State programs | Many states run SBIR matching (Phase 0/1 match) and seed funds | Depends on your state | — | Not researched; your state is unknown. Search "<state> SBIR matching grant" | — | — |

### 1d. Foundations, aging and consumer protection; individual grants

| Program | What you get | Eligibility | Next deadline | Fit | AI policy | Mark |
|---|---|---|---|---|---|---|
| [Emergent Ventures (Mercatus)](https://www.mercatus.org/emergent-ventures) | Unstated grant / fellowship size, typically $1k–$50k [K] | **Indiv OK**, worldwide, 13+ | Rolling; reply in about 1 week | ★★★★: cheapest high-upside ask; pitch the elder-scam angle and your personal story in 1,500 words | None found | [V2] |
| [1517 Fund Medici grants](https://www.1517fund.com/) | ≥$1k to validate an idea | Indiv; aimed at dropouts / students / deep-tech | Rolling (~2 weeks) | ★★: small, but no strings | None found | [V] |
| [Thiel Fellowship](https://thielfellowship.org/) | $250k over 2 years | Age ≤22 [K] | Rolling | ✗ unless you're under 23 | — | [V]/[K] |
| [Consumer Reports Innovation Lab fellowship](https://innovation.consumerreports.org/faqs) | $50k stipend over 8 months, non-resident; access to CR testing | Indiv (researchers / technologists) | No 2026–27 call found; watch | ★★★★ when open: CR runs the "Loyal Agents" program on consumer-authorized AI agents | None found | [V2] |
| [RRF Foundation for Aging](https://www.rrf.org) | $50k–$200k | **US nonprofits / academics** | LOIs Nov 1 2026 (research) and Feb 1 2027 [V2] | ★★ via a nonprofit or university partner (economic security is a priority) | — | [V2] |
| [FINRA Investor Education Foundation](https://www.finrafoundation.org) | Research and education grants | Nonprofits / universities | Rolling (general program) | ★★ via a partner (fraud-prevention study of the scam check) | — | [V2] |
| [Alfred P. Sloan Foundation, Technology program](https://sloan.org) | $50k–$600k | Mostly academic / nonprofit; LOI rolling | Rolling | ★: science-software focus | — | [V2] |
| Ford Foundation (digital infrastructure) | Research grants, collaborative funds | By invitation / RFP | No open RFP found | ★ | — | [V2] |
| The SCAN Foundation | Grants (older-adult financial stability is an objective) | Mostly by invitation | — | ★★ via a partner | — | [V2] |
| AARP Foundation | Scam-prevention programs (BankSafe etc.); no open tech grant found | — | — | ★★: partnership, not money | — | [V2] |
| Pivotal Ventures, Commonwealth | Caregiver / financial-security philanthropy; no open calls | Nonprofits | — | ★: relationship only | — | [V2] |

---

## 2. Credits and perks

*None of the programs in sections 2–6 publishes an AI-generated-code policy that I could find, so the column is left out of those tables.*

| Program | What you get | Eligibility | Deadline | Fit | Mark |
|---|---|---|---|---|---|
| [Claude for Open Source](https://www.anthropic.com/claude-for-oss-terms) | 6 months of Claude Max 20x | Natural person, 18+, GitHub account ≥2 years; one threshold, e.g. **20+ outside contributors**, 200k downloads a month, or 100+ PRs you got merged into others' repos; or the "ecosystem impact" route | Rolling until closed (cap 10k recipients) | ★★★ (★★★★ post-launch) | [V] |
| [Anthropic Startup Program](https://claude.com/programs/startups) | $5k API credits direct; $25k via a partner VC; up to $100k | **Incorporated** company | Rolling | ★★★ once you have a company | [V2] |
| [Microsoft for Startups Founders Hub](https://www.microsoft.com/startups) | $1k (Ideate) → $5k (verified) → $150k with an investor; GitHub Enterprise, Azure OpenAI | **Pre-company / idea stage OK** [V2]; crypto-mining excluded | Rolling | ★★★: the only big credit pool reachable without an LLC | [V2] |
| [AWS Activate Founders](https://aws.amazon.com/activate) | $1k (up to $5k via partners) | Self-funded *company*, website | Rolling | ★★ | [V2] |
| [Google for Startups Cloud (AI tier)](https://cloud.google.com/startup/ai) | Up to $350k | **VC-funded** seed to Series A | Rolling | ✗ until funded | [V2] |
| [NVIDIA Inception](https://www.nvidia.com/en-us/startups/) | Up to $100k GPU credits via partners, DLI | Incorporated, ≥1 developer; **excludes crypto-associated companies** | Rolling | ✗: x402/USDC may trip the crypto exclusion; low need anyway | [V2] |
| [Cloudflare for Startups](https://www.cloudflare.com/forstartups/) | $5k–$250k credits | Company on Cloudflare's developer platform | Rolling | ★★★: x402 co-announcer; deploy the verify SDK / demo on Workers | [V2] |
| [Stripe Atlas](https://stripe.com/atlas) | $500 incorporation; $2.5k Stripe credits + about $50k of partner perks (AWS $5k etc.) | You form a Delaware C-corp | Rolling | ★★★: if you incorporate, this is the cheapest route and unlocks the other perks | [V2] |
| OpenAI startup credits | No public self-serve program; via partners (Ramp ~$2.5k, VCs, YC) | — | — | ★ | [V2] |
| [Plaid startup / AI startup support](https://plaid.com/support-for-early-stage-ai-startups/) | Up to ~$21k of API credits via Fintech Sandbox | Startup | Rolling | ★ (bank data not needed) | [V2] |
| [Fintech Sandbox Data Access Residency](https://www.fintechsandbox.org/apply/) | Free data from 40+ providers (Plaid, Equifax…) for 6 months | **Incorporated**, full-time team, ARR <$1M | Rolling | ★ | [V2] |
| Polygon PIP-82 gas rebate | 100% of base gas refunded on x402 via Polygon facilitators ($1M pool) | Usage-based | Ongoing | ★★ | [V2] |

---

## 3. Accelerators and equity

| Program | Terms | Eligibility | Next deadline | Fit | Mark |
|---|---|---|---|---|---|
| [Y Combinator W27](https://www.ycombinator.com/apply) | $500k ($125k for 7% + $375k MFN SAFE) [V2/K]; $12M+ credits | Indiv can apply; you incorporate later | **Nov 2 2026, 8 pm PT** (decisions Dec 11) | ★★★: agent payments is hot; solo founders are accepted but disadvantaged | [V] |
| [Techstars Spring 2027](https://www.techstars.com) (NYC: AI/fintech) | $220k ($200k uncapped SAFE + $20k for ≥5%) | Company | **Nov 18 2026**; program starts Mar 8 2027 | ★★ | [V2] |
| [Alliance (ALL19)](https://alliance.xyz) | $250k–$500k [V2] | Crypto startups | **Regular admission closes Nov 18 2026**; starts Jan 11 2027 | ★★: crypto-native; AgentPay is "crypto-adjacent" | [V2] (site fetch failed) |
| [Colosseum accelerator](https://www.colosseum.com/) | $250k pre-seed | Win / place in a Colosseum hackathon; Solana preferred | Via Crypto World's Fair (**Oct 12**) | ★★★ | [V] |
| [Base Ecosystem Fund](https://www.base.org/ecosystem-fund/apply) | Pre-seed / seed investment (Coinbase Ventures) | Company building on Base (payments / AI agents) | Rolling | ★★★ | [V] |
| [Base Batches](https://www.basebatches.xyz/) | $100k investment + demo day | Pre-seed on Base | 004 closed Sep 9 2026; 005 not announced (likely early 2027 [K]) | ★★★ | [V2] |
| [a16z crypto CSX](https://a16zcrypto.com/csx/) | $500k minimum (7% in past terms) | Crypto startups | Spring/Fall cohorts; next date unknown | ★★ | [V2] |
| [a16z speedrun SR008](https://speedrun.a16z.com) | Up to $1M ($500k for 10% + $500k later) | Startups | SR008 runs late Jan–Apr 2027; **deadline not yet published** | ★★ | [V2] |
| [South Park Commons Founder Fellowship](https://www.southparkcommons.com/news/f26-founder-fellowship) | $400k for 7% + $600k in the next round; up to $1M credits (Anthropic, OpenAI, AWS) | Indiv / pre-idea OK | Fall 2026 closed Aug 2; **Spring 2027 likely ~Feb 1 2027** [V2/K] | ★★★: designed for solo technologists | [V] |
| [Entrepreneur First (SF)](https://apply.joinef.com/) | Stipend during FORM; up to $250k ($125k for 8% + $125k MFN) once you form a C-corp | **Individuals** (cofounder matching) | Rolling cohorts | ★★: only if you want a cofounder | [V2] |
| [Antler US](https://www.antler.co) | ~$250k at $2.75M post (US) [V2] | Individuals, residency | Rolling cohorts | ★★ | [V2] |
| [Neo Residency](https://neo.com) | $750k uncapped SAFE (0.75–5%) + $350k credits | Startups / students | Cohort timing varies | ★★ | [V2] |
| [AI Grant](https://aigrant.com/) | $250k uncapped SAFE + $350k Azure | — | **Batch 4 closed; no Batch 5 date** | ★★ watch | [V] |
| [Anthology Fund (Menlo × Anthropic)](https://www.anthropic.com/news/anthropic-partners-with-menlo-ventures-to-launch-anthology-fund) | Pre-seed to Series A + $25k Claude credits; "trust & safety tooling" is a stated focus | Company | Rolling (Menlo application) | ★★★ once incorporated: safety tooling for Claude agents | [V2] |
| OpenAI Startup Fund / Converge | Converge: $1M per company (≈10 companies) | Company | No current call found | ★ | [V2] |
| [Cloudflare Workers Launchpad](https://www.cloudflare.com/lp/workers-launchpad) | VC intros, credits, marketing (up to $2M from partner VCs) | Startup on Workers | Quarterly; no current date found (the "Cohort 7 / Mar 13" date is stale) | ★★★ | [V2] |
| [Mozilla Ventures](https://mozilla.vc) | Impact VC, pre-seed / seed | Company | Rolling | ★★: privacy / trustworthy-AI thesis | [K] |
| [Mastercard Start Path: Agentic Commerce](https://www.mastercard.com/start-path) | Partnership, co-development, possible investment; no equity by default | **Seed raised + product generating revenue** | Next cohort applications open [V2] | ★★★ later: exact topic, but you're not eligible yet | [V2] |
| Visa Everywhere Initiative | Prize / pilots | Needs a product in market, traction and **outside funding** | No 2026–27 US call found | ★ | [V2] |
| FinTech Innovation Lab NYC | Mentoring by banks | Company with a product | No 2027 info found | ★ | [K] |
| [Google for Startups Accelerator: AI First](https://startup.google.com/programs/accelerator/) | Equity-free accelerator | Seed to Series A | Regional (Europe, MENA, Africa, India); no US cohort found | ✗ | [V2] |
| [AARP AgeTech Collaborative accelerator](https://agetechcollaborative.org) | 8 weeks; AARP research, consumer testing, UX; pilots | **By invitation, via pitch events** | Via After Dark (**Oct 12**) | ★★★★ | [V] |
| Pioneer | — | — | **Dead** (stopped investing) | — | [V2] |

---

## 4. Recurring OSS funding platforms (set these up at launch)

| Platform | How it works / fees | Eligibility | Fit | Mark |
|---|---|---|---|---|
| [GitHub Sponsors](https://github.com/sponsors) | Monthly / one-off; 0% fee for individual sponsors [K] | Indiv, Sponsors region (this is also the SOS Fund requirement) | ★★★★: turn it on day 1 | [K] |
| [Open Collective via Open Source Collective](https://opencollective.com/opensource) | 501(c)(6) fiscal host; ~10% host fee [K]; lets you **receive grants that need a fiscal host** and companies' invoiced donations | Needs an OSI license and some adoption [K] | ★★★★: unlocks nonprofit-only grants (RRF, FINRA partners) | [V2] |
| [Polar.sh](https://polar.sh) | Merchant of record for selling (hosted tier / support plans); 5% + $0.50 on the free plan since May 27 2026 | Indiv | ★★★: sell a "hosted / support" tier without a company | [V2] |
| [thanks.dev](https://thanks.dev) | Companies fund their dependency tree automatically | Indiv (passive) | ★★: works once the SDKs are dependencies | [V2] |
| [Tidelift (now Sonar)](https://www.sonarsource.com/open-source-maintainers) | Paid "lifter" for meeting standards | Packages enterprises use | ★: later, for npm packages | [V2] |
| Buy Me a Coffee / Ko-fi | Tips; BMC 5% [K], Ko-fi 0% on donations [K] | Indiv | ★ | [K] |
| Drips / Gitcoin | See §1b | Indiv | ★★ | [V2] |

---

## 5. Prizes and hackathons (Oct 2026 – Mar 2027)

| Event | Prizes | Eligibility / rules | Dates | Fit | Mark |
|---|---|---|---|---|---|
| [Colosseum Crypto World's Fair](https://www.colosseum.com/) | **$800k+ in prizes** ($30k grand prize; $300k across 20 projects; $100k each for the Solana and Tempo tracks; $100k for Ethereum tracks) + a $250k accelerator path | Online, all chains; individuals or teams. Eligibility isn't spelled out: **confirm an existing project is allowed** before spending the 6 days (hackathons usually require code written during the window) | **Submissions close Oct 12 2026** (running since Sep 14) | ★★★★: the Tempo/Solana payment tracks match; submit an "agent spending firewall over x402/MPP" build | [V] for dates, [V2] for prizes |
| [AgeTech After Dark @ CES 2027](https://agetechcollaborative.org/?p=22004) | **$10k grand prize**, CES ticket, accelerator invite | AgeTech startups (financial resiliency is listed); "market-ready preferred"; no incorporation requirement stated | **Apply by Oct 12 2026, 11:59 pm**; pitch Jan 7 2027, Las Vegas | ★★★★★ for the older-adult features | [V] |
| [PayPal AI Hackathon (Devpost)](https://paypalaihackathon.devpost.com/) | **$67.5k+ cash** ($12k first place; $5k for "Best Use of Agentic Commerce") | Global, individuals OK; **must integrate a PayPal API** + AI; public open-source repo | **Nov 12 2026, 12:00 pm PST** | ★★★★: add PayPal as a funding source/rail with agent approvals | [V] |
| [Agent Pay (MERGE), Madrid](https://www.mmerge.io/hackathon-2026) | €25k+; VC intros; demo day in Buenos Aires in Mar 2027 | ~100 on-site builders; apply | **Nov 27–29 2026** (in person) | ★★★: Track A, agent commerce paid in stablecoins | [V] |
| AgentiX Playground (StraitsX / SMU) | Not stated | Agentic payments on live stablecoin rails; may be student-focused | Final at Singapore FinTech Festival, **Nov 18–20 2026** | ★★: check eligibility | [V2] |
| [Money20/20 USA](https://us.money2020.com/attend/startups/attend-as-a-startup) Startup Hub & pitch | Exposure, investors | Startups (paid attendance) | **Oct 18–21 2026**, Las Vegas | ★★: likely too soon to apply; good for networking | [V2] |
| ETHGlobal Mumbai | Sponsor bounties (typically $500k+ total [K]) | In person | **Nov 5–7 2026** | ★★: travel to India; x402/Coinbase bounties likely [K] | [V] |
| AWS "Agents for Humans" (Devpost) | $40k | Strands Agents SDK | Ends **Oct 14 2026** | ★: wrong SDK | [V2] |
| Google "All Things Agentic" | $180k | Google Cloud agents | **Oct 8 2026** | ★: too soon | [V2] |
| Anthropic / Cerebral Valley "Built with Claude" hackathons | $100k API credits; cash prizes in some editions | Virtual, ~1 week | Every few months (Feb, Apr, Jul 2026); watch for the next | ★★★★ when announced: an MCP-native spending control is on-theme | [V2] |
| Encode Club (AI London hackathon and others) | Varies | Usually in person | Annual; **no 2026–27 dates found** | ★★ watch | [V2] |
| Past (for pattern only) | SF x402 hackathon (Feb 2026, $50k); Cronos x402 ($42k, Jan 2026); MNEE ($50k, Jan 2026); Coinbase "Agents in Action" ($28k) | — | **Closed** | — | [V2] |

---

## 6. Non-cash (standards, mentorship, distribution)

| Program | What you get | Eligibility | Timing | Fit | Mark |
|---|---|---|---|---|---|
| [Agentic AI Foundation (LF)](https://aaif.io/) | Working groups: **Agentic Commerce**, Identity & Trust, Observability & Traceability, Security & Privacy (8 total). 247 member organizations as of Aug 2026 | WG participation is generally open in LF projects [K]; membership is for organizations | Ongoing | ★★★★★ | [V] |
| [x402 Foundation](https://x402.org/) | Spec work, ecosystem listing | Open source contributions are open; membership is for organizations | Ongoing | ★★★★ | [V] |
| [FIDO Alliance](https://fidoalliance.org/members/become-a-member/) | Passkeys / AP2 agent-payment work | Org membership (~$2,750 for associates with ≤100 staff, 2023 fees) | Ongoing | ★★★ (cost) | [V2] |
| OpenSSF | Scorecard, best-practices badge (strengthens the SOS Fund application) | Free | Ongoing | ★★★ | [K] |
| Google Summer of Code 2027 | Paid student contributors (GSoC pays them) | You'd need to be accepted as a mentor organization; hard for a new project | Org applications ~late Jan to early Feb 2027 [K] | ★★ | [V2/K] |
| LFX Mentorship | Paid mentees | Only for LF-hosted projects | 2027 Term 1 proposals ~early Jan 2027 [K] | ★: only if you join AAIF/x402 as a project | [V2/K] |
| Consumer Reports "Loyal Agents" (with Stanford) | Research collaboration on consumer-loyal agents | By outreach | Ongoing | ★★★★ for credibility | [V2] |
| AARP Fraud Watch / BankSafe, EverSafe, SAGE | Co-marketing for the older-adult features | Outreach | — | ★★★ | [K] |

---

## Next 90 days (Oct 6 2026 – Jan 5 2027), ordered by deadline

| Date | Action | Needs a company? |
|---|---|---|
| **Oct 12 (6 days)** | **AgeTech After Dark @ CES**: apply (video + short form, leading with trusted helpers, the 72-hour wait, gift-card/crypto refusal and the phone-scam check). Decide this week | No (not stated) |
| **Oct 12 (6 days)** | **Colosseum Crypto World's Fair**: submit only if you can deliver a demo in 6 days (an agent spending firewall over x402, ideally on the Tempo or Solana track). Otherwise skip | No |
| Oct (rolling, now) | **Emergent Ventures**: 1,500-word application | No |
| Oct (rolling, now) | **Microsoft Founders Hub** Ideate tier (credits with no LLC) | No |
| Oct 18–21 | Money20/20 USA (optional, for networking; Mastercard Start Path and Visa people attend) | — |
| **Nov 2, 8 pm PT** | **YC W27**, only if you're willing to incorporate and go full-time | Later |
| Nov 3 | NLnet: **skip** (AI policy) | — |
| Nov 4 | NSF SBIR full proposal: not realistic (needs an invited pitch + a company). **Submit a Project Pitch now** to target **Mar 4 2027** | Yes |
| **Nov 8** | **Stellar SCF #46**: submit the interest form now; needs a Stellar USDC path | No |
| **Nov 12, noon PST** | **PayPal AI Hackathon**: add a PayPal rail + agent approval demo; open-source repo | No |
| Nov 18 | Techstars Spring 2027 / Alliance ALL19: optional | Yes |
| Nov 27–29 | **Agent Pay, Madrid**: apply as a builder if you can travel | No |
| Rolling, post-launch | **GitHub Secure Open Source Fund** (once you have adoption numbers) | No |
| Rolling | **Circle Developer Grants**: apply with an Arc settlement milestone | No |
| Rolling | **Base Builder Grants**: deploy the x402 path on Base mainnet, then nominate yourself | No |
| Dec 29 | **Celo Prezenti Frontier**: only if you do the Celo + ERC-8004 + Self Agent ID work | No |
| Jan 5 2027 | NIA SBIR Phase I: only with an LLC/C-corp and SAM.gov/eRA registration (start registration ≥6 weeks ahead, i.e. by ~Nov 20) | Yes |
| Late Jan 2027 | GSoC 2027 mentor-org application [K]; SPC Spring 2027 (~Feb 1) [K] | No / No |

## Do this first: top 10

1. **AgeTech After Dark application, by Oct 12.** $10k prize, a path into AARP's accelerator and CES visibility. It's the best fit for the older-adult features and costs about 2 hours.
2. **Emergent Ventures application, this week.** Individual-friendly, quick answer, and the story is strong: a developer building scam-proof agent spending for older adults.
3. **Turn on GitHub Sponsors and apply to Open Source Collective as fiscal host.** This unlocks the nonprofit-only grants (RRF, FINRA, SCAN partners) and companies' donations.
4. **Circle Developer Grant application** with milestones:
   - x402 policy middleware
   - an **Arc** settlement option
   - USDC escrow and refunds for A2A jobs

   Up to $100k, open to individuals.
5. **PayPal AI Hackathon, by Nov 12.** $67.5k pool; open source is required, which you already meet. A PayPal funding rail is a reasonable product feature anyway.
6. **Join the AAIF Agentic Commerce and Observability working groups, and the x402 Foundation community.** Free; they're the distribution channels that move both stars and sponsors.
7. **Decide on incorporating by ~Oct 25** (Stripe Atlas or a Delaware C-corp). That decides YC W27 (Nov 2), the NSF Project Pitch (for Mar 4), NIA SBIR (Jan 5), Anthropic and Cloudflare credits, Anthology and Base Ecosystem Fund. If yes, submit the **NSF Project Pitch** right after incorporating.
8. **Stellar SCF #46 interest form now** (up to $150k XLM, build deadline Nov 8). Only if you'll add a Stellar USDC facilitator. Otherwise do **Base Builder Grants** (deploy on Base).
9. **GitHub Secure Open Source Fund the week after launch,** with the threat model already prepared: prompt injection, runaway spend, elder scams.
10. **Claude for Open Source application once you hit 20 outside contributors** (or go in through the "ecosystem impact" route at launch). At the same time, publish the MCP Registry listing and the plugin so Anthropic's showcase has something to point to.

**Skip / don't bother now:**
- **AI policy:** NLnet. Also note that no other funder publishes an AI policy, so keep the human-authored design docs and commit history tidy in case one asks.
- **Location:** Prototype Fund DE and CH.
- **Scope or instability:** OTF; Optimism Retro (paused); EF ESP open grants (paused); NVIDIA Inception (excludes crypto).
- **Not eligible yet:** Google Cloud AI tier (needs VC funding); Mastercard / Visa (need revenue or funding).
- **Dormant or dead:** Pioneer, GitHub Accelerator, AI Grant (until Batch 5).

**Gaps.** I didn't research these, or found nothing current:
- state-level programs (state unknown)
- the FinTech Innovation Lab NYC 2027 call
- current Coinbase CDP grant rounds
- Gitcoin GG25/26 dates
- Arbitrum renewal
- the next Workers Launchpad date
- the a16z OSS AI grant
- the next Anthropic hackathon date

Check these by hand.
