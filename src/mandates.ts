import type { AgentKey } from "./auth.js";
import { auditTx } from "./audit.js";
import { frozenAt } from "./controls.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { checkAccess, normalizeSite } from "./permissions.js";
import { getWatch } from "./pricewatch.js";
import { enforce, enforceSite, refusalMessage, screen, screenSite } from "./policy.js";

// Buy mandates: "buy this when it drops under $40, at most one, on target.com,
// before Dec 1", signed with a passkey (like Alipay's delegated mode and JD's
// task credential). The agent checks the mandate right before buying. AgentPay
// doesn't pay the store, so until AgentPay cards exist this is a rule the agent
// follows; the purchase is checked against the mandate when it's recorded.

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

const mandateColumns = `m.id, m.watch_id AS "watchId", w.title, m.site, m.max_price_cents AS "maxPriceCents", m.quantity, m.status,
  m.expires_at AS "expiresAt", m.used_at AS "usedAt", m.used_price_cents AS "usedPriceCents", m.created_at AS "createdAt",
  CASE WHEN m.status = 'active' AND m.expires_at <= now() THEN 'expired' ELSE m.status END AS state`;

export async function listMandates(q: Db | Tx, userId: string, opts: { watchId?: string; includeEnded?: boolean } = {}) {
  const { rows } = await q.query(
    `SELECT ${mandateColumns} FROM buy_mandates m JOIN price_watches w ON w.id = m.watch_id
      WHERE m.user_id = $1 AND ($2::uuid IS NULL OR m.watch_id = $2) AND ($3 OR (m.status IN ('pending','active') AND m.expires_at > now()))
      ORDER BY m.created_at DESC`,
    [userId, opts.watchId ?? null, !!opts.includeEnded],
  );
  return rows;
}

/** The store's site for a watch: amazon watches buy on amazon.<tld>, others on the watched host. */
function siteFor(watch: { url: string }): string {
  return normalizeSite(watch.url);
}

