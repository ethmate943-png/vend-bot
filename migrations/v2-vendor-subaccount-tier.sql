-- AGENT_UPDATE_V2: Paystack subaccounts (UPDATE 5a) + Vendor tier (UPDATE 6a)
-- Run in Neon SQL editor or: psql $DATABASE_URL -f migrations/v2-vendor-subaccount-tier.sql

-- 5a — Paystack subaccount columns
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS subaccount_created BOOLEAN DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS platform_fee_percent DECIMAL DEFAULT 5.0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS reserve_percent DECIMAL DEFAULT 10.0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ;

-- 6a — Vendor tier + caps
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_tier TEXT DEFAULT 'standard';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tier_set_by TEXT DEFAULT 'system';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS custom_daily_cap_kobo BIGINT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS custom_payout_hold_hours INT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_cap_kobo BIGINT DEFAULT 5000000;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS weekly_cap_kobo BIGINT DEFAULT 15000000;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_volume_kobo BIGINT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS weekly_volume_kobo BIGINT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS volume_reset_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS confirmed_deliveries INT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS baseline_weekly_volume BIGINT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS current_week_volume BIGINT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS fraud_watch BOOLEAN DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS fraud_flags JSONB;

-- UPDATE 9 — Price lock at quote time
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_item_price INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_item_price_quoted_at TIMESTAMPTZ;
