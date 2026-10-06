# Where to list AgentPay: directories, registries, marketplaces and launch sites (checked 2026-10-06)

Companion to [funding.md](funding.md). Builds on the launch steps in [open-source-launch.md](open-source-launch.md).

## How to read this

**Gates:**
- **A:** the repo is public.
- **B:** the npm package is published, or the server is listed in the MCP Registry.
- **C:** a hosted HTTPS server with OAuth sign-in and a privacy policy.
- **D:** a Docker image is published.
- **E:** a company or legal entity, or a review for financial apps.

**Status:**
- **[V]:** the submission, rules or policy page was fetched today and loaded.
  Anthropic §4.A was re-checked on its policy page (support.claude.com/en/articles/13145338) on 2026-10-06.
- **[V-mirror]:** a Reddit page read through a mirror, because Reddit blocks fetching.
- **[K]:** from search results or other sources only.
- **dead?:** closed, archived, paused, or unreachable today.

Star counts come from api.github.com today.

**Where AgentPay stands today:** it meets none of the gates. The repo is private, npm is unpublished, there is no hosted server, no Docker image in a registry, and no entity.

## The three findings that change the plan

1. **The big official stores ban software that moves money.** Each of these rules was fetched today:
   - **Anthropic**, Software Directory Policy §4.A. §4 covers all "Software" entering the Directories, and plugin bundles go through the same portal, which requires a "financial transactions" acknowledgment. The clause itself does not name plugins: *"Unless otherwise expressly permitted by us in writing, we do not allow Software with certain capabilities into our Directories… A. Software that transfers money, cryptocurrency, or other financial assets, or executes financial transactions on behalf of users."* 
   - **ChatGPT apps** (OpenAI now calls them "plugins") ban *"Execution of money transfers, crypto transfers, or investment trades"* and *"Selling digital products or services—including subscriptions, digital content, tokens, or credits."*
   - **Zapier** bans integrations that *"facilitate any form of financial transaction, transfer of assets, or payment processing."*
   - **Stripe Apps** must *"process payments through Stripe unless approved in writing otherwise"*, which conflicts with paying in USDC.

   **What this means:** the "later: Claude Connectors Directory + ChatGPT apps" step in [distribution.md](distribution.md) is not just waiting on OAuth. It needs either written permission from Anthropic (directory@anthropic.com for plugins, mcp-review@anthropic.com for connectors) or a reduced read-only build: subscription tracker, audit log and budgets, with no pay tools.
2. **One publish to the official MCP Registry feeds many directories.** It reaches the GitHub MCP Registry (github.com/mcp), which feeds the VS Code @mcp gallery and Copilot in JetBrains, Eclipse and Xcode. PulseMCP (submissions paused) says it will auto-ingest from the registry. Zed and Devin Local are moving to the registry schema. Fix the final name and the `io.github.<user>/<name>` namespace first, because renaming after a publish leaves a stale entry.
3. **Several channels have clocks or thresholds that start when the repo goes public:**

   | Channel | Rule |
   |---|---|
   | awesome-selfhosted | *"first released more than 4 months ago"* |
   | r/selfhosted | projects under 3 months old go only in the weekly New Project Megathread |
   | awesome-claude-code | 14+ days of commits, or 100+ stars |
   | Coolify | 1,000+ stars |

   Tag v0.1.0 on the day the repo goes public so the clocks start.

**Also:** search found `worldliberty/agentpay-sdk`, "an open SDK for agentic payments… with policy enforcement and human approval built in". That is very close in name and pitch, and one more reason to rename before launch.

---

## 1. MCP directories and registries

