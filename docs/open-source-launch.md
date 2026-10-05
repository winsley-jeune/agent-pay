# Open-source launch checklist

The repository is **private** and stays private until you decide to flip it. Everything below is prepared in the repo. The steps that publish something are listed for you to run yourself, in order.

## Already prepared

**Licensing**
- AGPL-3.0 for the server and dashboard (`LICENSE`).
- MIT for the MCP server, the plugin and `src/policy.ts` (`LICENSE-MIT`, `packages/mcp/LICENSE`, `plugins/agentpay/LICENSE`).
- `LICENSING.md` explains the split.

**Community files**
- `README.md`: developer pitch, badges, quick start, plugin install.
- `CONTRIBUTING.md`, including the rules for changes that touch money.
- `SECURITY.md`: private vulnerability reporting.
- `CODE_OF_CONDUCT.md`.
- Issue and pull-request templates.

**CI and dependencies**
- `.github/workflows/ci.yml`: typecheck, MCP build and the full test suite against Postgres 17.
- `.github/dependabot.yml`.

**MCP server package** (`packages/mcp`)
- Publishable as `@winsley-jeune/agentpay-mcp`, with a `bin` so `npx -y @winsley-jeune/agentpay-mcp` works.
- Built and smoke-tested: it starts and lists 41 tools.

**MCP Registry listing**
- `packages/mcp/server.json`, validated against the official schema (2025-12-11).
- Name `io.github.winsley-jeune/agentpay`, matching `mcpName` in the package.

**Claude Code plugin and marketplace**
- `.claude-plugin/marketplace.json` and `plugins/agentpay`: MCP server with a prompted server URL and a secret agent key, plus an `agent-spending` skill.
- Both pass `claude plugin validate`.

**Docs:** `docs/self-hosting.md`, plus the research in `docs/asia.md`, `docs/us-market.md` and `docs/distribution.md`.

**Secrets:** a scan of the whole git history found none. `.env` and `.demo-credentials.json` were never committed.

## Decide before going public

1. **Commit author email.** Every commit so far has your work email (`wjeune@suncorstainless.com`) as the author. Publishing makes it public. Two options:
   - keep it
   - before the first push to a public repo, rewrite authorship to your GitHub noreply address (`git filter-repo --mailmap`). This rewrites history, so do it while you're the only person with a clone.

   Set `git config user.email <id>+winsley-jeune@users.noreply.github.com` for future commits either way.
2. **Name.** `agentpay` and `agentpay-mcp` are already taken on npm by others, and other companies use "AgentPay". Search the USPTO trademark database before investing in the brand. A distinct name is cheaper now than later.
3. **npm scope.** The package is `@winsley-jeune/agentpay-mcp`. Make sure that npm scope is yours, or create an organisation and rename it in `packages/mcp/package.json`, `server.json`, the plugin, the README and `packages/mcp/README.md`.
4. **Copyright holder.** The license files say "The AgentPay authors". Change it to your name or company if you prefer.
5. **Your employer.** If you built this on company time or equipment, check your employment agreement about who owns it before publishing.

## Launch steps, in order (you run these)

1. **Make the repo public:** GitHub → Settings → Danger zone → Change visibility. Then:
   - enable **private vulnerability reporting**, Dependabot alerts and secret scanning
   - add a description and these topics: `mcp`, `mcp-server`, `ai-agents`, `agent-payments`, `agentic-commerce`, `claude-code`, `claude-code-plugin`, `spending-controls`, `passkeys`, `webauthn`, `fintech`, `typescript`
2. **Check CI passes** on GitHub Actions.
3. **Publish the MCP package:** `npm login`, then `npm publish -w packages/mcp`. The prepublish step builds it.
4. **List it in the MCP Registry:** install `mcp-publisher`, then `cd packages/mcp && mcp-publisher login github && mcp-publisher publish`.
5. **Test the plugin as a user:** `claude plugin marketplace add winsley-jeune/agent-pay` and `claude plugin install agentpay@agentpay`.
6. **Other directories**, once listed in the registry: Smithery, Glama, PulseMCP, mcp.so, and awesome-mcp-servers (open a pull request).
7. **Announce to developers.** A short post or demo video works best: an agent hits a paid tool, gets `pending_approval`, you approve with a passkey, and the why log shows it. Good places:
   - Show HN
   - r/ClaudeAI and r/mcp
   - the MCP Discord
   - X / Bluesky
8. **Later:** the Claude Connectors Directory and ChatGPT apps need a hosted HTTPS server with OAuth sign-in. That's step 1 in [distribution.md](distribution.md), and it's the hosted version covered in [us-market.md](us-market.md).

## Keep in mind

- Publishing the code doesn't make AgentPay a licensed service. The README says so. Keep that line visible.
- Forks can remove the refusal list in their own copies. The official build and name keep it.
