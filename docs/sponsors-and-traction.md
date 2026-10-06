# Sponsors and GitHub traction

Written 2026-10-06. Two questions:
- Who would back this project?
- What traction can it expect on GitHub once it's open source?

**How the evidence was gathered.** The traction numbers are **live GitHub and Hacker News data** pulled today through the GitHub API and HN's search API. The sponsor research couldn't run open web searches, because the session's search allowance was used up, so it read each program's own page directly.
- **[V]**: read on the program's own page today.
- **[K]**: from background knowledge; verify before applying.

## The short version

- **Rename before launch.** GitHub has **519 repositories named "agentpay"**. The most-starred, with 461 stars, is `worldliberty/agentpay-sdk` from World Liberty Financial. There's also an `agentpay-mcp` on GitHub, `agentpay` and `agentpay-mcp` are taken on npm, and other companies use the name. Launching under this name means competing for search results and inheriting other projects' reputations.
- **Realistic traction for a well-run launch:** about **1,500–5,000 stars in the first year**. Without one, most projects in this niche stay under 50 stars. Breaking past 5,000 usually takes being attached to a protocol or a big name.
- **The best co-sponsors are the bodies setting agent-payment standards, not grant programs:**
  - the Linux Foundation's **Agentic AI Foundation** (which runs MCP and A2A)
  - the **x402 Foundation**
  - the **FIDO Alliance** working groups that AP2 is moving to

  **Circle** (up to $100k in USDC), the **GitHub Secure Open Source Fund** ($10k plus Azure credits) and **AARP's AgeTech Collaborative** (pilots with older adults) come next.
- **Lead every pitch with the MIT-licensed parts** (MCP server, plugin, verify SDK) and the safety story. Several funders need a company or a nonprofit partner.

## Part 1: traction on GitHub

### What comparable projects reached (stars as of 2026-10-06)

| Project | Stars | Age | What it is | Lesson |
|---|---|---|---|---|
| `x402-foundation/x402` | 6,683 | 19 months | The x402 protocol (Coinbase, then the Linux Foundation) | Backed by a protocol owner |
| `google-agentic-commerce/AP2` | 3,206 | 16 months | Google's agent payments protocol | Backed by a big company |
| `agentic-commerce-protocol/...` | 1,562 | 12 months | OpenAI and Stripe's ACP | Backed by a big company |
| `stripe/ai` | 1,856 | 23 months | Stripe's agent toolkit | Backed by a big company |
| `coinbase/agentkit` | 1,322 | 23 months | "Every AI agent deserves a wallet" | The closest big-company analog |
| `google-agentic-commerce/a2a-x402` | 564 | 16 months | The A2A x402 extension | Specs draw fewer stars than products |
| `visa/trusted-agent-protocol` | 211 | 12 months | Visa's agent trust protocol | Even Visa's name doesn't guarantee stars |
| `GetBindu/Bindu` | 10,075 | 18 months | "Identity, communication and payments layer for AI agents" | An independent breakout |
| `internet-court/internet-court-skill` | 6,391 | **4 months** | "Trust layer for agent-to-agent commerce": mandates, delegated permissions, x402 | The closest independent analog; very fast growth |
| `BlockRunAI/ClawRouter` | 6,617 | 8 months | LLM router behind one agent wallet (x402) | Rode the OpenClaw and x402 wave |
| `ellite/Wallos` | 8,634 | 3 years | Self-hosted subscription tracker | The self-hosting crowd adopts money tools |
| `actualbudget/actual` / `maybe-finance/maybe` | 29,331 / 54,243 | 4 years / 21 months | Open-source personal finance | Big audience for open money apps |
| Most "MCP payments" and "agent wallet" repos | **under 10** | 2026 | Small independent projects | The default outcome without distribution |

**Some star counts are inflated.** A closer look ([landscape.md](landscape.md)) found signs of bought stars:
- **internet-court-skill:** one committer.
- **Bindu:** 10k stars but 792 downloads a month.

Don't treat either as a real breakout. Use monthly downloads as the yardstick instead: oneshot about 3k, ClawRouter about 8k, coinbase/agentkit about 31k.

**How crowded the space is** (GitHub topic counts):
- `topic:mcp`: 88,710 repos
- `topic:x402`: 3,579 repos, with 3,759 x402 repos created in the last 90 days alone
- `topic:agent-payments`: 389 repos
- `topic:agentic-commerce`: 954 repos

Interest is high, and so is the noise.

**Hacker News:**
- 56 "Show HN" posts about MCP servers have passed 100 points. The top ones got 150–300 for concrete, useful servers (WhatsApp, Apple Health, Ghidra).
- x402 stories do well when they're news: Cloudflare's Monetization Gateway got 355 points, the x402 launch 228.
- A 100–300-point Show HN is a realistic target for a clear demo.

### What this means for this project

