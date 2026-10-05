-- Invite trusted helpers by email or phone. AgentPay sends the invitation
-- (email through Resend, text messages through Twilio) when configured;
-- otherwise the owner passes the code on themselves.

ALTER TABLE helpers ADD COLUMN contact_type text CHECK (contact_type IN ('email','phone'));
ALTER TABLE helpers ADD COLUMN contact text;            -- lower-cased email, or phone in E.164 (+15551234567)
ALTER TABLE helpers ADD COLUMN delivery_status text CHECK (delivery_status IN ('sent','not_configured','failed'));
ALTER TABLE helpers ADD COLUMN delivered_at timestamptz;
ALTER TABLE helpers ADD COLUMN delivery_error text;
ALTER TABLE helpers ADD CHECK ((contact_type IS NULL) = (contact IS NULL));

-- Every message AgentPay sends or tries to send. Secrets (invite codes) are never stored here.
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),     -- whose action caused it
  channel      text NOT NULL CHECK (channel IN ('email','sms')),
  recipient    text NOT NULL,
  purpose      text NOT NULL,                           -- e.g. helper_invite
  status       text NOT NULL CHECK (status IN ('sent','not_configured','failed')),
  provider_id  text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