| Name | URL | How to submit | Gate | Cost | Reach | Financial restrictions | Status | Source |
|---|---|---|---|---|---|---|---|---|
| Official MCP Registry | registry.modelcontextprotocol.io | CLI: `mcp-publisher login github` / `publish`. npm `mcpName` must match server.json | B | Free | repo has 7,319 stars; feeds GitHub, VS Code, PulseMCP and others | None. "Assume minimal-to-no moderation"; still in preview, so data may be reset | [V] | github.com/modelcontextprotocol/registry (docs/…/quickstart.mdx, moderation-policy.mdx) |
| GitHub MCP Registry | github.com/mcp | Automatic from the official registry | B | Free | 375 servers listed | None | [V] | github.blog "Meet the GitHub MCP Registry" |
| VS Code MCP gallery (@mcp) | code.visualstudio.com | Automatic, through the GitHub registry | B | Free | All VS Code and Copilot users | None | [K] | code.visualstudio.com/docs/copilot/customization/mcp-servers |
| Copilot in JetBrains, Eclipse and Xcode | — | Automatic, through the GitHub registry (org allowlists apply) | B | Free | JetBrains and other Copilot users | None | [K] | github.blog changelog 2025-10-28 |
| Glama | glama.ai/mcp/servers | "Add Server" form plus GitHub crawl; claim the listing with `glama.json` (`maintainers`) | A (a Dockerfile helps its build score) | Free | 96,914 servers | None | [V] | glama.ai/blog/2025-07-08-what-is-glamajson |
| Smithery | smithery.ai/new | Web or CLI. Either a hosted URL behind its gateway, or stdio through an uploaded `.mcpb` bundle | C, or an MCPB bundle | Not stated | Not stated; its CLI moved to arcadeai-labs | None | [V] | smithery.ai/docs/build/publish |
| PulseMCP | pulsemcp.com/submit | Form paused; says it will auto-ingest from the official registry | B | Free | Bi-weekly newsletter | None | [V] **paused** | pulsemcp.com/submit |
| mcp.so | mcp.so | GitHub issue on chatmcp/mcpso ("Submit: …") | A | Free | repo has 2,108 stars | None | [K] site unreachable today (dead?); issue intake active | github.com/chatmcp/mcpso |
| mcpservers.org (= wong2/awesome-mcp-servers) | mcpservers.org/submit | Form (wong2's list doesn't take PRs) | A | Free (about 2 weeks), or $39 for 24h review and a badge | wong2 list has 4,348 stars | Has a Finance category | [V] | mcpservers.org/submit |
| MCP Market | mcpmarket.com/submit | Form with the repo URL | A | Free (4-6 week queue), or $29 for 24h | Claims 1M+ monthly visitors | None | [V] | mcpmarket.com/submit |
| LobeHub MCP Marketplace | lobehub.com/mcp | "Submit MCP" button on the site | A | Free | Claims 10k+ tools; lobehub has 83k stars | None | [K] (403) | lobehub.com docs |
| Docker MCP Catalog | hub.docker.com/mcp | PR adding `servers/<name>/server.yaml` to docker/mcp-registry; Docker builds and signs the image | D (Dockerfile) | Free | 568 stars; shown in Docker Desktop MCP Toolkit | **License:** "MIT or Apache 2 are great, GPL is not." Submit the MIT MCP package, not the AGPL server | [V] | github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md |
| Cline MCP Marketplace | github.com/cline/mcp-marketplace | Issue template; needs a 400×400 logo and an `llms-install.md` | A | Free | 791 stars | None | [V] active | github.com/cline/mcp-marketplace |
| cursor.directory | cursor.directory/mcp | Web form (log in) | A | Free | cursor/community-plugins has 4,000 stars | None | [K] (429) | cursor.directory/mcp |
| Cursor Marketplace (official plugins) | cursor.com/marketplace/publish | Form; every plugin and update is reviewed by hand; plugin.json can include the MCP server | A (must be open source) | Free | All Cursor users | Security review only | [V] | cursor.com/docs/plugins |
| Gemini CLI Extensions gallery | geminicli.com/extensions | **Automatic daily crawl**: public repo + topic `gemini-cli-extension` + `gemini-extension.json` at the repo root | A | Free | gemini-cli has 107k stars | None | [V] | geminicli.com/docs/extensions/releasing/ |
| Goose extensions | goose-docs.ai/extensions | PR to `documentation/static/servers.json` in aaif-goose/goose | A+B | Free | Goose has 55k stars | None | [K] | aaif-goose/goose servers.json |
| Zed extensions | github.com/zed-industries/extensions | PR with a Rust/WASM wrapper | A+B | Free | 1,917 stars | Zed plans to **deprecate MCP extensions** in favour of the registry | [V] | zed.dev/docs/extensions/mcp-extensions |
| Windsurf / Devin | docs.devin.ai | No marketplace; Devin Local reads registries that use the official schema | B (indirect) | — | — | — | [V] no channel | docs.devin.ai/desktop/cascade/mcp |
| Continue Hub | hub.continue.dev | Create an `mcpServers` block on the hub | B | Free | continue has 36k stars | None | [K] (docs 404, hub may be scaled back) | docs.continue.dev |
| Apify Store | apify.com/mcp/developers | Rebuild as an Apify Actor in Standby mode | C-like (hosted on Apify) | Free; developer keeps 80% of revenue | Claims 36k monthly developers | None | [K] | apify.com/mcp/developers |
| Raycast | manual.raycast.com/ai/model-context-protocol | No MCP store: users add servers with the "Install MCP Server" command, pasted JSON, or a deeplink `raycast://mcp/install?<config>`. Put a deeplink button in the README. A full Raycast Store extension means a PR to raycast/extensions | B (npx command) | Free | Raycast users | None | [K] (manual page 404 for WebFetch; search confirms) | manual.raycast.com/ai/model-context-protocol |
| MCP Server Finder | mcpserverfinder.com | Email info@mcpserverfinder.com | A | Free | 1,934 servers | None | [V] | mcpserverfinder.com |
| Composio | composio.dev/toolkits | No public route; it builds its own toolkits | — | — | 30k stars | — | [K] not open | composio.dev |
| OpenTools | opentools.com | "Talk to the team" | E | — | — | — | [V] no self-serve form | opentools.com |
| mcp.run | mcp.run | Redirects to turbomcp.ai | — | — | — | — | [V] **dead (pivoted)** | — |
| modelcontextprotocol/servers README | github.com/modelcontextprotocol/servers | Closed to community entries; points to the registry | — | — | 91k stars | — | [V] **closed** | repo README |

