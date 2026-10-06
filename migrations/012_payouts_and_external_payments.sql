-- Paying sellers their earnings through Stripe Connect, and paying agents and
-- resources outside AgentPay over x402 (HTTP) and A2A with the x402 extension.

-- ---------------------------------------------------------------- Stripe Connect payouts
ALTER TABLE providers ADD COLUMN stripe_account_id text UNIQUE;
ALTER TABLE providers ADD COLUMN payouts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE providers ADD COLUMN details_submitted boolean NOT NULL DEFAULT false;
-- Request a payout automatically whenever earnings reach this many cents (NULL = only when asked).
ALTER TABLE providers ADD COLUMN auto_payout_min_cents bigint CHECK (auto_payout_min_cents IS NULL OR auto_payout_min_cents >= 100);

-- status:
--   requested  earnings moved aside; waiting for the transfer (retried by the background job)
--   paid       transferred to the seller's Stripe account (Stripe pays it out to their bank)
--   failed     the transfer was refused; earnings went back to the seller's balance
--   reversed   the transfer was reversed later; earnings went back to the seller's balance
ALTER TABLE payouts DROP CONSTRAINT payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('requested','paid','failed','reversed'));
ALTER TABLE payouts ADD COLUMN stripe_transfer_id text UNIQUE;
ALTER TABLE payouts ADD COLUMN failure text;
ALTER TABLE payouts ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD COLUMN sent_at timestamptz;

-- ---------------------------------------------------------------- external payments
-- external_settlement records the USDC AgentPay's own wallet spent for owners on x402 and A2A.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('wallet','provider','holds','platform_fees','stripe_clearing','dev_clearing','payouts','envelope','vault','test_wallet','test_sink','external_settlement'));
INSERT INTO accounts (kind) VALUES ('external_settlement');

-- A hold for an outside payment has no marketplace tool.
ALTER TABLE holds ALTER COLUMN tool_id DROP NOT NULL;
ALTER TABLE holds ADD COLUMN external_protocol text CHECK (external_protocol IN ('x402','a2a'));
ALTER TABLE holds ADD COLUMN external_target text;            -- the URL or agent paid
ALTER TABLE holds ADD COLUMN external_receipt jsonb;          -- settlement response: transaction hash, network, payer
ALTER TABLE holds ADD CHECK ((tool_id IS NULL) = (external_protocol IS NOT NULL));