export async function requestMandate(
  db: Db,
  userId: string,
  agentKey: AgentKey | null,
  input: { watchId: string; maxPriceCents?: number; quantity?: number; days?: number },
) {
  const watch = await getWatch(db, userId, input.watchId);
  if (watch.status !== "watching" && watch.status !== "target_hit") throw new AppError(409, "watch_ended", `this watch is ${watch.status}`);
  enforce(watch.title, watch.url);
  enforceSite(siteFor(watch));
  const maxPriceCents = input.maxPriceCents ?? watch.targetPriceCents;
  if (!Number.isSafeInteger(maxPriceCents) || maxPriceCents <= 0) throw new AppError(400, "invalid_price", "maxPriceCents must be a positive integer");
  const quantity = Math.min(Math.max(Math.round(input.quantity ?? 1), 1), 10);
  const days = Math.min(Math.max(Math.round(input.days ?? 30), 1), 90);
  const site = siteFor(watch);
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO buy_mandates (user_id, watch_id, site, max_price_cents, quantity, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, expires_at AS "expiresAt"`,
      [userId, watch.id, site, maxPriceCents, quantity, days],
    );
    const approval = await tx.query(
      `INSERT INTO approvals (kind, user_id, agent_key_id, buy_mandate_id, amount_cents, input) VALUES ('buy_mandate', $1, $2, $3, $4, $5) RETURNING id`,
      [
        userId, agentKey?.id ?? null, rows[0].id, maxPriceCents * quantity,
        JSON.stringify({ title: watch.title, site, maxPriceCents, quantity, expiresOn: new Date(rows[0].expiresAt).toISOString().slice(0, 10) }),
      ],
    );
    return { status: "pending_approval" as const, mandateId: rows[0].id as string, approvalId: approval.rows[0].id as string, site, maxPriceCents, quantity };
  });
}

/** Called from approve() for a 'buy_mandate' approval. */
export async function activateMandate(tx: Tx, mandateId: string) {
  await tx.query("UPDATE buy_mandates SET status = 'active' WHERE id = $1 AND status = 'pending'", [mandateId]);
}

export async function denyMandate(tx: Tx, mandateId: string) {
  await tx.query("UPDATE buy_mandates SET status = 'denied' WHERE id = $1 AND status = 'pending'", [mandateId]);
}

export async function revokeMandate(db: Db, userId: string, mandateId: string) {
  await withTx(db, async (tx) => {
    const { rowCount } = await tx.query("UPDATE buy_mandates SET status = 'revoked' WHERE id = $1 AND user_id = $2 AND status IN ('pending','active')", [mandateId, userId]);
    if (!rowCount) throw new AppError(404, "not_found", "no pending or active mandate with that id");
    await tx.query("UPDATE approvals SET status = 'denied', decided_at = now() WHERE buy_mandate_id = $1 AND status = 'pending'", [mandateId]);
  });
}

export type MandateCheck =
  | { status: "allowed"; mandateId: string; maxPriceCents: number; quantity: number; message: string }
  | { status: "no_mandate" | "price_too_high" | "wrong_site" | "needs_browser_access" | "frozen" | "refused"; message: string };

/**
 * May the agent buy this watched item now, at this price, on this site?
 * Checks the mandate and the browser permission to check out. The agent must
 * call this right before checkout and stop unless it says "allowed".
 */
export async function checkMandate(db: Db, userId: string, input: { watchId: string; priceCents: number; site: string }): Promise<MandateCheck> {
  if (await frozenAt(db, userId)) return { status: "frozen", message: "The owner froze all agent activity. Don't buy anything." };
  const host = normalizeSite(input.site);
  const watch = await getWatch(db, userId, input.watchId);
  const refused = screen(watch.title) ?? screen(watch.url) ?? screenSite(host);
  if (refused) return { status: "refused", message: refusalMessage(refused) };
  const live = (await listMandates(db, userId, { watchId: input.watchId })).filter((m) => m.state === "active");
  if (!live.length) return { status: "no_mandate", message: "The owner hasn't signed a buy mandate for this item. Don't buy it; tell the owner the price instead." };
  const m = live.find((x) => host === x.site || host.endsWith(`.${x.site}`));
  if (!m) return { status: "wrong_site", message: `The mandate only covers ${live.map((x) => x.site).join(", ")}.` };
  if (input.priceCents > m.maxPriceCents) {
    return { status: "price_too_high", message: `${usd(input.priceCents)} is above the owner's ${usd(m.maxPriceCents)} limit. Keep watching.` };
  }
  const access = await checkAccess(db, userId, host, "checkout_approved_order");
  if (access.status !== "allowed") {
    return { status: "needs_browser_access", message: `The mandate is fine, but there's no permission to check out on ${host}: ${access.message}` };
  }
  return {
    status: "allowed", mandateId: m.id, maxPriceCents: m.maxPriceCents, quantity: m.quantity,
    message: `Allowed: buy at most ${m.quantity} at up to ${usd(m.maxPriceCents)} each, with the payment method the store already has selected. Then call mark_bought with the price you paid.`,
  };
}

/**
 * Called when a watched item is marked bought. Uses up the item's live
 * mandate and reports whether the purchase stayed within it. Returns null when
 * there was no mandate (the owner bought it themselves).
 */
export async function useMandate(tx: Tx, userId: string, watchId: string, priceCents: number | null, agentKeyId: string | null) {
  const { rows } = await tx.query(
    `SELECT id, max_price_cents AS "maxPriceCents", site FROM buy_mandates
      WHERE user_id = $1 AND watch_id = $2 AND status = 'active' AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, watchId],
  );
  const m = rows[0];
  if (!m) return null;
  const within = priceCents !== null && priceCents <= m.maxPriceCents;
  await tx.query("UPDATE buy_mandates SET status = 'used', used_at = now(), used_price_cents = $2 WHERE id = $1", [m.id, priceCents]);
  await auditTx(tx, userId, {
    actor: agentKeyId ? "agent" : "owner", agentKeyId, kind: "mandate_used",
    summary: `Bought under a mandate on ${m.site} for ${priceCents === null ? "an unknown price" : usd(priceCents)}`,
    result: within ? "within the mandate" : `above the ${usd(m.maxPriceCents)} limit`, data: { mandateId: m.id, watchId },
  });
  return { mandateId: m.id as string, maxPriceCents: m.maxPriceCents as number, within };
}