### MCP awesome lists

| Name | How to submit | Gate | Stars | Notes | Status |
|---|---|---|---|---|---|
| punkpeye/awesome-mcp-servers | PR, one line, alphabetical, in "Finance & Fintech" | A | **95,865** | Many x402 servers already listed; entries carry Glama badges, so get indexed on Glama first | [V] CONTRIBUTING.md |
| punkpeye/awesome-remote-mcp-servers | PR | C | 825 | Remote servers only | [K] |
| wong2/awesome-mcp-servers | Through the mcpservers.org form only | A | 4,348 | — | [V] |
| appcypher/awesome-mcp-servers | — | — | 5,788 | **Archived** | [V] dead |
| TensorBlock/awesome-mcp-servers | PR | A | 881 | Active today | [K] |
| MobinX/awesome-mcp-list | PR | A | 886 | Active | [K] |
| moov-io/awesome-fintech | PR | A | 386 | Fintech angle | [K] |

## 2. Claude-specific

| Name | URL | How to submit | Gate | Cost | Reach | Financial restrictions | Status | Source |
|---|---|---|---|---|---|---|---|---|
| Claude Connectors Directory | claude.ai/directory/manage → "MCP connector" | Developer portal | C + E | Needs a paid Claude plan | All Claude apps | **§4.A ban** unless Anthropic agrees in writing. Also needs a test account, `readOnlyHint`/`destructiveHint` on every tool, and a privacy policy ("missing… result in immediate rejection") | [V] | claude.com/docs/connectors/building/submission ; support.claude.com/en/articles/13145358 |
| Anthropic plugin directory (anthropics/claude-plugins-official) | claude.ai/directory/manage → "Plugin bundle" | Portal from a GitHub repo (repo can be private during review, must be public to go live); automated scan, then human review; no PRs. The old clau.de form is retired | A + E | Paid Claude plan | repo has 37,456 stars; 341 plugins | **Same §4.A ban.** Realistic only as a read-only build, or with written permission | [V] | claude.com/docs/plugins/submit |
| Claude Desktop extensions (.mcpb) directory | — | Listings deprecated | — | — | — | — | [V] **dead** | claude.com/docs/directory/publish |
| Your own marketplace (repo marketplace.json) | `/plugin marketplace add owner/repo` | Self-hosted; no review | A | Free | Only people who add it | None | [K] (ready in the repo) | code.claude.com/docs/en/plugins |
| skills.sh (Vercel, `npx skills add`) | skills.sh | Indexed automatically from install telemetry | A | Free | vercel-labs/skills has 33k stars; top skill has 3.7M installs | None found | [V] (method inferred) | skills.sh/docs |
| claudemarketplaces.com | claudemarketplaces.com | Crawls GitHub marketplace.json files | A | Free (ads paid) | Claims 380k monthly visitors | Spam checks | [V] (method inferred) | claudemarketplaces.com |
| claude-plugins.dev | claude-plugins.dev | Community index plus install CLI | A | Free | Top plugins 100k+ downloads | None | [V] (method unclear) | claude-plugins.dev |
| aitmpl.com / davila7/claude-code-templates | aitmpl.com | PR | A | Free | 32,418 stars | None | [V] | api.github.com/repos/davila7/claude-code-templates |
| hesreallyhim/awesome-claude-code | github.com/hesreallyhim/awesome-claude-code | **Web issue form only, filed by a human**; no PRs or agents | A + 14 days of commits, or 100+ stars | Free | **55,148** | Blocks resources "requiring signup or payment"; frame it as free self-hosted | [V] | CONTRIBUTING.md |
| ComposioHQ/awesome-claude-skills | github.com/ComposioHQ/awesome-claude-skills | PR | A | Free | **76,586** | None | [V] | api.github.com |
| composio-community/awesome-claude-plugins | — | PR | A | Free | 1,934 | — | [K] | api.github.com |
| quemsah/awesome-claude-plugins | — | PR or auto-index | A | Free | 1,407 | — | [K] | api.github.com |
| davepoon/buildwithclaude | — | PR (assumed) | A | Free | 3,597 | — | [K] | api.github.com |
| anthropics/skills | github.com/anthropics/skills | Unclear: no CONTRIBUTING, examples only | — | — | 179,862 | Docs say to bundle skills in a plugin | [V] unclear | repo |

## 3. Other agent hosts and stores

