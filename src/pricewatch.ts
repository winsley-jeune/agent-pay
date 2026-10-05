import type { AgentKey } from "./auth.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { reportIncidentTx } from "./incidents.js";
import { useMandate } from "./mandates.js";
import { normalizeSite } from "./permissions.js";
import { enforce, enforceSite } from "./policy.js";
import { recordPurchase } from "./purchases.js";

// Watch an item until it drops to a target price. Prices come from the
// owner's agent (which reads the page in the owner's own browser), from the
// owner, or optionally from the Keepa price-history API. AgentPay never logs
// in to a store, never scrapes it, and never buys. An agent may buy only
// under a buy mandate the owner signed (src/mandates.ts).

export type WatchStatus = "watching" | "target_hit" | "bought" | "stopped";

export interface PricePoint {
  priceCents: number;
  source: "agent" | "manual" | "keepa";
  note: string | null;
  observedAt: Date;
}

export interface PriceAlert {
  id: number;
  type: "target_hit" | "new_low" | "big_drop" | "price_up";
  message: string;
  priceCents: number;
  seen: boolean;
  createdAt: Date;
}

export interface PriceWatch {
  id: string;
  title: string;
  url: string;
  retailer: string;
  productKey: string | null;
  targetPriceCents: number;
  currentPriceCents: number | null;
  lowestSeenCents: number | null;
  status: WatchStatus;
  expiresOn: string | null;
  notes: string | null;
  targetHitAt: Date | null;
  boughtAt: Date | null;
  boughtPriceCents: number | null;
  createdAt: Date;
}

const watchColumns = `id, title, url, retailer, product_key AS "productKey", target_price_cents AS "targetPriceCents",
  current_price_cents AS "currentPriceCents", lowest_seen_cents AS "lowestSeenCents", status,
  to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn", notes, target_hit_at AS "targetHitAt", bought_at AS "boughtAt",
  bought_price_cents AS "boughtPriceCents", created_at AS "createdAt"`;

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * Normalise a product link. For Amazon, pulls out the ASIN and returns a clean
 * https://www.amazon.<tld>/dp/ASIN link without tracking or affiliate parameters.
 */
export function parseProductUrl(raw: string): { url: string; retailer: string; productKey: string | null } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AppError(400, "invalid_url", "give the full product link, starting with https://");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AppError(400, "invalid_url", "only web links are supported");
  const host = u.hostname.toLowerCase().replace(/^www\.|^smile\./, "");
  const amazon = host.match(/^amazon\.([a-z.]+)$/);
  if (amazon) {
    const asin = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|o\/asin)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() ?? null;
    return { url: asin ? `https://www.amazon.${amazon[1]}/dp/${asin}` : `${u.origin}${u.pathname}`, retailer: "amazon", productKey: asin };
  }
  if (host === "amzn.to" || host === "a.co") {
    // Short links hide the product id; keep the link and let the agent or owner open it.
    return { url: u.toString(), retailer: "amazon", productKey: null };
  }
  return { url: `${u.origin}${u.pathname}`, retailer: host, productKey: null };
}

