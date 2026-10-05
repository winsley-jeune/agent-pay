import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { AgentKey } from "./auth.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { enforce, refusalMessage, screen } from "./policy.js";
import { rememberPurchases } from "./shopping.js";

// Grocery lists: typed, or read from a photo with Claude. The owner's agent
// fills the cart at Walmart or Whole Foods in the owner's own browser and
// reports what it put in; the owner approves the total before checkout.
// AgentPay has no store account and never places the order itself.

export type Store = "walmart" | "whole_foods";
export type ListStatus = "draft" | "shopping" | "ready" | "approved" | "ordered" | "canceled";
export type ItemStatus = "needed" | "in_cart" | "substituted" | "unavailable" | "removed" | "refused";

export interface NewItem {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
  category?: string | null;
}

export const STORES: Record<Store, { name: string; site: string; search: (q: string) => string; note: string }> = {
  walmart: {
    name: "Walmart",
    site: "https://www.walmart.com/cart",
    search: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
    note: "Choose pickup or delivery and the time slot at checkout.",
  },
  whole_foods: {
    name: "Whole Foods Market",
    site: "https://www.wholefoodsmarket.com",
    // Search on Whole Foods' own site; "Shop online" there continues to Amazon, where the order is placed.
    // Link format not verified against the live site; adjust if it changes.
    search: (q) => `https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(q)}`,
    note: "Whole Foods delivery and pickup go through Amazon; Prime members get lower delivery fees.",
  },
};

// ---------------------------------------------------------------- reading a photo

const PhotoList = z.object({
  title: z.string().describe("Short name for the list, e.g. 'Weekly groceries'. Use any heading written on the list."),
  items: z.array(
    z.object({
      name: z.string().describe("The item as a shopper would search for it, e.g. 'whole milk', 'bananas'"),
      quantity: z.number().nullable().describe("Number written next to the item, or null if none"),
      unit: z.string().nullable().describe("lb, oz, gallon, dozen, pack, bunch, can... or null"),
      notes: z.string().nullable().describe("Brand, size or other detail written on the list, or null"),
      category: z.enum(["produce", "dairy & eggs", "meat & seafood", "bakery", "pantry", "frozen", "drinks", "snacks", "household", "personal care", "baby", "pet", "other"]),
    }),
  ),
  unreadable: z.array(z.string()).describe("Any word or line you could not read with confidence, exactly as it appears"),
});
export type PhotoListResult = z.infer<typeof PhotoList>;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export type PhotoReader = (imageBase64: string, mediaType: ImageType) => Promise<PhotoListResult>;

let anthropic: Anthropic | null = null;

