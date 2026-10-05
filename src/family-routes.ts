import express from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import {
  acceptInvite,
  alertsFor,
  cancelChange,
  getProtection,
  inviteHelper,
  leave,
  listChanges,
  listHelpers,
  listHelping,
  markAlertsSeen,
  removeHelper,
  setDisplayName,
  setProtection,
} from "./helpers.js";
import { h, parse } from "./http.js";

/**
 * Protected accounts and trusted helpers (/api/family). Always about the
 * signed-in user's own account and the accounts they help; acting on someone
 * else's account goes through the X-AgentPay-Account header instead.
 */
export function familyRoutes(db: Db) {
  const r = express.Router();
  r.use((req, _res, next) => next(req.helperLabel ? new AppError(403, "helper_read_only", "manage family settings from your own account") : undefined));
  const me = (req: express.Request) => req.user!.id;

  r.get(
    "/",
    h(async (req) => ({
      displayName: (await db.query("SELECT display_name AS n FROM users WHERE id = $1", [me(req)])).rows[0].n as string | null,
      protection: await getProtection(db, me(req)),
      helpers: await listHelpers(db, me(req)),
      scheduledChanges: await listChanges(db, me(req)),
      helping: await listHelping(db, me(req)),
    })),
  );
  r.put("/name", h(async (req) => setDisplayName(db, me(req), parse(z.object({ name: z.string().max(80) }), req.body).name)));
  r.post(
    "/protection",
    h(async (req) =>
      setProtection(db, me(req),
        parse(z.object({ enabled: z.boolean().optional(), cosignThresholdCents: z.number().int().min(0).max(10_000_000).optional(), cosignDelayHours: z.number().int().min(1).max(720).optional() }), req.body)),
    ),
  );
  r.post("/helpers", h(async (req) => inviteHelper(db, me(req), parse(z.object({ label: z.string().min(1).max(80) }), req.body).label)));
  r.delete("/helpers/:id", h(async (req) => removeHelper(db, me(req), String(req.params.id))));
  r.delete(
    "/changes/:id",
    h(async (req) => {
      await cancelChange(db, me(req), String(req.params.id));
    }),
  );

  // As a helper
  r.post("/accept", h(async (req) => acceptInvite(db, me(req), parse(z.object({ code: z.string().min(10).max(200) }), req.body).code)));
  r.get("/helping/:ownerId/alerts", h(async (req) => alertsFor(db, me(req), String(req.params.ownerId))));
  r.post(
    "/helping/:ownerId/alerts/seen",
    h(async (req) => {
      await markAlertsSeen(db, me(req), String(req.params.ownerId));
    }),
  );
  r.post(
    "/helping/:ownerId/leave",
    h(async (req) => {
      await leave(db, me(req), String(req.params.ownerId));
    }),
  );
  return r;
}
