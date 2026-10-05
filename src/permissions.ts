import type { AgentKey } from "./auth.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { auditTx } from "./audit.js";
import { enforce, enforceSite, refusalMessage, screenSite } from "./policy.js";

// What the owner allows their agent to do in the owner's own, already
// signed-in browser. A grant is a recorded permission and a rule the agent
// follows; AgentPay can't see or block what happens in the browser.
// AgentPay never stores passwords, sign-in codes or payment details.

export const CONSENT_KIND = "agent_browser_and_prepaid";
export const CONSENT_VERSION = 1;

/** Shown in full before the owner signs it with their passkey. Have a lawyer review the wording before launch. */
export const RISK_STATEMENT = {
  version: CONSENT_VERSION,
  title: "Letting your agent shop and pay for you",
  paragraphs: [
    "Your agent can use websites where you are already signed in, in your own browser, to do what you allow for each site: browse, add to cart, check out orders you approved, or manage subscriptions.",
    "Your agent never sees or types your passwords, sign-in codes or card details. If a site isn't signed in, your agent stops and asks you to sign in yourself.",
    "What protects you: you approve each site and each order with your passkey; AgentPay cards are prepaid, so nothing can be spent beyond the credits you added; each card works only at the store it's made for and only up to the amount you approved; you can revoke any permission or pause any card instantly.",
    "What AgentPay can't prevent: actions your agent takes inside a website you allowed. It could pick the wrong product, the wrong quantity, the wrong delivery time, or change something on that site. Within the limits you set, those mistakes can cost money, and refunds depend on the store's own policies.",
    "If a store also has your personal card saved, AgentPay can't stop a charge to that card. Make your AgentPay card the default payment method, and remove other cards, on stores your agent uses.",
    "You are the cardholder for your AgentPay cards and responsible for purchases made with them within the limits you approve. Review your activity log and orders regularly.",
    "You can withdraw this at any time from the Permissions page. That immediately revokes every site permission.",
  ],
};

export const BROWSER_ACTIONS = ["browse", "add_to_cart", "checkout_approved_order", "manage_subscription"] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export const ACTION_LABELS: Record<BrowserAction, string> = {
  browse: "look at products and prices",
  add_to_cart: "add and remove items in the cart",
  checkout_approved_order: "check out orders you approved",
  manage_subscription: "manage subscriptions (only ones you approved cancelling or changing)",
};

/** "https://www.walmart.com/cart" or "Walmart.com" -> "walmart.com" */
export function normalizeSite(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    if (host.includes("/") || host.includes(":")) host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    throw new AppError(400, "invalid_site", "give a website such as walmart.com");
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new AppError(400, "invalid_site", "give a website such as walmart.com");
  return host;
}

/** A grant for walmart.com covers grocery.walmart.com, but never walmart.com.evil.example. */
function siteMatches(granted: string, host: string) {
  return host === granted || host.endsWith(`.${granted}`);
}

// ---------------------------------------------------------------- consent

export async function currentConsent(q: Db | Tx, userId: string) {
  const { rows } = await q.query(
    `SELECT id, text_version AS "textVersion", created_at AS "createdAt" FROM consents
      WHERE user_id = $1 AND kind = $2 AND text_version = $3 AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId, CONSENT_KIND, CONSENT_VERSION],
  );
  return rows[0] ?? null;
}

/** Start the consent: an approval the owner signs with their passkey after reading RISK_STATEMENT. */
export async function requestConsent(db: Db, userId: string) {
  if (await currentConsent(db, userId)) throw new AppError(409, "already_consented", "you already accepted the current version");
  const { rows } = await db.query(
    "INSERT INTO approvals (kind, user_id, amount_cents, input) VALUES ('risk_consent', $1, 0, $2) RETURNING id",
    [userId, JSON.stringify({ version: CONSENT_VERSION })],
  );
  return { approvalId: rows[0].id as string, statement: RISK_STATEMENT };
}

/** Called from approve() for a 'risk_consent' approval. */
export async function recordConsent(tx: Tx, userId: string, version: number, passkeyId: string | null) {
  if (version !== CONSENT_VERSION) throw new AppError(409, "consent_outdated", "the risk statement changed; read and accept the new version");
  await tx.query("INSERT INTO consents (user_id, kind, text_version, passkey_id) VALUES ($1, $2, $3, $4)", [userId, CONSENT_KIND, version, passkeyId]);
}

export async function withdrawConsent(db: Db, userId: string) {
  await withTx(db, async (tx) => {
    await tx.query("UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND withdrawn_at IS NULL", [userId]);
    await tx.query("UPDATE browser_grants SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await tx.query(
      "UPDATE approvals SET status = 'denied', decided_at = now() WHERE user_id = $1 AND kind IN ('browser_access','risk_consent') AND status = 'pending'",
      [userId],
    );
  });
}

// ---------------------------------------------------------------- site grants

export async function requestBrowserAccess(
  db: Db,
  userId: string,
  agentKey: AgentKey | null,
  input: { site: string; actions: BrowserAction[]; reason?: string; days?: number; purpose?: string },
) {
  if (!(await currentConsent(db, userId))) {
    throw new AppError(403, "needs_consent", "the owner has to read and accept the risk statement first (Permissions page)");
  }
  const site = normalizeSite(input.site);
  enforceSite(site);
  enforce(input.purpose, input.reason);
  const actions = [...new Set(input.actions)];
  if (!actions.length || actions.some((a) => !BROWSER_ACTIONS.includes(a))) throw new AppError(400, "invalid_actions", `actions must be some of ${BROWSER_ACTIONS.join(", ")}`);
  const days = Math.min(Math.max(Math.round(input.days ?? 30), 1), 365);
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO browser_grants (user_id, site, actions, reason, agent_key_id, expires_at, purpose)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) RETURNING id`,
      [userId, site, actions, input.reason?.slice(0, 300) ?? null, agentKey?.id ?? null, days, input.purpose?.slice(0, 200) ?? null],
    );
    const approval = await tx.query(
      "INSERT INTO approvals (kind, user_id, agent_key_id, browser_grant_id, amount_cents, input) VALUES ('browser_access', $1, $2, $3, 0, $4) RETURNING id",
      [userId, agentKey?.id ?? null, rows[0].id, JSON.stringify({ site, actions, days, reason: input.reason ?? null, purpose: input.purpose ?? null })],
    );
    return { status: "pending_approval" as const, approvalId: approval.rows[0].id as string, grantId: rows[0].id as string, site, actions, days };
  });
}

