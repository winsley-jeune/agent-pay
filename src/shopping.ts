import type { Db, Tx } from "./db.js";
import { AppError } from "./errors.js";
import { refusalMessage, screen } from "./policy.js";

// Choosing a product when a store shows many versions of one list item
// ("carrots": 1 lb, 2 lb, 5 lb, baby, organic, shredded, carrot cake...).
// The agent passes the options it sees on the page; AgentPay picks one with
// reasons, using the owner's preferences and what they bought before.

export interface Preferences {
  organic: "prefer" | "avoid" | "no_preference";
  storeBrand: "prefer" | "ok" | "avoid";
  sizeStrategy: "match_list" | "best_value" | "smallest";
  brandsPrefer: string[];
  brandsAvoid: string[];
  dietary: string[];
  minRating: number;
  substitutionPolicy: "similar" | "ask" | "skip";
}

export const DEFAULT_PREFERENCES: Preferences = {
  organic: "no_preference", storeBrand: "ok", sizeStrategy: "match_list", brandsPrefer: [], brandsAvoid: [], dietary: [], minRating: 3.5, substitutionPolicy: "similar",
};

export interface Candidate {
  name: string;
  priceCents: number;
  sizeText?: string | null;
  brand?: string | null;
  organic?: boolean | null;
  storeBrand?: boolean | null;
  rating?: number | null;
  inStock?: boolean | null;
  url?: string | null;
  dietaryTags?: string[] | null;
}

export interface ListItemInput {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
}

export interface Memory {
  productName: string;
  productUrl: string | null;
  timesBought: number;
}

// ---------------------------------------------------------------- words and sizes

const singular = (w: string) =>
  w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("oes") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9%\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(singular);
}

export const itemKey = (name: string) => words(name).join(" ");

// Words that don't change what the product is.
const NEUTRAL = new Set(
  ("fresh organic whole natural all bag bagged pack package pkg value size family count ct each ea lb pound oz ounce fl " +
    "kg g gal gallon quart qt pint pt liter l ml dozen bunch box bottle jar can carton container tray loose premium " +
    "grade a aa usda certified non gmo farm farms grown product of usa great freshness guaranteed marketside 365 by " +
    "market food foods brand new and with the of for in x").split(" "),
);

// Words that turn it into a different product: never pick these unless the list asks for them.
const PRODUCT_CHANGERS = new Set(
  ("cake juice chip crisp soup sauce bread muffin cookie bar powder seed mix dressing candy pie puree smoothie " +
    "drink flavored flavor spread dip jam jelly baby-food frosting pizza fries tot tots cereal oil extract supplement " +
    "vitamin snack cracker gummy gum ice cream yogurt-covered dried pickled").split(" ").map(singular),
);

// Words that change the form: allowed, but plain wins unless chosen before.
const FORM_WORDS = new Set("baby shredded diced sliced chopped mini crinkle peeled cut matchstick spiral riced frozen canned steamable petite".split(" ").map(singular));

const GRADES = ["small", "medium", "large", "extra large", "jumbo"];
const gradeOf = (text: string) => {
  const t = text.toLowerCase();
  if (/extra[\s-]large|\bxl\b/.test(t)) return "extra large";
  return GRADES.find((g) => g !== "extra large" && new RegExp(`\\b${g}\\b`).test(t)) ?? null;
};

type Family = "weight" | "volume" | "count";
interface Size {
  amount: number;
  family: Family;
}

const UNIT_TABLE: [RegExp, Family, number][] = [
  [/^(lb|lbs|pound|pounds)$/, "weight", 16],
  [/^(oz|ounce|ounces)$/, "weight", 1],
  [/^(kg|kilogram|kilograms)$/, "weight", 35.274],
  [/^(g|gram|grams)$/, "weight", 0.035274],
  [/^(gal|gallon|gallons)$/, "volume", 128],
  [/^(qt|quart|quarts)$/, "volume", 32],
  [/^(pt|pint|pints)$/, "volume", 16],
  [/^(fl oz|floz)$/, "volume", 1],
  [/^(l|liter|liters|litre|litres)$/, "volume", 33.814],
  [/^(ml)$/, "volume", 0.033814],
  [/^(ct|count|each|ea|pack|pk|bunch|bunches|piece|pieces|pc)$/, "count", 1],
  [/^(dozen|doz)$/, "count", 12],
];

