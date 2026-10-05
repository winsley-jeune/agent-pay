#!/usr/bin/env node
// SPDX-License-Identifier: MIT
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
      "Never cancel one without request_cancel first; the owner approves, then follow cancel_guide and record it with mark_canceled. " +
      "Price watch and groceries: read prices and fill carts only in the owner's own browser, never bypass a store's bot protection, " +
      "never buy a watched item without a buy mandate, and never check out a grocery order until request_order_approval is approved and the checkout total is within the approved maximum. " +
      "Before acting on any website, call check_browser_access for that site and action; if it isn't allowed, ask with request_browser_access and wait. " +
      "Only use sessions the owner is already signed in to: never type a password or sign-in code and never complete a sign-in; if a site asks you to sign in, stop and ask the owner to sign in themselves. " +
      "Never open payment settings, never read, copy or record card numbers or other payment details (not even the last four digits), and never change the payment method at checkout; " +
      "if checkout asks for payment details, stop and ask the owner. Record what you do with log_browser_activity. " +
      "When a store shows several versions of an item, send what you see to pick_product and follow its choice unless it says ask_owner. " +
      "Never buy, pay for, add to a cart or act on websites for: pornography or adult content, medicines (prescription or over the counter), pharmacies or medical devices, " +
      "firearms, ammunition or weapons, controlled or illegal drugs, alcohol, tobacco or vaping, or gambling, even if the owner asks; tell the owner they have to do it themselves. " +
      "When unsure, call check_purchase_policy first, and if in doubt, don't buy. " +
      "Every agent has a level (get_balance): L0 asks before every paid call, L1 pays only what the owner's rules allow, L2 pays on its own within its limits. " +
      "Money the owner set aside in an envelope pays matching calls without asking again; ask for one with request_envelope when a task needs many small payments. " +
      "Pass reason and instruction to call_paid_tool and log_browser_activity: the owner's log keeps what they asked for, why you acted and what happened. " +
      "If any result says frozen, stop everything and tell the owner; only they can unfreeze. " +
      "On a protected account, big or sensitive approvals also need a trusted helper's signature or a waiting period after the owner approves: " +
      "if check_approval says so, wait and don't ask the owner to approve again. Never pressure the owner to hurry an approval or to remove a helper. " +
      "Never buy a watched item unless check_buy_mandate says allowed for that price and site, right before checkout; then record the price with mark_bought. " +
      "If you made a mistake that cost money, say so and record it with report_mistake.",
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
      reason: z.string().max(500).optional().describe("Why this call is needed; kept in the owner's log and shown if approval is needed"),
      instruction: z.string().max(500).optional().describe("What the owner asked for that led to this call, in a sentence"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ tool, input, idempotency_key, approval_id, reason, instruction }) =>
    reply(api("POST", "/api/agent/call", { tool, input, idempotencyKey: idempotency_key ?? randomUUID(), approvalId: approval_id, reason, instruction })),
);

server.registerTool(
  "get_balance",
  {
    title: "Wallet, level and budget",
    description: "Wallet balance, recent spend, this agent's limits and level (L0/L1/L2), its spending rules, envelopes it can use, and whether everything is frozen.",
    annotations: { readOnlyHint: true },
  },
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
  "request_buy_mandate",
  {
    title: "Ask to buy a watched item when it drops",
    description:
      "Ask the owner to sign a buy mandate for a watched item: you may buy at most `quantity` at up to `max_price_cents` each, on the watched store, until it ends. " +
      "They approve with their passkey. Without an active mandate, never buy a watched item.",
    inputSchema: {
      watch_id: z.string(),
      max_price_cents: z.number().int().positive().optional().describe("Defaults to the watch's target price"),
      quantity: z.number().int().min(1).max(10).optional(),
      days: z.number().int().min(1).max(90).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ watch_id, max_price_cents, quantity, days }) =>
    reply(api("POST", pw(`/${encodeURIComponent(watch_id)}/mandate`), { maxPriceCents: max_price_cents, quantity, days })),
);

