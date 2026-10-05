import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve } from "../src/approvals.js";
import type { Db } from "../src/db.js";
import { callPaidTool } from "../src/gateway.js";
import { createList, updateItem } from "../src/grocery.js";
import { checkAccess, requestBrowserAccess, requestConsent } from "../src/permissions.js";
import { screen, screenSite } from "../src/policy.js";
import { addWatch } from "../src/pricewatch.js";
import { createTool } from "../src/registry.js";
import { DEFAULT_PREFERENCES, pickProduct } from "../src/shopping.js";
import { fakeFetch, freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

describe("restricted categories", () => {
  it("recognises restricted items without catching everyday ones", () => {
    expect(screen("Bud Light beer 12 pack")?.category).toBe("alcohol");
    expect(screen("Cabernet Sauvignon red wine")?.category).toBe("alcohol");
    // Stores treat non-alcoholic beer like beer (ID check), so it is refused too.
    expect(screen("non-alcoholic beer")?.category).toBe("alcohol");
    expect(screen("Advil ibuprofen 200mg")?.category).toBe("medical");
    expect(screen("Mucinex cold & flu")?.category).toBe("medical");
    expect(screen("Tums antacid chews")?.category).toBe("medical");
    expect(screen("9mm ammunition, 50 rounds")?.category).toBe("weapons");
    expect(screen("THC gummies")?.category).toBe("drugs");
    expect(screen("Marlboro cigarettes")?.category).toBe("tobacco");
    expect(screen("XXX adult video subscription")?.category).toBe("adult");
    for (const fine of ["root beer", "red wine vinegar", "kale", "ginger", "glue gun sticks", "RXBAR protein bar", "alcohol-free hand soap", "rum extract", "burgundy towels"]) {
      expect(screen(fine), fine).toBeNull();
    }
  });

  it("recognises pharmacy and other restricted websites", () => {
    expect(screenSite("walgreens.com")?.category).toBe("medical");
    expect(screenSite("photo.cvs.com")?.category).toBe("medical");
    expect(screenSite("bestrxpharmacy.net")?.category).toBe("medical");
    expect(screenSite("totalwine.com")?.category).toBe("alcohol");
    expect(screenSite("walmart.com")).toBeNull();
    expect(screenSite("hammockstore.com")).toBeNull();
    expect(screenSite("essex.ac.uk")).toBeNull();
  });

  it("refuses browser access to pharmacy sites, even with consent", async () => {
    const { user, agentKey } = await setup(db);
    const c = await requestConsent(db, user.id);
    await approve(db, user.id, c.approvalId, undefined, { requirePasskey: false });
    await expect(requestBrowserAccess(db, user.id, agentKey, { site: "https://www.walgreens.com/", actions: ["browse"] })).rejects.toMatchObject({
      code: "restricted_category",
    });
    expect((await checkAccess(db, user.id, "cvs.com", "browse")).status).toBe("refused");
  });

  it("keeps restricted grocery items on the list as refused, and won't let them into the cart", async () => {
    const { user } = await setup(db);
    const list = await createList(db, user.id, { items: [{ name: "milk" }, { name: "beer", quantity: 6 }, { name: "Tylenol" }], source: "typed" });
    const byName = Object.fromEntries(list.items.map((i: { name: string; status: string; id: number }) => [i.name, i]));
    expect(byName.milk.status).toBe("needed");
    expect(byName.beer.status).toBe("refused");
    expect(byName.Tylenol.status).toBe("refused");
    await expect(updateItem(db, user.id, list.id, byName.beer.id, { status: "in_cart", productName: "Coors", priceCents: 999 })).rejects.toMatchObject({
      code: "restricted_category",
    });
    await expect(updateItem(db, user.id, list.id, byName.milk.id, { status: "substituted", productName: "Bailey's Irish cream liquor" })).rejects.toMatchObject({
      code: "restricted_category",
    });
  });

  it("skips restricted products when picking, refuses watches, tools and paid calls", async () => {
    const pick = pickProduct({ name: "cream" }, DEFAULT_PREFERENCES, null, [
      { name: "Irish cream liquor", priceCents: 1999 },
      { name: "Heavy cream", priceCents: 399 },
    ]);
    expect(pick.chosen?.name).toBe("Heavy cream");
    expect(pick.skipped[0].reason).toMatch(/^Refused/);

    const s = await setup(db, { credit: 1000 });
    await expect(addWatch(db, s.user.id, { url: "https://www.amazon.com/dp/B000000001", title: "Glock 19 pistol", targetPriceCents: 100 })).rejects.toMatchObject({
      code: "restricted_category",
    });
    await expect(addWatch(db, s.user.id, { url: "https://www.totalwine.com/p/123", title: "Gift box", targetPriceCents: 100 })).rejects.toMatchObject({
      code: "restricted_category",
    });
    await expect(
      createTool(db, s.provider.id, { slug: "rx-refills", name: "Prescription refills", description: "orders prescription refills", pricingType: "per_call", priceCents: 10, upstreamUrl: "https://x.example" }),
    ).rejects.toMatchObject({ code: "restricted_category" });

    // A tool listed before the policy (or past the word list) is still refused at call time.
    await db.query("UPDATE tools SET description = 'buys wine for you' WHERE id = $1", [s.tool.id]);
    await expect(callPaidTool(db, s.agentKey, { tool: s.tool.slug, input: {}, idempotencyKey: "p1" }, { fetchImpl: fakeFetch().impl })).rejects.toMatchObject({
      code: "restricted_category",
    });
  });
});