export async function getWatch(q: Db | Tx, userId: string, id: string): Promise<PriceWatch> {
  const { rows } = await q.query(`SELECT ${watchColumns} FROM price_watches WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) throw new AppError(404, "not_found", "price watch not found");
  return rows[0];
}

export async function addWatch(
  db: Db,
  userId: string,
  input: { url: string; title?: string; targetPriceCents: number; currentPriceCents?: number; expiresOn?: string; notes?: string },
  agentKey: AgentKey | null = null,
) {
  if (!Number.isSafeInteger(input.targetPriceCents) || input.targetPriceCents <= 0) throw new AppError(400, "invalid_price", "targetPriceCents must be a positive integer");
  const { url, retailer, productKey } = parseProductUrl(input.url);
  // Agents can't buy these, so there's nothing to watch for them either.
  enforce(input.title, url);
  enforceSite(normalizeSite(url));
  const title = input.title?.trim() || (productKey ? `Amazon item ${productKey}` : url);
  const { rows } = await db
    .query(
      `INSERT INTO price_watches (user_id, title, url, retailer, product_key, target_price_cents, expires_on, notes, added_by_agent_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, title.slice(0, 200), url, retailer, productKey, input.targetPriceCents, input.expiresOn ?? null, input.notes ?? null, agentKey?.id ?? null],
    )
    .catch((err) => {
      if (err.code === "23505") throw new AppError(409, "already_watching", "you're already watching this item");
      throw err;
    });
  const id: string = rows[0].id;
  const result = input.currentPriceCents
    ? await recordPrice(db, userId, id, { priceCents: input.currentPriceCents, source: agentKey ? "agent" : "manual" })
    : { watch: await getWatch(db, userId, id), alerts: [] };
  return { ...result, timing: saleTiming() };
}

/**
 * Store an observed price and raise alerts:
 *   target_hit  price at or below target (once per time it crosses)
 *   new_low     strictly lower than any earlier price
 *   big_drop    10% or more below the previous price
 *   price_up    went back above target after hitting it (the deal ended)
 */
export async function recordPrice(
  db: Db,
  userId: string,
  watchId: string,
  p: { priceCents: number; source: PricePoint["source"]; note?: string; observedAt?: string },
): Promise<{ watch: PriceWatch; alerts: Omit<PriceAlert, "id" | "seen" | "createdAt">[] }> {
  if (!Number.isSafeInteger(p.priceCents) || p.priceCents <= 0) throw new AppError(400, "invalid_price", "priceCents must be a positive integer");
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(`SELECT ${watchColumns} FROM price_watches WHERE id = $1 AND user_id = $2 FOR UPDATE`, [watchId, userId]);
    const w: PriceWatch | undefined = rows[0];
    if (!w) throw new AppError(404, "not_found", "price watch not found");
    if (w.status === "bought" || w.status === "stopped") throw new AppError(409, "not_watching", `this watch is ${w.status}`);

    const prev = await tx.query(
      `SELECT price_cents AS "priceCents" FROM price_points WHERE watch_id = $1 AND observed_at <= COALESCE($2::timestamptz, now())
        ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [watchId, p.observedAt ?? null],
    );
    const previous: number | null = prev.rows[0]?.priceCents ?? null;
    await tx.query("INSERT INTO price_points (watch_id, price_cents, source, note, observed_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))", [
      watchId, p.priceCents, p.source, p.note?.slice(0, 200) ?? null, p.observedAt ?? null,
    ]);
    const latest = await tx.query(`SELECT price_cents AS "priceCents" FROM price_points WHERE watch_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1`, [watchId]);
    const current: number = latest.rows[0].priceCents;
    const isLatest = current === p.priceCents;

    const alerts: Omit<PriceAlert, "id" | "seen" | "createdAt">[] = [];
    const deal = p.note ? ` (${p.note})` : "";
    let status = w.status;
    if (isLatest && p.priceCents <= w.targetPriceCents && w.status === "watching") {
      status = "target_hit";
      alerts.push({
        type: "target_hit", priceCents: p.priceCents,
        message: `${w.title} is ${usd(p.priceCents)}${deal}, at or below your target of ${usd(w.targetPriceCents)}. Deals can end quickly: ${w.url}`,
      });
    } else if (isLatest && p.priceCents > w.targetPriceCents && w.status === "target_hit") {
      status = "watching";
      alerts.push({ type: "price_up", priceCents: p.priceCents, message: `${w.title} went back up to ${usd(p.priceCents)}; the deal ended. Still watching for ${usd(w.targetPriceCents)}.` });
    }
    if (!alerts.some((a) => a.type === "target_hit") && w.lowestSeenCents !== null && p.priceCents < w.lowestSeenCents) {
      alerts.push({ type: "new_low", priceCents: p.priceCents, message: `${w.title} hit a new low: ${usd(p.priceCents)}${deal} (was ${usd(w.lowestSeenCents)}). Your target is ${usd(w.targetPriceCents)}.` });
    } else if (alerts.length === 0 && previous !== null && p.priceCents <= Math.floor(previous * 0.9)) {
      alerts.push({ type: "big_drop", priceCents: p.priceCents, message: `${w.title} dropped ${Math.round((1 - p.priceCents / previous) * 100)}% to ${usd(p.priceCents)}${deal}.` });
    }

    for (const a of alerts) {
      await tx.query("INSERT INTO price_alerts (watch_id, type, message, price_cents) VALUES ($1, $2, $3, $4)", [watchId, a.type, a.message, a.priceCents]);
    }
    await tx.query(
      `UPDATE price_watches SET current_price_cents = $2, lowest_seen_cents = LEAST(COALESCE(lowest_seen_cents, $3), $3), status = $4,
              target_hit_at = CASE WHEN $4 = 'target_hit' AND status <> 'target_hit' THEN now() ELSE target_hit_at END
        WHERE id = $1`,
      [watchId, current, p.priceCents, status],
    );
    return { watch: await getWatch(tx, userId, watchId), alerts };
  });
}

export async function listWatches(db: Db, userId: string, opts: { includeEnded?: boolean } = {}) {
  const { rows } = await db.query(
    `SELECT ${watchColumns} FROM price_watches WHERE user_id = $1 ${opts.includeEnded ? "" : "AND status IN ('watching','target_hit')"}
      ORDER BY (status = 'target_hit') DESC, created_at DESC`,
    [userId],
  );
  const timing = saleTiming();
  return Promise.all(
    rows.map(async (w: PriceWatch) => {
      const [points, alerts] = await Promise.all([
        db.query(
          `SELECT price_cents AS "priceCents", source, note, observed_at AS "observedAt" FROM price_points WHERE watch_id = $1 ORDER BY observed_at DESC LIMIT 30`,
          [w.id],
        ),
        db.query(
          `SELECT id, type, message, price_cents AS "priceCents", seen, created_at AS "createdAt" FROM price_alerts WHERE watch_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [w.id],
        ),
      ]);
      return { ...w, history: points.rows as PricePoint[], alerts: alerts.rows as PriceAlert[], advice: advice(w, timing) };
    }),
  );
}

