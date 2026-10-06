-- From docs/landscape.md: payment safety checks, the LLM gateway, notifications
-- on more channels, and a calendar feed.

-- ---------------------------------------------------------------- payment safety
-- Same payer, same payee or tool, same amount and same input within a short
-- window looks like a duplicate even with a new idempotency key.
ALTER TABLE holds ADD COLUMN fingerprint text;
CREATE INDEX holds_fingerprint ON holds (fingerprint, created_at) WHERE fingerprint IS NOT NULL;

-- An outside payment whose outcome was unclear (the authorization left, the answer didn't
-- confirm it). Nothing to the same payee is sent again until the owner resolves it.
ALTER TABLE holds ADD COLUMN external_status text CHECK (external_status IN ('unclear','confirmed_paid','refunded'));

-- The payment address each outside seller was last paid at; a change needs the owner.
CREATE TABLE known_payees (
  user_id     uuid NOT NULL REFERENCES users(id),
  target      text NOT NULL,                -- the seller's host
  pay_to      text NOT NULL,
  first_paid  timestamptz NOT NULL DEFAULT now(),
  last_paid   timestamptz NOT NULL DEFAULT now(),
  payments    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, target)
);

-- ---------------------------------------------------------------- LLM gateway
ALTER TABLE holds DROP CONSTRAINT holds_external_protocol_check;
ALTER TABLE holds ADD CONSTRAINT holds_external_protocol_check CHECK (external_protocol IN ('x402','a2a','llm'));
-- Calls in one conversation share a cap (X-AgentPay-Conversation).
ALTER TABLE holds ADD COLUMN conversation_id text;
CREATE INDEX holds_conversation ON holds (agent_key_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- ---------------------------------------------------------------- notifications
--   kind: telegram (chat id), discord (webhook URL), webhook (any https URL, signed), email, sms
CREATE TABLE notification_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('email','sms','telegram','discord','webhook')),
  target      text NOT NULL,
  secret      text,                         -- HMAC key for signed webhooks
  events      text[] NOT NULL DEFAULT ARRAY['approvals','alerts','reminders'],
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (events <@ ARRAY['approvals','alerts','reminders','payments']::text[])
);
CREATE INDEX notification_channels_user ON notification_channels (user_id) WHERE active;

-- How far each recipient has been told about each account's why log.
CREATE TABLE notification_cursors (
  recipient_id  uuid NOT NULL REFERENCES users(id),
  account_id    uuid NOT NULL REFERENCES users(id),
  last_seq      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (recipient_id, account_id)
);

ALTER TABLE users ADD COLUMN last_digest_on date;
ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('email','sms','telegram','discord','webhook'));

-- ---------------------------------------------------------------- calendar feed
-- Calendar apps can't send a bearer token, so the feed URL carries its own secret.
ALTER TABLE users ADD COLUMN calendar_token_hash text UNIQUE;