/** Read a photo of a shopping list with Claude and return structured items. */
export const readListWithClaude: PhotoReader = async (imageBase64, mediaType) => {
  anthropic ??= new Anthropic();
  let response;
  try {
    response = await anthropic.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // If the request is declined, the API retries on a fallback model it picks.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(PhotoList) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            {
              type: "text",
              text:
                "This is a photo of a grocery shopping list, often handwritten. List every item on it, in order. " +
                "Keep crossed-out items out. Expand obvious abbreviations (\"OJ\" = orange juice). " +
                "If a word is unclear, give your best reading as the item and also add the original to `unreadable` so the person can check it. " +
                "If the photo isn't a shopping list, return no items and describe what you see in `unreadable`.",
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AppError(503, "claude_not_configured", "set ANTHROPIC_API_KEY on the AgentPay server to read photos");
    if (err instanceof Anthropic.RateLimitError) throw new AppError(503, "claude_busy", "photo reading is busy; try again in a minute");
    if (err instanceof Anthropic.BadRequestError) throw new AppError(400, "photo_rejected", `the photo couldn't be read: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new AppError(502, "claude_error", `photo reading failed (${err.status})`);
    // Anything else failed before a request was sent, most often no API key or login on this server.
    throw new AppError(503, "claude_unavailable", `photo reading isn't set up on this server (set ANTHROPIC_API_KEY): ${(err as Error).message}`);
  }
  if (response.stop_reason === "refusal") throw new AppError(422, "photo_refused", "this photo couldn't be processed; type the list instead");
  if (!response.parsed_output) throw new AppError(502, "photo_unparsed", "couldn't turn the photo into a list; try a clearer photo or type it");
  return response.parsed_output;
};

export function checkImage(imageBase64: string, mediaType: string): ImageType {
  if (!IMAGE_TYPES.includes(mediaType as ImageType)) throw new AppError(400, "invalid_image", "send a JPEG, PNG, WebP or GIF photo");
  const bytes = Math.floor((imageBase64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) throw new AppError(413, "image_too_large", "photo is over 5 MB; take it at a lower resolution");
  if (!/^[A-Za-z0-9+/]+=*$/.test(imageBase64.slice(0, 1000))) throw new AppError(400, "invalid_image", "imageBase64 must be plain base64 (no data: prefix)");
  return mediaType as ImageType;
}

// ---------------------------------------------------------------- typed lists

const UNITS = ["lb", "lbs", "oz", "kg", "g", "gal", "gallon", "gallons", "dozen", "doz", "pack", "packs", "bunch", "bag", "bags", "box", "boxes", "can", "cans", "jar", "bottle", "bottles", "loaf", "ct"];

/** Parse "2 lb chicken thighs", "milk x2", "eggs (large)" style lines. */
export function parseTypedList(text: string): NewItem[] {
  return text
    .split(/\r?\n|,(?![^(]*\))/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .map((line) => {
      let quantity: number | null = null;
      let unit: string | null = null;
      let rest = line;
      const lead = rest.match(/^(\d+(?:\.\d+)?|\d+\/\d+)\s*([a-zA-Z]+)?\s+(.*)$/);
      if (lead) {
        quantity = lead[1].includes("/") ? Number(lead[1].split("/")[0]) / Number(lead[1].split("/")[1]) : Number(lead[1]);
        if (lead[2] && UNITS.includes(lead[2].toLowerCase())) {
          unit = lead[2].toLowerCase();
          rest = lead[3];
        } else rest = `${lead[2] ? lead[2] + " " : ""}${lead[3]}`;
      } else {
        const trail = rest.match(/^(.*?)\s*[x×]\s*(\d+)$/i);
        if (trail) {
          rest = trail[1];
          quantity = Number(trail[2]);
        }
      }
      const notes = rest.match(/\(([^)]+)\)/)?.[1] ?? null;
      const name = rest.replace(/\([^)]*\)/g, "").trim();
      return { name: name || line, quantity, unit, notes };
    });
}

// ---------------------------------------------------------------- lists

export interface GroceryItem {
  id: number;
  position: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
  category: string | null;
  status: ItemStatus;
  productName: string | null;
  productUrl: string | null;
  priceCents: number | null;
  substituteNote: string | null;
  searchUrl: string | null;
}

const listColumns = `id, title, store, status, source, unreadable, estimated_total_cents AS "estimatedTotalCents",
  approved_max_cents AS "approvedMaxCents", order_number AS "orderNumber", ordered_total_cents AS "orderedTotalCents",
  ordered_at AS "orderedAt", created_at AS "createdAt"`;

export async function getList(q: Db | Tx, userId: string, id: string) {
  const { rows } = await q.query(`SELECT ${listColumns} FROM grocery_lists WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "grocery list not found");
  const list = rows[0];
  const items = await q.query(
    `SELECT id, position, name, quantity::float8 AS quantity, unit, notes, category, status, product_name AS "productName",
            product_url AS "productUrl", price_cents AS "priceCents", substitute_note AS "substituteNote"
       FROM grocery_items WHERE list_id = $1 ORDER BY position, id`,
    [id],
  );
  const store = list.store ? STORES[list.store as Store] : null;
  return {
    ...list,
    storeName: store?.name ?? null,
    cartUrl: store?.site ?? null,
    storeNote: store?.note ?? null,
    items: items.rows.map((i) => ({ ...i, searchUrl: store ? store.search([i.notes, i.name].filter(Boolean).join(" ")) : null })) as GroceryItem[],
  };
}

export async function listLists(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT ${listColumns}, (SELECT count(*)::int FROM grocery_items i WHERE i.list_id = l.id AND i.status <> 'removed') AS "itemCount"
       FROM grocery_lists l WHERE user_id = $1 ORDER BY (status IN ('ordered','canceled')), created_at DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

export async function createList(
  db: Db,
  userId: string,
  input: { title?: string; store?: Store | null; items: NewItem[]; source: "typed" | "photo" | "agent"; unreadable?: string[] },
  agentKey: AgentKey | null = null,
) {
  const items = input.items.map((i) => ({ ...i, name: i.name.trim() })).filter((i) => i.name);
  if (!items.length && !input.unreadable?.length) throw new AppError(400, "empty_list", "the list has no items");
  if (items.length > 200) throw new AppError(400, "list_too_long", "a list can have at most 200 items");
  const id = await withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO grocery_lists (user_id, title, store, source, unreadable, added_by_agent_key_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, (input.title?.trim() || "Groceries").slice(0, 100), input.store ?? null, input.source, input.unreadable ?? [], agentKey?.id ?? null],
    );
    let position = 0;
    for (const i of items) await insertItem(tx, rows[0].id, position++, i);
    return rows[0].id as string;
  });
  return getList(db, userId, id);
}

/** Add one item. Something agents can't buy (alcohol, medicine...) stays on the list, marked refused, for the owner to buy themselves. */
async function insertItem(tx: Tx, listId: string, position: number, i: NewItem) {
  const refused = screen(`${i.name} ${i.notes ?? ""}`);
  await tx.query(
    "INSERT INTO grocery_items (list_id, position, name, quantity, unit, notes, category, status, substitute_note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      listId, position, i.name.slice(0, 120), i.quantity ?? null, i.unit?.slice(0, 20) ?? null, i.notes?.slice(0, 200) ?? null, i.category ?? null,
      refused ? "refused" : "needed", refused ? refusalMessage(refused) : null,
    ],
  );
}

async function lockEditable(tx: Tx, userId: string, listId: string) {
  const { rows } = await tx.query("SELECT status FROM grocery_lists WHERE id = $1 AND user_id = $2 FOR UPDATE", [listId, userId]);
  const status: ListStatus | undefined = rows[0]?.status;
  if (!status) throw new AppError(404, "not_found", "grocery list not found");
  if (status === "approved") throw new AppError(409, "list_approved", "the owner already approved this order; ask them to reopen it before changing it");
  if (status === "ordered" || status === "canceled") throw new AppError(409, "list_closed", `this list is ${status}`);
  return status;
}

async function refreshTotal(tx: Tx, listId: string) {
  await tx.query(
    `UPDATE grocery_lists SET estimated_total_cents =
       (SELECT SUM(price_cents) FROM grocery_items WHERE list_id = $1 AND status IN ('in_cart','substituted'))
     WHERE id = $1`,
    [listId],
  );
}

export async function updateList(db: Db, userId: string, listId: string, input: { title?: string; store?: Store | null; status?: "draft" | "shopping" }) {
  await withTx(db, async (tx) => {
    await lockEditable(tx, userId, listId);
    await tx.query(
      `UPDATE grocery_lists SET title = COALESCE($2, title), store = CASE WHEN $3::boolean THEN $4 ELSE store END, status = COALESCE($5, status) WHERE id = $1`,
      [listId, input.title ?? null, input.store !== undefined, input.store ?? null, input.status ?? null],
    );
  });
  return getList(db, userId, listId);
}

export async function addItems(db: Db, userId: string, listId: string, items: NewItem[]) {
  await withTx(db, async (tx) => {
    await lockEditable(tx, userId, listId);
    const { rows } = await tx.query("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM grocery_items WHERE list_id = $1", [listId]);
    let position: number = rows[0].next;
    for (const i of items) await insertItem(tx, listId, position++, i);
  });
  return getList(db, userId, listId);
}

export interface ItemUpdate {
  status?: ItemStatus;
  name?: string;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
  productName?: string | null;
  productUrl?: string | null;
  priceCents?: number | null;
  substituteNote?: string | null;
}

/** The agent reports what it put in the cart (product, line price) or that it couldn't find something. */
export async function updateItem(db: Db, userId: string, listId: string, itemId: number, u: ItemUpdate) {
  if (u.priceCents != null && (!Number.isSafeInteger(u.priceCents) || u.priceCents < 0)) throw new AppError(400, "invalid_price", "priceCents must be a non-negative integer");
  if (u.status === "substituted" && !u.substituteNote && !u.productName) throw new AppError(400, "substitute_needs_note", "say what was used instead (productName or substituteNote)");
  if (u.status === "refused") throw new AppError(400, "invalid_status", "only AgentPay marks items refused");
  enforce(u.name, u.productName, u.productUrl, u.substituteNote);
  await withTx(db, async (tx) => {
    const status = await lockEditable(tx, userId, listId);
    const current = await tx.query("SELECT status FROM grocery_items WHERE id = $1 AND list_id = $2", [itemId, listId]);
    if (current.rows[0]?.status === "refused" && u.status !== "removed") {
      throw new AppError(403, "restricted_category", "this item is refused: agents can't buy it. The owner has to buy it themselves.");
    }
    const columns: Record<keyof ItemUpdate, string> = {
      status: "status", name: "name", quantity: "quantity", unit: "unit", notes: "notes", productName: "product_name",
      productUrl: "product_url", priceCents: "price_cents", substituteNote: "substitute_note",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, col] of Object.entries(columns) as [keyof ItemUpdate, string][]) {
      if (u[k] !== undefined) {
        values.push(u[k]);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (!sets.length) return;
    values.push(itemId, listId);
    const { rowCount } = await tx.query(`UPDATE grocery_items SET ${sets.join(", ")} WHERE id = $${values.length - 1} AND list_id = $${values.length}`, values);
    if (!rowCount) throw new AppError(404, "not_found", "item not found on this list");
    if (status === "draft") await tx.query("UPDATE grocery_lists SET status = 'shopping' WHERE id = $1", [listId]);
    // A change after asking for approval puts the order back to shopping; the old approval no longer matches the cart.
    if (status === "ready") {
      await tx.query("UPDATE grocery_lists SET status = 'shopping' WHERE id = $1", [listId]);
      await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE grocery_list_id = $1 AND status = 'pending'", [listId]);
    }
    await refreshTotal(tx, listId);
  });
  return getList(db, userId, listId);
}

/** How much over the cart estimate the owner allows at checkout (weighed produce, tax, fees). */
export const CHECKOUT_BUFFER = 0.15;

/**
 * Once every item is in the cart, swapped, or marked unavailable, ask the
 * owner to approve the order total with their passkey.
 */
export async function requestOrderApproval(db: Db, userId: string, listId: string, agentKey: AgentKey | null = null) {
  return withTx(db, async (tx) => {
    await lockEditable(tx, userId, listId);
    const { rows } = await tx.query(`SELECT ${listColumns} FROM grocery_lists WHERE id = $1`, [listId]);
    const list = rows[0];
    if (!list.store) throw new AppError(400, "no_store", "choose Walmart or Whole Foods first");
    const items = await tx.query("SELECT name, status, price_cents FROM grocery_items WHERE list_id = $1 AND status <> 'removed'", [listId]);
    const open = items.rows.filter((i) => i.status === "needed");
    if (open.length) throw new AppError(409, "items_open", `still to do: ${open.map((i) => i.name).join(", ")}`);
    const unpriced = items.rows.filter((i) => (i.status === "in_cart" || i.status === "substituted") && i.price_cents == null);
    if (unpriced.length) throw new AppError(409, "items_unpriced", `record the cart price for: ${unpriced.map((i) => i.name).join(", ")}`);
    await refreshTotal(tx, listId);
    const total = (await tx.query("SELECT estimated_total_cents AS t FROM grocery_lists WHERE id = $1", [listId])).rows[0].t;
    if (!total) throw new AppError(409, "empty_cart", "nothing is in the cart");
    await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE grocery_list_id = $1 AND status = 'pending'", [listId]);
    const { rows: ap } = await tx.query(
      `INSERT INTO approvals (kind, user_id, agent_key_id, grocery_list_id, amount_cents, input) VALUES ('grocery_order', $1, $2, $3, $4, $5) RETURNING id`,
      [userId, agentKey?.id ?? null, listId, total, JSON.stringify({ title: list.title, store: list.store, items: items.rows.length, maxCents: Math.ceil(total * (1 + CHECKOUT_BUFFER)) })],
    );
    await tx.query("UPDATE grocery_lists SET status = 'ready' WHERE id = $1", [listId]);
    return {
      status: "pending_approval" as const,
      approvalId: ap[0].id as string,
      estimatedTotalCents: total,
      maxCents: Math.ceil(total * (1 + CHECKOUT_BUFFER)),
      message: "Waiting for the owner to approve the order with their passkey. Don't check out until check_approval says approved.",
    };
  });
}

/** Called when the owner approves a grocery_order approval. */
export async function approveGroceryOrder(tx: Tx, listId: string, input: { maxCents?: number }) {
  const { rowCount } = await tx.query("UPDATE grocery_lists SET status = 'approved', approved_max_cents = $2 WHERE id = $1 AND status = 'ready'", [listId, input.maxCents ?? null]);
  if (!rowCount) throw new AppError(409, "list_changed", "the cart changed after this approval was requested; ask for a new approval");
}

export async function denyGroceryOrder(tx: Tx, listId: string) {
  await tx.query("UPDATE grocery_lists SET status = 'shopping' WHERE id = $1 AND status = 'ready'", [listId]);
}

/** Owner reopens an approved list to change it. */
export async function reopenList(db: Db, userId: string, listId: string) {
  const { rowCount } = await db.query(
    "UPDATE grocery_lists SET status = 'shopping', approved_max_cents = NULL WHERE id = $1 AND user_id = $2 AND status IN ('approved','ready')",
    [listId, userId],
  );
  if (!rowCount) throw new AppError(409, "not_reopenable", "only a list waiting for or past approval can be reopened");
  await db.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE grocery_list_id = $1 AND status = 'pending'", [listId]);
  return getList(db, userId, listId);
}

/**
 * Record the placed order. An agent may only do this for an approved list,
 * and the total must be within what the owner approved.
 */
export async function markOrdered(db: Db, userId: string, listId: string, input: { orderNumber?: string; totalCents: number }, byAgent: boolean) {
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents <= 0) throw new AppError(400, "invalid_total", "totalCents must be a positive integer");
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT status, approved_max_cents AS max FROM grocery_lists WHERE id = $1 AND user_id = $2 FOR UPDATE", [listId, userId]);
    const list = rows[0];
    if (!list) throw new AppError(404, "not_found", "grocery list not found");
    if (list.status === "ordered") throw new AppError(409, "already_ordered", "already recorded as ordered");
    if (byAgent && list.status !== "approved") throw new AppError(403, "not_approved", "the owner hasn't approved this order");
    if (byAgent && list.max != null && input.totalCents > list.max) {
      throw new AppError(403, "over_approved_total", `the order total is above the $${(list.max / 100).toFixed(2)} the owner approved; don't place it, ask the owner`);
    }
    await tx.query("UPDATE grocery_lists SET status = 'ordered', order_number = $2, ordered_total_cents = $3, ordered_at = now() WHERE id = $1", [
      listId, input.orderNumber?.slice(0, 80) ?? null, input.totalCents,
    ]);
    await rememberPurchases(tx, userId, listId);
    return getList(tx, userId, listId);
  });
}

export async function cancelList(db: Db, userId: string, listId: string) {
  const { rowCount } = await db.query("UPDATE grocery_lists SET status = 'canceled' WHERE id = $1 AND user_id = $2 AND status <> 'ordered'", [listId, userId]);
  if (!rowCount) throw new AppError(409, "not_cancelable", "list not found or already ordered");
  await db.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE grocery_list_id = $1 AND status = 'pending'", [listId]);
}