/** Called from approve() for a 'browser_access' approval. */
export async function activateGrant(tx: Tx, userId: string, grantId: string) {
  if (!(await currentConsent(tx, userId))) throw new AppError(403, "needs_consent", "accept the risk statement first");
  await tx.query("UPDATE browser_grants SET status = 'active' WHERE id = $1 AND status = 'pending'", [grantId]);
}

export async function denyGrant(tx: Tx, grantId: string) {
  await tx.query("UPDATE browser_grants SET status = 'denied' WHERE id = $1 AND status = 'pending'", [grantId]);
}

export async function revokeGrant(db: Db, userId: string, grantId: string) {
  const { rowCount } = await db.query("UPDATE browser_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [grantId, userId]);
  if (!rowCount) throw new AppError(404, "not_found", "permission not found or already revoked");
}

export async function listGrants(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT g.id, g.site, g.actions, g.reason, g.purpose, g.status, g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt",
            g.created_at AS "createdAt", k.name AS "agentKeyName",
            CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.status <> 'active' THEN g.status
                 WHEN g.expires_at < now() THEN 'expired' ELSE 'active' END AS state
       FROM browser_grants g LEFT JOIN agent_keys k ON k.id = g.agent_key_id
      WHERE g.user_id = $1 ORDER BY g.created_at DESC`,
    [userId],
  );
  return rows;
}

export type AccessStatus = "allowed" | "needs_consent" | "needs_grant" | "expired" | "revoked" | "refused";

/** May the agent do `action` on `site` right now? */
export async function checkAccess(q: Db | Tx, userId: string, siteInput: string, action: BrowserAction) {
  const host = normalizeSite(siteInput);
  if (!BROWSER_ACTIONS.includes(action)) throw new AppError(400, "invalid_action", `action must be one of ${BROWSER_ACTIONS.join(", ")}`);
  const refused = screenSite(host);
  if (refused) return { status: "refused" as AccessStatus, site: host, message: `${refusalMessage(refused)} Don't open or use this site.` };
  if (!(await currentConsent(q, userId))) {
    return { status: "needs_consent" as AccessStatus, site: host, message: "The owner hasn't accepted the risk statement. Ask them to open the Permissions page." };
  }
  const { rows } = await q.query(
    `SELECT id, site, actions, expires_at AS "expiresAt", revoked_at AS "revokedAt" FROM browser_grants
      WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`,
    [userId],
  );
  const forSite = rows.filter((g) => siteMatches(g.site, host) && g.actions.includes(action));
  const live = forSite.find((g) => !g.revokedAt && new Date(g.expiresAt) > new Date());
  if (live) return { status: "allowed" as AccessStatus, site: host, grantId: live.id as string, expiresAt: live.expiresAt as Date, message: "Allowed." };
  if (forSite.some((g) => !g.revokedAt)) return { status: "expired" as AccessStatus, site: host, message: "The owner's permission for this has expired; ask again with request_browser_access." };
  if (forSite.length) return { status: "revoked" as AccessStatus, site: host, message: "The owner revoked this permission. Don't act on this site." };
  return { status: "needs_grant" as AccessStatus, site: host, message: `No permission to ${ACTION_LABELS[action]} on ${host}. Ask with request_browser_access.` };
}

/**
 * The agent records what it did (or was about to do), the owner's instruction
 * it came from, why, and what happened. Logged even when not allowed, so the
 * owner sees attempts. Also goes into the hash-chained "why" log.
 */
export async function logActivity(
  db: Db,
  userId: string,
  agentKey: AgentKey | null,
  input: { site: string; action: BrowserAction; summary: string; instruction?: string; reason?: string; result?: string },
) {
  const access = await checkAccess(db, userId, input.site, input.action);
  const allowed = access.status === "allowed";
  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO agent_activity (user_id, agent_key_id, site, action, summary, grant_id, allowed, instruction, reason, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId, agentKey?.id ?? null, access.site, input.action, input.summary.slice(0, 500), "grantId" in access ? access.grantId : null, allowed,
        input.instruction?.slice(0, 500) ?? null, input.reason?.slice(0, 500) ?? null, input.result?.slice(0, 500) ?? null,
      ],
    );
    await auditTx(tx, userId, {
      actor: "agent", agentKeyId: agentKey?.id ?? null, kind: "browser_activity", summary: `${access.site}: ${input.summary}`,
      instruction: input.instruction, reason: input.reason, result: input.result,
      data: { site: access.site, action: input.action, allowed, access: access.status },
    });
  });
  return access;
}

export async function listActivity(db: Db, userId: string, limit = 100) {
  const { rows } = await db.query(
    `SELECT a.id, a.site, a.action, a.summary, a.instruction, a.reason, a.result, a.allowed, a.created_at AS "createdAt", k.name AS "agentKeyName"
       FROM agent_activity a LEFT JOIN agent_keys k ON k.id = a.agent_key_id
      WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}
