import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, deny, listApprovals } from "../src/approvals.js";
import type { Db } from "../src/db.js";
import { checkAccess, currentConsent, listActivity, logActivity, normalizeSite, requestBrowserAccess, requestConsent, revokeGrant, withdrawConsent } from "../src/permissions.js";
import { freshDb, setup } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(() => db.end());

const ok = { requirePasskey: false };

async function consented() {
  const s = await setup(db);
  const c = await requestConsent(db, s.user.id);
  await approve(db, s.user.id, c.approvalId, undefined, ok);
  return s;
}

describe("site names", () => {
  it("normalises links and rejects junk", () => {
    expect(normalizeSite("https://www.walmart.com/cart?x=1")).toBe("walmart.com");
    expect(normalizeSite("Walmart.com")).toBe("walmart.com");
    expect(normalizeSite("grocery.walmart.com")).toBe("grocery.walmart.com");
    expect(() => normalizeSite("walmart")).toThrow(/website/);
  });
});

describe("browser permissions", () => {
  it("goes needs_consent -> needs_grant -> allowed only after the owner approves", async () => {
    const { user, agentKey } = await setup(db);
    expect((await checkAccess(db, user.id, "walmart.com", "add_to_cart")).status).toBe("needs_consent");
    await expect(requestBrowserAccess(db, user.id, agentKey, { site: "walmart.com", actions: ["add_to_cart"] })).rejects.toMatchObject({ code: "needs_consent" });

    const c = await requestConsent(db, user.id);
    expect(c.statement.paragraphs.join(" ")).toMatch(/never sees or types your passwords/);
    expect(c.statement.paragraphs.join(" ")).toMatch(/What AgentPay can't prevent/);
    await expect(approve(db, user.id, c.approvalId)).rejects.toMatchObject({ code: "passkey_required" });
    await approve(db, user.id, c.approvalId, undefined, ok);
    expect(await currentConsent(db, user.id)).not.toBeNull();
    expect((await checkAccess(db, user.id, "walmart.com", "add_to_cart")).status).toBe("needs_grant");

    const g = await requestBrowserAccess(db, user.id, agentKey, { site: "https://www.walmart.com/", actions: ["browse", "add_to_cart"], reason: "weekly groceries", days: 14 });
    expect(g.site).toBe("walmart.com");
    const [pending] = await listApprovals(db, user.id, "pending");
    expect(pending.summary).toBe("Let my agent use my signed-in walmart.com to look at products and prices, add and remove items in the cart, for 14 days");
    expect((await checkAccess(db, user.id, "walmart.com", "add_to_cart")).status).toBe("needs_grant"); // not until approved
    await approve(db, user.id, g.approvalId, undefined, ok);

    expect((await checkAccess(db, user.id, "https://www.walmart.com/ip/123", "add_to_cart")).status).toBe("allowed");
    expect((await checkAccess(db, user.id, "grocery.walmart.com", "browse")).status).toBe("allowed");
    // Not a different action, not a look-alike site.
    expect((await checkAccess(db, user.id, "walmart.com", "checkout_approved_order")).status).toBe("needs_grant");
    expect((await checkAccess(db, user.id, "walmart.com.evil.example", "browse")).status).toBe("needs_grant");
    expect((await checkAccess(db, user.id, "notwalmart.com", "browse")).status).toBe("needs_grant");
  });

  it("stops working when it expires, is revoked, or consent is withdrawn", async () => {
    const { user, agentKey } = await consented();
    const g = await requestBrowserAccess(db, user.id, agentKey, { site: "walmart.com", actions: ["browse"] });
    await approve(db, user.id, g.approvalId, undefined, ok);
    expect((await checkAccess(db, user.id, "walmart.com", "browse")).status).toBe("allowed");

    await db.query("UPDATE browser_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [g.grantId]);
    expect((await checkAccess(db, user.id, "walmart.com", "browse")).status).toBe("expired");

    const g2 = await requestBrowserAccess(db, user.id, agentKey, { site: "walmart.com", actions: ["browse"] });
    await approve(db, user.id, g2.approvalId, undefined, ok);
    await revokeGrant(db, user.id, g2.grantId);
    expect((await checkAccess(db, user.id, "walmart.com", "browse")).status).toBe("expired"); // the older one is still just expired

    const g3 = await requestBrowserAccess(db, user.id, agentKey, { site: "netflix.com", actions: ["manage_subscription"] });
    await approve(db, user.id, g3.approvalId, undefined, ok);
    await revokeGrant(db, user.id, g3.grantId);
    expect((await checkAccess(db, user.id, "netflix.com", "manage_subscription")).status).toBe("revoked");

    const g4 = await requestBrowserAccess(db, user.id, agentKey, { site: "wholefoodsmarket.com", actions: ["browse"] });
    await approve(db, user.id, g4.approvalId, undefined, ok);
    await withdrawConsent(db, user.id);
    expect((await checkAccess(db, user.id, "wholefoodsmarket.com", "browse")).status).toBe("needs_consent");
  });

  it("doesn't grant anything when the owner says no", async () => {
    const { user, agentKey } = await consented();
    const g = await requestBrowserAccess(db, user.id, agentKey, { site: "amazon.com", actions: ["checkout_approved_order"] });
    await deny(db, user.id, g.approvalId);
    expect((await checkAccess(db, user.id, "amazon.com", "checkout_approved_order")).status).toBe("needs_grant");
  });

  it("logs what the agent does, including attempts without permission", async () => {
    const { user, agentKey } = await consented();
    const g = await requestBrowserAccess(db, user.id, agentKey, { site: "walmart.com", actions: ["add_to_cart"] });
    await approve(db, user.id, g.approvalId, undefined, ok);
    await logActivity(db, user.id, agentKey, { site: "walmart.com", action: "add_to_cart", summary: "Added Fresh Whole Carrots, 2 lb" });
    const denied = await logActivity(db, user.id, agentKey, { site: "walmart.com", action: "checkout_approved_order", summary: "About to check out" });
    expect(denied.status).toBe("needs_grant");
    const log = await listActivity(db, user.id);
    expect(log.map((a) => [a.action, a.allowed])).toEqual([["checkout_approved_order", false], ["add_to_cart", true]]);
  });
});