| Name | URL | How to submit | Gate | Cost | Financial restrictions (quoted where fetched) | Status | Source |
|---|---|---|---|---|---|---|---|
| ChatGPT apps/plugins directory | platform.openai.com/plugins | Dashboard: ZIP upload, domain verification (`/.well-known/openai-apps-challenge`), demo video, test account, 5 positive and 3 negative test cases | C + E (identity verification) | No fee | **Banned:** "Execution of money transfers, crypto transfers…", selling "tokens, or credits"; "commerce only for physical goods". **Not viable** for the wallet | [V] (via proxy) | developers.openai.com/apps-sdk/app-submission-guidelines |
| OpenAI AgentKit Connector Registry | admin console | Not a public store; each org's admin enables connectors | C | — | n/a | [K] | — |
| Microsoft 365 Agent Store / Copilot | Partner Center | App package built with Agents Toolkit | C + E (business verification) | Free | §1140.3.1: "Financial transaction details must not be transmitted to users through a bot/chat interface… only… through a user interface linked to a secure purchase API" | [V] policy | learn.microsoft.com/en-us/legal/marketplace/certification-policies |
| Google Cloud Marketplace AI agents → Gemini Enterprise | docs.cloud.google.com/marketplace/docs/partners/ai-agents | Vendor signup + project info form; A2A agent card; Google sign-in; billing integration | C + E | Free or paid | None found; default model must be Google or from Model Garden | [V] | same |
| AWS Marketplace "AI agents and tools" | aws.amazon.com/marketplace/management | Partner Central; as an API or an AgentCore container | Free listing: an AWS account + support process. Paid listing: E (entity, tax, bank, KYC). Container route: D | Free listing allowed | No financial clause found | [V] | docs.aws.amazon.com/marketplace/latest/userguide/ai-agents-tools.html |
| Salesforce AgentExchange | Partner Console | ISV program + security review (Checkmarx) | E | Fees (amount unknown) | Not obtained | [K] (403) | developer.salesforce.com security review |
| Hugging Face Spaces (MCP) | huggingface.co/spaces?filter=mcp-server | Automatic for Gradio Spaces running as MCP servers | A (+ hosted Space) | Free tier | None | [V] | huggingface.co/docs/hub/en/hf-mcp-server |
| LangChain integrations | docs.langchain.com | Publish a `langchain-<name>` package, then a docs PR | A + PyPI | Free | None | [V]; **langchain-mcp-adapters archived 2026-09-16** | api.github.com |
| CrewAI | docs.crewai.com/en/mcp/overview | No submission; users point CrewAI at an MCP server | B | Free | None | [V] | same |
| n8n verified community nodes | n8n Creator Portal | npm `n8n-nodes-*` with provenance, then review | B | Free | May reject nodes that "compete with any of n8n's paid features" | [V] | docs.n8n.io community-nodes |
| Zapier App Directory | developer.zapier.com | Form, about 1 week of review | E (you must own the API) | Free | **Banned:** "must not facilitate any form of financial transaction, transfer of assets, or payment processing" | [V] | docs.zapier.com/platform/publish/integration-publishing-requirements |
| Make (public custom app) | developers.make.com | App review by Make's QA team | E-ish | Free | None found | [K] | — |

## 4. Agentic commerce and crypto

| Name | URL | How to submit | Gate | Cost | Reach | Notes | Status | Source |
|---|---|---|---|---|---|---|---|---|
| x402 ecosystem page (x402 Foundation / Linux Foundation) | x402.org/ecosystem | **Page returns 404**; CONTRIBUTING has no listing route; ask in slack.x402.org | A | Free | x402-foundation/x402 has 6,683 stars (canonical repo since 2026-04; coinbase/x402 is a fork) | — | [V] **404 (dead?)** | raw.githubusercontent.com/x402-foundation/x402/main/CONTRIBUTING.md |
| x402 Bazaar (CDP facilitator) | docs.cdp.coinbase.com/x402/bazaar | **Automatic** after "a successful paid call through the CDP Facilitator"; no form | Live paid x402 endpoint (mainnet) | Free | Coinbase agent discovery | Lists **sellers only**. Needs AgentPay's seller or A2A-quote side exposed | [V] | docs.cdp.coinbase.com/x402/validate-endpoint |
| x402scan (Merit-Systems) | x402scan.com/resources/register | Form with a URL; added automatically if it returns a valid x402 schema | Live endpoint | Free | 393 stars | Sellers only | [V] | Merit-Systems/x402scan README |
| awesome-x402 (xpaysh) | github.com/xpaysh/awesome-x402 | PR using the template; merged in 24-48h | A | Free | 290 | Has an AI agent / MCP section | [V] | CONTRIBUTING.md |
| awesome-agentic-commerce (xpaysh) | github.com/xpaysh/awesome-agentic-commerce | PR | A | Free | 82 | — | [K] | api.github.com |
| awesome-agent-native-services | github.com/haoruilee/awesome-agent-native-services | PR | A | Free | 476 | — | [K] | api.github.com |
| awesome-a2a (ai-boost) | github.com/ai-boost/awesome-a2a | PR | A | Free | 694 | No payments category yet | [V] | api.github.com |
| A2A Registry | a2aregistry.org/submit | Form with the Agent Card URL | Hosted A2A agent (`/.well-known/agent-card.json`) | Free | 387 agents | Reachability is checked regularly | [V] | a2aregistry.org/submit |
| AP2 samples | github.com/google-agentic-commerce/AP2 | PR + Google CLA; samples and SDK only (spec moved to FIDO) | A | Free | 3,207 | A sample: "AP2 mandate from a passkey approval" | [V] | AP2 CONTRIBUTING.md |
| MPP services directory (Stripe + Tempo) | mpp.dev/services | PR to tempoxyz/mpp using the template, or MPPScan | Live MPP-paid service | Free | 100+ providers | Curated; declines duplicates | [V] | mpp.dev/services |
| Base ecosystem page | base.org/ecosystem | The old ecosystem.json PR route is dead (base/web **archived 2026-03-17**); the new route appears to be Base Dashboard (base.dev) | A + onchain on Base | Free | — | — | [V] page; [K] route | api.github.com/repos/base/web |
| Base Builder Rewards / Base Batches | talent.app ; batches.base.org | Form / accelerator application | A + onchain activity | Free | Grants | — | [K] | docs.talent.app |
| Circle ecosystem (circlefin/centre-ecosystem) | github.com/circlefin/centre-ecosystem | PR (name, company, category, logo) | A (+ company field) | Free | 42 stars | Catalog page returns 404 | [K] dead? | api.github.com |
| Skyfire Directory | docs.skyfire.xyz/docs/service-discovery | Seller onboarding + KYA token support | C + Skyfire account | Fees on payments | — | Verified sellers only | [K] (fetch failed) | same |
| CDP Discord (x402 community) | discord.com/invite/cdp | Post | none | Free | Coinbase devs + the x402 team | Explicitly invites "share what you're building" | [V] | docs.cdp.coinbase.com/x402/support/community |

