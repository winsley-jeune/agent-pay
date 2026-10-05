import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, deny, listApprovals } from "../src/approvals.js";
import type { Db } from "../src/db.js";
import {
  checkImage,
  createList,
  getList,
  markOrdered,
  parseTypedList,
  reopenList,
  requestOrderApproval,
  updateItem,
  updateList,
} from "../src/grocery.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const noPasskey = { requirePasskey: false };

describe("typed lists", () => {
  it("understands quantities, units and notes", () => {
    expect(parseTypedList("2 lb chicken thighs\nmilk x2\n- eggs (large, brown)\n3 avocados\n1/2 gallon orange juice\nbread")).toEqual([
      { name: "chicken thighs", quantity: 2, unit: "lb", notes: null },
      { name: "milk", quantity: 2, unit: null, notes: null },
      { name: "eggs", quantity: null, unit: null, notes: "large, brown" },
      { name: "avocados", quantity: 3, unit: null, notes: null },
      { name: "orange juice", quantity: 0.5, unit: "gallon", notes: null },
      { name: "bread", quantity: null, unit: null, notes: null },
    ]);
  });

  it("checks photos before sending them anywhere", () => {
    expect(checkImage("iVBORw0KGgo=", "image/png")).toBe("image/png");
    expect(() => checkImage("iVBORw0KGgo=", "application/pdf")).toThrow(/JPEG, PNG/);
    expect(() => checkImage("data:image/png;base64,AAAA", "image/png")).toThrow(/plain base64/);
    expect(() => checkImage("A".repeat(7_000_001), "image/jpeg")).toThrow(/over 5 MB/);
  });
});

describe("ordering flow", () => {
  async function shopped() {
    const { user, agentKey } = await setup(db);
    const list = await createList(db, user.id, { title: "Weekly", items: parseTypedList("milk\n2 lb bananas\nsourdough bread\nsaffron"), source: "typed" }, agentKey);
    await updateList(db, user.id, list.id, { store: "walmart" });
    const [milk, bananas, bread, saffron] = (await getList(db, user.id, list.id)).items;
    await updateItem(db, user.id, list.id, milk.id, { status: "in_cart", productName: "Great Value Whole Milk, 1 gal", priceCents: 368 });
    await updateItem(db, user.id, list.id, bananas.id, { status: "in_cart", productName: "Bananas, each (about 2 lb)", priceCents: 124 });
    await updateItem(db, user.id, list.id, bread.id, { status: "substituted", productName: "Freshness Guaranteed French Bread", substituteNote: "no sourdough in stock", priceCents: 248 });
    await updateItem(db, user.id, list.id, saffron.id, { status: "unavailable" });
    return { user, agentKey, listId: list.id };
  }

  it("builds search links for the chosen store and keeps a running total", async () => {
    const { user, listId } = await shopped();
    const list = await getList(db, user.id, listId);
    expect(list.items[0].searchUrl).toBe("https://www.walmart.com/search?q=milk");
    expect(list).toMatchObject({ status: "shopping", estimatedTotalCents: 368 + 124 + 248 });
    await updateList(db, user.id, listId, { store: "whole_foods" });
    expect((await getList(db, user.id, listId)).items[0].searchUrl).toBe("https://www.wholefoodsmarket.com/search?text=milk");
  });

  it("won't ask for approval while items are still open or unpriced", async () => {
    const { user, agentKey } = await setup(db);
    const list = await createList(db, user.id, { items: [{ name: "milk" }, { name: "eggs" }], store: "walmart", source: "typed" }, agentKey);
    await expect(requestOrderApproval(db, user.id, list.id, agentKey)).rejects.toMatchObject({ code: "items_open" });
    await updateItem(db, user.id, list.id, list.items[0].id, { status: "in_cart" });
    await updateItem(db, user.id, list.id, list.items[1].id, { status: "unavailable" });
    await expect(requestOrderApproval(db, user.id, list.id, agentKey)).rejects.toMatchObject({ code: "items_unpriced" });
  });

  it("asks the owner, then lets the agent record the order only within the approved total", async () => {
    const { user, agentKey, listId } = await shopped();
    await expect(markOrdered(db, user.id, listId, { totalCents: 740 }, true)).rejects.toMatchObject({ code: "not_approved" });

    const req = await requestOrderApproval(db, user.id, listId, agentKey);
    expect(req).toMatchObject({ estimatedTotalCents: 740, maxCents: 851 });
    const [pending] = await listApprovals(db, user.id, "pending");
    expect(pending.summary).toBe('Place Walmart order "Weekly" (4 items): about $7.40, up to $8.51 at checkout');

    await expect(approve(db, user.id, req.approvalId)).rejects.toMatchObject({ code: "passkey_required" });
    await approve(db, user.id, req.approvalId, undefined, noPasskey);
    expect((await getList(db, user.id, listId)).status).toBe("approved");

    // The cart can't change behind the owner's back once approved.
    const milk = (await getList(db, user.id, listId)).items[0];
    await expect(updateItem(db, user.id, listId, milk.id, { priceCents: 9999 })).rejects.toMatchObject({ code: "list_approved" });

    await expect(markOrdered(db, user.id, listId, { totalCents: 900 }, true)).rejects.toMatchObject({ code: "over_approved_total" });
    const done = await markOrdered(db, user.id, listId, { totalCents: 812, orderNumber: "WM-2000123" }, true);
    expect(done).toMatchObject({ status: "ordered", orderNumber: "WM-2000123", orderedTotalCents: 812 });
  });

  it("voids the pending approval if the cart changes before the owner answers", async () => {
    const { user, agentKey, listId } = await shopped();
    const req = await requestOrderApproval(db, user.id, listId, agentKey);
    const milk = (await getList(db, user.id, listId)).items[0];
    await updateItem(db, user.id, listId, milk.id, { priceCents: 2999 }); // agent swapped in something pricier
    await expect(approve(db, user.id, req.approvalId, undefined, noPasskey)).rejects.toMatchObject({ code: "not_pending" });
    expect((await getList(db, user.id, listId)).status).toBe("shopping");
  });

  it("goes back to shopping when the owner says no, and the owner can reopen an approved list", async () => {
    const { user, agentKey, listId } = await shopped();
    const r1 = await requestOrderApproval(db, user.id, listId, agentKey);
    await deny(db, user.id, r1.approvalId);
    expect((await getList(db, user.id, listId)).status).toBe("shopping");

    const r2 = await requestOrderApproval(db, user.id, listId, agentKey);
    await approve(db, user.id, r2.approvalId, undefined, noPasskey);
    expect((await reopenList(db, user.id, listId)).status).toBe("shopping");
    await expect(markOrdered(db, user.id, listId, { totalCents: 700 }, true)).rejects.toMatchObject({ code: "not_approved" });
  });
});
