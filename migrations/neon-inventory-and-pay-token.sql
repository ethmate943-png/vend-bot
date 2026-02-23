-- Run this against your Neon (Postgres) database.
-- From CLI: psql "postgresql://user:pass@host/db?sslmode=require" -f migrations/neon-inventory-and-pay-token.sql
-- Or paste into Neon Console → SQL Editor and run.

-- 1. Payment link binding (if not already applied)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64) UNIQUE;

-- 2. DB-backed inventory (alternative to Google Sheets)
-- Use when vendor has no sheet_id; supports images via image_url.
CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  sku VARCHAR(128) NOT NULL,
  price INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  category VARCHAR(128) DEFAULT '',
  min_price INTEGER,
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vendor_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_vendor_id ON inventory_items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_vendor_sku ON inventory_items(vendor_id, sku);

COMMENT ON TABLE inventory_items IS 'DB-backed inventory per vendor; used when vendor has no Google Sheet. Supports image_url.';
