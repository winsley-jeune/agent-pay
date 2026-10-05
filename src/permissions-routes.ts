import express from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import { h, parse } from "./http.js";
import {
  BROWSER_ACTIONS,
  checkAccess,
  currentConsent,
  listActivity,
  listGrants,
  logActivity,
  requestBrowserAccess,
  requestConsent,
  revokeGrant,
  RISK_STATEMENT,
  withdrawConsent,
  type BrowserAction,
} from "./permissions.js";
import { getPreferences, setPreferences } from "./shopping.js";

const actions = z.array(z.enum(BROWSER_ACTIONS)).min(1);
const prefsSchema = z.object({
  organic: z.enum(["prefer", "avoid", "no_preference"]).optional(),
  storeBrand: z.enum(["prefer", "ok", "avoid"]).optional(),
  sizeStrategy: z.enum(["match_list", "best_value", "smallest"]).optional(),
  brandsPrefer: z.array(z.string().max(60)).max(30).optional(),
  brandsAvoid: z.array(z.string().max(60)).max(30).optional(),
  dietary: z.array(z.string().max(40)).max(10).optional(),
  minRating: z.number().min(0).max(5).optional(),
  substitutionPolicy: z.enum(["similar", "ask", "skip"]).optional(),
});

/** Permissions and shopping preferences for owners (/api/permissions) and agents (/api/agent/permissions). */
export function permissionsRoutes(db: Db, as: "owner" | "agent") {
  const r = express.Router();
  const userId = (req: express.Request) => (as === "owner" ? req.user!.id : req.agentKey!.userId);
  const agentKey = (req: express.Request) => (as === "agent" ? req.agentKey! : null);

  r.get(
    "/",
    h(async (req) => ({
      consent: await currentConsent(db, userId(req)),
      statement: RISK_STATEMENT,
      grants: await listGrants(db, userId(req)),
      ...(as === "owner" ? { activity: await listActivity(db, userId(req)) } : {}),
      preferences: await getPreferences(db, userId(req)),
    })),
  );
  r.get(
    "/check",
    h(async (req) => checkAccess(db, userId(req), String(req.query.site ?? ""), String(req.query.action ?? "") as BrowserAction)),
  );
  r.post(
    "/request",
    h(async (req) =>
      requestBrowserAccess(db, userId(req), agentKey(req),
        parse(
          z.object({
            site: z.string().min(3).max(200), actions, reason: z.string().max(300).optional(),
            purpose: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional(),
          }),
          req.body,
        )),
    ),
  );
  r.post(
    "/activity",
    h(async (req) =>
      logActivity(db, userId(req), agentKey(req),
        parse(
          z.object({
            site: z.string().min(3).max(200), action: z.enum(BROWSER_ACTIONS), summary: z.string().min(1).max(500),
            instruction: z.string().max(500).optional(), reason: z.string().max(500).optional(), result: z.string().max(500).optional(),
          }),
          req.body,
        )),
    ),
  );
  r.get("/preferences", h(async (req) => getPreferences(db, userId(req))));

  if (as === "owner") {
    r.post("/consent", h(async (req) => requestConsent(db, userId(req))));
    r.post(
      "/consent/withdraw",
      h(async (req) => {
        await withdrawConsent(db, userId(req));
      }),
    );
    r.delete(
      "/grants/:id",
      h(async (req) => {
        await revokeGrant(db, userId(req), String(req.params.id));
      }),
    );
    r.put("/preferences", h(async (req) => setPreferences(db, userId(req), parse(prefsSchema, req.body))));
  }
  return r;
}
