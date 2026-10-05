-- Agents selling work to other agents: long-running jobs, prices quoted per
-- task, and signed requests so a provider knows who is paying and that the
-- money is held.

-- ---------------------------------------------------------------- tools
--   mode sync   the provider answers within the request timeout (as before)
--   mode async  the provider answers 202 and reports the result later on a callback
--   pricing quoted  the provider quotes a price per task, up to price_cents
ALTER TABLE tools ADD COLUMN mode text NOT NULL DEFAULT 'sync' CHECK (mode IN ('sync','async'));
ALTER TABLE tools ADD COLUMN max_job_seconds integer CHECK (max_job_seconds IS NULL OR max_job_seconds BETWEEN 60 AND 86400);
ALTER TABLE tools DROP CONSTRAINT tools_pricing_type_check;
ALTER TABLE tools ADD CONSTRAINT tools_pricing_type_check CHECK (pricing_type IN ('per_call','per_unit','quoted'));
ALTER TABLE tools DROP CONSTRAINT tools_check;
ALTER TABLE tools ADD CONSTRAINT tools_units_check CHECK (pricing_type <> 'per_unit' OR units_field IS NOT NULL);

-- ---------------------------------------------------------------- async jobs
-- An async call keeps its hold open until the provider reports back (or the job times out and the hold is released).
ALTER TABLE holds ADD COLUMN async boolean NOT NULL DEFAULT false;
ALTER TABLE holds ADD COLUMN job_token_hash text;
ALTER TABLE holds ADD COLUMN quote_id uuid;

-- ---------------------------------------------------------------- quotes
CREATE TABLE task_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id  uuid NOT NULL REFERENCES agent_keys(id),
  tool_id       uuid NOT NULL REFERENCES tools(id),
  input_hash    text NOT NULL,                 -- the quote is only good for the same input
  price_cents   bigint NOT NULL CHECK (price_cents >= 0),
  description   text,
  provider_ref  text,                          -- the provider's own quote reference, sent back with the call
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','used')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_quotes_agent ON task_quotes (agent_key_id, created_at DESC);
ALTER TABLE holds ADD CONSTRAINT holds_quote_fk FOREIGN KEY (quote_id) REFERENCES task_quotes(id);

-- ---------------------------------------------------------------- signing keys
-- AgentPay signs every request it sends to a provider. Public keys are published at
-- /.well-known/agentpay-keys.json. (Set AGENTPAY_SIGNING_KEY to keep the private key out of the database.)
CREATE TABLE signing_keys (
  kid          text PRIMARY KEY,
  private_pem  text NOT NULL,
  public_pem   text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
