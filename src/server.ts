import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { approvalStatusForAgent, approve, deny, listApprovals, startApproval } from "./approvals.js";
import {
  agentKeyByToken,
  userById,
  createAgentKey,
  createUser,
  listAgentKeys,
  revokeAgentKey,
  updateAgentKeyLimits,
  userByToken,
  type AgentKey,
  type User,
} from "./auth.js";
import { syncCatalog } from "./catalog.js";
import { config } from "./config.js";
import { createPool, type Db } from "./db.js";
import { AppError } from "./errors.js";
import { bearer, h, parse } from "./http.js";
import { externalRoutes } from "./external-routes.js";
import { rollRenewalDates } from "./external.js";
import { expireWatches, refreshFromKeepa } from "./pricewatch.js";
import { priceWatchRoutes } from "./pricewatch-routes.js";
import { groceryRoutes } from "./grocery-routes.js";
import { permissionsRoutes } from "./permissions-routes.js";
import { agentControlsRoutes, controlsRoutes } from "./controls-routes.js";
import { completeDelayedApprovals } from "./approvals.js";
import { familyRoutes } from "./family-routes.js";
import { addTestCredits, approveTestCall, testKeyAllowed } from "./testmode.js";
import { purchasesRoutes } from "./purchases-routes.js";
import { applyDueChanges, getProtection, helperOn, scheduleAgentLimits } from "./helpers.js";
import { auditTx } from "./audit.js";
import { withTx } from "./db.js";
import { frozenAt, frozenError, releaseVaultUnlocks, sweepEnvelopes } from "./controls.js";
import { callPaidTool, getToolForAgent, spendSummary, sweepExpiredHolds } from "./gateway.js";
import { decideCall } from "./controls.js";
import { balance, history } from "./ledger.js";
import { migrate } from "./migrate.js";
import { deletePasskey, finishRegistration, hasPasskey, listPasskeys, startRegistration } from "./passkeys.js";
import { recommend } from "./recommend.js";
import { createProvider, createTool, listTools, providerForUser, providersForUser, publicTool, quote, setToolActive } from "./registry.js";
import { sampleRouter } from "./sample.js";
import {
  cancelSubscription,
  createPlan,
  listPlans,
  listSubscriptions,
  renewDueSubscriptions,
  requestResume,
  requestSubscription,
  setPlanActive,
  setPlanPrice,
} from "./subscriptions.js";
import { createTopupCheckout, devCredit, handleStripeEvent, listPayouts, requestPayout, verifyStripeEvent } from "./wallet.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Whose account the request acts on. */
      user?: User;
      /** Who is signed in: the owner, or a trusted helper acting on the owner's account. */
      signer?: User;
      helperLabel?: string;
      agentKey?: AgentKey;
    }
  }
}

const cents = z.number().int().nonnegative().max(10_000_000);
const nullableCents = cents.nullable().optional();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "lowercase letters, digits and dashes");

const limitsSchema = z.object({
  perCallMaxCents: nullableCents,
  dailyCapCents: nullableCents,
  monthlyCapCents: nullableCents,
  approvalThresholdCents: nullableCents,
  allowedToolSlugs: z.array(slug).nullable().optional(),
  level: z.enum(["ask", "rules", "budget"]).optional(),
  spendRules: z
    .array(z.object({ name: z.string().min(1).max(60), tools: z.array(slug).nullable().default(null), maxCents: cents, outcome: z.enum(["auto", "observe"]).default("auto") }))
    .max(20)
    .optional(),
  observeAboveCents: nullableCents,
});
const createKeySchema = limitsSchema.extend({ name: z.string().min(1).max(80), test: z.boolean().optional() });

