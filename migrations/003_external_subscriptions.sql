-- Everyday subscriptions (Netflix, Apple TV+, AT&T, the gym...) that bill the
-- owner's card or phone bill directly. AgentPay tracks, reminds, guides
-- cancellation and recommends; it never charges these through the ledger.

-- Known consumer services. Prices here are illustrative tiers with an as-of
-- date, used for comparisons only; the owner's own price is the truth.
CREATE TABLE services (
  slug                 text PRIMARY KEY,
  name                 text NOT NULL,
  category             text NOT NULL,
  website              text,
  cancel_url           text,
  cancel_steps         text[] NOT NULL DEFAULT '{}',
  -- Uppercase substrings that identify this service on a bank statement.
  merchant_patterns    text[] NOT NULL DEFAULT '{}',
  -- Cancelling may cost money (early termination fee, device balance) or need notice.
  contract_risk        boolean NOT NULL DEFAULT false,
  contract_note        text,
  -- [{ "name": "Standard with ads", "priceCents": 799, "interval": "month" }, ...]
  tiers                jsonb NOT NULL DEFAULT '[]',
  prices_as_of         date
);

-- A bundle that includes several services for one price.
CREATE TABLE service_bundles (
  slug          text PRIMARY KEY,
  name          text NOT NULL,
  includes      text[] NOT NULL,          -- service slugs
  price_cents   bigint NOT NULL,
  interval      text NOT NULL CHECK (interval IN ('week','month','year')),
  note          text,
  prices_as_of  date
);

-- status:
--   active            being billed
--   trial             free trial; billing starts at trial_ends_on
--   cancel_requested  an agent asked to cancel; waiting for the owner
--   cancel_approved   the owner said go ahead; someone still has to cancel it
--   canceled          cancelled (charges after canceled_at are flagged)
CREATE TABLE external_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  service_slug        text REFERENCES services(slug),
  name                text NOT NULL,
  category            text NOT NULL,
  plan_name           text,
  price_cents         bigint NOT NULL CHECK (price_cents >= 0),
  interval            text NOT NULL CHECK (interval IN ('week','month','year')),
  -- Who actually bills it decides how to cancel it (Paramount+ bought on an iPhone is cancelled in Apple settings).
  billed_through      text NOT NULL DEFAULT 'direct' CHECK (billed_through IN ('direct','apple','google','amazon','carrier','other')),
  payment_method      text,                 -- free text, e.g. "Visa ending 4242"
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','trial','cancel_requested','cancel_approved','canceled')),
  next_renewal_on     date,
  trial_ends_on       date,
  contract_until      date,
  early_termination_fee_cents bigint,
  last_used_on        date,
  merchant_key        text,                 -- links imported bank charges to this subscription
  price_history       jsonb NOT NULL DEFAULT '[]',   -- [{ "date": "2026-09-01", "fromCents": 1549, "toCents": 1799 }]
  notes               text,
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','agent')),
  added_by_agent_key_id uuid REFERENCES agent_keys(id),
  canceled_at         timestamptz,
  cancel_confirmation text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX external_subscriptions_user ON external_subscriptions (user_id, status);
CREATE INDEX external_subscriptions_merchant ON external_subscriptions (user_id, merchant_key);

-- Charges imported from bank or card statements.
CREATE TABLE external_charges (
  id                        bigserial PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES users(id),
  charged_on                date NOT NULL,
  description               text NOT NULL,
  amount_cents              bigint NOT NULL,
  merchant_key              text NOT NULL,
  service_slug              text REFERENCES services(slug),
  external_subscription_id  uuid REFERENCES external_subscriptions(id),
  imported_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, charged_on, description, amount_cents)
);
CREATE INDEX external_charges_merchant ON external_charges (user_id, merchant_key, charged_on);

-- Agents can ask to cancel an everyday subscription; the owner approves.
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('call','subscription','resume','external_cancel'));
ALTER TABLE approvals ADD COLUMN external_subscription_id uuid REFERENCES external_subscriptions(id);
ALTER TABLE approvals DROP CONSTRAINT approvals_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_check CHECK (
  kind = 'call'
  OR (kind IN ('subscription','resume') AND subscription_id IS NOT NULL)
  OR (kind = 'external_cancel' AND external_subscription_id IS NOT NULL)
);