**Working for it:**
- **A real gap.** No open-source project combines agent spending controls with a policy engine, approvals and an audit log, plus outside payments over x402 and A2A, plus everyday subscriptions. Most competitors are SDKs for *making* payments; this is about **controlling** them.
- **Three audiences, each with a proven appetite:**
  - **MCP and Claude Code developers:** easy to reach through the registry, a plugin and Show HN.
  - **The x402 and A2A crowd:** fast-growing and starved of safety tooling.
  - **Self-hosters:** Wallos shows that a self-hosted subscription tracker alone can reach about 8.6k stars.
- **A strong safety story for older adults,** which is rare in this space and good for press.
- **Real engineering depth** (146 tests, a double-entry ledger, signed requests), which earns developers' trust once they look.

**Working against it:**
- **The name.** See above.
- **Setup takes effort:**
  - Postgres
  - Stripe
  - HTTPS for passkeys
  - a USDC wallet for outside payments

  Projects that break out usually run with a single command.
- **The scope is wide.** A visitor who can't tell in 10 seconds what it is moves on. Lead with one sentence.
- **It handles money.** People are careful and want to read the code first. That's good for serious users but slows casual stars.
- **Parts of the audience may hesitate:**
  - Some Hacker News readers are skeptical of anything crypto, and x402 is crypto.
  - Some companies avoid AGPL code.
- **One maintainer.** Contributors watch how fast issues get answered.

### Traction scenarios for the first 12 months

| Scenario | What happens | Stars | npm downloads a month |
|---|---|---|---|
| **Quiet** | Repo made public, no launch | 20–150 | under 500 |
| **Solid launch** | New name, one-command demo, video, Show HN (100+ points), listed in the MCP Registry and the Claude plugin directory, the awesome lists and r/selfhosted | **1,500–5,000** | 2k–15k |
| **Breakout** | All of the above, plus a mention or listing from the x402 Foundation, AAIF, Anthropic or Cloudflare, or press on the older-adults angle | 5,000–15,000 | 20k+ |

These are estimates from the comparables above, not forecasts.

### What most moves the number

1. **A new, distinctive name**, checked across GitHub, npm and trademarks.
2. **A one-command start.** For example, `docker compose up` with demo data, test mode and no Stripe needed. Ideally also a hosted read-only demo.
3. **A 60–90-second video, and a GIF at the top of the README:** an agent hits a paid tool, gets `pending_approval`, the owner approves with a passkey, and the why log shows it.
4. **One promise first:** for example, "a spending firewall for your AI agents". Show the other features further down the README, as other entry points.
5. **Publish the packages:** the MCP server and the verify SDK on npm, the MCP Registry listing, and the plugin marketplace.
6. **Get listed in the indexes:**
   - `awesome-mcp-servers` (95k stars)
   - `awesome-x402` (290)
   - `awesome-agent-native-services` (476)
   - Smithery, Glama and PulseMCP
7. **Launch with a sequence:** Show HN, then r/ClaudeAI, r/mcp and r/selfhosted (lead with the subscription tracker there), then the x402 and Base communities.
8. **Make contributing easy:** "good first issue" labels, quick replies, and a public roadmap.

## Part 2: possible co-sponsors

### Shortlist, in order

| # | Who | What they offer | Fit | Notes |
|---|---|---|---|---|
| 1 | **Agentic AI Foundation, Linux Foundation** (runs MCP and A2A) [V] | Working groups open to the community, including **Agentic Commerce**, **Identity & Trust** and **Observability & Traceability**. Platinum members include Anthropic, Google, Microsoft, OpenAI, Cloudflare, Block and AWS | ★★★★★ | Free; puts the project in front of every major AI company. Offer the why-log format and policy model as candidate shared formats |
| 2 | **Circle Developer Grants** [V] | **$5k–$100k in USDC**, paid by milestone; "agentic economic activity" is a focus area; **open now** (circle.questbook.app) | ★★★★ | USDC must be central: lead with x402 and A2A payments |
| 3 | **GitHub Secure Open Source Fund** [V] | **$10k** plus $10k in Azure credits, a 3-week security program, and possibly $150k more through Microsoft for Startups; rolling | ★★★★ | Pitch it as a security project. The weak point today is adoption, so apply after launch |
| 4 | **x402 Foundation (Linux Foundation) and Coinbase Developer Platform** [V/K] | Ecosystem listing, developer-relations promotion, reference-implementation status; no grant program found | ★★★★ | "The spending-control layer for x402" |
| 5 | **AARP AgeTech Collaborative** [V] | Connections, **pilots with AARP members**, introductions to investors and companies; not a direct funder | ★★★★ | Protected accounts, the scam check and the gift-card and crypto refusals fit exactly |
| 6 | **FIDO Alliance AP2 working groups** [V] | A standards seat; AP2 is moving there; paid membership tiers [K] | ★★★★ | Passkey approval of agent purchases is their exact topic |
| 7 | **Base Batches and Base Ecosystem Fund** [V] | **$100k** plus a demo day; pre-seed and seed investment for payments and AI-agent companies | ★★★★ | Needs a company |
| 8 | **Anthropic** [V] | Claude for Open Source (6 months of Claude Max 20x) once adoption meets their bar (for example, 200k monthly downloads or 20+ outside contributors); MCP Registry and plugin showcase now | ★★★ (★★★★ later) | No cash grants known; the value is visibility |
| 9 | **NIA SBIR/STTR** (National Institute on Aging) [K] | Phase I about $300k, Phase II about $2M; deadlines around Jan 5, Apr 5 and Sep 5 | ★★★★ with a company | Needs a US small business. Slow, but large and doesn't take equity |
| 10 | **Y Combinator W27** [V] | Standard deal [K], plus $12M+ in partner credits; **deadline Nov 2, 8 pm PT** | ★★★ | Only if you want to build a company around it |

