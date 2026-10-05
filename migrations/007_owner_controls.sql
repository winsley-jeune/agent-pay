-- Owner controls borrowed from Asian agent-payment systems (see docs/asia.md):
-- autonomy levels and spend rules, envelopes, buy mandates, a kill switch,
-- a locked vault, a hash-chained "why" log, price-rise decisions and incidents.

-- ---------------------------------------------------------------- ledger
--   envelope   money set aside for one agent or set of tools, returned to the wallet when it ends
--   vault      money no agent or approval can spend; unlocking takes a passkey and a delay
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('wallet','provider','holds','platform_fees','stripe_clearing','dev_clearing','payouts','envelope','vault'));

ALTER TABLE ledger_txns DROP CONSTRAINT ledger_txns_type_check;
ALTER TABLE ledger_txns ADD CONSTRAINT ledger_txns_type_check
  CHECK (type IN ('topup','hold','capture','release','refund','payout','dev_credit','subscription','envelope','vault'));

-- ---------------------------------------------------------------- kill switch
ALTER TABLE users ADD COLUMN frozen_at timestamptz;

-- ---------------------------------------------------------------- autonomy levels
-- level:
--   ask       every paid call needs the owner's approval
--   rules     calls matching one of spend_rules go through; anything else needs approval
--   budget    calls go through within the caps and below approval_threshold_cents (the original behaviour)
-- spend_rules: [{ "name": "...", "tools": ["slug"] | null, "maxCents": 50, "outcome": "auto" | "observe" }]
-- observe_above_cents: calls that go through on their own but cost more than this are flagged for review.
-- cooling_off_until: until then, only calls up to config.coolingOffAutoMaxCents go through on their own.
ALTER TABLE agent_keys ADD COLUMN level text NOT NULL DEFAULT 'budget' CHECK (level IN ('ask','rules','budget'));
ALTER TABLE agent_keys ADD COLUMN spend_rules jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_keys ADD COLUMN observe_above_cents bigint;
ALTER TABLE agent_keys ADD COLUMN cooling_off_until timestamptz;

-- How each paid call was decided, so the owner can review the ones that ran unattended.
--   auto      within the agent's level, rules or envelope
--   observe   went through, flagged for the owner to look at
--   approved  the owner approved it with a passkey
--   covered   free under a subscription's included calls
ALTER TABLE holds ADD COLUMN decision text NOT NULL DEFAULT 'auto' CHECK (decision IN ('auto','observe','approved','covered'));
ALTER TABLE holds ADD COLUMN decision_reason text;
ALTER TABLE holds ADD COLUMN reviewed_at timestamptz;
ALTER TABLE holds ADD COLUMN agent_reason text;
CREATE INDEX holds_to_review ON holds (wallet_account_id) WHERE decision = 'observe' AND reviewed_at IS NULL;