## 5. Payments (Stripe)

| Name | URL | How to submit | Gate | Cost | Restrictions (quoted) | Status | Source |
|---|---|---|---|---|---|---|---|
| Stripe App Marketplace | marketplace.stripe.com | CLI `stripe apps set distribution public` → `upload` → listing form → review (about 4 business days) | E + C (activated account, one app per account, privacy policy, test credentials, OAuth install URL) | Free | "process payments through Stripe unless approved in writing otherwise"; not on Prohibited/Restricted Businesses; "Don't include any custom cryptographic functions"; name can't contain "Stripe"/"app"/"free". **Poor fit** | [V] | docs.stripe.com/stripe-apps/publish-app ; /review-requirements |
| Stripe Partner Ecosystem | stripe.com/partners/become-a-partner | Form → vetting → agreement. The Apps track needs a passed Stripe Apps review; the Technology track is invitation only | E | Free | Bar raised April 2026; Premier needs 2,000 installs. The SaaS Platforms track (Connect) may fit better (not fetched) | [V] | docs.stripe.com/partners |

## 6. Self-hosting (lead with the subscription tracker)

Wallos (8,634 stars, the self-hosted subscription tracker) is the model. It is listed on:
- awesome-selfhosted ("Money, Budgeting & Management")
- Unraid CA
- CasaOS
- Umbrel
- YunoHost
- Docker Hub
- Railway templates

