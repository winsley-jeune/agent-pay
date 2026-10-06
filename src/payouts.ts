import type Stripe from "stripe";
import { auditTx } from "./audit.js";
import { config } from "./config.js";
import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";
import type { Provider } from "./registry.js";
import { requestPayout, stripe } from "./wallet.js";

// Paying sellers their earnings, through Stripe Connect. Each seller connects
// a Stripe Express account (Stripe collects and verifies their identity and
// bank details; AgentPay never sees them). A payout moves the seller's earnings
// aside in the ledger and transfers that amount from AgentPay's Stripe
// balance to the seller's Stripe account; Stripe then pays it to their bank on
// their payout schedule. A refused or reversed transfer puts the earnings back.

/** The parts of the Stripe client payouts use, so tests can pass a fake. */
export interface StripeConnect {
  accounts: { create(p: Stripe.AccountCreateParams): Promise<{ id: string }> };
  accountLinks: { create(p: Stripe.AccountLinkCreateParams): Promise<{ url: string }> };
  transfers: { create(p: Stripe.TransferCreateParams, o?: Stripe.RequestOptions): Promise<{ id: string }> };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const MAX_ATTEMPTS = 5;

/** Start (or continue) Stripe onboarding for a seller; returns the Stripe-hosted onboarding link. */
export async function connectOnboarding(db: Db, provider: Provider, email: string, client: StripeConnect = stripe()) {
  const { rows } = await db.query("SELECT stripe_account_id AS id FROM providers WHERE id = $1", [provider.id]);
  let accountId: string | null = rows[0]?.id ?? null;
  if (!accountId) {
    const account = await client.accounts.create({
      type: "express",
      country: "US",
      email,
      business_profile: { name: provider.name },
      capabilities: { transfers: { requested: true } },
      metadata: { provider_id: provider.id },
    });
    accountId = account.id;
    await db.query("UPDATE providers SET stripe_account_id = $2 WHERE id = $1", [provider.id, accountId]);
  }
  const link = await client.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${config.publicUrl}/#provider`,
    return_url: `${config.publicUrl}/#provider`,
  });
  return { stripeAccountId: accountId, onboardingUrl: link.url };
}

export async function connectStatus(db: Db, providerId: string) {
  const { rows } = await db.query(
    `SELECT stripe_account_id AS "stripeAccountId", payouts_enabled AS "payoutsEnabled", details_submitted AS "detailsSubmitted",
            auto_payout_min_cents AS "autoPayoutMinCents" FROM providers WHERE id = $1`,
    [providerId],
  );
  return rows[0];
}

export async function setAutoPayout(db: Db, providerId: string, minCents: number | null) {
  if (minCents !== null && (!Number.isInteger(minCents) || minCents < 100)) throw new AppError(400, "invalid_amount", "the minimum must be at least 100 cents");
  await db.query("UPDATE providers SET auto_payout_min_cents = $2 WHERE id = $1", [providerId, minCents]);
}

/** Put a failed or reversed payout's money back in the seller's earnings. */
async function returnToEarnings(tx: Tx, payoutId: string, providerAccountId: string, amountCents: number, why: string) {
  await post(
    tx,
    "payout",
    [{ accountId: await systemAccount(tx, "payouts"), amountCents: -amountCents }, { accountId: providerAccountId, amountCents }],
    `payout ${payoutId} returned to earnings: ${why}`.slice(0, 300),
  );
}

/**
 * Transfer one requested payout. Idempotent: the payout id is the Stripe
 * idempotency key, so retrying never sends money twice.
 */
