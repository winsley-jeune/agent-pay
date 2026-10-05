import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import {
  addWatch,
  listWatches,
  markBought,
  parseKeepaProduct,
  parseProductUrl,
  recordPrice,
  refreshFromKeepa,
  saleTiming,
  updateWatch,
} from "../src/pricewatch.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

describe("product links", () => {
  it("pulls the ASIN out of the usual Amazon link shapes and drops tracking", () => {
    expect(parseProductUrl("https://www.amazon.com/Sony-WH-1000XM5-Canceling-Headphones/dp/B09XS7JWHH/ref=sr_1_3?crid=2X&tag=someone-20")).toEqual({
      url: "https://www.amazon.com/dp/B09XS7JWHH", retailer: "amazon", productKey: "B09XS7JWHH",
    });
    expect(parseProductUrl("https://amazon.com/gp/product/b0bdhwdr12?th=1").productKey).toBe("B0BDHWDR12");
    expect(parseProductUrl("https://www.amazon.ca/dp/B09XS7JWHH").url).toBe("https://www.amazon.ca/dp/B09XS7JWHH");
    expect(parseProductUrl("https://amzn.to/3xYz")).toMatchObject({ retailer: "amazon", productKey: null });
    expect(parseProductUrl("https://www.bestbuy.com/site/sony-headphones/6505727.p?skuId=6505727")).toMatchObject({ retailer: "bestbuy.com", productKey: null });
    expect(() => parseProductUrl("not a link")).toThrow(/full product link/);
  });
});

describe("price alerts", () => {
  async function watch(target = 27_900, current = 39_999) {
    const { user } = await setup(db);
    const { watch: w } = await addWatch(db, user.id, { url: `https://www.amazon.com/dp/B0TEST${Math.random().toString(36).slice(2, 6).toUpperCase()}`, title: "Headphones", targetPriceCents: target, currentPriceCents: current });
    return { user, w };
  }

  it("fires target_hit exactly once, then price_up when the deal ends, and again on the next hit", async () => {
    const { user, w } = await watch();
    const hit = await recordPrice(db, user.id, w.id, { priceCents: 27_800, source: "agent", note: "Lightning deal" });
    expect(hit.alerts.map((a) => a.type)).toEqual(["target_hit"]);
    expect(hit.alerts[0].message).toMatch(/Lightning deal/);
    expect(hit.watch.status).toBe("target_hit");

    const stillLow = await recordPrice(db, user.id, w.id, { priceCents: 27_500, source: "agent" });
    expect(stillLow.alerts.map((a) => a.type)).toEqual(["new_low"]); // no second target_hit

    const up = await recordPrice(db, user.id, w.id, { priceCents: 34_900, source: "agent" });
    expect(up.alerts.map((a) => a.type)).toEqual(["price_up"]);
    expect(up.watch.status).toBe("watching");

    const again = await recordPrice(db, user.id, w.id, { priceCents: 27_900, source: "agent" });
    expect(again.alerts.map((a) => a.type)).toEqual(["target_hit"]);
  });

  it("only calls it a new low when it is strictly lower than every earlier price", async () => {
    const { user, w } = await watch(10_000, 39_999);
    expect((await recordPrice(db, user.id, w.id, { priceCents: 35_000, source: "agent" })).alerts.map((a) => a.type)).toEqual(["new_low"]);
    expect((await recordPrice(db, user.id, w.id, { priceCents: 38_000, source: "agent" })).alerts).toEqual([]);
    expect((await recordPrice(db, user.id, w.id, { priceCents: 35_000, source: "agent" })).alerts).toEqual([]); // equal is not a new low
  });

  it("measures a big drop against the previous price, not the first", async () => {
    const { user, w } = await watch(10_000, 30_000);
    await recordPrice(db, user.id, w.id, { priceCents: 40_000, source: "agent" }); // up from first
    const r = await recordPrice(db, user.id, w.id, { priceCents: 35_000, source: "agent" }); // -12.5% vs previous, above lowest
    expect(r.alerts).toEqual([expect.objectContaining({ type: "big_drop", message: expect.stringContaining("13%") })]);
    const small = await recordPrice(db, user.id, w.id, { priceCents: 33_000, source: "agent" }); // -5.7%
    expect(small.alerts).toEqual([]);
  });

  it("re-checks the target when the owner changes it, and stops alerting once bought", async () => {
    const { user, w } = await watch(27_900, 31_000);
    expect((await updateWatch(db, user.id, w.id, { targetPriceCents: 32_000 })).status).toBe("target_hit");
    const bought = await markBought(db, user.id, w.id);
    expect(bought).toMatchObject({ status: "bought", boughtPriceCents: 31_000 });
    await expect(recordPrice(db, user.id, w.id, { priceCents: 20_000, source: "agent" })).rejects.toMatchObject({ code: "not_watching" });
  });

  it("won't watch the same item twice", async () => {
    const { user } = await setup(db);
    await addWatch(db, user.id, { url: "https://www.amazon.com/dp/B0DUPL1CAT", targetPriceCents: 100 });
    await expect(addWatch(db, user.id, { url: "https://www.amazon.com/x/dp/B0DUPL1CAT?ref=y", targetPriceCents: 200 })).rejects.toMatchObject({ code: "already_watching" });
  });
});

