# Licensing

AgentPay uses two licenses, so that anyone can build on the agent side freely while the server stays open.

| Part | License | Why |
|---|---|---|
| `packages/mcp` (the MCP server agents run) | [MIT](LICENSE-MIT) | Use it, embed it, ship it in any agent or product |
| `packages/verify` (signature verification for providers) | [MIT](LICENSE-MIT) | Drop it into any tool or agent that sells through AgentPay |
| `src/policy.ts` (restricted-category rules) | [MIT](LICENSE-MIT) | Reuse the refusal list anywhere |
| `plugins/agentpay` (Claude Code plugin and skill) | [MIT](LICENSE-MIT) | Same as the MCP server |
| Everything else: the server, ledger, approvals, controls, dashboard, migrations | [AGPL-3.0-only](LICENSE) | Self-host and modify freely. If you run a modified version as a service for others, you must share your changes with them |

Files under MIT carry an `SPDX-License-Identifier: MIT` header, or sit in a directory with its own `LICENSE`. Everything without one is AGPL-3.0-only.

## Contributions

By contributing, you agree that your contribution is licensed under the license of the files you change (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Name

"AgentPay" names this project. Forks are welcome under the licenses above. Please give a modified hosted service a different name, so people can tell it apart from the official project.
