import express from "express";
import { z } from "zod";
import { deny, listApprovals } from "./approvals.js";
import { listAudit, verifyAudit } from "./audit.js";
import { listAgentKeys } from "./auth.js";
import {
  cancelVaultUnlock,
  closeEnvelope,
  freeze,
  frozenAt,
  LEVEL_LABELS,
  listEnvelopes,
  lockInVault,
  requestEnvelope,
  requestUnfreeze,
  requestVaultUnlock,
  vaultSummary,
} from "./controls.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { allSubscriptions } from "./external.js";
import { spendSummary } from "./gateway.js";
import { h, parse } from "./http.js";
import { guaranteePolicy, INCIDENT_KINDS, listIncidents, reportIncident, updateIncident } from "./incidents.js";
import { listMandates } from "./mandates.js";
import { listGrants, normalizeSite } from "./permissions.js";
import { listPurchases, purchaseReminders } from "./purchases.js";
import { policySummary, refusalMessage, screen, screenSite } from "./policy.js";

const cents = z.number().int().positive().max(10_000_000);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const envelopeSchema = z.object({
  name: z.string().min(1).max(80),
  amountCents: cents,
  days: z.number().int().min(1).max(90).default(30),
  purpose: z.string().max(300).optional(),
  agentKeyId: z.uuid().nullable().optional(),
  toolSlugs: z.array(slug).max(50).nullable().optional(),
});
const incidentSchema = z.object({
  description: z.string().min(1).max(2000),
  kind: z.enum(INCIDENT_KINDS).optional(),
  amountCents: z.number().int().nonnegative().max(10_000_000).optional(),
  holdId: z.uuid().nullable().optional(),
});

