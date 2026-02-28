-- Onboarding tokens for landing-page → WhatsApp flows.
-- Short tokens stored server-side; messages carry only MOOV-[TOKEN].

CREATE TABLE IF NOT EXISTS onboarding_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT NOT NULL UNIQUE,
  phone      TEXT NOT NULL,
  category   TEXT,
  name       TEXT,
  source     TEXT DEFAULT 'landing_page',
  vendor_id  UUID REFERENCES vendors(id),
  status     TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS onboarding_tokens_phone_key
  ON onboarding_tokens(phone);

CREATE INDEX IF NOT EXISTS onboarding_tokens_token_idx
  ON onboarding_tokens(token);

CREATE INDEX IF NOT EXISTS onboarding_tokens_status_idx
  ON onboarding_tokens(status);

CREATE INDEX IF NOT EXISTS onboarding_tokens_created_at_idx
  ON onboarding_tokens(created_at);

