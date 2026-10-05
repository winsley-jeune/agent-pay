-- Grocery lists (typed, or read from a photo) that the owner's agent turns
-- into a cart at Walmart or Whole Foods in the owner's own browser. AgentPay
-- has no store account and never checks out; the owner approves the order total first.

-- status:
--   draft          being written or reviewed
--   shopping       the agent is filling the cart
--   ready          cart filled, estimated total known; waiting for the owner
--   approved       owner approved the total (passkey); the agent may check out
--   ordered        order placed (order number and actual total recorded)
--   canceled
CREATE TABLE grocery_lists (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id),
  title                  text NOT NULL,
  store                  text CHECK (store IN ('walmart','whole_foods')),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shopping','ready','approved','ordered','canceled')),
  source                 text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','photo','agent')),
  unreadable             text[] NOT NULL DEFAULT '{}',   -- words on the photo that couldn't be read
  estimated_total_cents  bigint,
  approved_max_cents     bigint,
  order_number           text,
  ordered_total_cents    bigint,
  ordered_at             timestamptz,
  added_by_agent_key_id  uuid REFERENCES agent_keys(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grocery_lists_user ON grocery_lists (user_id, status);

-- status: needed -> in_cart | substituted | unavailable; removed = owner took it off the list
CREATE TABLE grocery_items (
  id              bigserial PRIMARY KEY,
  list_id         uuid NOT NULL REFERENCES grocery_lists(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  name            text NOT NULL,
  quantity        numeric,
  unit            text,
  notes           text,
  category        text,
  status          text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','in_cart','substituted','unavailable','removed')),
  product_name    text,
  product_url     text,
  price_cents     bigint,                 -- line total as shown in the cart
  substitute_note text
);
CREATE INDEX grocery_items_list ON grocery_items (list_id, position);

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('call','subscription','resume','external_cancel','grocery_order'));
ALTER TABLE approvals ADD COLUMN grocery_list_id uuid REFERENCES grocery_lists(id);
ALTER TABLE approvals DROP CONSTRAINT approvals_target_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_target_check CHECK (
  kind = 'call'
  OR (kind IN ('subscription','resume') AND subscription_id IS NOT NULL)
  OR (kind = 'external_cancel' AND external_subscription_id IS NOT NULL)
  OR (kind = 'grocery_order' AND grocery_list_id IS NOT NULL)
);
