import express from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { h, parse } from "./http.js";
import { addWatch, getWatch, listWatches, markAlertsSeen, markBought, recordPrice, saleTiming, stopWatch, unseenAlerts, updateWatch } from "./pricewatch.js";

const cents = z.number().int().positive().max(100_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** Price-watch routes for owners (/api/price-watch) and agents (/api/agent/price-watch). */
export function priceWatchRoutes(db: Db, as: "owner" | "agent") {
  const r = express.Router();
  const userId = (req: express.Request) => (as === "owner" ? req.user!.id : req.agentKey!.userId);

  r.get("/", h(async (req) => ({ watches: await listWatches(db, userId(req), { includeEnded: req.query.all === "1" }), saleEvents: saleTiming() })));
  r.get("/alerts", h(async (req) => ({ alerts: await unseenAlerts(db, userId(req)) })));
  r.post("/alerts/seen", h(async (req) => markAlertsSeen(db, userId(req))));
  r.post(
    "/",
    h(async (req) => {
      const body = parse(
        z.object({ url: z.string().min(8).max(2000), title: z.string().max(200).optional(), targetPriceCents: cents, currentPriceCents: cents.optional(), expiresOn: date.optional(), notes: z.string().max(500).optional() }),
        req.body,
      );
      return addWatch(db, userId(req), body, as === "agent" ? req.agentKey! : null);
    }),
  );
  r.get("/:id", h(async (req) => ({ watch: await getWatch(db, userId(req), String(req.params.id)) })));
  r.patch(
    "/:id",
    h(async (req) => ({
      watch: await updateWatch(db, userId(req), String(req.params.id),
        parse(z.object({ targetPriceCents: cents.optional(), title: z.string().max(200).optional(), expiresOn: date.nullable().optional(), notes: z.string().max(500).nullable().optional() }), req.body)),
    })),
  );
  r.post(
    "/:id/prices",
    h(async (req) => {
      const { priceCents, note, observedAt } = parse(z.object({ priceCents: cents, note: z.string().max(200).optional(), observedAt: z.iso.datetime().optional() }), req.body);
      return recordPrice(db, userId(req), String(req.params.id), { priceCents, note, observedAt, source: as === "agent" ? "agent" : "manual" });
    }),
  );
  r.post(
    "/:id/bought",
    h(async (req) => ({ watch: await markBought(db, userId(req), String(req.params.id), parse(z.object({ priceCents: cents.optional() }), req.body).priceCents) })),
  );
  r.post(
    "/:id/stop",
    h(async (req) => {
      await stopWatch(db, userId(req), String(req.params.id));
    }),
  );
  return r;
}
