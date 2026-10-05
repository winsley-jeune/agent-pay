import express from "express";
import { z } from "zod";
import { BUNDLES, PRICES_AS_OF, SERVICES } from "./catalog.js";
import type { Db } from "./db.js";
import {
  acceptPrice,
  addExternal,
  allSubscriptions,
  cancelGuide,
  deleteExternal,
  externalSuggestions,
  getExternal,
  importStatement,
  markExternalCanceled,
  parseStatementCsv,
  requestExternalCancel,
  updateExternal,
} from "./external.js";
import { h, parse } from "./http.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const fields = {
  serviceSlug: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(80).optional(),
  category: z.string().min(1).max(40).optional(),
  planName: z.string().max(80).nullable().optional(),
  priceCents: z.number().int().nonnegative().max(10_000_000),
  interval: z.enum(["week", "month", "year"]).default("month"),
  billedThrough: z.enum(["direct", "apple", "google", "amazon", "carrier", "other"]).optional(),
  paymentMethod: z.string().max(80).nullable().optional(),
  status: z.enum(["active", "trial"]).optional(),
  nextRenewalOn: date.nullable().optional(),
  trialEndsOn: date.nullable().optional(),
  contractUntil: date.nullable().optional(),
  earlyTerminationFeeCents: z.number().int().nonnegative().nullable().optional(),
  lastUsedOn: date.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
};
const createSchema = z.object(fields);
const updateSchema = z.object({ ...fields, priceCents: fields.priceCents.optional(), interval: z.enum(["week", "month", "year"]).optional() });
const importSchema = z.object({ csv: z.string().min(1).max(2_000_000) });

/**
 * Everyday-subscription routes. The same handlers serve owners
 * (/api/everyday) and agents (/api/agent/everyday); agents act for the
 * owner of their key, and may only mark a cancellation done once the owner approved it.
 */
export function externalRoutes(db: Db, as: "owner" | "agent") {
  const r = express.Router();
  const userId = (req: express.Request) => (as === "owner" ? req.user!.id : req.agentKey!.userId);
  const agentKey = (req: express.Request) => (as === "agent" ? req.agentKey! : null);

  r.get("/catalog", h(async () => ({ pricesAsOf: PRICES_AS_OF, pricesNote: "approximate US list prices, for comparison only", services: SERVICES, bundles: BUNDLES })));
  r.get("/", h(async (req) => allSubscriptions(db, userId(req))));
  r.get("/suggestions", h(async (req) => ({ suggestions: await externalSuggestions(db, userId(req)) })));
  r.post(
    "/",
    h(async (req) => ({
      subscription: await addExternal(db, userId(req), parse(createSchema, req.body), { source: as === "agent" ? "agent" : "manual", agentKey: agentKey(req) }),
    })),
  );
  r.post(
    "/import",
    h(async (req) => importStatement(db, userId(req), parseStatementCsv(parse(importSchema, req.body).csv))),
  );
  r.get("/:id", h(async (req) => ({ subscription: await getExternal(db, userId(req), String(req.params.id)) })));
  r.patch(
    "/:id",
    h(async (req) => ({ subscription: await updateExternal(db, userId(req), String(req.params.id), parse(updateSchema, req.body), { byOwner: as === "owner" }) })),
  );
  r.get("/:id/cancel-guide", h(async (req) => cancelGuide(await getExternal(db, userId(req), String(req.params.id)))));
  r.post(
    "/:id/request-cancel",
    h(async (req) => requestExternalCancel(db, userId(req), String(req.params.id), agentKey(req), parse(z.object({ reason: z.string().max(500).optional() }), req.body).reason)),
  );
  r.post(
    "/:id/mark-canceled",
    h(async (req) => ({
      subscription: await markExternalCanceled(db, userId(req), String(req.params.id), {
        confirmation: parse(z.object({ confirmation: z.string().max(200).optional() }), req.body).confirmation,
        byAgent: as === "agent",
      }),
    })),
  );
  if (as === "owner") {
    // Keeping a subscription at a higher price is the owner's call, never the agent's.
    r.post("/:id/accept-price", h(async (req) => ({ subscription: await acceptPrice(db, userId(req), String(req.params.id)) })));
    r.delete(
      "/:id",
      h(async (req) => {
        await deleteExternal(db, userId(req), String(req.params.id));
      }),
    );
  }
  return r;
}
