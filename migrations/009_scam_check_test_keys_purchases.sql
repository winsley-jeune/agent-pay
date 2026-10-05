-- Three features from docs/asia-features.md: the "is someone on the phone
-- with you?" check, test keys for developers, and purchase tracking with
-- return windows and confirm-received.

-- ---------------------------------------------------------------- scam check
-- On a protected account, the owner answers three questions before signing a
-- big or sensitive approval. Any "yes" means only a trusted helper can let it
-- through (the waiting period no longer completes it).
ALTER TABLE approvals ADD COLUMN scam_answers jsonb;
ALTER TABLE approvals ADD COLUMN scam_flagged boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- test keys
--   test_wallet  per-owner pretend money for ap_test_ keys
--   test_sink    where pretend money goes and comes from; never mixed with real accounts
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('wallet','provider','holds','platform_fees','stripe_clearing','dev_clearing','payouts','envelope','vault','test_wallet','test_sink'));
INSERT INTO accounts (kind) VALUES ('test_sink');

ALTER TABLE ledger_txns DROP CONSTRAINT ledger_txns_type_check;
ALTER TABLE ledger_txns ADD CONSTRAINT ledger_txns_type_check
  CHECK (type IN ('topup','hold','capture','release','refund','payout','dev_credit','subscription','envelope','vault','test'));

ALTER TABLE agent_keys ADD COLUMN test boolean NOT NULL DEFAULT false;
ALTER TABLE holds ADD COLUMN test boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- purchases
-- Orders the agent placed (or the owner records), with the return deadline and
-- whether the owner confirmed everything arrived.
--   status: ordered -> received | problem -> returned | closed
CREATE TABLE purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  source          text NOT NULL CHECK (source IN ('grocery','price_watch','manual','agent')),
  source_id       uuid,
  store           text NOT NULL,
  title           text NOT NULL,
  order_number    text,
  total_cents     bigint,
  ordered_at      timestamptz NOT NULL DEFAULT now(),
  return_days     integer NOT NULL CHECK (return_days BETWEEN 0 AND 365),
  return_by       date NOT NULL,
  status          text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','received','problem','returned','closed')),
  received_at     timestamptz,
  missing_items   text[] NOT NULL DEFAULT '{}',
  problem_note    text,
  added_by_agent_key_id uuid REFERENCES agent_keys(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX purchases_user ON purchases (user_id, status, return_by);