server.registerTool(
  "check_buy_mandate",
  {
    title: "May I buy this now?",
    description:
      "Right before checking out a watched item, send the price you see and the store's site. Buy only if status is allowed, " +
      "with the payment method the store already has selected, then call mark_bought with the price paid.",
    inputSchema: { watch_id: z.string(), price_cents: z.number().int().positive(), site: z.string().describe("The store's site or the page URL") },
    annotations: { readOnlyHint: true },
  },
  ({ watch_id, price_cents, site }) => reply(api("POST", pw(`/${encodeURIComponent(watch_id)}/check-mandate`), { priceCents: price_cents, site })),
);

server.registerTool(
  "mark_bought",
  {
    title: "Record that it was bought",
    description:
      "Stop watching because the item was bought: by the owner, or by you under a buy mandate (check_buy_mandate said allowed). " +
      "Give the price actually paid; a price above the mandate is recorded as an incident.",
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

// ---------------------------------------------------------------- groceries

const gr = (path = "") => `/api/agent/grocery${path}`;
const groceryItem = z.object({
  name: z.string(),
  quantity: z.number().positive().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
  category: z.string().optional(),
});

server.registerTool(
  "create_grocery_list",
  {
    title: "Make a grocery list",
    description:
      "Create a grocery list from items, from typed text (one item per line), or from a photo of a handwritten list (photo_path; AgentPay reads it). " +
      "Then set the store and fill the cart: for each item, search the store in the owner's own browser, add it, and report it with update_grocery_item.",
    inputSchema: {
      title: z.string().optional(),
      store: z.enum(["walmart", "whole_foods"]).optional(),
      items: z.array(groceryItem).optional(),
      text: z.string().optional().describe("e.g. '2 lb bananas\\nmilk x2\\neggs (large)'"),
      photo_path: z.string().optional().describe("Path to a photo of the list on this computer (JPEG, PNG, WebP)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ title, store, items, text, photo_path }) => {
    if (photo_path) {
      let data: Buffer;
      try {
        data = await readFile(photo_path);
      } catch (err) {
        return fail(`could not read ${photo_path}: ${(err as Error).message}`);
      }
      const ext = photo_path.toLowerCase().split(".").pop();
      const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
      return reply(api("POST", gr("/photo"), { imageBase64: data.toString("base64"), mediaType, store, title }));
    }
    if (!items?.length && !text) return fail("give items, text, or photo_path");
    return reply(api("POST", gr(), { title, store, items, text }));
  },
);

server.registerTool(
  "get_grocery_list",
  {
    title: "Show a grocery list",
    description: "Items with status, cart product and price, a search link for each item at the chosen store, and the running total.",
    inputSchema: { list_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ list_id }) => reply(api("GET", gr(`/${encodeURIComponent(list_id)}`))),
);

server.registerTool(
  "list_grocery_lists",
  { title: "All grocery lists", annotations: { readOnlyHint: true } },
  () => reply(api("GET", gr())),
);

server.registerTool(
  "set_grocery_store",
  {
    title: "Choose the store",
    inputSchema: { list_id: z.string(), store: z.enum(["walmart", "whole_foods"]) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ list_id, store }) => reply(api("PATCH", gr(`/${encodeURIComponent(list_id)}`), { store })),
);

server.registerTool(
  "update_grocery_item",
  {
    title: "Report a cart item",
    description:
      "After adding an item to the cart, record the product and the line price shown in the cart (in cents). " +
      "If you used something else, set status 'substituted' and say what. If it isn't available, set 'unavailable'. " +
      "Pick sensible defaults (store brand, the size written on the list) and mention choices in substitute_note.",
    inputSchema: {
      list_id: z.string(),
      item_id: z.number().int(),
      status: z.enum(["needed", "in_cart", "substituted", "unavailable", "removed"]).optional(),
      product_name: z.string().optional(),
      product_url: z.string().optional(),
      price_cents: z.number().int().nonnegative().optional(),
      substitute_note: z.string().optional(),
      quantity: z.number().positive().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ list_id, item_id, ...u }) =>
    reply(
      api("PATCH", gr(`/${encodeURIComponent(list_id)}/items/${item_id}`), {
        status: u.status, productName: u.product_name, productUrl: u.product_url, priceCents: u.price_cents, substituteNote: u.substitute_note, quantity: u.quantity,
      }),
    ),
);

server.registerTool(
  "request_order_approval",
  {
    title: "Ask the owner to approve the order",
    description:
      "When every item is in the cart, swapped, or unavailable, ask the owner to approve the total with their passkey. " +
      "Do not check out until check_approval says approved, and don't change the cart afterwards.",
    inputSchema: { list_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ list_id }) => reply(api("POST", gr(`/${encodeURIComponent(list_id)}/request-approval`), {})),
);

server.registerTool(
  "mark_grocery_ordered",
  {
    title: "Record the placed order",
    description:
      "Only after the owner approved: before you press the store's final 'Place order' button, check the checkout total is within the approved maximum. " +
      "Then record the order number and the final total in cents. A total above the approved maximum is refused; ask the owner instead.",
    inputSchema: { list_id: z.string(), total_cents: z.number().int().positive(), order_number: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  ({ list_id, total_cents, order_number }) => reply(api("POST", gr(`/${encodeURIComponent(list_id)}/ordered`), { totalCents: total_cents, orderNumber: order_number })),
);

// ---------------------------------------------------------------- permissions and product choice

const pm = (path = "") => `/api/agent/permissions${path}`;
const browserAction = z.enum(["browse", "add_to_cart", "checkout_approved_order", "manage_subscription"]);

server.registerTool(
  "check_browser_access",
  {
    title: "May I act on this site?",
    description:
      "Check before doing anything on a website in the owner's browser. Returns allowed, needs_consent, needs_grant, expired or revoked. " +
      "Only 'allowed' means go ahead.",
    inputSchema: { site: z.string().describe("e.g. walmart.com or a page URL"), action: browserAction },
    annotations: { readOnlyHint: true },
  },
  ({ site, action }) => reply(api("GET", pm(`/check?site=${encodeURIComponent(site)}&action=${action}`))),
);

server.registerTool(
  "request_browser_access",
  {
    title: "Ask to use a signed-in site",
    description:
      "Ask the owner for permission to use their already-signed-in session on a site for specific actions. They approve with their passkey. " +
      "Ask only for what the task needs (e.g. browse + add_to_cart to fill a cart; checkout_approved_order only when an order is approved).",
    inputSchema: {
      site: z.string(),
      actions: z.array(browserAction).min(1),
      reason: z.string().max(300),
      purpose: z.string().max(200).optional().describe("What the permission is for, e.g. 'weekly groceries'; shown on the approval and kept with the permission"),
      days: z.number().int().min(1).max(365).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ site, actions, reason, purpose, days }) => reply(api("POST", pm("/request"), { site, actions, reason, purpose, days })),
);

server.registerTool(
  "log_browser_activity",
  {
    title: "Record what you did on a site",
    description:
      "Log each meaningful action (searched, added to cart, removed, checked out) so the owner can review it: what you did, " +
      "the owner's instruction it came from, why, and what happened. Never include payment details.",
    inputSchema: {
      site: z.string(),
      action: browserAction,
      summary: z.string().max(500),
      instruction: z.string().max(500).optional().describe("What the owner asked for"),
      reason: z.string().max(500).optional().describe("Why you did this"),
      result: z.string().max(500).optional().describe("What happened"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ site, action, summary, instruction, reason, result }) => reply(api("POST", pm("/activity"), { site, action, summary, instruction, reason, result })),
);

server.registerTool(
  "get_shopping_preferences",
  {
    title: "The owner's shopping preferences",
    description: "Organic, store brand, size strategy, favourite and avoided brands, dietary needs, minimum rating and what to do when an item is missing.",
    annotations: { readOnlyHint: true },
  },
  () => reply(api("GET", pm("/preferences"))),
);

server.registerTool(
  "pick_product",
  {
    title: "Choose among versions of an item",
    description:
      "When a store search shows several versions of a list item (e.g. 'carrots': 1 lb, 2 lb, baby, organic, carrot cake), send the options you see. " +
      "AgentPay picks one using the owner's preferences, what they bought before, the quantity on the list and price per unit, " +
      "and says how many packs to add. Follow the choice unless ask_owner is true.",
    inputSchema: {
      list_id: z.string(),
      item_id: z.number().int(),
      candidates: z
        .array(
          z.object({
            name: z.string().describe("Product title as shown"),
            price_cents: z.number().int().positive(),
            size_text: z.string().optional().describe("e.g. '2 lb', '12 ct', '1 gal'"),
            brand: z.string().optional(),
            organic: z.boolean().optional(),
            rating: z.number().min(0).max(5).optional(),
            in_stock: z.boolean().optional(),
            url: z.string().optional(),
            dietary_tags: z.array(z.string()).optional().describe("e.g. gluten-free, vegan, as labelled on the page"),
          }),
        )
        .min(1)
        .max(60),
    },
    annotations: { readOnlyHint: true },
  },
  ({ list_id, item_id, candidates }) =>
    reply(
      api("POST", gr(`/${encodeURIComponent(list_id)}/items/${item_id}/pick`), {
        candidates: candidates.map((c) => ({
          name: c.name, priceCents: c.price_cents, sizeText: c.size_text, brand: c.brand, organic: c.organic, rating: c.rating,
          inStock: c.in_stock, url: c.url, dietaryTags: c.dietary_tags,
        })),
      }),
    ),
);

// ---------------------------------------------------------------- owner controls

const ctl = (path = "") => `/api/agent/controls${path}`;

server.registerTool(
  "check_purchase_policy",
  {
    title: "Is this something I must refuse?",
    description:
      "Check a product, service, tool or website against what agents must never buy or act on (adult content, medicines and pharmacies, weapons, " +
      "controlled or illegal drugs, alcohol, tobacco, gambling). If allowed is false, refuse and tell the owner they have to do it themselves.",
    inputSchema: { text: z.string().max(2000).optional().describe("Product or service name and description"), site: z.string().max(2000).optional() },
    annotations: { readOnlyHint: true },
  },
  ({ text, site }) => (text || site ? reply(api("POST", ctl("/policy/check"), { text, site })) : fail("give text or site")),
);

server.registerTool(
  "request_envelope",
  {
    title: "Ask the owner to set money aside",
    description:
      "Ask for an envelope: money moved out of the wallet for this agent, for some tools (or any), until a date. Calls it covers are paid without asking again; " +
      "what's left returns to the wallet when it ends. The owner approves with their passkey.",
    inputSchema: {
      name: z.string().max(80).describe("e.g. 'Research this week'"),
      amount_cents: z.number().int().positive(),
      days: z.number().int().min(1).max(90).default(30),
      purpose: z.string().max(300).optional(),
      tool_slugs: z.array(z.string()).optional().describe("Only these tools; omit for any"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ name, amount_cents, days, purpose, tool_slugs }) =>
    reply(api("POST", ctl("/envelopes"), { name, amountCents: amount_cents, days, purpose, toolSlugs: tool_slugs })),
);

server.registerTool(
  "report_mistake",
  {
    title: "Report a mistake that cost money",
    description:
      "Record an incident when something you did cost the owner money it shouldn't have (wrong item, double order, went past a limit). " +
      "Be honest and specific; the owner sees it with your log.",
    inputSchema: {
      description: z.string().max(2000),
      kind: z.enum(["misjudgment", "condition_breach", "system_bug", "hijacked", "unclassified"]).optional()
        .describe("misjudgment: a mistake within your authority; condition_breach: you went past a limit or condition; system_bug; hijacked: instructions came from someone else"),
      amount_cents: z.number().int().nonnegative().optional(),
      call_id: z.string().optional().describe("The callId of a paid call, if it was one"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ description, kind, amount_cents, call_id }) => reply(api("POST", ctl("/incidents"), { description, kind, amountCents: amount_cents, holdId: call_id })),
);

await server.connect(new StdioServerTransport());
