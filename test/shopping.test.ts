import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { createList, getList, markOrdered, requestOrderApproval, updateItem, updateList } from "../src/grocery.js";
import { approve } from "../src/approvals.js";
import { DEFAULT_PREFERENCES, memoryFor, parseSize, pickProduct, setPreferences, getPreferences, type Candidate, type Preferences } from "../src/shopping.js";
import { freshDb, setup } from "./helpers.js";

const prefs = (p: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...p });

// What an agent might see searching "carrots" on a grocery site.
const carrots: Candidate[] = [
  { name: "Fresh Carrots, 1 lb Bag", priceCents: 129, sizeText: "1 lb", rating: 4.5 },
  { name: "Fresh Whole Carrots, 2 lb Bag", priceCents: 219, sizeText: "2 lb", rating: 4.6 },
  { name: "Fresh Carrots, 5 lb Bag", priceCents: 399, sizeText: "5 lb", rating: 4.4 },
  { name: "Marketside Fresh Baby Carrots, 1 lb", priceCents: 189, sizeText: "1 lb", rating: 4.7 },
  { name: "Organic Carrots, 2 lb Bag", priceCents: 349, sizeText: "2 lb", rating: 4.5 },
  { name: "Carrot Cake, 8 in", priceCents: 899, rating: 4.8 },
  { name: "Shredded Carrots, 10 oz", priceCents: 249, sizeText: "10 oz", inStock: false },
];
const item = { name: "carrots", quantity: 2, unit: "lb" };

describe("picking among many versions of an item", () => {
  it("parses common package sizes", () => {
    expect(parseSize("2 lb Bag")).toEqual({ amount: 32, family: "weight" });
    expect(parseSize("Whole Milk, 1 Gallon")).toEqual({ amount: 128, family: "volume" });
    expect(parseSize("Half Gallon")).toEqual({ amount: 64, family: "volume" });
    expect(parseSize("Large Eggs, 12 ct")).toEqual({ amount: 12, family: "count" });
    expect(parseSize("Eggs, 1 dozen")).toEqual({ amount: 12, family: "count" });
    expect(parseSize("Avocado, each")).toEqual({ amount: 1, family: "count" });
    expect(parseSize("Greek yogurt 32 fl oz")).toEqual({ amount: 32, family: "volume" });
  });

  it("buys the 2 lb bag for '2 lb carrots' and never the cake", () => {
    const r = pickProduct(item, prefs(), null, carrots);
    expect(r.chosen?.name).toBe("Fresh Whole Carrots, 2 lb Bag");
    expect(r).toMatchObject({ packs: 1, totalCents: 219, confidence: "high", askOwner: false });
    expect(r.reasons[0]).toMatch(/covers the 2 lb/);
    expect(r.skipped.map((s) => s.name)).toEqual(expect.arrayContaining(["Carrot Cake, 8 in", "Shredded Carrots, 10 oz"]));
    expect(r.skipped.find((s) => s.name.startsWith("Carrot Cake"))?.reason).toMatch(/different product/);
    // Two 1 lb bags cost more than one 2 lb bag; the 5 lb bag wastes 3 lb.
    expect(r.alternatives[0].name).toBe("Fresh Carrots, 1 lb Bag");
  });

  it("follows an organic preference", () => {
    expect(pickProduct(item, prefs({ organic: "prefer" }), null, carrots).chosen?.name).toBe("Organic Carrots, 2 lb Bag");
  });

  it("buys what the owner bought last time, even if it's baby carrots", () => {
    const r = pickProduct(item, prefs(), { productName: "Marketside Fresh Baby Carrots, 1 lb", productUrl: null, timesBought: 3 }, carrots);
    expect(r.chosen?.name).toBe("Marketside Fresh Baby Carrots, 1 lb");
    expect(r).toMatchObject({ packs: 2, totalCents: 378 });
    expect(r.reasons[0]).toMatch(/bought before \(3×\)/);
  });

  it("goes for the cheapest per pound when asked for best value", () => {
    expect(pickProduct(item, prefs({ sizeStrategy: "best_value" }), null, carrots).chosen?.name).toBe("Fresh Carrots, 5 lb Bag");
  });

  it("buys 2 of the right milk for 'milk (whole) x2'", () => {
    const milk: Candidate[] = [
      { name: "Great Value 2% Reduced Fat Milk, 1 Gallon", priceCents: 358 },
      { name: "Great Value Whole Milk, 1 Gallon", priceCents: 368 },
      { name: "Horizon Organic Whole Milk, Half Gallon", priceCents: 529 },
      { name: "Chocolate Milk, 1 Gallon", priceCents: 449 },
    ];
    const r = pickProduct({ name: "milk", quantity: 2, notes: "whole" }, prefs(), null, milk);
    expect(r.chosen?.name).toBe("Great Value Whole Milk, 1 Gallon");
    expect(r).toMatchObject({ packs: 2, totalCents: 736 });
  });

  it("respects egg size on the list", () => {
    const eggs: Candidate[] = [
      { name: "Great Value Jumbo White Eggs, 12 ct", priceCents: 289 },
      { name: "Great Value Large White Eggs, 12 ct", priceCents: 312 },
      { name: "Eggland's Best Large Brown Eggs, 12 ct", priceCents: 499 },
    ];
    const r = pickProduct({ name: "eggs", notes: "large" }, prefs(), null, eggs);
    expect(r.chosen?.name).toBe("Great Value Large White Eggs, 12 ct");
    expect(r.skipped[0]).toMatchObject({ name: "Great Value Jumbo White Eggs, 12 ct", reason: "jumbo, list says large" });
  });

  it("skips avoided brands and products that don't meet dietary needs", () => {
    const bread: Candidate[] = [
      { name: "Wonder Classic White Bread", priceCents: 248, brand: "Wonder" },
      { name: "Canyon Bakehouse Gluten-Free White Bread", priceCents: 649, brand: "Canyon Bakehouse", dietaryTags: ["gluten-free"] },
    ];
    const r = pickProduct({ name: "bread" }, prefs({ dietary: ["gluten-free"] }), null, bread);
    expect(r.chosen?.brand).toBe("Canyon Bakehouse");
    expect(pickProduct({ name: "bread" }, prefs({ brandsAvoid: ["Wonder"] }), null, bread.slice(0, 1)).chosen).toBeNull();
  });

  it("says so when nothing matches", () => {
    const r = pickProduct({ name: "saffron" }, prefs(), null, carrots);
    expect(r).toMatchObject({ chosen: null, askOwner: true, confidence: "low" });
  });
});

