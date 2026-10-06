# The open-source agent-payments landscape: what others ship, what's used, what to take

Written 2026-10-06 from live GitHub, npm and PyPI data:
- **The full landscape:** 1,729 repositories found by searching agent payments, x402, agentic commerce and "agentpay".
- **A close read** of the READMEs, contributors, issues, releases and package downloads of 34 notable projects.

GitHub wouldn't return star timelines, so judgments about bought stars rest on proxies:
- stars compared with watchers, forks, contributors and outside issues
- downloads

## The short version

1. **It's a gold rush of tiny repos.**
   - **Star counts:** of 1,729 repositories, 941 have no stars and 588 have fewer than 10. Only 14 pass 1,000, and several of those aren't about agent payments.
   - **How fast it's growing:** about 12 new repositories a month a year ago; **315 in August 2026**.
   - **The mix:** mostly TypeScript and Python, and mostly crypto (x402 in 752, USDC or stablecoins in 490).
2. **Stars lie here; downloads don't.** The projects with the most stars show the weakest usage:
   - **internet-court-skill:** 6.4k stars, one committer, 4 commits.
   - **sphere-sdk:** 5.4k stars, almost no outside contributors.
   - **Bindu:** 10k stars but 792 downloads a month.
   - **helix:** 825 stars, 0 watchers.
   - **northcinder:** 1.2k stars in 5 days, 57 downloads.
   - **moneyclaw:** 937 forks from accounts created minutes apart.

   **Measure success by package downloads and outside contributors.**
3. **Real usage, by monthly downloads:**
   - **x402 itself:** `x402` 1.8M, `@x402/core` 1.35M, `@x402/fetch` 505k
   - **coinbase/agentkit:** 31k npm and 7k PyPI
   - **ClawRouter:** 8.4k
   - **Merit's `agentcash`:** 8.7k
   - **oneshot:** 3.4k for the SDK and 3.1k for the MCP server
   - **Franklin:** 3.2k

   Outside agent payments, **Wallos** (a self-hosted subscription tracker) has **8.9M Docker pulls**.
4. **Almost everyone builds the "pay" side. Almost nobody builds the owner's side well.**
   - About 200 repositories mention limits, budgets or policies, but together they have only about 1,250 stars.
   - Only 18 touch subscriptions.

   That's this project's opening.
5. **The best ideas to take:**
   - plain-English policies with a dry run
   - payee pinning and catching duplicate payments
   - an evidence bundle the owner can verify
   - an OpenAI-compatible LLM gateway billed to envelopes
   - x402 `upto` and `auth-capture` payment schemes
   - publishing listings to x402 discovery
   - a red-team suite
   - Wallos-style notifications and an iCal feed
6. **The tactics that clearly drove adoption:**
   - `npx skills add owner/repo` as the install line
   - a plugin and marketplace living in the same repo
   - one installer that sets up every agent tool on the machine
   - zero-code `npx` MCP servers
   - free use with no signup
   - drop-in clients
   - an explorer site that doubles as a way to contribute

## What they ship

| Category | Examples | What it is |
|---|---|---|
| **Protocols and their SDKs** | `x402-foundation/x402` (6.7k stars, 100+ contributors, 1.8M downloads a month), `google-agentic-commerce/AP2`, ACP | The rails. Everyone builds on x402 |
| **Agent wallets and SDKs** | `coinbase/agentkit`, `coinbase/agentic-wallet-skills`, `worldliberty/agentpay-sdk`, `unicity-sphere/sphere-sdk` | Give the agent a wallet; limits are a side feature |
| **Agents that spend** | `BlockRunAI/ClawRouter` (LLM router behind one wallet), `BlockRunAI/Franklin` (an agent with a USDC wallet), `oneshot-agent/sdk` (email, SMS, research and purchases, paid in USDC) | Real downloads, fast releases (near daily) |
| **Merchant and seller side** | `devlab-group/agent-commerce` (expose an existing API over MCP, A2A, ACP, x402 and AP2), `daydreamsai/lucid-agents` (turn functions into paid services), `qntx/facilitator` | Help sellers get paid by agents |
| **Identity, trust and disputes** | `GetBindu/Bindu` (identity with DIDs, mTLS, negotiation), `internet-court-skill` (pre-agreed adjudicators), `mishrasanjeev/grantex` (OAuth-style grants, sub-agent delegation) | Mostly early, and some with inflated stars |
| **Controls and policy** | `Steward-Fi/steward` (credential proxy, policy, approvals, audit bundles; 12 contributors), `richard7463/askgrokwallet` (plain-English policy, then a signed receipt), `presidio-v/presidio-hardened-x402` (PII redaction, payee pinning, duplicate guard), `1lystore/dcp` (desktop vault) | **This project's category.** Small, but serious |
| **Evidence and legal specs** | `A-Comm-Tech/a-comm-evidence-protocol` (dispute bundles), `legal-context-protocol` (`/.well-known/legal-context.json`) | Specs with no running code |
| **Security testing** | `gy15901580825/Argus` (26 x402 abuse probes), `msaleme/red-team-blue-team-agent-fabric` (640 tests, 1.7k PyPI downloads a month) | A real and growing need |
| **Explorers and lists** | `Merit-Systems/x402scan` (54 contributors, under-starred), `awesome-x402`, `awesome-agent-native-services` | Discovery, and a way in for contributors |
| **Consumer money tools** | `ellite/Wallos` (8.6k stars, 87 contributors, 8.9M Docker pulls) | Proves self-hosters adopt money tools |