| Name | URL | How to submit | Gate | Cost | Reach | Restrictions | Status | Source |
|---|---|---|---|---|---|---|---|---|
| awesome-selfhosted | github.com/awesome-selfhosted/awesome-selfhosted-data | PR adding a YAML file under `software/` | A | Free | **324,289** | *"first released more than 4 months ago"*; FOSS, maintained; category "Money, Budgeting & Management" | [V] | CONTRIBUTING.md |
| selfh.st directory + Self-Host Weekly | selfh.st/submit | Form (apps and newsletter tips) | A | Free | Leading self-host newsletter | None published | [V] | selfh.st/submit |
| r/selfhosted | reddit.com/r/selfhosted | Weekly "New Project Megathread" while under 3 months old | A (+D) | Free | Very large | Needs an "AI Involvement" disclosure; under 3 months: megathread only | [V-mirror] | megathread 2026-05-28 |
| Unraid Community Applications | ca.unraid.net/submit | Form + your own template repo (XML templates + `ca_profile.xml`) | A, D | Free | Most Unraid users | Open source; 2FA on GitHub/Docker Hub; no affiliate links; support thread recommended, not required | [V] | forums.unraid.net/topic/87144 |
| Umbrel App Store | github.com/getumbrel/umbrel-apps | PR (`docker-compose.yml` + `umbrel-app.yml`) | A, D | Free | 783 stars; large user base | **Multi-arch (amd64+arm64), pinned by digest**; usable from the browser after install | [V] | umbrel-apps .agents/skills SKILL.md |
| CasaOS / ZimaOS AppStore | github.com/IceWhaleTech/CasaOS-AppStore | PR with a compose folder | A, D | Free | 360 | — | [V] | CONTRIBUTING.md |
| TrueNAS Apps (community train) | github.com/truenas/apps | PR to the `community` train | A, D | Free | 402 | Prefers ghcr; rejection "at its sole discretion" | [V] | CONTRIBUTIONS.md |
| Dokploy templates | github.com/Dokploy/templates | PR (`blueprints/<id>/`) | A, D | Free | 226 | `expose`, not `ports`; no container_name | [V] | README |
| CapRover one-click apps | github.com/caprover/one-click-apps | PR (`captainVersion: 4`) | A, D | Free | 637 | Only a subset of compose keys | [V] | README |
| Coolify one-click services | coolify.io/docs/get-started/contribute/service | PR to `next` + docs PR | A, D | Free | 62k (coolify) | **Upstream needs 1,000+ stars**; pinned version | [V] | same |
| Cosmos Cloud market | github.com/azukaar/cosmos-servapps-official | PR | A, D | Free | 63 | CI checks architecture | [V] | README |
| YunoHost | github.com/YunoHost/apps | PR to `apps.toml` + a `<app>_ynh` package (native packaging), or `wishlist.toml` | A | Free | 262 | Free-software upstream only; warns against AI-made packages | [V] | README |
| Cloudron | docs.cloudron.io/packaging/publishing | Self-published `CloudronVersions.json` + forum "Community Apps" post | A, D | Free | Paid self-hosters | The official store is curated | [V] | same |
| Start9 / StartOS | docs.start9.com | Email submissions@start9.com → Start9-Community fork | A | Free | 1,987 | Security, backup and health-check review | [V] | docs.start9.com/0.3.5.x/…/submission |
| Proxmox VE Helper-Scripts | github.com/community-scripts/ProxmoxVE | Request in Discussions; new scripts go through the DevScripts repo first | A | Free | 29,740 | — | [V] | CONTRIBUTING.md |
| GHCR / Docker Hub (+ Docker-Sponsored OSS) | ghcr.io ; docs.docker.com/…/dsos-program | Push (GHCR); DSOS application | A, D | Free | — | DSOS: "no pathway to commercialization", which a paid hosted tier would break | [V] | dsos-program |
| Railway templates | railway.com/deploy | Publish from your account | A | Free | Marketplace (Wallos is there) | "Earn commission… up to 25%" | [V] | docs.railway.com/reference/templates |
| PikaPods | feedback.pikapods.com | Request; they package it | A, D | Free; 10-15% revenue share by agreement [K] | Managed hosting | — | [V]/[K] | pikapods.com/apps |
| Elestio | elest.io | Curated / contact | A, D | 10% revenue share (their blog) | 150+ apps | — | [K] dead? (pages 404) | blog.elest.io/why-open-source |
| DigitalOcean 1-Click | marketplace.digitalocean.com/vendors | Vendor application + Packer image | A, E | Free | Large | Company-oriented review | [V] | same |
| Render | render.com/docs/deploy-to-render | `render.yaml` + a button in the README | A | Free | No gallery | — | [V] | same |
| Fly.io | fly.io | `fly launch` docs only | A | Free | No marketplace | — | [K] | — |
| Runtipi | github.com/runtipi/runtipi-appstore | — | — | — | 498 | *"no new applications will be accepted"* | [V] **closed** | README |
| Portainer templates / LinuxServer.io | — | No third-party route | — | — | — | — | [V]/[K] not open | — |
| Homebrew / Sandstorm | — | Poor fit; skip | — | — | — | — | [V]/[K] | docs.brew.sh/Acceptable-Formulae |

## 7. Launch, listing and community sites