describe("preferences and memory", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(() => db.end());

  it("stores preferences and remembers what was ordered, per store", async () => {
    const { user, agentKey } = await setup(db);
    expect(await getPreferences(db, user.id)).toEqual(DEFAULT_PREFERENCES);
    expect(await setPreferences(db, user.id, { organic: "prefer", brandsAvoid: ["Wonder"] })).toMatchObject({ organic: "prefer", brandsAvoid: ["Wonder"], storeBrand: "ok" });

    const list = await createList(db, user.id, { items: [{ name: "Carrots", quantity: 2, unit: "lb" }], source: "typed", store: "walmart" }, agentKey);
    await updateItem(db, user.id, list.id, list.items[0].id, { status: "in_cart", productName: "Organic Carrots, 2 lb Bag", productUrl: "https://www.walmart.com/ip/123", priceCents: 349 });
    const req = await requestOrderApproval(db, user.id, list.id, agentKey);
    await approve(db, user.id, req.approvalId, undefined, { requirePasskey: false });
    expect(await memoryFor(db, user.id, "walmart", "carrots")).toBeNull(); // not remembered until ordered
    await markOrdered(db, user.id, list.id, { totalCents: 349 }, true);

    expect(await memoryFor(db, user.id, "walmart", "carrot")).toEqual({ productName: "Organic Carrots, 2 lb Bag", productUrl: "https://www.walmart.com/ip/123", timesBought: 1 });
    expect(await memoryFor(db, user.id, "whole_foods", "carrots")).toBeNull();
    void getList;
    void updateList;
  });
});