/** Calls that went through on their own but were flagged for the owner to look at. */
async function toReview(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT h.id, COALESCE(t.slug, h.external_protocol || ': ' || h.external_target) AS tool, COALESCE(h.captured_cents, h.amount_cents) AS "amountCents",
            h.decision_reason AS "decidedBecause", h.agent_reason AS "agentReason", h.status, h.created_at AS "createdAt", k.name AS "agentKeyName"
       FROM holds h JOIN agent_keys k ON k.id = h.agent_key_id LEFT JOIN tools t ON t.id = h.tool_id
      WHERE k.user_id = $1 AND h.decision = 'observe' AND h.reviewed_at IS NULL AND h.status <> 'released'
      ORDER BY h.created_at DESC LIMIT 200`,
    [userId],
  );
  return rows;
}

/** Owner controls: kill switch, envelopes, vault, reviews, the why log, incidents and the one board. */
export function controlsRoutes(db: Db) {
  const r = express.Router();
  const uid = (req: express.Request) => req.user!.id;

  r.post("/freeze", h(async (req) => freeze(db, uid(req), deny, req.helperLabel ? { helperLabel: req.helperLabel } : null)));
  r.post("/unfreeze", h(async (req) => requestUnfreeze(db, uid(req))));

  r.get("/envelopes", h(async (req) => ({ envelopes: await listEnvelopes(db, uid(req), { includeEnded: req.query.all === "1" }) })));
  r.post("/envelopes", h(async (req) => requestEnvelope(db, uid(req), parse(envelopeSchema, req.body))));
  r.post("/envelopes/:id/close", h(async (req) => closeEnvelope(db, uid(req), String(req.params.id))));

  r.get("/vault", h(async (req) => vaultSummary(db, uid(req))));
  r.post("/vault/lock", h(async (req) => lockInVault(db, uid(req), parse(z.object({ amountCents: cents }), req.body).amountCents)));
  r.post("/vault/unlock", h(async (req) => requestVaultUnlock(db, uid(req), parse(z.object({ amountCents: cents }), req.body).amountCents)));
  r.post(
    "/vault/unlocks/:id/cancel",
    h(async (req) => {
      await cancelVaultUnlock(db, uid(req), String(req.params.id));
    }),
  );

  r.get("/reviews", h(async (req) => ({ calls: await toReview(db, uid(req)) })));
  r.post(
    "/reviews/:holdId",
    h(async (req) => {
      const { ok, description } = parse(z.object({ ok: z.boolean(), description: z.string().max(2000).optional() }), req.body);
      const { rowCount } = await db.query(
        `UPDATE holds h SET reviewed_at = now() FROM agent_keys k
          WHERE h.id = $1 AND k.id = h.agent_key_id AND k.user_id = $2 AND h.decision = 'observe' AND h.reviewed_at IS NULL`,
        [String(req.params.holdId), uid(req)],
      );
      if (!rowCount) throw new AppError(404, "not_found", "no call waiting for review with that id");
      if (ok) return { reviewed: true };
      return { reviewed: true, incident: await reportIncident(db, uid(req), { holdId: String(req.params.holdId), description: description || "Flagged during review" }) };
    }),
  );

  r.get("/audit", h(async (req) => ({ entries: await listAudit(db, uid(req)) })));
  r.get("/audit/verify", h(async (req) => verifyAudit(db, uid(req))));

  r.get("/policy", h(async () => policySummary()));
  r.post("/policy/check", h(async (req) => checkPolicy(req.body)));
  r.get("/guarantee", h(async () => guaranteePolicy()));
  r.get("/incidents", h(async (req) => ({ incidents: await listIncidents(db, uid(req), { includeResolved: req.query.all === "1" }), policy: guaranteePolicy() })));
  r.post("/incidents", h(async (req) => ({ incident: await reportIncident(db, uid(req), parse(incidentSchema, req.body)) })));
  r.patch(
    "/incidents/:id",
    h(async (req) => ({
      incident: await updateIncident(db, uid(req), String(req.params.id),
        parse(z.object({ kind: z.enum(INCIDENT_KINDS).optional(), resolution: z.string().max(1000).optional(), resolved: z.boolean().optional() }), req.body)),
    })),
  );

  // Everything that can spend the owner's money, in one place, each with a way to stop it
  // (Korea's Payinfo and India's UPI mandate view, extended to agents).
  r.get(
    "/board",
    h(async (req) => {
      const userId = uid(req);
      const [keys, envelopes, vault, grants, mandates, subs, pending, reviews, incidents, frozen, purchases, purchaseAlerts] = await Promise.all([
        listAgentKeys(db, userId),
        listEnvelopes(db, userId),
        vaultSummary(db, userId),
        listGrants(db, userId),
        listMandates(db, userId),
        allSubscriptions(db, userId),
        listApprovals(db, userId, "pending"),
        toReview(db, userId),
        listIncidents(db, userId),
        frozenAt(db, userId),
        listPurchases(db, userId, { open: true }),
        purchaseReminders(db, userId),
      ]);
      return {
        frozenAt: frozen,
        agents: await Promise.all(
          keys.filter((k) => !k.revokedAt).map(async (k) => {
            const spend = await spendSummary(db, k);
            return {
              id: k.id, name: k.name, level: k.level, levelLabel: LEVEL_LABELS[k.level], coolingOffUntil: spend.coolingOffUntil,
              spentLast24hCents: spend.spentLast24hCents, spentLast30dCents: spend.spentLast30dCents, limits: spend.limits,
              spendRules: k.spendRules, observeAboveCents: k.observeAboveCents, stop: { method: "DELETE", path: `/api/agent-keys/${k.id}` },
            };
          }),
        ),
        envelopes: envelopes.map((e) => ({ ...e, stop: { method: "POST", path: `/api/controls/envelopes/${e.id}/close` } })),
        vault,
        browserPermissions: grants.filter((g: { state: string }) => g.state === "active").map((g: { id: string }) => ({ ...g, stop: { method: "DELETE", path: `/api/permissions/grants/${g.id}` } })),
        buyMandates: mandates.map((m: { id: string }) => ({ ...m, stop: { method: "DELETE", path: `/api/price-watch/mandates/${m.id}` } })),
        subscriptions: subs.items
          .filter((s) => !["canceled", "denied"].includes(s.status))
          .map((s) => ({ ...s, stop: s.kind === "agentpay" ? { method: "POST", path: `/api/subscriptions/${s.id}/cancel` } : { method: "POST", path: `/api/everyday/${s.id}/request-cancel` } })),
        subscriptionTotals: subs.totals,
        reminders: subs.reminders,
        pendingApprovals: pending.length,
        toReview: reviews,
        openIncidents: incidents,
        openPurchases: purchases,
        purchaseReminders: purchaseAlerts,
      };
    }),
  );
  return r;
}

/** Is this item, tool or website something agents must refuse? */
async function checkPolicy(body: unknown) {
  const { text, site } = parse(z.object({ text: z.string().max(2000).optional(), site: z.string().max(2000).optional() }), body);
  const refused = screen(text) ?? (site ? screenSite(normalizeSite(site)) : null);
  return refused ? { allowed: false, ...refused, message: refusalMessage(refused) } : { allowed: true, message: "Not in a restricted category." };
}

/** What agents may do here: check the restricted-category policy, ask for an envelope, and report their own mistakes. */
export function agentControlsRoutes(db: Db) {
  const r = express.Router();
  r.get("/policy", h(async () => policySummary()));
  r.post("/policy/check", h(async (req) => checkPolicy(req.body)));
  r.post(
    "/envelopes",
    h(async (req) => requestEnvelope(db, req.agentKey!.userId, parse(envelopeSchema.omit({ agentKeyId: true }), req.body), req.agentKey!)),
  );
  r.post("/incidents", h(async (req) => ({ incident: await reportIncident(db, req.agentKey!.userId, parse(incidentSchema, req.body), req.agentKey!) })));
  return r;
}
