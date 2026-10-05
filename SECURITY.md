# Security

AgentPay moves money and gives AI agents limited authority to spend it, so security reports get priority.

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting).

Please include:
- what an attacker can do (for example, spend beyond a cap, approve without a passkey, read another owner's data, bypass the restricted-category rules or the kill switch)
- steps to reproduce against a local install
- the commit you tested

You'll get an acknowledgement within 3 business days. We'll agree on a disclosure date once it's fixed.

## Scope

In scope:
- the server (`src/`)
- the dashboard (`public/`)
- the migrations
- the MCP server (`packages/mcp`)
- the Claude Code plugin (`plugins/agentpay`)

Especially:
- **the ledger:** balances, holds, envelopes, the vault
- **approvals:** passkey challenge binding, final-confirmation terms
- **agent levels and rules, cooling-off and the drain guard**
- **the kill switch**
- **the hash-chained audit log**
- **authentication:** owner tokens, agent keys
- **SSRF through provider endpoints**

Out of scope:
- what an agent does inside a website the owner allowed (see the risk statement in `src/permissions.ts`)
- missing hardening already listed under "Not production-ready yet" in the README

## Running it safely

Read "Not production-ready yet" in the README before handling real money:
- **Owner sign-in:** owner tokens are bearer tokens.
- **Provider secrets:** they're stored in plain text.
- **Provider endpoints:** they aren't sandboxed.
- **HTTPS:** run the server behind HTTPS.
- **Stripe test mode:** use test-mode keys until you've done a legal review (see [docs/us-market.md](docs/us-market.md)).
