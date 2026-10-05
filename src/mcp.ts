import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

async function api(method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
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
      "Before subscribing, call browse_plans and prefer the suggestion that saves the most; never subscribe to two plans that cover the same need. " +
      "AgentPay also keeps the owner's everyday subscriptions (Netflix, Apple TV+, phone plan, gym...) in one list: use list_all_subscriptions, " +
      "add_subscription, import_bank_statement and savings_ideas. Those are billed by the merchant, not AgentPay. " +
      "Never cancel one without request_cancel first; the owner approves, then follow cancel_guide and record it with mark_canceled.",
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

// ---------------------------------------------------------------- everyday subscriptions

const ext = (path = "") => `/api/agent/everyday${path}`;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const billedThrough = z.enum(["direct", "apple", "google", "amazon", "carrier", "other"]);
const fail = (message: string) => reply(Promise.resolve({ ok: false, json: { error: { message } } }));

server.registerTool(
  "list_all_subscriptions",
  {
    title: "All subscriptions in one place",
    description:
      "Every subscription the owner has: everyday ones (streaming, phone, gym, software...) and AgentPay plans, with prices, " +
      "renewal dates, monthly total by category, and upcoming reminders (renewals, trial ends, contract ends).",
    annotations: { readOnlyHint: true },
  },
  () => reply(api("GET", ext())),
);

server.registerTool(
  "find_service",
  {
    title: "Look up a known service",
    description: "Known services: slug, category, cancel steps, approximate prices. Use the slug when adding a subscription.",
    inputSchema: { query: z.string().optional().describe("e.g. 'netflix' or 'phone'") },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const res = await api("GET", ext("/catalog"));
    if (!res.ok || !query) return reply(Promise.resolve(res));
    const q = query.toLowerCase();
    const j = res.json as { services: { slug: string; name: string; category: string }[]; pricesAsOf: string; pricesNote: string };
    const services = j.services.filter((s) => s.slug.includes(q) || s.name.toLowerCase().includes(q) || s.category.includes(q));
    return reply(Promise.resolve({ ok: true, json: { pricesAsOf: j.pricesAsOf, pricesNote: j.pricesNote, services } }));
  },
);

server.registerTool(
  "add_subscription",
  {
    title: "Track an everyday subscription",
    description:
      "Add a subscription the owner pays outside AgentPay (Netflix, AT&T, gym...). Ask the owner for the real price. " +
      "Set billed_through to apple, google or amazon if they subscribed through an app store, because that changes how to cancel.",
    inputSchema: {
      service: z.string().optional().describe("Slug from find_service, e.g. netflix, att-wireless"),
      name: z.string().optional().describe("Needed when the service is not in the catalog"),
      category: z.string().optional(),
      plan_name: z.string().optional(),
      price_cents: z.number().int().nonnegative(),
      interval: z.enum(["week", "month", "year"]).default("month"),
      billed_through: billedThrough.optional(),
      payment_method: z.string().optional().describe("e.g. Visa ending 4242"),
      status: z.enum(["active", "trial"]).optional(),
      next_renewal_on: day.optional(),
      trial_ends_on: day.optional(),
      contract_until: day.optional(),
      early_termination_fee_cents: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  (a) =>
    reply(
      api("POST", ext(), {
        serviceSlug: a.service, name: a.name, category: a.category, planName: a.plan_name, priceCents: a.price_cents, interval: a.interval,
        billedThrough: a.billed_through, paymentMethod: a.payment_method, status: a.status, nextRenewalOn: a.next_renewal_on,
        trialEndsOn: a.trial_ends_on, contractUntil: a.contract_until, earlyTerminationFeeCents: a.early_termination_fee_cents, notes: a.notes,
      }),
    ),
);

server.registerTool(
  "update_subscription",
  {
    title: "Update an everyday subscription",
    description: "Change price, renewal date or contract details, or record when the owner last used it (feeds the 'you never use this' suggestion).",
    inputSchema: {
      subscription_id: z.string(),
      price_cents: z.number().int().nonnegative().optional(),
      interval: z.enum(["week", "month", "year"]).optional(),
      next_renewal_on: day.optional(),
      contract_until: day.optional(),
      early_termination_fee_cents: z.number().int().nonnegative().optional(),
      last_used_on: day.optional(),
      billed_through: billedThrough.optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ subscription_id, ...a }) =>
    reply(
      api("PATCH", ext(`/${encodeURIComponent(subscription_id)}`), {
        priceCents: a.price_cents, interval: a.interval, nextRenewalOn: a.next_renewal_on, contractUntil: a.contract_until,
        earlyTerminationFeeCents: a.early_termination_fee_cents, lastUsedOn: a.last_used_on, billedThrough: a.billed_through, notes: a.notes,
      }),
    ),
);

server.registerTool(
  "import_bank_statement",
  {
    title: "Find subscriptions in a bank statement",
    description:
      "Import a bank or card CSV export (date, description, amount columns). Returns recurring charges not tracked yet " +
      "(confirm them with the owner, then add_subscription), price increases, and charges that kept coming after a cancellation.",
    inputSchema: {
      file_path: z.string().optional().describe("Path to a CSV file on this computer"),
      csv: z.string().optional().describe("CSV text, if there is no file"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ file_path, csv }) => {
    let text = csv;
    if (file_path) {
      try {
        text = await readFile(file_path, "utf8");
      } catch (err) {
        return fail(`could not read ${file_path}: ${(err as Error).message}`);
      }
    }
    if (!text) return fail("give file_path or csv");
    return reply(api("POST", ext("/import"), { csv: text }));
  },
);

server.registerTool(
  "savings_ideas",
  {
    title: "Ways to save on everyday subscriptions",
    description: "Bundles, paying twice for the same thing, cheaper ad tiers, yearly plans, unused services, too many streaming services, trials and contracts ending.",
    annotations: { readOnlyHint: true },
  },
  () => reply(api("GET", ext("/suggestions"))),
);

server.registerTool(
  "cancel_guide",
  {
    title: "How to cancel",
    description:
      "Where and how to cancel, which depends on who bills it (Paramount+ bought on an iPhone is cancelled in Apple settings), " +
      "plus warnings about contracts, fees, and the date to cancel by.",
    inputSchema: { subscription_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ subscription_id }) => reply(api("GET", ext(`/${encodeURIComponent(subscription_id)}/cancel-guide`))),
);

server.registerTool(
  "request_cancel",
  {
    title: "Ask the owner to approve cancelling",
    description: "Start cancelling an everyday subscription. The owner approves first, with their passkey; then follow cancel_guide.",
    inputSchema: { subscription_id: z.string(), reason: z.string().max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ subscription_id, reason }) => reply(api("POST", ext(`/${encodeURIComponent(subscription_id)}/request-cancel`), { reason })),
);

server.registerTool(
  "mark_canceled",
  {
    title: "Record that it is cancelled",
    description: "After it was actually cancelled with the provider (and the owner approved), record it with the confirmation number.",
    inputSchema: { subscription_id: z.string(), confirmation: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ subscription_id, confirmation }) => reply(api("POST", ext(`/${encodeURIComponent(subscription_id)}/mark-canceled`), { confirmation })),
);

// ---------------------------------------------------------------- price watch

const pw = (path = "") => `/api/agent/price-watch${path}`;

server.registerTool(
  "watch_price",
  {
    title: "Watch an item for a price drop",
    description:
      "Track a product (e.g. an Amazon link) until it reaches the owner's target price. Include the current price if you know it. " +
      "The result lists upcoming sales (Black Friday dates; Prime events as typical windows) to help decide whether to wait.",
    inputSchema: {
      url: z.string().describe("Product link"),
      target_price_cents: z.number().int().positive().describe("Owner's target price"),
      title: z.string().optional(),
      current_price_cents: z.number().int().positive().optional(),
      expires_on: day.optional().describe("Stop watching after this date"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ url, target_price_cents, title, current_price_cents, expires_on }) =>
    reply(api("POST", pw(), { url, targetPriceCents: target_price_cents, title, currentPriceCents: current_price_cents, expiresOn: expires_on })),
);

server.registerTool(
  "list_price_watches",
  {
    title: "Items being watched",
    description: "Watched items with current, lowest and target price, recent history, alerts and timing advice.",
    annotations: { readOnlyHint: true },
  },
  () => reply(api("GET", pw())),
);

server.registerTool(
  "record_price",
  {
    title: "Report a price you saw",
    description:
      "Record the price you just saw on the product page (read it in the owner's own browser or from a search result; " +
      "never try to get around a store's bot protection). Returns alerts such as target reached or new low. " +
      "Use the price the owner would actually pay, and put coupons or deal names in note.",
    inputSchema: { watch_id: z.string(), price_cents: z.number().int().positive(), note: z.string().max(200).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ watch_id, price_cents, note }) => reply(api("POST", pw(`/${encodeURIComponent(watch_id)}/prices`), { priceCents: price_cents, note })),
);

server.registerTool(
  "mark_bought",
  {
    title: "Record that the owner bought it",
    description: "Stop watching because the owner bought the item. Never buy it yourself; the owner decides and checks out.",
    inputSchema: { watch_id: z.string(), price_cents: z.number().int().positive().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ watch_id, price_cents }) => reply(api("POST", pw(`/${encodeURIComponent(watch_id)}/bought`), { priceCents: price_cents })),
);

server.registerTool(
  "stop_watch",
  {
    title: "Stop watching an item",
    inputSchema: { watch_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ watch_id }) => reply(api("POST", pw(`/${encodeURIComponent(watch_id)}/stop`), {})),
);

await server.connect(new StdioServerTransport());