describe("sale timing", () => {
  it("gives exact Black Friday and Cyber Monday dates but only typical windows for Prime events", () => {
    const t = saleTiming("2026-10-05");
    expect(t.find((e) => e.name === "Black Friday")).toMatchObject({ date: "2026-11-27", daysAway: 53 });
    expect(t.find((e) => e.name === "Cyber Monday")).toMatchObject({ date: "2026-11-30" });
    const prime = t.find((e) => e.name === "Prime Big Deal Days")!;
    expect(prime.date).toBeUndefined();
    expect(prime.window).toMatch(/usually early to mid October 2026/);
    // Black Friday 2025 was Nov 28.
    expect(saleTiming("2025-11-01").find((e) => e.name === "Black Friday")?.date).toBe("2025-11-28");
  });

  it("includes the advice on each watch", async () => {
    const { user } = await setup(db);
    await addWatch(db, user.id, { url: "https://www.amazon.com/dp/B0ADV1CE00", title: "Robot vacuum", targetPriceCents: 19_900, currentPriceCents: 27_999 });
    const [w] = await listWatches(db, user.id);
    expect(w.advice.join(" ")).toMatch(/\$80\.99 above your target/);
    expect(w.history).toHaveLength(1);
  });
});

describe("Keepa (optional)", () => {
  it("reads the Amazon price, falling back to the lowest new offer", () => {
    expect(parseKeepaProduct({ products: [{ title: "X", stats: { current: [27999, 26500] } }] })).toEqual({ priceCents: 27999, title: "X" });
    expect(parseKeepaProduct({ products: [{ stats: { current: [-1, 26500] } }] }).priceCents).toBe(26500);
    expect(parseKeepaProduct({ products: [] }).priceCents).toBeNull();
  });

  it("records Keepa prices for Amazon watches and raises alerts", async () => {
    const { user } = await setup(db);
    const { watch: w } = await addWatch(db, user.id, { url: "https://www.amazon.com/dp/B0KEEPA001", targetPriceCents: 25_000, currentPriceCents: 29_900 });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ products: [{ stats: { current: [24_999, -1] } }] }));
    }) as unknown as typeof fetch;
    expect(await refreshFromKeepa(db, "k3y", fetchImpl)).toBeGreaterThanOrEqual(1);
    expect(urls.find((u) => u.includes("asin=B0KEEPA001"))).toMatch(/domain=1/);
    const [listed] = (await listWatches(db, user.id)).filter((x) => x.id === w.id);
    expect(listed).toMatchObject({ status: "target_hit", currentPriceCents: 24_999 });
    expect(listed.history[0].source).toBe("keepa");
  });
});
