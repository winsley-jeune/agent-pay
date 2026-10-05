-- Money is always integer cents (bigint). Balances are never stored: an
-- account's balance is SUM(ledger_entries.amount_cents) for that account.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- kind:
--   wallet          a user's spendable credits
--   provider        a provider's earnings
--   holds           system escrow for in-flight calls
--   platform_fees   system revenue
--   stripe_clearing system counter-account for card top-ups
--   dev_clearing    system counter-account for free test credits
--   payouts         system account for earnings paid out to providers
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('wallet','provider','holds','platform_fees','stripe_clearing','dev_clearing','payouts')),
  owner_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_system_kind ON accounts (kind) WHERE owner_id IS NULL;
CREATE INDEX accounts_owner ON accounts (owner_id);

-- A transaction groups entries that must sum to zero (checked by a deferred trigger).
CREATE TABLE ledger_txns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL CHECK (type IN ('topup','hold','capture','release','refund','payout','dev_credit')),
  memo        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  txn_id        uuid NOT NULL REFERENCES ledger_txns(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);
CREATE INDEX ledger_entries_txn ON ledger_entries (txn_id);

-- The ledger is append-only.
CREATE FUNCTION ledger_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_no_mutation();
CREATE TRIGGER ledger_txns_immutable BEFORE UPDATE OR DELETE ON ledger_txns
  FOR EACH ROW EXECUTE FUNCTION ledger_no_mutation();

-- Every transaction must balance to zero by commit time.
CREATE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO total FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger txn % does not balance (sum=%)', NEW.txn_id, total;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

CREATE TABLE agent_keys (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users(id),
  name                      text NOT NULL,
  key_prefix                text NOT NULL,
  key_hash                  text NOT NULL UNIQUE,
  per_call_max_cents        bigint,
  daily_cap_cents           bigint,
  monthly_cap_cents         bigint,
  approval_threshold_cents  bigint,
  allowed_tool_slugs        text[],          -- NULL = every tool
  revoked_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_keys_user ON agent_keys (user_id);

CREATE TABLE providers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  name         text NOT NULL,
  account_id   uuid NOT NULL REFERENCES accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- pricing_type:
--   per_call  every call costs price_cents
--   per_unit  cost = price_cents * input[units_field]; the provider may report
--             fewer units used via the X-AgentPay-Units response header
CREATE TABLE tools (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      uuid NOT NULL REFERENCES providers(id),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name             text NOT NULL,
  description      text NOT NULL,
  input_schema     jsonb NOT NULL DEFAULT '{"type":"object"}',
  pricing_type     text NOT NULL CHECK (pricing_type IN ('per_call','per_unit')),
  price_cents      bigint NOT NULL CHECK (price_cents >= 0),
  units_field      text,
  max_units        integer,
  upstream_url     text NOT NULL,
  upstream_auth    text,                    -- sent as the Authorization header
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (pricing_type = 'per_call' OR units_field IS NOT NULL)
);

CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id  uuid NOT NULL REFERENCES agent_keys(id),
  tool_id       uuid NOT NULL REFERENCES tools(id),
  amount_cents  bigint NOT NULL,
  input         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','used')),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_agent_key ON approvals (agent_key_id, status);

-- One row per paid call. Holds are the unit of idempotency and budget accounting.
CREATE TABLE holds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id      uuid NOT NULL REFERENCES agent_keys(id),
  wallet_account_id uuid NOT NULL REFERENCES accounts(id),
  tool_id           uuid NOT NULL REFERENCES tools(id),
  idempotency_key   text NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  captured_cents    bigint,
  status            text NOT NULL DEFAULT 'held' CHECK (status IN ('held','captured','released')),
  result            jsonb,
  error             text,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  UNIQUE (agent_key_id, idempotency_key)
);
CREATE INDEX holds_budget ON holds (agent_key_id, created_at) WHERE status <> 'released';
CREATE INDEX holds_expiry ON holds (expires_at) WHERE status = 'held';

-- Stripe webhook dedupe and checkout bookkeeping.
CREATE TABLE stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  checkout_session   text UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','expired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

CREATE TABLE payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES providers(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO accounts (kind) VALUES ('holds'), ('platform_fees'), ('stripe_clearing'), ('dev_clearing'), ('payouts');