## Features worth taking, and how to do them better

Each was checked against this repo first; nothing below exists here yet. Effort is S, M or L.

### Safety and trust (do first: they are the product)

| # | Feature | From | How to do it better here | Effort |
|---|---|---|---|---|
| 1 | **Plain-English policy** ("under $50 run on their own; above, ask me; never pay blacklisted merchants; $200 a day") | `askgrokwallet` | Compile to the existing levels, rules and envelopes. Show a rule-by-rule **dry run** ("what this would have done to your last 30 days"). Sign it with the passkey final-confirmation terms. Keep the original sentence in the why log | M |
| 2 | **Payee pinning and a price-jump limit:** warn or block when a seller's pay-to address changes, or a price jumps past a set ratio | `presidio-hardened-x402` v0.12 | Apply to x402, A2A and marketplace quotes. Use price-watch history as the reference price. Protected accounts block by default | S |
| 3 | **Duplicate-payment fingerprint:** the same payee, amount and resource within a time window, even with a new idempotency key | `presidio` ReplayGuard | Make it an "Observe" or "Escalate" outcome, not a silent block | S |
| 4 | **"Possibly paid" state:** never resend after a crash or unclear answer | `sphere-sdk`, `oneshot` in-flight ledger | Build on the existing `unclear` branch. Show it to the owner as pending, and block a resend until resolved | S |
| 5 | **An evidence bundle the owner can verify:** a signed slice of the why log, with a pinned, standalone verifier and test vectors | `askgrokwallet` `spec/verify-receipt.mjs`, Steward `/audit/bundle`, AEP DisputeBundle | Export per incident, with AEP's step names (intent, authorization, fulfillment, refund) so a bank or store can read it. Back the guarantee policy with it | M |
| 6 | **Signed offers and receipts** from sellers | x402 `offer-and-receipt` extension | Check every receipt's signature, chain it into the why log, and use it as evidence | M |
| 7 | **PII redaction** on outgoing payment details (emails, social security numbers, card numbers, including encoded forms) | `presidio` | Apply to x402 and A2A messages and job inputs. Protected accounts block instead of redacting | M |
| 8 | **Red-team suite:** `npx agentpay redteam`: prompt-injection-to-spend, approval spoofing, envelope drain, refusal bypass, against test keys | `Argus`, `msaleme` harness (PASS, FAIL or INCONCLUSIVE; SARIF output) | Ship it as a CI job, and publish the results in the README | M |

### Usefulness for developers