function unitFamily(unit: string): [Family, number] | null {
  const u = unit.toLowerCase().replace(/\.$/, "").trim();
  for (const [re, family, factor] of UNIT_TABLE) if (re.test(u)) return [family, factor];
  return null;
}

/** "2 lb bag" -> 32 oz weight; "1 gal" -> 128 fl oz; "12 ct" -> 12 count; "half gallon" -> 64 fl oz. */
export function parseSize(text: string | null | undefined): Size | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/half[\s-]gallon/, "0.5 gal").replace(/fl\.?\s*oz/, "floz");
  const m = t.match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|oz|ounces?|kg|kilograms?|g|grams?|gal|gallons?|qt|quarts?|pt|pints?|floz|l|liters?|litres?|ml|ct|count|each|ea|pk|pack|dozen|doz)\b/);
  if (m) {
    const f = unitFamily(m[2]);
    if (f) return { amount: Number(m[1]) * f[1], family: f[0] };
  }
  if (/\b(dozen)\b/.test(t)) return { amount: 12, family: "count" };
  if (/\b(each|ea|bunch)\b/.test(t)) return { amount: 1, family: "count" };
  return null;
}

/** What the list asks for: "2 lb" -> 32 oz; "x2" with no unit -> 2 packs; nothing -> 1 pack. */
function need(item: ListItemInput): { size: Size | null; packs: number } {
  if (item.quantity && item.unit) {
    const f = unitFamily(item.unit);
    if (f) return { size: { amount: item.quantity * f[1], family: f[0] }, packs: 1 };
  }
  return { size: null, packs: item.quantity && item.quantity > 0 ? Math.ceil(item.quantity) : 1 };
}

// ---------------------------------------------------------------- picking

