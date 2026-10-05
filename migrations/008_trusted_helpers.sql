-- Protected accounts and trusted helpers (caregivers). The owner keeps their
-- money: helpers can see, freeze, and co-sign or object to big approvals, but
-- never spend, move money, approve alone or lock the owner out. Anything that
-- weakens protection waits out a delay, so neither a scammer's urgency nor an
-- unreachable helper decides alone.

ALTER TABLE users ADD COLUMN protected_at timestamptz;
ALTER TABLE users ADD COLUMN cosign_threshold_cents bigint NOT NULL DEFAULT 5000 CHECK (cosign_threshold_cents >= 0);
ALTER TABLE users ADD COLUMN cosign_delay_hours integer NOT NULL DEFAULT 72 CHECK (cosign_delay_hours BETWEEN 1 AND 720);
ALTER TABLE users ADD COLUMN display_name text;

-- status: invited (code not used yet), active, removing (waiting out the delay), removed
CREATE TABLE helpers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  helper_id        uuid REFERENCES users(id),
  label            text NOT NULL,              -- what the owner calls them, e.g. "Maria (daughter)"
  invite_hash      text UNIQUE,
  invite_expires_at timestamptz,
  status           text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','removing','removed')),
  last_seen_seq    integer NOT NULL DEFAULT 0,  -- the owner's why-log entries this helper has seen
  created_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  removed_at       timestamptz,
  CHECK (helper_id IS NULL OR helper_id <> owner_id)
);
CREATE INDEX helpers_owner ON helpers (owner_id, status);
CREATE INDEX helpers_helper ON helpers (helper_id, status);
CREATE UNIQUE INDEX helpers_one_live ON helpers (owner_id, helper_id) WHERE status IN ('active','removing');

-- Changes that weaken protection take effect after the owner's delay; helpers are alerted and can't block them.
--   kind: unprotect | remove_helper | settings | agent_limits
CREATE TABLE account_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('unprotect','remove_helper','settings','agent_limits')),
  target_id     uuid,                          -- helper row or agent key
  payload       jsonb NOT NULL DEFAULT '{}',
  summary       text NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','applied','canceled')),
  effective_at  timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz
);
CREATE INDEX account_changes_due ON account_changes (effective_at) WHERE status = 'scheduled';

-- Co-signing: on a protected account, big or sensitive approvals need the owner's
-- signature plus either a helper's signature or the owner's delay to pass.
ALTER TABLE approvals ADD COLUMN needs_cosign boolean NOT NULL DEFAULT false;
ALTER TABLE approvals ADD COLUMN owner_signed_at timestamptz;
ALTER TABLE approvals ADD COLUMN owner_passkey_id text REFERENCES passkeys(id);
ALTER TABLE approvals ADD COLUMN helper_signed_by uuid REFERENCES users(id);
ALTER TABLE approvals ADD COLUMN helper_signed_at timestamptz;
ALTER TABLE approvals ADD COLUMN helper_passkey_id text REFERENCES passkeys(id);
ALTER TABLE approvals ADD COLUMN cosign_due_at timestamptz;
ALTER TABLE approvals ADD COLUMN denied_by uuid REFERENCES users(id);
CREATE INDEX approvals_cosign_due ON approvals (cosign_due_at) WHERE status = 'pending' AND owner_signed_at IS NOT NULL;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_check CHECK (actor IN ('agent','owner','system','helper'));
