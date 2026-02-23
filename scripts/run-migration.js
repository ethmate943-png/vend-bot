#!/usr/bin/env node
require('dotenv').config();
const { query } = require('../src/db');
const statements = [
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64) UNIQUE`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_volume_kobo BIGINT DEFAULT 0`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS volume_reset_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS list_skus TEXT`,
  `CREATE TABLE IF NOT EXISTS inventory_items (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_items_vendor_id ON inventory_items(vendor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_items_vendor_sku ON inventory_items(vendor_id, sku)`,
  `COMMENT ON TABLE inventory_items IS 'DB-backed inventory per vendor; used when vendor has no Google Sheet. Supports image_url.'`
];

async function main() {
  console.log('Running migration (pay_token + inventory_items)...');
  for (let i = 0; i < statements.length; i++) {
    try {
      await query(statements[i]);
      console.log('OK', i + 1 + '/', statements.length);
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  }
  console.log('Migration done.');
  process.exit(0);
}

main();
