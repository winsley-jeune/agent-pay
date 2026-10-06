import Stripe from "stripe";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, lockAccount, post, systemAccount } from "./ledger.js";
import type { Provider } from "./registry.js";

export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 100_000;

let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  if (!config.stripeSecretKey) throw new AppError(503, "stripe_not_configured", "STRIPE_SECRET_KEY is not set");
  if (!config.stripeSecretKey.startsWith("sk_test_") && process.env.NODE_ENV !== "production") {
    throw new AppError(503, "stripe_live_key", "refusing to use a live Stripe key outside production");
  }
  stripeClient ??= new Stripe(config.stripeSecretKey);
  return stripeClient;
}

/** Start a card top-up. Credits are added only when Stripe's webhook confirms payment. */
export async function createTopupCheckout(db: Db, userId: string, email: string, amountCents: number): Promise<string> {
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    throw new AppError(400, "invalid_amount", `top-ups must be between ${MIN_TOPUP_CENTS} and ${MAX_TOPUP_CENTS} cents`);
  }
  const { rows } = await db.query("INSERT INTO topups (user_id, amount_cents) VALUES ($1, $2) RETURNING id", [userId, amountCents]);
  const topupId: string = rows[0].id;
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: email,
    client_reference_id: topupId,
    metadata: { topup_id: topupId, user_id: userId },
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: amountCents, product_data: { name: "Agent credits" } },
      },
    ],
    success_url: `${config.publicUrl}/?topup=success`,
    cancel_url: `${config.publicUrl}/?topup=cancelled`,
  });
  await db.query("UPDATE topups SET checkout_session = $2 WHERE id = $1", [topupId, session.id]);
  return session.url!;
}

/** Verify a webhook's signature and parse it. Throws on a bad signature. */
export function verifyStripeEvent(rawBody: Buffer, signature: string, secret = config.stripeWebhookSecret) {
  if (!secret) throw new AppError(503, "stripe_not_configured", "STRIPE_WEBHOOK_SECRET is not set");
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new AppError(400, "bad_signature", "invalid Stripe signature");
  }
}

/**
 * Apply a verified Stripe event. Each event id is recorded in the same
 * transaction as its ledger entries, so a redelivered event is a no-op.
 */
export async function handleStripeEvent(db: Db, event: { id: string; type: string; data: { object: any } }): Promise<"applied" | "duplicate" | "ignored"> {
  return withTx(db, async (tx) => {
    const { rowCount } = await tx.query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [event.id, event.type]);
    if (!rowCount) return "duplicate";

    const session = event.data.object;
    if (event.type === "checkout.session.expired") {
      await tx.query("UPDATE topups SET status = 'expired' WHERE id = $1 AND status = 'pending'", [session.metadata?.topup_id]);
      return "applied";
    }
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
      return "ignored";
    }
    if (session.payment_status !== "paid") return "ignored";

    const { rows } = await tx.query(
      `SELECT t.id, t.amount_cents AS "amountCents", t.status, a.id AS "walletAccountId"
         FROM topups t JOIN accounts a ON a.owner_id = t.user_id AND a.kind = 'wallet'
        WHERE t.id = $1 FOR UPDATE OF t`,
      [session.metadata?.topup_id],
    );
    const topup = rows[0];
    if (!topup || topup.status === "completed") return "ignored";
    // Trust the amount Stripe actually collected, and refuse anything that doesn't match what we asked for.
    if (session.amount_total !== topup.amountCents || session.currency !== "usd") {
      throw new AppError(422, "topup_mismatch", `Stripe amount ${session.amount_total} ${session.currency} does not match top-up ${topup.id}`);
    }
    await post(
      tx,
      "topup",
      [
        { accountId: await systemAccount(tx, "stripe_clearing"), amountCents: -topup.amountCents },
        { accountId: topup.walletAccountId, amountCents: topup.amountCents },
      ],
      `card top-up ${topup.id} (${session.id})`,
    );
    await tx.query("UPDATE topups SET status = 'completed', completed_at = now() WHERE id = $1", [topup.id]);
    return "applied";
  });
}

/** Free test credits. Only reachable when ALLOW_DEV_CREDIT=true. */
export async function devCredit(db: Db, walletAccountId: string, amountCents: number): Promise<void> {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_TOPUP_CENTS) {
    throw new AppError(400, "invalid_amount", `amount must be 1–${MAX_TOPUP_CENTS} cents`);
  }
  await withTx(db, async (tx) =>
    post(
      tx,
      "dev_credit",
      [
        { accountId: await systemAccount(tx, "dev_clearing"), amountCents: -amountCents },
        { accountId: walletAccountId, amountCents },
      ],
      "test credits (dev only)",
    ),
  );
}

/**
 * Move a provider's earnings into the payouts account and record a payout
 * request. Sending the money (Stripe Connect transfer) is a separate step.
 */
export async function requestPayout(db: Db, provider: Provider, amountCents: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new AppError(400, "invalid_amount", "amount must be a positive integer");
  return withTx(db, async (tx) => {
    await lockAccount(tx, provider.accountId);
    const available = await balance(tx, provider.accountId);
    if (available < amountCents) {
      throw new AppError(402, "insufficient_earnings", "payout exceeds available earnings", { availableCents: available });
    }
    const { rows } = await tx.query(
      `INSERT INTO payouts (provider_id, amount_cents) VALUES ($1, $2)
       RETURNING id, amount_cents AS "amountCents", status, created_at AS "createdAt"`,
      [provider.id, amountCents],
    );
    await post(
      tx,
      "payout",
      [
        { accountId: provider.accountId, amountCents: -amountCents },
        { accountId: await systemAccount(tx, "payouts"), amountCents },
      ],
      `payout ${rows[0].id}`,
    );
    return rows[0];
  });
}

export async function listPayouts(db: Db, providerId: string) {
  const { rows } = await db.query(
    `SELECT id, amount_cents AS "amountCents", status, created_at AS "createdAt" FROM payouts WHERE provider_id = $1 ORDER BY created_at DESC`,
    [providerId],
  );
  return rows;
}