export async function unseenAlerts(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT a.id, a.type, a.message, a.price_cents AS "priceCents", a.created_at AS "createdAt", w.id AS "watchId", w.title
       FROM price_alerts a JOIN price_watches w ON w.id = a.watch_id
      WHERE w.user_id = $1 AND NOT a.seen ORDER BY a.created_at DESC`,
    [userId],
  );
  return rows;
}

export async function markAlertsSeen(db: Db, userId: string) {
  await db.query("UPDATE price_alerts a SET seen = true FROM price_watches w WHERE w.id = a.watch_id AND w.user_id = $1 AND NOT a.seen", [userId]);
}

export async function updateWatch(db: Db, userId: string, id: string, input: { targetPriceCents?: number; title?: string; expiresOn?: string | null; notes?: string | null }) {
  const w = await getWatch(db, userId, id);
  if (input.targetPriceCents !== undefined && (!Number.isSafeInteger(input.targetPriceCents) || input.targetPriceCents <= 0)) {
    throw new AppError(400, "invalid_price", "targetPriceCents must be a positive integer");
  }
  const target = input.targetPriceCents ?? w.targetPriceCents;
  // Changing the target re-evaluates whether the current price meets it.
  const status = w.status === "bought" || w.status === "stopped" ? w.status : w.currentPriceCents !== null && w.currentPriceCents <= target ? "target_hit" : "watching";
  await db.query(
    `UPDATE price_watches SET target_price_cents = $3, title = COALESCE($4, title), expires_on = CASE WHEN $5::boolean THEN $6::date ELSE expires_on END,
            notes = CASE WHEN $7::boolean THEN $8 ELSE notes END, status = $9 WHERE id = $1 AND user_id = $2`,
    [id, userId, target, input.title ?? null, input.expiresOn !== undefined, input.expiresOn ?? null, input.notes !== undefined, input.notes ?? null, status],
  );
  return getWatch(db, userId, id);
}

/**
 * Record that the item was bought. If a buy mandate covered it, the mandate is
 * used up, and an agent purchase above the mandate's limit is recorded as an incident.
 */
export async function markBought(db: Db, userId: string, id: string, priceCents?: number, agentKey: AgentKey | null = null) {
  const w = await getWatch(db, userId, id);
  if (w.status === "bought") throw new AppError(409, "already_bought", "already marked as bought");
  const paid = priceCents ?? w.currentPriceCents;
  if (agentKey && paid == null) throw new AppError(400, "price_required", "give the price you actually paid (priceCents)");
  const mandate = await withTx(db, async (tx) => {
    await tx.query("UPDATE price_watches SET status = 'bought', bought_at = now(), bought_price_cents = $3 WHERE id = $1 AND user_id = $2", [id, userId, paid]);
    const used = await useMandate(tx, userId, id, paid, agentKey?.id ?? null);
    await recordPurchase(tx, userId, { source: "price_watch", sourceId: id, store: w.retailer, title: w.title, totalCents: paid }, agentKey);
    if (used && !used.within && agentKey) {
      await reportIncidentTx(
        tx, userId,
        { kind: "condition_breach", agentKeyId: agentKey.id, amountCents: paid === null ? 0 : Math.max(0, paid - used.maxPriceCents),
          description: `${w.title} was bought for ${paid === null ? "an unknown price" : usd(paid)}, above the mandate's ${usd(used.maxPriceCents)} limit` },
        "agent",
      );
    }
    return used;
  });
  return { ...(await getWatch(db, userId, id)), mandate };
}

