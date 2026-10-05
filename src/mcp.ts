import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// MCP server an agent runs locally. It holds only an agent key and talks to
// the AgentPay API over HTTP; the key's owner controls its limits.
//
//   AGENTPAY_URL        e.g. http://localhost:8787
//   AGENTPAY_AGENT_KEY  ap_agent_...

const baseUrl = (process.env.AGENTPAY_URL ?? "http://localhost:8787").replace(/\/$/, "");
const agentKey = process.env.AGENTPAY_AGENT_KEY ?? "";

async function api(method: "GET" | "POST", path: string, body?: unknown) {
  if (!agentKey) throw new Error("AGENTPAY_AGENT_KEY is not set in this MCP server's environment");
  const res = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${agentKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  return { ok: res.ok, json };
}

/** MCP tool result: JSON text, flagged as an error when the API refused. */
async function reply(call: Promise<{ ok: boolean; json: unknown }>) {
  try {
    const { ok, json } = await call;
    return { content: [{ type: "text" as const, text: JSON.stringify(json, null, 2) }], isError: !ok };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `AgentPay unreachable: ${(err as Error).message}` }], isError: true };
  }
}

const server = new McpServer(
  { name: "agentpay", version: "0.1.0" },
  {
    instructions:
      "AgentPay lets you pay for tools and subscriptions from a prepaid wallet your owner controls. " +
      "Amounts are in US cents. Before an expensive call, use get_quote. Every call_paid_tool result says what was charged. " +
      "If a result says pending_approval, tell the user what needs approving and why; they approve with a passkey on their own device. " +
      "Before subscribing, call browse_plans and prefer the suggestion that saves the most; never subscribe to two plans that cover the same need.",
  },
);

server.registerTool(
  "list_paid_tools",
  { title: "List paid tools", description: "Paid tools this agent may call, with prices and input schemas.", annotations: { readOnlyHint: true } },
  () => reply(api("GET", "/api/agent/tools")),
);

server.registerTool(
  "get_quote",
  {
    title: "Get a price quote",
    description: "What a call would cost, whether it needs owner approval, and the remaining budget. Free; charges nothing.",
    inputSchema: { tool: z.string().describe("Tool slug from list_paid_tools"), input: z.record(z.string(), z.unknown()).default({}) },
    annotations: { readOnlyHint: true },
  },
  ({ tool, input }) => reply(api("POST", "/api/agent/quote", { tool, input })),
);

server.registerTool(
  "call_paid_tool",
  {
    title: "Call a paid tool",
    description:
      "Call a paid tool. Spends credits from the owner's wallet. If the provider fails you are not charged. " +
      "Reuse the same idempotency_key when retrying the same call so it is never charged twice.",
    inputSchema: {
      tool: z.string().describe("Tool slug"),
      input: z.record(z.string(), z.unknown()).default({}).describe("Input matching the tool's inputSchema"),
      idempotency_key: z.string().max(200).optional().describe("Stable key for this logical call; generated if omitted"),
      approval_id: z.string().optional().describe("From an earlier pending_approval result, once the owner has approved"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ tool, input, idempotency_key, approval_id }) =>
    reply(api("POST", "/api/agent/call", { tool, input, idempotencyKey: idempotency_key ?? randomUUID(), approvalId: approval_id })),
);

server.registerTool(
  "get_balance",
  { title: "Wallet and budget", description: "Wallet balance, recent spend and this agent's limits.", annotations: { readOnlyHint: true } },
  () => reply(api("GET", "/api/agent/balance")),
);

server.registerTool(
  "check_approval",
  {
    title: "Check an approval",
    description: "Whether the owner has approved, denied, or not yet answered a request.",
    inputSchema: { approval_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ approval_id }) => reply(api("GET", `/api/agent/approvals/${encodeURIComponent(approval_id)}`)),
);

server.registerTool(
  "browse_plans",
  {
    title: "Browse and compare plans",
    description:
      "Subscription plans in the marketplace, cheapest per month first, plus personalised suggestions: " +
      "duplicate subscriptions, cheaper alternatives, underused plans, and plans that would cost less than current pay-per-call spending.",
    inputSchema: { category: z.string().optional(), search: z.string().optional().describe("Free-text match on name, description, features") },
    annotations: { readOnlyHint: true },
  },
  ({ category, search }) => {
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (search) qs.set("search", search);
    return reply(api("GET", `/api/agent/plans${qs.size ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "subscribe",
  {
    title: "Request a subscription",
    description:
      "Ask the owner to subscribe to a plan. Nothing is charged until the owner approves with their passkey. " +
      "Explain the reason clearly; the owner sees it on the approval screen.",
    inputSchema: {
      plan: z.string().describe("Plan slug from browse_plans"),
      reason: z.string().max(500).describe("Why this subscription is needed"),
      max_price_cents: z.number().int().optional().describe("Highest renewal price the owner accepts; defaults to the current price"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  ({ plan, reason, max_price_cents }) => reply(api("POST", "/api/agent/subscriptions", { plan, reason, maxPriceCents: max_price_cents })),
);

server.registerTool(
  "list_subscriptions",
  { title: "List subscriptions", description: "The owner's live subscriptions, renewal dates and included-call usage.", annotations: { readOnlyHint: true } },
  () => reply(api("GET", "/api/agent/subscriptions")),
);

server.registerTool(
  "cancel_subscription",
  {
    title: "Cancel a subscription",
    description: "Cancel at the end of the paid period (default) or immediately. Cancelling never charges anything.",
    inputSchema: { subscription_id: z.string(), immediately: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  ({ subscription_id, immediately }) =>
    reply(api("POST", `/api/agent/subscriptions/${encodeURIComponent(subscription_id)}/cancel`, { immediately })),
);

server.registerTool(
  "renew_subscription",
  {
    title: "Request a renewal",
    description: "Ask the owner to renew a past-due subscription or undo a scheduled cancel. Needs the owner's passkey.",
    inputSchema: { subscription_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ subscription_id }) => reply(api("POST", `/api/agent/subscriptions/${encodeURIComponent(subscription_id)}/renew`, {})),
);

await server.connect(new StdioServerTransport());