export function createApp(db: Db) {
  const app = express();
  app.disable("x-powered-by");

  // Stripe needs the exact raw bytes to verify its signature, so this route comes before express.json().
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    h(async (req) => {
      const event = verifyStripeEvent(req.body as Buffer, req.header("stripe-signature") ?? "");
      return { result: await handleStripeEvent(db, event as any) };
    }),
  );

  // Grocery list photos need a larger body; body-parser skips bodies that are already parsed.
  app.use(["/api/grocery/photo", "/api/agent/grocery/photo"], express.json({ limit: "8mb" }));
  app.use(express.json({ limit: "256kb" }));

  // A trusted helper acts on someone else's account with the X-AgentPay-Account header,
  // and only on these routes: see, freeze, and co-sign or object to approvals.
  const helperAllowed = (method: string, path: string) =>
    (method === "GET" &&
      ["/api/me", "/api/controls/board", "/api/controls/audit", "/api/controls/audit/verify", "/api/controls/policy", "/api/controls/incidents",
       "/api/controls/reviews", "/api/approvals", "/api/everyday", "/api/ledger", "/api/purchases"].includes(path)) ||
    (method === "POST" && (path === "/api/controls/freeze" || /^\/api\/approvals\/[^/]+\/(start|approve|deny)$/.test(path)));

  const ownerOnly = (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    (async () => {
      const user = token?.startsWith("ap_owner_") ? await userByToken(db, token) : null;
      if (!user) throw new AppError(401, "unauthorized", "send your owner token as 'Authorization: Bearer ap_owner_...'");
      req.signer = user;
      req.user = user;
      const account = req.header("x-agentpay-account");
      if (account && account !== user.id) {
        const helper = /^[0-9a-f-]{36}$/i.test(account) ? await helperOn(db, user.id, account) : null;
        if (!helper) throw new AppError(403, "not_helper", "you're not a trusted helper on that account");
        const path = req.originalUrl.split("?")[0].replace(/\/$/, "");
        if (!helperAllowed(req.method, path)) {
          throw new AppError(403, "helper_read_only", "trusted helpers can see the account, freeze it, and co-sign or object to approvals; nothing else");
        }
        req.user = (await userById(db, account))!;
        req.helperLabel = helper.label;
      }
    })().then(() => next(), next);
  };
  const signerId = (req: Request) => (req.signer ?? req.user)!.id;
  const agentOnly = (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    (token?.startsWith("ap_agent_") || token?.startsWith("ap_test_") ? agentKeyByToken(db, token) : Promise.resolve(null)).then((key) => {
      if (!key) return next(new AppError(401, "unauthorized", "send a valid, unrevoked agent key as 'Authorization: Bearer ap_agent_...'"));
      req.agentKey = key;
      if (key.test && !testKeyAllowed(req.method, req.originalUrl.split("?")[0].replace(/\/$/, ""))) {
        return next(new AppError(403, "test_key_scope", "test keys (ap_test_...) can only list, quote and call paid tools; use a real agent key for the rest"));
      }
      // The kill switch: while the owner has frozen everything, agents can do nothing at all.
      frozenAt(db, key.userId).then((frozen) => next(frozen ? frozenError() : undefined), next);
    }, next);
  };

  // ------------------------------------------------------------ public

  app.get("/api/health", h(async () => ({ ok: true })));

  app.get(
    "/api/catalog",
    h(async (req) => ({
      tools: (await listTools(db)).map(publicTool),
      plans: (await listPlans(db, { search: typeof req.query.search === "string" ? req.query.search : undefined })).map(({ id, providerId, toolId, ...p }) => p),
    })),
  );

  app.post(
    "/api/signup",
    h(async (req) => {
      const { email } = parse(z.object({ email: z.email() }), req.body);
      const { user, token } = await createUser(db, email);
      return { user: { id: user.id, email: user.email }, token, note: "Keep this token safe; it is shown only once." };
    }),
  );

  // ------------------------------------------------------------ owner

  app.get(
    "/api/me",
    ownerOnly,
    h(async (req) => ({
      user: { id: req.user!.id, email: req.user!.email },
      balanceCents: await balance(db, req.user!.walletAccountId),
      // Passkey state of whoever signs: the owner, or the helper acting for them.
      hasPasskey: await hasPasskey(db, signerId(req)),
      signer: { id: signerId(req), email: req.signer!.email },
      actingAs: req.helperLabel ? "helper" : "owner",
      protection: await getProtection(db, req.user!.id),
      requirePasskey: config.requirePasskey,
      stripeEnabled: !!config.stripeSecretKey,
      devCreditEnabled: config.allowDevCredit,
      // Lets the dashboard print a ready-to-paste MCP config for this install.
      mcpScript: fileURLToPath(new URL("../packages/mcp/src/index.ts", import.meta.url)).replaceAll("\\", "/"),
    })),
  );

  app.get("/api/ledger", ownerOnly, h(async (req) => ({ entries: await history(db, req.user!.walletAccountId) })));

  app.post(
    "/api/topups",
    ownerOnly,
    h(async (req) => {
      const { amountCents } = parse(z.object({ amountCents: cents }), req.body);
      return { url: await createTopupCheckout(db, req.user!.id, req.user!.email, amountCents) };
    }),
  );

  app.post(
    "/api/dev/credit",
    ownerOnly,
    h(async (req) => {
      if (!config.allowDevCredit) throw new AppError(403, "disabled", "dev credits are disabled (ALLOW_DEV_CREDIT)");
      const { amountCents } = parse(z.object({ amountCents: cents }), req.body);
      await devCredit(db, req.user!.walletAccountId, amountCents);
      return { balanceCents: await balance(db, req.user!.walletAccountId) };
    }),
  );

  // Agent keys
  app.get(
    "/api/agent-keys",
    ownerOnly,
    h(async (req) => {
      const keys = await listAgentKeys(db, req.user!.id);
      return { agentKeys: await Promise.all(keys.map(async (k) => ({ ...k, spend: await spendSummary(db, k) }))) };
    }),
  );
  app.post(
    "/api/agent-keys",
    ownerOnly,
    h(async (req) => {
      const body = parse(createKeySchema, req.body);
      const { name, ...limits } = body;
      // On a protected account, new agents start at L0: they ask before every paid call.
      const protectedAccount = !!(await getProtection(db, req.user!.id)).protectedAt;
      const { agentKey, key } = await createAgentKey(db, req.user!.id, name, protectedAccount ? { ...limits, level: "ask" } : limits);
      await withTx(db, (tx) =>
        auditTx(tx, req.user!.id, { actor: "owner", kind: "agent_key_created", summary: `Created agent key "${name}" (${agentKey.level})` }),
      );
      return { agentKey, key, note: "Copy this key into your agent's MCP config now; it is shown only once." };
    }),
  );
  app.patch(
    "/api/agent-keys/:id",
    ownerOnly,
    h(async (req) => {
      const limits = parse(limitsSchema, req.body);
      // On a protected account, limit changes wait out the delay (revoking is still immediate).
      if ((await getProtection(db, req.user!.id)).protectedAt) return scheduleAgentLimits(db, req.user!.id, String(req.params.id), limits);
      return { agentKey: await updateAgentKeyLimits(db, req.user!.id, String(req.params.id), limits) };
    }),
  );
  app.delete(
    "/api/agent-keys/:id",
    ownerOnly,
    h(async (req) => {
      await revokeAgentKey(db, req.user!.id, String(req.params.id));
    }),
  );

  // Approvals
  app.get(
    "/api/approvals",
    ownerOnly,
    h(async (req) => ({ approvals: await listApprovals(db, req.user!.id, typeof req.query.status === "string" ? req.query.status : undefined) })),
  );
  app.post("/api/approvals/:id/start", ownerOnly, h(async (req) => startApproval(db, signerId(req), String(req.params.id))));
  app.post(
    "/api/approvals/:id/approve",
    ownerOnly,
    h(async (req) => {
      const { passkey, scamCheck } = parse(
        z.object({ passkey: z.any().optional(), scamCheck: z.object({ calledYou: z.boolean(), keepSecret: z.boolean(), urgent: z.boolean() }).optional() }),
        req.body,
      );
      return approve(db, signerId(req), String(req.params.id), passkey, { scamCheck });
    }),
  );
  app.post(
    "/api/approvals/:id/deny",
    ownerOnly,
    h(async (req) => {
      await deny(db, signerId(req), String(req.params.id));
    }),
  );

  // Passkeys
  app.get("/api/passkeys", ownerOnly, h(async (req) => ({ passkeys: await listPasskeys(db, req.user!.id) })));
  app.post("/api/passkeys/register/start", ownerOnly, h(async (req) => startRegistration(db, req.user!)));
  app.post(
    "/api/passkeys/register/finish",
    ownerOnly,
    h(async (req) => {
      const { response, deviceName } = parse(z.object({ response: z.any(), deviceName: z.string().max(80).default("Passkey") }), req.body);
      return { passkey: await finishRegistration(db, req.user!.id, response, deviceName) };
    }),
  );
  app.delete(
    "/api/passkeys/:id",
    ownerOnly,
    h(async (req) => {
      await deletePasskey(db, req.user!.id, String(req.params.id));
    }),
  );

  // Subscriptions
  app.get(
    "/api/subscriptions",
    ownerOnly,
    h(async (req) => ({ subscriptions: await listSubscriptions(db, req.user!.id, { includeEnded: req.query.all === "1" }) })),
  );
  app.post(
    "/api/subscriptions",
    ownerOnly,
    h(async (req) => {
      const { plan, maxPriceCents } = parse(z.object({ plan: slug, maxPriceCents: cents.optional() }), req.body);
      return requestSubscription(db, req.user!.id, null, plan, { maxPriceCents });
    }),
  );
  app.post(
    "/api/subscriptions/:id/cancel",
    ownerOnly,
    h(async (req) => {
      const { immediately } = parse(z.object({ immediately: z.boolean().optional() }), req.body);
      return cancelSubscription(db, req.user!.id, String(req.params.id), { immediately });
    }),
  );
  app.post("/api/subscriptions/:id/renew", ownerOnly, h(async (req) => requestResume(db, req.user!.id, String(req.params.id))));
  app.get(
    "/api/recommendations",
    ownerOnly,
    h(async (req) =>
      recommend(db, req.user!.id, {
        category: typeof req.query.category === "string" ? req.query.category : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
      }),
    ),
  );

  // Providers (any owner can also sell tools and plans)
  app.get("/api/providers", ownerOnly, h(async (req) => ({ providers: await providersForUser(db, req.user!.id) })));
  app.post(
    "/api/providers",
    ownerOnly,
    h(async (req) => ({ provider: await createProvider(db, req.user!.id, parse(z.object({ name: z.string().min(1).max(80) }), req.body).name) })),
  );
  app.get(
    "/api/providers/:id",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      return {
        provider,
        earningsCents: await balance(db, provider.accountId),
        tools: (await listTools(db, { providerId: provider.id })).map((t) => ({ ...publicTool(t), active: t.active, upstreamUrl: t.upstreamUrl })),
        plans: (await listPlans(db, { providerId: provider.id })).map(({ id, providerId, toolId, ...p }) => p),
        payouts: await listPayouts(db, provider.id),
      };
    }),
  );
  app.post(
    "/api/providers/:id/tools",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      const body = parse(
        z.object({
          slug,
          name: z.string().min(1).max(80),
          description: z.string().min(1).max(2000),
          pricingType: z.enum(["per_call", "per_unit"]),
          priceCents: cents,
          unitsField: z.string().max(64).optional(),
          maxUnits: z.number().int().positive().optional(),
          upstreamUrl: z.url(),
          upstreamAuth: z.string().max(500).optional(),
          inputSchema: z.record(z.string(), z.unknown()).optional(),
        }),
        req.body,
      );
      const tool = await createTool(db, provider.id, body);
      return { tool: publicTool(tool) };
    }),
  );
  app.patch(
    "/api/providers/:id/tools/:slug",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      await setToolActive(db, provider.id, String(req.params.slug), parse(z.object({ active: z.boolean() }), req.body).active);
    }),
  );
  app.post(
    "/api/providers/:id/plans",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      const body = parse(
        z.object({
          slug,
          name: z.string().min(1).max(80),
          description: z.string().min(1).max(2000),
          category: z.string().min(1).max(40),
          priceCents: cents,
          interval: z.enum(["week", "month", "year"]),
          toolSlug: slug.optional(),
          includedCalls: z.number().int().positive().optional(),
          features: z.array(z.string().max(120)).max(20).optional(),
        }),
        req.body,
      );
      const { id, providerId, toolId, ...plan } = await createPlan(db, provider.id, body);
      return { plan };
    }),
  );
  app.patch(
    "/api/providers/:id/plans/:slug",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      const { active, priceCents } = parse(z.object({ active: z.boolean().optional(), priceCents: cents.optional() }), req.body);
      if (active !== undefined) await setPlanActive(db, provider.id, String(req.params.slug), active);
      if (priceCents !== undefined) await setPlanPrice(db, provider.id, String(req.params.slug), priceCents);
    }),
  );
  app.post(
    "/api/providers/:id/payouts",
    ownerOnly,
    h(async (req) => {
      const provider = await providerForUser(db, req.user!.id, String(req.params.id));
      return { payout: await requestPayout(db, provider, parse(z.object({ amountCents: cents }), req.body).amountCents) };
    }),
  );

  // ------------------------------------------------------------ agent

  app.get(
    "/api/agent/tools",
    agentOnly,
    h(async (req) => {
      const allowed = req.agentKey!.allowedToolSlugs;
      return { tools: (await listTools(db)).filter((t) => !allowed || allowed.includes(t.slug)).map(publicTool) };
    }),
  );
  app.post(
    "/api/agent/quote",
    agentOnly,
    h(async (req) => {
      const { tool: slugValue, input } = parse(z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).default({}) }), req.body);
      const tool = await getToolForAgent(db, req.agentKey!, slugValue);
      const { amountCents, units } = quote(tool, input);
      const key = req.agentKey!;
      return {
        tool: tool.slug,
        amountCents,
        units,
        ...(await decideCall(db, key, tool, amountCents).then((d) => ({ needsApproval: d.outcome === "approve", decision: d.outcome, why: d.reason }))),
        overPerCallMax: key.perCallMaxCents !== null && amountCents > key.perCallMaxCents,
        ...(await spendSummary(db, key)),
      };
    }),
  );
  app.post(
    "/api/agent/call",
    agentOnly,
    h(async (req) => {
      const body = parse(
        z.object({
          tool: z.string(),
          input: z.record(z.string(), z.unknown()).default({}),
          idempotencyKey: z.string().min(1).max(200),
          approvalId: z.uuid().optional(),
          reason: z.string().max(500).optional(),
          instruction: z.string().max(500).optional(),
        }),
        req.body,
      );
      return callPaidTool(db, req.agentKey!, body);
    }),
  );
  app.get("/api/agent/balance", agentOnly, h(async (req) => spendSummary(db, req.agentKey!)));
  app.get("/api/agent/approvals/:id", agentOnly, h(async (req) => approvalStatusForAgent(db, req.agentKey!, String(req.params.id))));
  app.get(
    "/api/agent/plans",
    agentOnly,
    h(async (req) =>
      recommend(db, req.agentKey!.userId, {
        category: typeof req.query.category === "string" ? req.query.category : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
      }),
    ),
  );
  app.get("/api/agent/subscriptions", agentOnly, h(async (req) => ({ subscriptions: await listSubscriptions(db, req.agentKey!.userId) })));
  app.post(
    "/api/agent/subscriptions",
    agentOnly,
    h(async (req) => {
      const { plan, maxPriceCents, reason } = parse(
        z.object({ plan: slug, maxPriceCents: cents.optional(), reason: z.string().max(500).optional() }),
        req.body,
      );
      return requestSubscription(db, req.agentKey!.userId, req.agentKey!, plan, { maxPriceCents, reason });
    }),
  );
  app.post(
    "/api/agent/subscriptions/:id/cancel",
    agentOnly,
    h(async (req) => {
      const { immediately } = parse(z.object({ immediately: z.boolean().optional() }), req.body);
      return cancelSubscription(db, req.agentKey!.userId, String(req.params.id), { immediately });
    }),
  );
  app.post(
    "/api/agent/subscriptions/:id/renew",
    agentOnly,
    h(async (req) => requestResume(db, req.agentKey!.userId, String(req.params.id), req.agentKey!)),
  );

  // ------------------------------------------------------------ everyday subscriptions (Netflix, phone, gym...)

  app.use("/api/everyday", ownerOnly, externalRoutes(db, "owner"));
  app.use("/api/agent/everyday", agentOnly, externalRoutes(db, "agent"));
  app.use("/api/price-watch", ownerOnly, priceWatchRoutes(db, "owner"));
  app.use("/api/agent/price-watch", agentOnly, priceWatchRoutes(db, "agent"));
  app.use("/api/grocery", ownerOnly, groceryRoutes(db, "owner"));
  app.use("/api/agent/grocery", agentOnly, groceryRoutes(db, "agent"));
  app.use("/api/permissions", ownerOnly, permissionsRoutes(db, "owner"));
  app.use("/api/agent/controls", agentOnly, agentControlsRoutes(db));
  app.post(
    "/api/agent/test/credit",
    agentOnly,
    h(async (req) => addTestCredits(db, req.agentKey!, parse(z.object({ amountCents: cents }), req.body).amountCents)),
  );
  app.post("/api/agent/test/approvals/:id/approve", agentOnly, h(async (req) => approveTestCall(db, req.agentKey!, String(req.params.id))));
  app.use("/api/controls", ownerOnly, controlsRoutes(db));
  app.use("/api/family", ownerOnly, familyRoutes(db));
  app.use("/api/purchases", ownerOnly, purchasesRoutes(db, "owner"));
  app.use("/api/agent/purchases", agentOnly, purchasesRoutes(db, "agent"));
  app.use("/api/agent/permissions", agentOnly, permissionsRoutes(db, "agent"));

  // ------------------------------------------------------------ demo provider + dashboard

  app.use("/sample", sampleRouter());
  app.get("/vendor/simplewebauthn-browser.js", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js", import.meta.url)));
  });
  app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url))));

  app.use("/api", (_req, _res, next) => next(new AppError(404, "not_found", "no such endpoint")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // Postgres rejects malformed UUIDs in path params (e.g. /api/approvals/abc).
    if ((err as { code?: string })?.code === "22P02") {
      res.status(404).json({ error: { code: "not_found", message: "no record with that id" } });
      return;
    }
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "invalid_json", message: "request body is not valid JSON" } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "internal", message: "internal error" } });
  });

  return app;
}

