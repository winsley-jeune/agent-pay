import express from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { h, parse } from "./http.js";
import { confirmReceived, getPurchase, listPurchases, purchaseReminders, recordPurchase, setPurchaseStatus, setReturnBy } from "./purchases.js";

/** Purchases for owners (/api/purchases) and agents (/api/agent/purchases). */
export function purchasesRoutes(db: Db, as: "owner" | "agent") {
  const r = express.Router();
  const userId = (req: express.Request) => (as === "owner" ? req.user!.id : req.agentKey!.userId);
  const agentKey = (req: express.Request) => (as === "agent" ? req.agentKey! : null);

  r.get("/", h(async (req) => ({ purchases: await listPurchases(db, userId(req), { open: req.query.all !== "1" }), reminders: await purchaseReminders(db, userId(req)) })));
  r.post(
    "/",
    h(async (req) => {
      const body = parse(
        z.object({
          store: z.string().min(1).max(80), title: z.string().min(1).max(200), orderNumber: z.string().max(80).optional(),
          totalCents: z.number().int().nonnegative().max(10_000_000).optional(), returnDays: z.number().int().min(0).max(365).optional(),
        }),
        req.body,
      );
      const id = await recordPurchase(db, userId(req), { ...body, source: as === "agent" ? "agent" : "manual" }, agentKey(req));
      return { purchase: await getPurchase(db, userId(req), id!) };
    }),
  );
  r.post(
    "/:id/received",
    h(async (req) =>
      confirmReceived(db, userId(req), String(req.params.id),
        parse(z.object({ missingItems: z.array(z.string().max(120)).max(50).optional(), note: z.string().max(500).optional() }), req.body), agentKey(req)),
    ),
  );
  if (as === "owner") {
    r.patch("/:id", h(async (req) => ({ purchase: await setReturnBy(db, userId(req), String(req.params.id), parse(z.object({ returnBy: z.string() }), req.body).returnBy) })));
    r.post("/:id/returned", h(async (req) => ({ purchase: await setPurchaseStatus(db, userId(req), String(req.params.id), "returned") })));
    r.post("/:id/close", h(async (req) => ({ purchase: await setPurchaseStatus(db, userId(req), String(req.params.id), "closed") })));
  }
  return r;
}