**Also worth setting up:**
- **GitHub Sponsors:** turn it on at launch.
- **The Gitcoin GG24 open-source round** [V]: cheap to try.
- **Cloudflare:** startup credits of $10k–$350k need a company [V]; it also co-announced x402, so it's a good demo partner.
- **Stripe:** a partner and distribution route (Stripe Apps, its agent toolkit, ACP), not a funder [K].
- **EverSafe, SAGE and AARP's Fraud Watch Network:** co-marketing for the older-adults features [K].

### Not a fit right now

| Program | Why not |
|---|---|
| **Sovereign Tech Agency** [V] | Funds "open digital base technologies", not apps or prototypes. Maybe later for the verify SDK alone |
| **NLnet** [V] | European focus, and **"AI-generated projects not accepted"**. This repository's history shows Claude as a co-author |
| **FINRA Investor Education Foundation** [V] | Nonprofits and universities only. Possible later with a university partner studying the scam check |
| **Vercel open-source program** [V] | Applications closed |
| **Visa and Mastercard programs, Plaid, Sloan, a16z crypto, Alliance DAO, Techstars** | Later-stage, crypto-native, by invitation, or a weak fit today |

### Pitch angles for the top five

1. **Agentic AI Foundation.**
   - The angle: "MCP gave agents tools, A2A gave them peers, and x402 gave them a way to pay. Nobody has standardized the owner's controls."
   - Present: this project as an open-source reference for agent spending: per-agent limits, envelopes, passkey approvals, a kill switch, refused categories, and a tamper-evident log of why each payment happened.
   - Offer: the log format and the policy model to the Agentic Commerce and Observability working groups, with MIT-licensed SDKs.
2. **Circle.**
   - The angle: where USDC meets everyday people.
   - Present: agents pay APIs and other agents in USDC over x402 and A2A, but every payment first passes the human's rules, envelopes and passkey approval.
   - Milestones: open-source x402 policy middleware, USDC refunds and escrow for jobs agents sell to each other, and a public dashboard of agent-to-agent volume.
3. **GitHub Secure Open Source Fund.**
   - The angle: a security project that happens to hold money.
   - The threat model: prompt injection, runaway spending, merchant fraud and elder scams.
   - What exists today: signed requests, a hash-chained audit log, WebAuthn approvals and hard refusals.
   - Ask for: a formal threat model, fuzzing of the policy engine, and an audit of the server and verify SDK.
4. **x402 Foundation and Coinbase.**
   - The angle: x402 makes agent payments easy, so the next question from every company and every parent is "how do I stop it?"
   - Present: this project as the spending-control layer in front of any x402 client, including the A2A extension.
   - Ask for: a listing as a reference implementation, and a co-written guide to safe x402 for consumers.
5. **AARP AgeTech Collaborative.**
   - The angle: AI agents will soon shop, renew and pay for older adults, and so will scammers pretending to be those agents.
   - Present: trusted helpers co-sign or add a 72-hour wait; gift cards, crypto and money transfers are refused outright; a phone-scam check; tracking and cancelling unwanted subscriptions. All open source.
   - Ask for: a pilot with AARP members and caregivers, measuring scams stopped and money saved.

**Correction for the pitches:** the MCP Registry listing is prepared but **not published yet**. Publish it before claiming it.

## Things to decide first

1. **The new name.** Everything else (packages, registry, plugin, pitches) depends on it.
2. **A company, or stay independent?**
   - *With a company:* YC, Base, Cloudflare credits and SBIR open up.
   - *Staying independent:* lean on AAIF, Circle, GitHub, Gitcoin and Sponsors.
3. **The authorship email and the AI co-authorship in the history.** The email was already flagged in [open-source-launch.md](open-source-launch.md). AI co-authorship rules some funders out (NLnet); it's fine for most of the others.