/** Background jobs: release stuck holds and process subscription renewals. */
export function startJobs(db: Db) {
  const run = async () => {
    try {
      await rollRenewalDates(db);
      await expireWatches(db);
      if (config.keepaApiKey) await refreshFromKeepa(db, config.keepaApiKey);
      const released = await sweepExpiredHolds(db);
      if (released) console.log(`released ${released} expired hold(s)`);
      const closed = await sweepEnvelopes(db);
      if (closed) console.log(`closed ${closed} expired envelope(s)`);
      await releaseVaultUnlocks(db);
      await applyDueChanges(db);
      await completeDelayedApprovals(db);
      for (const o of await renewDueSubscriptions(db)) console.log(`subscription ${o.subscriptionId}: ${o.outcome}${o.reason ? ` (${o.reason})` : ""}`);
    } catch (err) {
      console.error("background job failed", err);
    }
  };
  void run();
  return setInterval(run, 30_000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = createPool();
  await migrate(db);
  await syncCatalog(db);
  startJobs(db);
  createApp(db).listen(config.port, () => {
    console.log(`AgentPay listening on ${config.publicUrl}`);
    if (!config.stripeSecretKey) console.log("  Stripe not configured: card top-ups disabled (set STRIPE_SECRET_KEY)");
    if (config.allowDevCredit) console.log("  ALLOW_DEV_CREDIT is on: the dashboard can add free test credits");
  });
}