| # | Feature | From | How to do it better here | Effort |
|---|---|---|---|---|
| 9 | **OpenAI-compatible LLM gateway billed to the wallet:** swap `baseURL` | `qntx/openai`, `ClawRouter`, `Alephant` | Every LLM call goes through the agent's level, rules and envelope. Eco, auto and premium profiles. A cap per conversation that **stops before it's crossed**, based on projected spend (Argus's predictive abort) | M |
| 10 | **x402 `upto` and `auth-capture` on the outside rail:** commit a maximum, charge less | x402 schemes | The envelope caps the authorization, and the unused part returns to the owner automatically | M |
| 11 | **Publish to x402 discovery:** `openapi.json` with `x-payment-info` and `/.well-known/x402` for every marketplace tool, then appear on x402scan and the bazaar | `x402scan` `docs/DISCOVERY.md` | Also pull x402scan's registry into `find_service`, labeled with each seller's incident rate | S–M |
| 12 | **Public seller trust page:** success rate, refunds, incidents, share of verified signatures | `x402scan` | Only this project has the data to publish it | M |
| 13 | **Sub-agent delegation:** a child key gets a strict subset of rules, expiry = the sooner of parent and child, revoking the parent revokes the child | `grantex` | Carve the child's envelope out of the parent's | M |
| 14 | **Credential proxy:** the agent gets a scoped grant (host, path, method) and the proxy adds the API key, so the agent never sees the key | `Steward`, `dcp` | Keys live in the vault, per-call cost goes to envelopes, the kill switch revokes everything | L |
| 15 | **Seller onboarding:** `agentpay provider import openapi.yaml` drafts listings; `agentpay doctor` checks keys, Stripe Connect, webhooks and test keys end to end | `agent-commerce` | — | M |
| 16 | **Check delivered work before paying a job:** a reviewer compares the result with the quote before the held money is charged | `Franklin` adversarial reviewers | On failure, the money stays held and an incident opens | M |
| 17 | **Pre-agreed dispute terms** shown at quote time: refund window, who decides, what evidence counts | `internet-court-skill` (the idea, not the repo) | Shown on the passkey approval | L |
| 18 | **Solana USDC** on the outside rail | x402 `mechanisms/svm`; ClawRouter and Franklin default to Solana | Same caps and controls | M |

### Usefulness for people (the Wallos lessons)

| # | Feature | From | How to do it better here | Effort |
|---|---|---|---|---|
| 19 | **Notifications:** email (built), plus Telegram, Discord, Pushover, Gotify and webhooks, for reminders, approvals and helper alerts | `Wallos` | Helpers get alerts finally pushed to them, not only on the dashboard | M |
| 20 | **An iCal feed** of renewals, trial ends, return deadlines and contract ends | `Wallos` | Includes return windows and helper co-sign deadlines | S |
| 21 | **Household view, payment method per subscription, period budget, logo lookup** | `Wallos` | The household maps to trusted helpers | S each |
| 22 | **"Sponsored never ranks higher," with published ranking rules,** for product picking | `northcinder` (idea only; the repo looks inflated) | Add to `pick_product` and document it | S |
| 23 | **Hosted-agent connect link:** single use, 10 minutes, no permissions; pairs Claude.ai or ChatGPT to a limited key after a passkey approval | `dcp` | — | S |
| 24 | **Spend export:** CSV of the ledger and envelopes, marking which figures are estimates | `lucid-agents`, `Franklin` | — | S |

## Distribution tactics to copy

1. **`npx skills add <owner>/<repo>` as the headline install.** Coinbase puts it in the repo description, and oneshot and internet-court do the same. Ship a skills repo.
2. **Plugin and marketplace in the same repo, with copy-paste installs for each agent tool:** Claude Code, Codex, Cursor, opencode, OpenClaw, Goose. This project already has the Claude Code plugin; add the others.
3. **One installer that detects every agent tool** on the machine and writes skill packs plus AGENTS.md, CLAUDE.md, GEMINI.md and Cursor rules. worldliberty and ClawRouter both do it.
4. **A zero-code MCP server via `npx -y`.** Oneshot's MCP server gets about as many downloads as its SDK.
5. **Free with no signup**, with card and USDC as equal choices. ClawRouter's 6 free models are its on-ramp. For this project, that's test keys plus a hosted read-only demo.
6. **Drop-in clients and middleware for every framework.** `@x402/fetch` gets 505k downloads a month. For this project: an OpenAI-compatible gateway, a `fetch` wrapper, and Express and Hono middleware for sellers.
7. **An explorer or registry that invites contributions.** x402scan's registration form and facilitator pull requests brought 54 contributors.
8. **Fast, visible releases.** The real winners ship almost daily.

## Correction to [sponsors-and-traction.md](sponsors-and-traction.md)

That report used internet-court-skill (6.4k stars in 4 months) and Bindu (10k) as examples of independent breakouts. **Both show signs of inflated stars:**
- internet-court-skill has one committer.
- Bindu has 10k stars but 792 downloads a month.

The traction estimate stands, but the yardstick should be **monthly downloads and outside contributors**, not stars:

| Goal | Monthly downloads (MCP server and SDK) |
|---|---|
| Solid first year | 2,000–15,000 |
| Breakout | 20,000+ |

Compare oneshot (3k), Franklin (3k), ClawRouter (8k) and agentkit (31k).

## Suggested next build

Six pieces that add the most for the effort, grouped:

1. **Install everywhere:** a skills repo plus one installer for all agent tools, a zero-code `npx` MCP server (already have), and a one-command `docker compose` demo. Distribution.
2. **Plain-English policy with a 30-day dry run** (#1). The most visible "wow".
3. **Payment safety pack:** payee pinning, a price-jump limit, duplicate fingerprinting and a "possibly paid" state (#2–4). Small, and fits the safety story.
4. **Verifiable evidence bundle and verifier** (#5–6). Credibility with funders (GitHub's security fund, AAIF) and for disputes.
5. **OpenAI-compatible gateway billed to envelopes** (#9). Opens up the biggest developer audience.
6. **Notifications and an iCal feed** (#19–20). Makes reminders and helper alerts real, and draws in the self-hosting crowd.

## Repositories read closely

coinbase/agentkit, coinbase/agentic-wallet-skills, x402-foundation/x402, GetBindu/Bindu, internet-court/internet-court-skill, BlockRunAI/ClawRouter, BlockRunAI/Franklin, unicity-sphere/sphere-sdk, worldliberty/agentpay-sdk, usehelix/helix, Snaplii-Inc/agent-to-merchant-payments, Merit-Systems/x402scan, qntx/openai, qntx/facilitator, daydreamsai/lucid-agents, oneshot-agent/sdk, cinderline/northcinder, Steward-Fi/steward, AlephantAI/AIephant-AI-Agent-Gateway, richard7463/askgrokwallet, presidio-v/presidio-hardened-x402, 1lystore/dcp, keep-starknet-strange/starkclaw, A-Comm-Tech/a-comm-evidence-protocol, mishrasanjeev/grantex, Matchameleon/moneyclaw, auscaster/frantic-board, devlab-group/agent-commerce, nikoSchoinas/routeweiler-python-sdk, wienerlabs/covenant, gy15901580825/Argus, msaleme/red-team-blue-team-agent-fabric, ellite/Wallos, legal-context-protocol/legal-context-protocol, accensa/accensa-contracts.
