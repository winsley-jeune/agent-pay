-- Subscriptions an agent can request for its owner, approved with a passkey.

ALTER TABLE ledger_txns DROP CONSTRAINT ledger_txns_type_check;
ALTER TABLE ledger_txns ADD CONSTRAINT ledger_txns_type_check
  CHECK (type IN ('topup','hold','capture','release','refund','payout','dev_credit','subscription'));

-- Passkeys (WebAuthn credentials). A passkey never leaves the owner's device;
-- the server keeps only the public key.
CREATE TABLE passkeys (
  id            text PRIMARY KEY,                 -- base64url credential id
  user_id       uuid NOT NULL REFERENCES users(id),
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[],
  device_name   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- One-time WebAuthn challenges. An "approve" challenge is bound to one approval
-- and its amount, so a signature can't be replayed to approve something else.
CREATE TABLE passkey_challenges (
  challenge    text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  purpose      text NOT NULL CHECK (purpose IN ('register','approve')),
  approval_id  uuid,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);

-- Plans a provider sells. A plan can include free calls to one of the provider's tools.
CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES providers(id),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name            text NOT NULL,
  description     text NOT NULL,
  category        text NOT NULL,
  price_cents     bigint NOT NULL CHECK (price_cents > 0),
  interval        text NOT NULL CHECK (interval IN ('week','month','year')),
  tool_id         uuid REFERENCES tools(id),
  included_calls  integer CHECK (included_calls IS NULL OR included_calls > 0),
  features        text[] NOT NULL DEFAULT '{}',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((tool_id IS NULL) = (included_calls IS NULL))
);
CREATE INDEX plans_category ON plans (category) WHERE active;

-- status:
--   pending_approval  requested by an agent, waiting for the owner's passkey
--   active            paid for the current period
--   past_due          renewal failed (no funds, or price rose above the owner's limit)
--   canceled          ended; never charged again
--   denied            owner said no
CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  agent_key_id          uuid REFERENCES agent_keys(id),
  plan_id               uuid NOT NULL REFERENCES plans(id),
  status                text NOT NULL CHECK (status IN ('pending_approval','active','past_due','canceled','denied')),
  -- Each subscription has its own ceiling: renewals above it need a new passkey approval.
  max_price_cents       bigint NOT NULL CHECK (max_price_cents > 0),
  reason                text,
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  past_due_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  canceled_at           timestamptz
);
CREATE INDEX subscriptions_user ON subscriptions (user_id, status);
CREATE INDEX subscriptions_due ON subscriptions (current_period_end) WHERE status IN ('active','past_due');
-- One live subscription per plan per owner.
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (user_id, plan_id)
  WHERE status IN ('pending_approval','active','past_due');

CREATE TABLE subscription_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id),
  amount_cents     bigint NOT NULL,
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_start)
);

-- Approvals now cover subscriptions as well as single expensive calls.
ALTER TABLE approvals ALTER COLUMN tool_id DROP NOT NULL;
ALTER TABLE approvals ALTER COLUMN agent_key_id DROP NOT NULL;
ALTER TABLE approvals ADD COLUMN kind text NOT NULL DEFAULT 'call' CHECK (kind IN ('call','subscription','resume'));
ALTER TABLE approvals ADD COLUMN subscription_id uuid REFERENCES subscriptions(id);
ALTER TABLE approvals ADD COLUMN user_id uuid REFERENCES users(id);
ALTER TABLE approvals ADD COLUMN passkey_id text REFERENCES passkeys(id);
UPDATE approvals ap SET user_id = k.user_id FROM agent_keys k WHERE k.id = ap.agent_key_id;
ALTER TABLE approvals ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE approvals ADD CHECK (kind = 'call' OR subscription_id IS NOT NULL);

-- Calls covered by a subscription's included quota are free and counted here.
ALTER TABLE holds ADD COLUMN subscription_id uuid REFERENCES subscriptions(id);
CREATE INDEX holds_subscription ON holds (subscription_id, created_at) WHERE subscription_id IS NOT NULL;