export async function processPayout(db: Db, payoutId: string, client: StripeConnect = stripe()) {
  const { rows } = await db.query(
    `SELECT po.id, po.amount_cents AS "amountCents", po.status, po.attempts, p.id AS "providerId", p.user_id AS "userId",
            p.account_id AS "accountId", p.stripe_account_id AS "stripeAccountId", p.payouts_enabled AS "payoutsEnabled"
       FROM payouts po JOIN providers p ON p.id = po.provider_id WHERE po.id = $1`,
    [payoutId],
  );
  const po = rows[0];
  if (!po) throw new AppError(404, "not_found", "payout not found");
  if (po.status !== "requested") return { payoutId, status: po.status as string };
  if (!po.stripeAccountId || !po.payoutsEnabled) return { payoutId, status: "requested", waitingFor: "the seller to finish Stripe onboarding" };

  let transferId: string | null = null;
  let failure: string | null = null;
  try {
    const t = await client.transfers.create(
      { amount: po.amountCents, currency: "usd", destination: po.stripeAccountId, transfer_group: `payout_${po.id}`, metadata: { payout_id: po.id, provider_id: po.providerId } },
      { idempotencyKey: `payout_${po.id}` },
    );
    transferId = t.id;
  } catch (err) {
    failure = String((err as Error).message ?? err).slice(0, 500);
  }

  return withTx(db, async (tx) => {
    const locked = await tx.query("SELECT status, attempts FROM payouts WHERE id = $1 FOR UPDATE", [po.id]);
    if (locked.rows[0].status !== "requested") return { payoutId, status: locked.rows[0].status as string };
    if (transferId) {
      await tx.query("UPDATE payouts SET status = 'paid', stripe_transfer_id = $2, sent_at = now(), attempts = attempts + 1 WHERE id = $1", [po.id, transferId]);
      await auditTx(tx, po.userId, { actor: "system", kind: "payout_sent", summary: `Sent ${usd(po.amountCents)} of earnings to Stripe`, data: { payoutId: po.id, transferId } });
      return { payoutId, status: "paid", transferId };
    }
    const attempts = locked.rows[0].attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      await tx.query("UPDATE payouts SET attempts = $2, failure = $3 WHERE id = $1", [po.id, attempts, failure]);
      return { payoutId, status: "requested", retrying: true, failure };
    }
    await lockAccount(tx, po.accountId);
    await returnToEarnings(tx, po.id, po.accountId, po.amountCents, failure ?? "transfer failed");
    await tx.query("UPDATE payouts SET status = 'failed', attempts = $2, failure = $3 WHERE id = $1", [po.id, attempts, failure]);
    await auditTx(tx, po.userId, { actor: "system", kind: "payout_failed", summary: `Payout of ${usd(po.amountCents)} failed; back in earnings`, result: failure });
    return { payoutId, status: "failed", failure };
  });
}

/** Ask for a payout and send it right away if the seller is set up. */
export async function payOut(db: Db, provider: Provider, amountCents: number, client?: StripeConnect) {
  const payout = await requestPayout(db, provider, amountCents);
  const status = config.stripeSecretKey || client ? await processPayout(db, payout.id, client) : { payoutId: payout.id, status: "requested", waitingFor: "Stripe to be configured" };
  return { payout, ...status };
}

/** Retry requested payouts and start automatic ones. Run periodically. */
export async function runPayouts(db: Db, client?: StripeConnect): Promise<number> {
  if (!config.stripeSecretKey && !client) return 0;
  const auto = await db.query(
    `SELECT p.id, p.user_id AS "userId", p.name, p.account_id AS "accountId", p.created_at AS "createdAt", p.auto_payout_min_cents AS min
       FROM providers p WHERE p.auto_payout_min_cents IS NOT NULL AND p.payouts_enabled`,
  );
  for (const p of auto.rows) {
    const earnings = await balance(db, p.accountId);
    if (earnings >= p.min) await requestPayout(db, p, earnings).catch((err) => console.error("auto payout", err));
  }
  const { rows } = await db.query(
    `SELECT po.id FROM payouts po JOIN providers p ON p.id = po.provider_id WHERE po.status = 'requested' AND p.payouts_enabled ORDER BY po.created_at LIMIT 50`,
  );
  let done = 0;
  for (const { id } of rows) {
    const r = await processPayout(db, id, client).catch((err) => ({ status: "error", failure: String(err) }));
    if (r.status === "paid") done++;
  }
  return done;
}

/** Stripe Connect webhook events: account onboarding progress and reversed transfers. */
export async function handleConnectEvent(db: Db, event: { id: string; type: string; account?: string; data: { object: any } }) {
  const fresh = await db.query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [event.id, event.type]);
  if (!fresh.rowCount) return "duplicate" as const;
  const o = event.data.object;
  if (event.type === "account.updated") {
    // Transfers can only be sent once Stripe has enabled the transfers capability for the account.
    const ready = !!o.payouts_enabled && (o.capabilities?.transfers ?? "active") === "active";
    await db.query("UPDATE providers SET payouts_enabled = $2, details_submitted = $3 WHERE stripe_account_id = $1", [o.id, ready, !!o.details_submitted]);
    return "applied" as const;
  }
  if (event.type === "transfer.reversed") {
    return withTx(db, async (tx) => {
      const { rows } = await tx.query(
        `SELECT po.id, po.amount_cents AS "amountCents", po.status, p.account_id AS "accountId", p.user_id AS "userId"
           FROM payouts po JOIN providers p ON p.id = po.provider_id WHERE po.stripe_transfer_id = $1 FOR UPDATE OF po`,
        [o.id],
      );
      const po = rows[0];
      if (!po || po.status !== "paid") return "ignored" as const;
      await lockAccount(tx, po.accountId);
      await returnToEarnings(tx, po.id, po.accountId, po.amountCents, "transfer reversed");
      await tx.query("UPDATE payouts SET status = 'reversed', failure = 'transfer reversed' WHERE id = $1", [po.id]);
      await auditTx(tx, po.userId, { actor: "system", kind: "payout_reversed", summary: `Payout of ${usd(po.amountCents)} was reversed; back in earnings` });
      return "applied" as const;
    });
  }
  return "ignored" as const;
}