export async function stopWatch(db: Db, userId: string, id: string) {
  await getWatch(db, userId, id);
  await db.query("UPDATE price_watches SET status = 'stopped' WHERE id = $1 AND user_id = $2", [id, userId]);
}

/** Stop watches whose end date passed. */
export async function expireWatches(db: Db, today = new Date().toISOString().slice(0, 10)) {
  const { rowCount } = await db.query("UPDATE price_watches SET status = 'stopped' WHERE status IN ('watching','target_hit') AND expires_on < $1::date", [today]);
  return rowCount ?? 0;
}

// ---------------------------------------------------------------- sale timing

export interface SaleEvent {
  name: string;
  date?: string; // only for events with a fixed rule (Black Friday, Cyber Monday)
  window?: string; // "usually ..." for events Amazon announces each year
  daysAway: number;
}

/** US Thanksgiving: fourth Thursday of November. */
function thanksgiving(year: number): Date {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstThursday = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, 10, firstThursday + 21));
}

/**
 * Upcoming sale events. Black Friday and Cyber Monday follow a fixed rule.
 * Amazon's Prime Day and October Prime event dates are announced each year,
 * so they're given as typical windows only.
 */
export function saleTiming(today = new Date().toISOString().slice(0, 10)): SaleEvent[] {
  const t = Date.parse(today + "T00:00:00Z");
  const days = (d: Date) => Math.round((d.getTime() - t) / 86_400_000);
  const events: SaleEvent[] = [];
  for (const year of [new Date(t).getUTCFullYear(), new Date(t).getUTCFullYear() + 1]) {
    const tg = thanksgiving(year);
    const bf = new Date(tg.getTime() + 86_400_000);
    const cm = new Date(tg.getTime() + 4 * 86_400_000);
    events.push({ name: "Black Friday", date: bf.toISOString().slice(0, 10), daysAway: days(bf) });
    events.push({ name: "Cyber Monday", date: cm.toISOString().slice(0, 10), daysAway: days(cm) });
    // Typical windows; mid-month used only to order them and estimate distance.
    events.push({ name: "Prime Day", window: `usually in July ${year} (Amazon announces the dates a few weeks ahead)`, daysAway: days(new Date(Date.UTC(year, 6, 15))) });
    events.push({ name: "Prime Big Deal Days", window: `usually early to mid October ${year} (dates announced a few weeks ahead)`, daysAway: days(new Date(Date.UTC(year, 9, 10))) });
  }
  return events.filter((e) => e.daysAway >= (e.window ? -10 : 0)).sort((a, b) => a.daysAway - b.daysAway).slice(0, 4);
}

