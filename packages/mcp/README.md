# AgentPay MCP server

Let Claude Code, Claude Desktop, Cursor or any MCP client pay for paid tools and subscriptions from a prepaid wallet that **you** control.

What you control:
- **Levels**: ask every time, pay only what your rules allow, or pay within limits
- **Envelopes**: money set aside for one agent
- **Passkey approvals** on your own device
- **A kill switch**
- **A tamper-evident log** of what the agent did and why

This package is the agent side. It needs an [AgentPay server](https://github.com/winsley-jeune/agent-pay), which you can self-host. The server holds the wallet and enforces your limits; this MCP server holds only an agent key.

## Install

Create an agent key on your AgentPay dashboard (Agents tab), then:

**Claude Code**

```sh
claude mcp add agentpay --scope user \
  -e AGENTPAY_URL=http://localhost:8787 -e AGENTPAY_AGENT_KEY=ap_agent_... \
  -- npx -y @winsley-jeune/agentpay-mcp
```

Or install the plugin, which also teaches Claude the spending rules:

```sh
claude plugin marketplace add winsley-jeune/agent-pay
claude plugin install agentpay@agentpay
```

**Claude Desktop, Cursor and other clients** (`mcpServers` config):

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["-y", "@winsley-jeune/agentpay-mcp"],
      "env": { "AGENTPAY_URL": "http://localhost:8787", "AGENTPAY_AGENT_KEY": "ap_agent_..." }
    }
  }
}
```

| Variable | Required | |
|---|---|---|
| `AGENTPAY_URL` | yes | Your AgentPay server |
| `AGENTPAY_AGENT_KEY` | yes | `ap_agent_...` from the dashboard. Treat it like a password |

## What the agent can do

41 tools, including:
- `get_balance`: level, rules, envelopes, frozen or not
- `get_quote` and `call_paid_tool`: with a reason and the owner's instruction, kept in the log
- `check_approval`
- `request_envelope`
- `check_purchase_policy`: refuses adult content, medicine and pharmacies, weapons, drugs, alcohol, tobacco and gambling
- everyday subscriptions: `list_all_subscriptions`, `request_cancel`, `savings_ideas`
- price watch with signed buy mandates
- grocery lists filled in the owner's own browser with approval before checkout
- browser permissions
- `report_mistake`

The full list is in the [main README](https://github.com/winsley-jeune/agent-pay#mcp-tools).

## License

MIT. The AgentPay server is AGPL-3.0; see [LICENSING.md](https://github.com/winsley-jeune/agent-pay/blob/master/LICENSING.md).
