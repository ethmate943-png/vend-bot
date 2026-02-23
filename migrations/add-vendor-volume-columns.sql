-- Add daily volume tracking columns to vendors (required by checkVendorCap in paystack.js).
-- Run: node scripts/run-migration.js migrations/add-vendor-volume-columns.sql
-- Or in Neon SQL editor: paste and run this file.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_volume_kobo BIGINT DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS volume_reset_at TIMESTAMPTZ DEFAULT NOW();
