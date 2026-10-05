# Distribution: where AgentPay fits in today's AI infrastructure

Written 2026-10-05. Some facts below come from industry blogs rather than official documentation; verify specifics before relying on them (sources at the end).

## What already exists (as of late 2026)

Agent payments have become a stack of standards, each layer with a leading player:

| Layer | Who | What it overlaps with in AgentPay |
|---|---|---|
| **Approval / mandates** | Google's AP2, now handed to the FIDO Alliance | Passkey-signed approvals |
| **Checkout** | ACP from OpenAI and Stripe | Grocery checkout in the browser |
| **Per-call payment** | x402 from Coinbase, now at the Linux Foundation (Stripe, Visa, Mastercard, AWS, Google and others are members) | Paid tool calls |
| **Card credentials** | Visa Intelligent Commerce, Mastercard Agent Pay | The virtual-card design |
| **Discovery** | MCP: the official registry, the Claude Connectors Directory, ChatGPT's Apps SDK (all MCP-based) | How agents find AgentPay |

Mastercard's agentic tokens tie a card to one agent, certain merchants and spending rules, so the agent completes checkout without ever holding the card number. That's very close to AgentPay's rule that the agent never knows payment info, and it's run by the card network itself.

Unverified: a report that Anthropic released "Claude Commerce Agents" with Visa and Mastercard on 2026-09-02.

## Where AgentPay fits

Competing on payment rails against Visa, Stripe and Google is a losing position. What none of them gives the owner is **one place, under their control, for all their agents' spending**:

- It works across hosts: Claude, ChatGPT, Cursor or a custom agent.
- It works across payment methods: x402, cards, ACP or the marketplace.
- It covers everyday subscriptions too (Netflix, AT&T, the gym), which the payment networks don't touch.
- It adds the safety layer: prepaid, passkey approvals, per-site permissions, and the risk statement.

AgentPay connects to those systems instead of replacing them: the owner's control panel above whichever payment method a merchant accepts.

## Ways to get it out there, in order

1. **Make the MCP server remote, with OAuth sign-in.** Today it runs locally with an agent key. The Claude directory and ChatGPT both require a hosted HTTPS server with OAuth, a privacy policy, and a test account for reviewers. Everything else depends on this. It also means replacing owner tokens with real sign-in; passkey sign-in fits naturally.
2. **The cheap channels:**
   - list it in the official MCP Registry
   - package it as a Claude Code plugin, for developers
   - it then works in any MCP app (Cursor, VS Code, Gemini CLI)
3. **The big directories:** the Claude Connectors Directory (listings start as Community, then can become Verified) and the ChatGPT app catalogue. Expect extra scrutiny for anything that moves money; read each platform's rules on financial apps before submitting.
4. **Let the wallet pay x402 services.** When a tool answers "payment required", AgentPay pays it from the wallet, within the owner's limits. That opens thousands of existing paid tools without each joining the marketplace. Catch: x402 settles mostly in stablecoins, which brings back crypto and compliance questions.
5. **Let tool builders charge through AgentPay:** a wrapper that adds per-call billing to any existing MCP server. Builders bring their own users, so this channel grows through them.
6. **Make approvals compatible with AP2**, so an owner's approval is also proof a standards-compliant merchant accepts.

## One decision to revisit

The virtual-card design ([virtual-cards.md](design/virtual-cards.md)) uses Stripe Issuing, where AgentPay issues the cards. The card networks' agentic tokens are an alternative:

| | Stripe Issuing (current design) | Network agentic tokens |
|---|---|---|
| Whose card | An AgentPay prepaid card | The owner's own card |
| Agent sees the number | No | No |
| Prepaid | Yes | No |
| Who carries the compliance burden | AgentPay (issuing, holding customer money) | Mostly the network and the bank |

Tokens would mean much less regulation, but they break the "always prepaid" decision. A mix is possible: tokens for subscriptions, the prepaid wallet for agent tools and spending limits.

## Open question

**Who is the first customer: consumers, or developers building agents and paid tools?** That decides whether step 3 or step 5 comes first. Developers are faster to reach, and their tools pull in consumers later.

## Sources

- [Announcing Agent Payments Protocol (AP2) — Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [AP2 (Agent Payments Protocol) Explained — Eco](https://eco.com/support/en/articles/14845479-ap2-agent-payments-protocol-explained)
- [Google's AP2: A new chapter in agentic commerce — Everest Group](https://www.everestgrp.com/googles-agent-payments-protocol-ap2-a-new-chapter-in-agentic-commerce-blog/)
- [Agentic payments protocols compared (MPP, ACP, AP2, x402) — Crossmint](https://www.crossmint.com/learn/agentic-payments-protocols-compared)
- [Agentic Payments in 2026: The x402 Explainer — rzlt](https://www.rzlt.io/blog/agentic-payments-2026-x402-explainer)
- [The 2026 Guide to AI Agent Payments — OpenHermit](https://www.openhermit.com/blog/ai-agent-payments-guide)
- [AP2 vs ACP vs x402 (June 2026) — OpenHermit](https://www.openhermit.com/blog/ap2-acp-x402-comparison-2026)
- [Agentic Payments Protocols 2026 — AgentBets](https://agentbets.ai/guides/agentic-payments-protocols/)
- [Distribution: Claude Connectors Directory — GitHub issue](https://github.com/yschimke/compose-ag-plugin/issues/54)
- [Distribution pack: Claude Code plugin, Connectors Directory, MCP registry — GitHub issue](https://github.com/enrichmeai/cistern/issues/120)
- [Claude Connectors Tutorial (July 2026) — sunpeak](https://sunpeak.ai/blogs/claude-connectors-tutorial/)
- [ChatGPT MCP in 2026 — Peliqan](https://peliqan.io/blog/chatgpt-mcp/)
- [MCP in 2026: which AI agents support custom connectors — Truthifi](https://truthifi.com/education/state-of-mcp-2026-ai-agents-custom-connectors)
- [Agentic Payments in 2026: Anthropic, Visa and Mastercard — Elogic](https://elogic.co/blog/agentic-payments/)
- [Mastercard Agent Pay vs Visa Trusted Agent — Eco](https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared)
- [Visa and Mastercard Put Tokens in Charge of AI Commerce — PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/visa-and-mastercard-put-tokens-in-charge-of-ai-commerce/)
- [Visa opens one integration for AI agent payments — TechInformed](https://techinformed.com/visa-opens-one-integration-for-ai-agent-payments/)
