-- Items the owner wants to buy once the price drops. AgentPay never logs in
-- to the store and never buys; it stores prices that agents report (or that
-- a price-history API returns), and alerts when the target is reached.

CREATE TABLE price_watches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id),
  title                  text NOT NULL,
  url                    text NOT NULL,
  retailer               text NOT NULL,              -- 'amazon', or the store's host name
  product_key            text,                       -- Amazon ASIN when known
  target_price_cents     bigint NOT NULL CHECK (target_price_cents > 0),
  current_price_cents    bigint,
  lowest_seen_cents      bigint,
  status                 text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','target_hit','bought','stopped')),
  expires_on             date,
  notes                  text,
  added_by_agent_key_id  uuid REFERENCES agent_keys(id),
  target_hit_at          timestamptz,
  bought_at              timestamptz,
  bought_price_cents     bigint,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_watches_user ON price_watches (user_id, status);
CREATE UNIQUE INDEX price_watches_one_live ON price_watches (user_id, retailer, product_key)
  WHERE product_key IS NOT NULL AND status IN ('watching','target_hit');

CREATE TABLE price_points (
  id            bigserial PRIMARY KEY,
  watch_id      uuid NOT NULL REFERENCES price_watches(id) ON DELETE CASCADE,
  price_cents   bigint NOT NULL CHECK (price_cents > 0),
  source        text NOT NULL CHECK (source IN ('agent','manual','keepa')),
  note          text,                     -- e.g. "Lightning deal", "with $10 coupon"
  observed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_points_watch ON price_points (watch_id, observed_at);

CREATE TABLE price_alerts (
  id           bigserial PRIMARY KEY,
  watch_id     uuid NOT NULL REFERENCES price_watches(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('target_hit','new_low','big_drop','price_up')),
  message      text NOT NULL,
  price_cents  bigint NOT NULL,
  seen         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_alerts_watch ON price_alerts (watch_id, created_at);