export interface PickResult {
  chosen: (Candidate & { index: number }) | null;
  packs: number;
  totalCents: number | null;
  reasons: string[];
  confidence: "high" | "medium" | "low";
  askOwner: boolean;
  alternatives: { index: number; name: string; packs: number; totalCents: number; note: string }[];
  skipped: { index: number; name: string; reason: string }[];
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const has = (list: string[], value: string | null | undefined) => !!value && list.some((b) => b.toLowerCase() === value.toLowerCase());
const STORE_BRANDS = ["great value", "marketside", "freshness guaranteed", "equate", "mainstays", "365 by whole foods market", "365", "whole foods market"];

export function pickProduct(item: ListItemInput, prefs: Preferences, memory: Memory | null, candidates: Candidate[]): PickResult {
  const itemWords = new Set(words(item.name));
  const noteWords = new Set(item.notes ? words(item.notes) : []);
  const wantedGrade = gradeOf(`${item.name} ${item.notes ?? ""}`);
  const want = need(item);
  const skipped: PickResult["skipped"] = [];
  const memoryKey = memory ? itemKey(memory.productName) : null;

  type Scored = { index: number; c: Candidate; packs: number; total: number; score: number; notes: string[]; fromMemory: boolean };
  const scored: Scored[] = [];

  candidates.forEach((c, index) => {
    const cw = words(c.name);
    const brandWords = new Set(c.brand ? words(c.brand) : []);
    const fromMemory = !!memory && ((!!memory.productUrl && c.url === memory.productUrl) || itemKey(c.name) === memoryKey);
    const skip = (reason: string) => skipped.push({ index, name: c.name, reason });

    const refused = screen(`${c.name} ${c.brand ?? ""}`) ?? screen(item.name);
    if (refused) return skip(refusalMessage(refused));
    if (c.inStock === false) return skip("out of stock");
    if (!Number.isSafeInteger(c.priceCents) || c.priceCents <= 0) return skip("no price");
    if (has(prefs.brandsAvoid, c.brand)) return skip(`brand ${c.brand} is on your avoid list`);
    const missingDiet = prefs.dietary.filter((d) => !(c.dietaryTags ?? []).map((t) => t.toLowerCase()).includes(d.toLowerCase()) && !c.name.toLowerCase().includes(d.toLowerCase()));
    if (missingDiet.length) return skip(`not marked ${missingDiet.join(", ")}`);
    if (![...itemWords].every((w) => cw.includes(w))) return skip(`doesn't match "${item.name}"`);
    const extra = cw.filter((w) => !itemWords.has(w) && !noteWords.has(w) && !brandWords.has(w) && !NEUTRAL.has(w) && !/^\d/.test(w) && !GRADES.includes(w));
    const changers = extra.filter((w) => PRODUCT_CHANGERS.has(w));
    if (changers.length && !fromMemory) return skip(`is a different product (${changers.join(", ")})`);
    const grade = gradeOf(c.name);
    if (wantedGrade && grade && grade !== wantedGrade && !fromMemory) return skip(`${grade}, list says ${wantedGrade}`);

    const notes: string[] = [];
    let multiplier = 1;
    const forms = extra.filter((w) => FORM_WORDS.has(w));
    if (forms.length && !fromMemory) {
      multiplier *= 1 + 0.25 * forms.length;
      notes.push(forms.join(", "));
    }
    multiplier *= 1 + 0.03 * (extra.length - forms.length);
    // Notes are what the owner asked for ("whole" milk), so they count even when the word is otherwise neutral.
    const missingNotes = [...noteWords].filter((w) => !cw.includes(w) && !GRADES.includes(w) && !/^\d/.test(w) && !["x", "and", "the", "of"].includes(w));
    if (missingNotes.length) {
      multiplier *= 1.3;
      notes.push(`not ${missingNotes.join(" ")}`);
    }

    const isStoreBrand = c.storeBrand ?? STORE_BRANDS.some((b) => c.name.toLowerCase().startsWith(b) || c.brand?.toLowerCase() === b);
    if (prefs.storeBrand === "prefer" && !isStoreBrand) multiplier *= 1.15;
    if (prefs.storeBrand === "avoid" && isStoreBrand) multiplier *= 1.3;
    if (has(prefs.brandsPrefer, c.brand)) multiplier *= 0.8;
    if (c.rating != null && c.rating < prefs.minRating) {
      multiplier *= 1.5;
      notes.push(`rated ${c.rating}`);
    }

    // Packs and cost to cover what the list asks for.
    const size = parseSize(c.sizeText ?? c.name);
    let packs = want.packs;
    let wasteRatio = 0;
    if (want.size && size && size.family === want.size.family) {
      packs = prefs.sizeStrategy === "smallest" ? 1 : Math.max(1, Math.ceil(want.size.amount / size.amount - 1e-9));
      wasteRatio = (packs * size.amount - want.size.amount) / want.size.amount;
    }
    const total = packs * c.priceCents;
    let score = total * multiplier;
    if (prefs.sizeStrategy === "match_list") score += total * 0.3 * Math.max(0, wasteRatio);
    if (prefs.sizeStrategy === "best_value" && size) score = (c.priceCents / size.amount) * (want.size?.amount ?? size.amount) * multiplier;
    if (fromMemory) {
      score *= 0.4;
      notes.push(`what you bought before (${memory!.timesBought}×)`);
    }
    scored.push({ index, c: { ...c, storeBrand: isStoreBrand }, packs, total, score, notes, fromMemory });
  });

  // Organic as a firm preference: if any acceptable option matches it, only consider those.
  let pool = scored;
  if (prefs.organic === "prefer" && scored.some((s) => isOrganic(s.c))) pool = scored.filter((s) => isOrganic(s.c) || s.fromMemory);
  if (prefs.organic === "avoid" && scored.some((s) => !isOrganic(s.c))) pool = scored.filter((s) => !isOrganic(s.c) || s.fromMemory);
  pool.sort((a, b) => a.score - b.score);

  const [best, second] = pool;
  if (!best) {
    return {
      chosen: null, packs: 0, totalCents: null, confidence: "low", askOwner: prefs.substitutionPolicy !== "skip", alternatives: [], skipped,
      reasons: [`Nothing on the page matches "${item.name}". ${prefs.substitutionPolicy === "skip" ? "Mark it unavailable." : "Ask the owner, or search with different words."}`],
    };
  }
  const reasons: string[] = [];
  if (best.fromMemory) reasons.push(`Same as you bought before (${memory!.timesBought}×).`);
  if (want.size && parseSize(best.c.sizeText ?? best.c.name)) {
    reasons.push(`${best.packs} × ${best.c.sizeText ?? "pack"} covers the ${item.quantity} ${item.unit} on your list for ${usd(best.total)}.`);
  } else if (best.packs > 1) reasons.push(`${best.packs} packs, as on your list.`);
  if (prefs.organic === "prefer" && isOrganic(best.c)) reasons.push("Organic, as you prefer.");
  if (prefs.storeBrand === "prefer" && best.c.storeBrand) reasons.push("Store brand, as you prefer.");
  if (!best.fromMemory && second) reasons.push(`Cheapest good match; next best is ${second.c.name} at ${usd(second.total)}.`);
  if (best.notes.length) reasons.push(`Note: ${best.notes.join("; ")}.`);
  const gap = second ? (second.score - best.score) / best.score : 1;
  const confidence: PickResult["confidence"] = best.fromMemory || gap >= 0.1 ? "high" : gap >= 0.02 ? "medium" : "low";
  return {
    chosen: { ...best.c, index: best.index },
    packs: best.packs,
    totalCents: best.total,
    reasons,
    confidence,
    // Decide by default; only ask when the top choices are nearly tied but differ on something the owner hasn't set a preference for.
    askOwner:
      confidence === "low" && !!second && prefs.organic === "no_preference" && isOrganic(best.c) !== isOrganic(second.c),
    alternatives: pool.slice(1, 4).map((s) => ({ index: s.index, name: s.c.name, packs: s.packs, totalCents: s.total, note: s.notes.join("; ") })),
    skipped,
  };
}

const isOrganic = (c: Candidate) => c.organic ?? /\borganic\b/i.test(c.name);

// ---------------------------------------------------------------- storage

const prefColumns = `organic, store_brand AS "storeBrand", size_strategy AS "sizeStrategy", brands_prefer AS "brandsPrefer",
  brands_avoid AS "brandsAvoid", dietary, min_rating::float8 AS "minRating", substitution_policy AS "substitutionPolicy"`;

export async function getPreferences(q: Db | Tx, userId: string): Promise<Preferences> {
  const { rows } = await q.query(`SELECT ${prefColumns} FROM shopping_preferences WHERE user_id = $1`, [userId]);
  return rows[0] ?? { ...DEFAULT_PREFERENCES };
}

export async function setPreferences(db: Db, userId: string, p: Partial<Preferences>) {
  const merged = { ...(await getPreferences(db, userId)), ...p };
  if (merged.minRating < 0 || merged.minRating > 5) throw new AppError(400, "invalid_rating", "minRating must be 0 to 5");
  await db.query(
    `INSERT INTO shopping_preferences (user_id, organic, store_brand, size_strategy, brands_prefer, brands_avoid, dietary, min_rating, substitution_policy, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (user_id) DO UPDATE SET organic = EXCLUDED.organic, store_brand = EXCLUDED.store_brand, size_strategy = EXCLUDED.size_strategy,
       brands_prefer = EXCLUDED.brands_prefer, brands_avoid = EXCLUDED.brands_avoid, dietary = EXCLUDED.dietary,
       min_rating = EXCLUDED.min_rating, substitution_policy = EXCLUDED.substitution_policy, updated_at = now()`,
    [userId, merged.organic, merged.storeBrand, merged.sizeStrategy, merged.brandsPrefer, merged.brandsAvoid, merged.dietary, merged.minRating, merged.substitutionPolicy],
  );
  return getPreferences(db, userId);
}

export async function memoryFor(q: Db | Tx, userId: string, store: string, itemName: string): Promise<Memory | null> {
  const { rows } = await q.query(
    `SELECT product_name AS "productName", product_url AS "productUrl", times_bought AS "timesBought"
       FROM product_memory WHERE user_id = $1 AND store = $2 AND item_key = $3`,
    [userId, store, itemKey(itemName)],
  );
  return rows[0] ?? null;
}

/** After an order is placed, remember what was bought for each list item. */
export async function rememberPurchases(tx: Tx, userId: string, listId: string) {
  const { rows } = await tx.query(
    `SELECT l.store, i.name, i.product_name AS "productName", i.product_url AS "productUrl", i.price_cents AS "priceCents"
       FROM grocery_items i JOIN grocery_lists l ON l.id = i.list_id
      WHERE i.list_id = $1 AND i.status IN ('in_cart','substituted') AND i.product_name IS NOT NULL AND l.store IS NOT NULL`,
    [listId],
  );
  for (const r of rows) {
    await tx.query(
      `INSERT INTO product_memory (user_id, store, item_key, product_name, product_url, last_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, store, item_key) DO UPDATE SET
         times_bought = CASE WHEN product_memory.product_name = EXCLUDED.product_name THEN product_memory.times_bought + 1 ELSE 1 END,
         product_name = EXCLUDED.product_name, product_url = EXCLUDED.product_url, last_price_cents = EXCLUDED.last_price_cents, last_bought_at = now()`,
      [userId, r.store, itemKey(r.name), r.productName, r.productUrl, r.priceCents],
    );
  }
}