-- ---------------------------------------------------------------- envelopes
-- status: pending (waiting for the owner's passkey), active, closed (money returned), denied
CREATE TABLE envelopes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  agent_key_id  uuid REFERENCES agent_keys(id),     -- NULL = any of the owner's agents
  name          text NOT NULL,
  purpose       text,
  tool_slugs    text[],                             -- NULL = any tool
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','closed','denied')),
  expires_at    timestamptz NOT NULL,
  closed_at     timestamptz,
  close_reason  text,
  requested_by_agent_key_id uuid REFERENCES agent_keys(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX envelopes_user ON envelopes (user_id, status);
CREATE INDEX envelopes_expiry ON envelopes (expires_at) WHERE status = 'active';

-- ---------------------------------------------------------------- vault
CREATE TABLE vault_unlocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  -- requested -> waiting (approved, until available_at) -> done | canceled | denied
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','waiting','done','canceled','denied')),
  available_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX vault_unlocks_due ON vault_unlocks (available_at) WHERE status = 'waiting';

-- ---------------------------------------------------------------- buy mandates
-- "Buy this when it drops under $40, at most 1, on target.com, before Dec 1."
-- Signed with a passkey; the agent checks it before buying. A rule the agent
-- follows until AgentPay cards can refuse the charge themselves.
CREATE TABLE buy_mandates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  watch_id         uuid NOT NULL REFERENCES price_watches(id),
  site             text NOT NULL,
  max_price_cents  bigint NOT NULL CHECK (max_price_cents > 0),
  quantity         integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','used','revoked','denied')),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  used_price_cents bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buy_mandates_watch ON buy_mandates (watch_id, status);

-- ---------------------------------------------------------------- browser permissions: purpose
ALTER TABLE browser_grants ADD COLUMN purpose text;

-- ---------------------------------------------------------------- everyday subscriptions: price-rise decisions
-- The price the owner has accepted. A newer, higher price waits for "keep at the new price" or "cancel".
ALTER TABLE external_subscriptions ADD COLUMN accepted_price_cents bigint;

-- ---------------------------------------------------------------- restricted categories
-- A grocery item agents must not buy (alcohol, medicine...) stays on the list as 'refused'.
ALTER TABLE grocery_items DROP CONSTRAINT grocery_items_status_check;
ALTER TABLE grocery_items ADD CONSTRAINT grocery_items_status_check
  CHECK (status IN ('needed','in_cart','substituted','unavailable','removed','refused'));

-- ---------------------------------------------------------------- why log
-- Append-only and hash-chained per owner: each entry's hash covers the
-- previous entry's hash, so editing or removing an entry breaks the chain.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  seq           integer NOT NULL,
  actor         text NOT NULL CHECK (actor IN ('agent','owner','system')),
  agent_key_id  uuid REFERENCES agent_keys(id),
  kind          text NOT NULL,
  summary       text NOT NULL,
  instruction   text,          -- what the owner asked for, in the agent's words
  reason        text,          -- why the agent or AgentPay did it
  result        text,          -- what happened
  data          jsonb NOT NULL DEFAULT '{}',
  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  created_at    timestamptz NOT NULL,
  UNIQUE (user_id, seq)
);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ledger_no_mutation();

ALTER TABLE agent_activity ADD COLUMN instruction text;
ALTER TABLE agent_activity ADD COLUMN reason text;
ALTER TABLE agent_activity ADD COLUMN result text;

-- ---------------------------------------------------------------- incidents
-- kind (from a Japanese legal analysis of agent payments):
--   misjudgment       a mistake within the authority the owner gave
--   condition_breach  the agent went outside the limits or conditions the owner set
--   system_bug        AgentPay or a provider got it wrong
--   hijacked          someone else controlled the agent (stolen key, prompt injection)
--   unclassified
CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  agent_key_id     uuid REFERENCES agent_keys(id),
  hold_id          uuid REFERENCES holds(id),
  kind             text NOT NULL DEFAULT 'unclassified' CHECK (kind IN ('misjudgment','condition_breach','system_bug','hijacked','unclassified')),
  description      text NOT NULL,
  amount_cents     bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution       text,
  reported_by      text NOT NULL CHECK (reported_by IN ('owner','agent')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX incidents_user ON incidents (user_id, status);

-- ---------------------------------------------------------------- approvals
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('call','subscription','resume','external_cancel','grocery_order','risk_consent','browser_access',
                  'envelope','buy_mandate','unfreeze','vault_unlock'));
-- Why AgentPay asked (e.g. "no spending rule covers this call") and the agent's own reason.
ALTER TABLE approvals ADD COLUMN why text;
ALTER TABLE approvals ADD COLUMN agent_reason text;
ALTER TABLE approvals ADD COLUMN envelope_id uuid REFERENCES envelopes(id);
ALTER TABLE approvals ADD COLUMN buy_mandate_id uuid REFERENCES buy_mandates(id);
ALTER TABLE approvals ADD COLUMN vault_unlock_id uuid REFERENCES vault_unlocks(id);
ALTER TABLE approvals DROP CONSTRAINT approvals_target_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_check CHECK (
  kind IN ('call','risk_consent','unfreeze')
  OR (kind IN ('subscription','resume') AND subscription_id IS NOT NULL)
  OR (kind = 'external_cancel' AND external_subscription_id IS NOT NULL)
  OR (kind = 'grocery_order' AND grocery_list_id IS NOT NULL)
  OR (kind = 'browser_access' AND browser_grant_id IS NOT NULL)
  OR (kind = 'envelope' AND envelope_id IS NOT NULL)
  OR (kind = 'buy_mandate' AND buy_mandate_id IS NOT NULL)
  OR (kind = 'vault_unlock' AND vault_unlock_id IS NOT NULL)
);