| Name | URL | How to submit | Gate | Cost | Reach | Restrictions | Status | Source |
|---|---|---|---|---|---|---|---|---|
| Show HN | news.ycombinator.com/showhn.html | Post | A + something people can try without signup | Free | Biggest one-day developer traffic | Must be tryable without barriers; "Don't post generated text or AI-edited text"; no vote asking; unpublished extra rules hit new accounts | [V] | newsguidelines.html |
| Product Hunt | producthunt.com/launch | Self-hunt | A + website | Free | Large | Personal accounts only; don't ask for upvotes | [V] | same |
| DevHunt | devhunt.org | Form | A + site | Free (paid boosts $9-49 [K]) | 481k visitors, 40.9k devs | Dev tools only | [V] | devhunt.org |
| Uneed | uneed.best | Form | A + site | Free (wait up to ~5 months) / $14.99 / $29.99 | 125k monthly visitors | 10 upvotes to stay listed | [V] | uneed.best/pricing |
| BetaList | betalist.com/submit | Form | A + own domain | **Paid only** (refund if rejected) | 60-70k newsletter | Startups only | [V] | betalist.com/faq |
| Peerlist Launchpad | peerlist.io/launchpad | Form (needs a profile) | A + demo | Free | Weekly | No DMs asking for upvotes | [K] (403) | help.peerlist.io |
| OpenAlternative | openalternative.co/submit | Form | A | Free (weeks), paid 24h option | 100k monthly visitors | Open source only | [V]/[K] | openalternative.co/advertise |
| opensourcealternative.to | opensourcealternative.to | Form | A | Free | Claims 2M users | Position against a named proprietary product | [V] | site |
| LibHunt | libhunt.com/repo/submit | Form + automatic from HN and dev.to mentions | A | Free | 559k projects | — | [V] | site |
| SaaSHub | saashub.com/submit | Form | A + site | Free (paid featured) | — | — | [K] (403) | — |
| AlternativeTo | alternativeto.net | "Add app" (account) | A + site | Free | Large | Moderated | [K] | — |
| There's An AI For That | theresanaiforthat.com/launch | Form | A + site | $49 / $437 | 5M monthly visitors | — | [V] | same |
| Toolify | toolify.ai/submit | Form | A + site | $99 | — | — | [K] | — |
| Futurepedia | futurepedia.io/submit-tool | Form | A + site | $247 (sold out) / $497 | — | — | [K] | — |
| AI Agents List | aiagentslist.com/submit | Form | A + site | $29 / $49 | 25k monthly visitors | — | [V] | same |
| AI Agents Directory | aiagentsdirectory.com/submit-agent | Form | A + site | Free and paid tiers | Daily newsletter | — | [V] | same |
| Tiny Startups | tinystartups.com | Form | A + site | Free launch | 25k newsletter | Hand-picked | [V] | site |
| Microlaunch | microlaunch.net | Form | A + site | Free / premium | About 1.9k daily visitors | — | [V] | site |
| Fazier | fazier.com | Form | A + site | Free + add-ons | — | — | [V] partial | site |
| Launching Next / agent.ai / Indie Hackers / Hashnode | — | Form / post | A | Free (Launching Next has a paid expedite) | — | — | [K] | — |
| Console.dev newsletter | console.dev/selection-criteria | Editorial contact | A + self-serve try | Free | 30k+ | For developers, tryable without sales, good docs, no privacy concerns | [V]/[K] | same |
| Changelog News | changelog.com/news/submit | Form | A | Free | Changelog audience | No commercial products; pitch the open-source project | [V] | same |
| TLDR newsletters | tldr.tech | Editorial; ads only | A | Ads paid | 8M+ total | No public submission | [V] | tldr.tech |
| PulseMCP "Agentic Loop" newsletter | pulsemcp.com | Through the directory | B | Free | Bi-weekly | Submissions paused | [V] | — |
| Podcasts (e.g. Techstrong Gang, which covered x402 micropayments on 2026-04-03; Agentic Edge, which covered MCP and A2A) | techstrong.tv ; podcastaddict.com/agentic-edge | Pitch the host by email or contact form; there is no public queue | A + a demo | Free | Niche | None | [K] | techstrong.tv/?p=24712 |
| Lobsters | lobste.rs | Post (invite only) | A + invite | Free | Small, high signal | New users can't submit new domains for 70 days; self-promotion under 25%; use the `show` tag | [V] | lobste.rs/about |
| dev.to | dev.to | Article | A | Free | Large | AI-assisted posts must be disclosed; AI-generated posts must not promote your own business | [K] | dev.to AI guidelines |
| MCP Contributor Discord | modelcontextprotocol.io/community/communication | Discussion only | — | Free | MCP maintainers | **No product marketing** ("vendor-neutral"); bring payment or auth spec topics | [V] | same |
| CDP Discord (x402) | discord.com/invite/cdp | Post | — | Free | x402 team | "Share what you're building" | [V] | — |
| Claude Developers / Base Discords | — | Post | — | Free | — | Showcase rules unconfirmed | [K] | — |
| r/ClaudeAI | reddit.com/r/ClaudeAI | "Built with Claude" flair, or the showcase megathread | A | Free | 1.2M | Rule 7: what, how, screenshots, at least one prompt; 50+ karma for a feed post | [V-mirror] | — |
| r/mcp | reddit.com/r/mcp | Showcase flair | A/B | Free | 123k | Disclose that you're the author | [V-mirror] | — |
| r/LocalLLaMA | reddit.com/r/LocalLLaMA | "I Built A Thing" flair | A | Free | 842k | Self-promotion at most 10%; must fit local models | [V-mirror] | — |
| r/opensource | reddit.com/r/opensource | "Promotional" flair | A (OSI license) | Free | 387k | About 10% self-promotion | [V-mirror] | — |
| r/SideProject | reddit.com/r/SideProject | Post titled "[Name] - [desc]" | A | Free | 862k | — | [V-mirror] | — |
| r/AI_Agents | reddit.com/r/AI_Agents | Post / megathread | A | Free | 456k | Promotion likely limited to a megathread | [V-mirror]/[K] | — |
| r/ChatGPTCoding | reddit.com/r/ChatGPTCoding | Self-promotion thread | A | Free | — | — | [K] | — |
| r/cursor, r/aiagents | — | Post | A | Free | — | Rules not captured | [K] | — |
| r/fintech | reddit.com/r/fintech | Weekly self-promotion thread | A | Free | 96.8k | No press releases | [V-mirror] | — |
| r/personalfinance | — | **Don't post** | — | — | — | Bans self-promotion | [V-mirror] | — |
| GitHub Trending / Topics | github.com/trending | Automatic | A | Free | Large | Set topics: mcp, mcp-server, x402, ai-agents, self-hosted, subscription-tracker, gemini-cli-extension | [K] | — |
| X / Bluesky / LinkedIn | — | Post | A | Free | — | Tag @x402, @base, @AnthropicAI, MCP people | [K] | — |