function advice(w: PriceWatch, timing: SaleEvent[]): string[] {
  const out: string[] = [];
  if (w.status === "target_hit") out.push(`At or below your target now (${usd(w.currentPriceCents!)}). Buy soon if you still want it.`);
  if (w.currentPriceCents !== null && w.lowestSeenCents !== null && w.status === "watching") {
    const gap = w.currentPriceCents - w.targetPriceCents;
    out.push(`Now ${usd(w.currentPriceCents)}, ${usd(gap)} above your target. Lowest seen: ${usd(w.lowestSeenCents)}.`);
    if (w.lowestSeenCents > w.targetPriceCents) out.push("Your target is below any price seen so far; it may take a big sale to reach it.");
  }
  if (w.status === "watching" && w.retailer === "amazon") {
    for (const e of timing.filter((e) => e.daysAway <= 60)) {
      out.push(e.date ? `${e.name} is ${e.date} (${e.daysAway} days away). Many items drop then.` : `${e.name}: ${e.window}.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Keepa (optional automatic prices)

/**
 * Parse a Keepa /product response into the current Amazon price, or the
 * lowest new offer if Amazon itself isn't selling it.
 *
 * Based on Keepa's documented format (stats.current indexed by price type:
 * 0 = Amazon, 1 = new marketplace; integer cents; -1 = no offer). Only
 * verified against sample responses, not a live key.
 */
export function parseKeepaProduct(json: unknown): { priceCents: number | null; title: string | null } {
  const product = (json as { products?: { title?: string; stats?: { current?: number[] } }[] })?.products?.[0];
  const current = product?.stats?.current ?? [];
  const amazon = current[0];
  const marketplace = current[1];
  const priceCents = typeof amazon === "number" && amazon > 0 ? amazon : typeof marketplace === "number" && marketplace > 0 ? marketplace : null;
  return { priceCents, title: product?.title ?? null };
}

const KEEPA_DOMAINS: Record<string, number> = { com: 1, "co.uk": 2, de: 3, fr: 4, "co.jp": 5, ca: 6, it: 8, es: 9, in: 10, "com.mx": 11 };

/** Refresh Amazon watches from Keepa. Runs only when KEEPA_API_KEY is set. */
export async function refreshFromKeepa(db: Db, apiKey: string, fetchImpl: typeof fetch = fetch) {
  const { rows } = await db.query(
    `SELECT w.id, w.user_id AS "userId", w.url, w.product_key AS asin FROM price_watches w
      WHERE w.status IN ('watching','target_hit') AND w.retailer = 'amazon' AND w.product_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM price_points p WHERE p.watch_id = w.id AND p.source = 'keepa' AND p.observed_at > now() - interval '6 hours')`,
  );
  let updated = 0;
  for (const r of rows) {
    const tld = new URL(r.url).hostname.replace(/^www\.amazon\./, "");
    const domain = KEEPA_DOMAINS[tld];
    if (!domain) continue;
    try {
      const res = await fetchImpl(`https://api.keepa.com/product?key=${encodeURIComponent(apiKey)}&domain=${domain}&asin=${r.asin}&stats=1`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const { priceCents } = parseKeepaProduct(await res.json());
      if (priceCents) {
        await recordPrice(db, r.userId, r.id, { priceCents, source: "keepa" });
        updated++;
      }
    } catch (err) {
      console.error(`keepa refresh failed for ${r.asin}: ${(err as Error).message}`);
    }
  }
  return updated;
}
