-- Owner permissions for agents acting in the owner's own browser, and
-- shopping preferences. AgentPay never stores passwords, sign-in codes or
-- payment details; agents use sessions the owner already signed in to.

-- The owner read and accepted a risk statement (signed with a passkey).
CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('agent_browser_and_prepaid')),
  text_version  integer NOT NULL,
  passkey_id    text REFERENCES passkeys(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);
CREATE INDEX consents_user ON consents (user_id, kind);

-- "My agent may use my signed-in session on walmart.com to ..."
CREATE TABLE browser_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  site         text NOT NULL,          -- exact host name without www., e.g. walmart.com
  actions      text[] NOT NULL CHECK (actions <@ ARRAY['browse','add_to_cart','checkout_approved_order','manage_subscription']::text[] AND cardinality(actions) > 0),
  reason       text,
  agent_key_id uuid REFERENCES agent_keys(id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','denied')),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_grants_user ON browser_grants (user_id, site);

CREATE TABLE agent_activity (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  agent_key_id  uuid REFERENCES agent_keys(id),
  site          text NOT NULL,
  action        text NOT NULL,
  summary       text NOT NULL,
  grant_id      uuid REFERENCES browser_grants(id),
  allowed       boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_activity_user ON agent_activity (user_id, created_at DESC);

CREATE TABLE shopping_preferences (
  user_id              uuid PRIMARY KEY REFERENCES users(id),
  organic              text NOT NULL DEFAULT 'no_preference' CHECK (organic IN ('prefer','avoid','no_preference')),
  store_brand          text NOT NULL DEFAULT 'ok' CHECK (store_brand IN ('prefer','ok','avoid')),
  size_strategy        text NOT NULL DEFAULT 'match_list' CHECK (size_strategy IN ('match_list','best_value','smallest')),
  brands_prefer        text[] NOT NULL DEFAULT '{}',
  brands_avoid         text[] NOT NULL DEFAULT '{}',
  dietary              text[] NOT NULL DEFAULT '{}',   -- e.g. gluten-free, vegan, lactose-free
  min_rating           numeric NOT NULL DEFAULT 3.5,
  substitution_policy  text NOT NULL DEFAULT 'similar' CHECK (substitution_policy IN ('similar','ask','skip')),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- What the owner actually bought for a list item at a store, to buy the same next time.
CREATE TABLE product_memory (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  store            text NOT NULL,
  item_key         text NOT NULL,
  product_name     text NOT NULL,
  product_url      text,
  times_bought     integer NOT NULL DEFAULT 1,
  last_price_cents bigint,
  last_bought_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, store, item_key)
);

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('call','subscription','resume','external_cancel','grocery_order','risk_consent','browser_access'));
ALTER TABLE approvals ADD COLUMN browser_grant_id uuid REFERENCES browser_grants(id);
ALTER TABLE approvals DROP CONSTRAINT approvals_target_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_check CHECK (
  kind IN ('call','risk_consent')
  OR (kind IN ('subscription','resume') AND subscription_id IS NOT NULL)
  OR (kind = 'external_cancel' AND external_subscription_id IS NOT NULL)
  OR (kind = 'grocery_order' AND grocery_list_id IS NOT NULL)
  OR (kind = 'browser_access' AND browser_grant_id IS NOT NULL)
);