---

## Recommended order (top 15, by gate unlocked, then impact per effort)

0. **Rename first.** Check npm and the USPTO, and check for conflict with `worldliberty/agentpay-sdk`. Then set the `io.github.<user>/<name>` registry namespace, the npm scope and the repo name before anything is published. Every listing below keys on these.
1. **Make the repo public, add topics and tag v0.1.0 the same day (gate A).** This starts the clocks: awesome-selfhosted (4 months), r/selfhosted (3 months), awesome-claude-code (14 days). Add `gemini-extension.json` and the `gemini-cli-extension` topic so the Gemini CLI gallery crawls it automatically, at near-zero effort.
2. **Publish to npm, then the MCP Registry with `mcp-publisher` (gate B).** One action reaches GitHub's MCP Registry, VS Code @mcp, Copilot in JetBrains, Eclipse and Xcode, and later PulseMCP. Highest reach per minute.
3. **Glama:** add the server and commit `glama.json`. Then the **punkpeye/awesome-mcp-servers** PR (96k stars, "Finance & Fintech" category, carries a Glama badge).
4. **Show HN** with a one-command Docker demo using test keys, no signup needed. Write the text yourself (HN bans AI-written or AI-edited posts), and post from an established account.
5. **Publish a multi-arch (amd64+arm64) image to GHCR (gate D).** This unblocks Umbrel, CasaOS, TrueNAS, Dokploy, CapRover, Cosmos, Unraid and the Docker MCP Catalog (MIT MCP package only, because of the AGPL rule).
6. **Payments awesome lists**, PRs merged in 1-2 days: awesome-x402, awesome-agent-native-services, awesome-agentic-commerce, awesome-a2a. Then post in the **CDP Discord**.
7. **Claude community channels:**
   - Get the repo marketplace.json indexed by claudemarketplaces.com and claude-plugins.dev.
   - Make the skill installable with `npx skills add` (skills.sh).
   - PRs to aitmpl (davila7) and ComposioHQ/awesome-claude-skills (77k stars).
   - After 14 days, a human files the hesreallyhim/awesome-claude-code issue (55k stars).
8. **Cursor:** the Cursor Marketplace (open-source plugin, manual review) and cursor.directory. Plus the **Cline** marketplace issue (needs `llms-install.md` and a logo).
9. **Paid fast lanes or free queues:** mcpservers.org (free, or $39 for 24h; also covers wong2's list) and MCP Market (free, or $29). mcp.so issue and LobeHub. Free lanes are fine if you're patient.
10. **Self-hosted, leading with the subscription tracker:** Umbrel, CasaOS and Unraid CA (Wallos is on all three).
11. **selfh.st** submit form, plus the **r/selfhosted** New Project Megathread with an honest AI-involvement line.
12. **Reddit in order:** r/ClaudeAI (Rule 7 format), r/mcp, r/SideProject, r/opensource ("Promotional" flair). Build some non-promotional karma first.
13. **Product Hunt + DevHunt + OpenAlternative**, once the site and demo video exist. All free.
14. **x402 discovery** (x402scan register, Bazaar auto-index, MPP directory) once the seller/A2A-quote endpoint runs on mainnet. Ask in slack.x402.org how to get onto the (currently 404) x402.org ecosystem page.
15. **Anthropic plugin directory:** email directory@anthropic.com asking for written permission under §4.A, or submit a read-only "subscription tracker + audit" plugin build. The fuller listing comes later with the hosted OAuth server (C). Treat ChatGPT, Zapier and Stripe Apps as not viable for the wallet.

**Later, triggered by time or stars:**
- awesome-selfhosted, after 4 months from the first release.
- Coolify, after 1,000 stars.
- Console.dev and Changelog News, once docs and the try-without-signup demo are polished.
- AWS Marketplace free container listing and Google Gemini Enterprise, only if B2B demand appears.

**Skip or dead:**
- appcypher list (archived)
- modelcontextprotocol/servers community list (closed)
- mcp.run (pivoted)
- Runtipi (closed)
- Claude Desktop extension directory (deprecated)
- base/web ecosystem PRs (archived)
- r/personalfinance (bans self-promotion)
- MCP Contributor Discord, for promotion (it bans marketing)
- Homebrew
