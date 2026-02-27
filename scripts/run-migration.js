#!/usr/bin/env node
require('dotenv').config();
const { query } = require('../src/db');
const statements = [
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pay_token VARCHAR(64) UNIQUE`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS daily_volume_kobo BIGINT DEFAULT 0`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS volume_reset_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS list_skus TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_item_price INTEGER`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_item_price_quoted_at TIMESTAMPTZ`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS category TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS location TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS delivery_coverage TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS turnaround TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tone TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS custom_note TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS conversation_history JSONB DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS inventory_items (
    id SERIAL PRIMARY KEY,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
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
  `COMMENT ON TABLE inventory_items IS 'DB-backed inventory per vendor; used when vendor has no Google Sheet. Supports image_url.'`,
  `CREATE TABLE IF NOT EXISTS vendor_trusted_buyers (
    id SERIAL PRIMARY KEY,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    buyer_jid TEXT NOT NULL,
    buyer_name TEXT,
    note TEXT,
    added_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(vendor_id, buyer_jid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vendor_trusted_buyers_vendor ON vendor_trusted_buyers(vendor_id)`,
  `CREATE TABLE IF NOT EXISTS buyer_trusted_vendors (
    id SERIAL PRIMARY KEY,
    buyer_jid TEXT NOT NULL,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(buyer_jid, vendor_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_buyer_trusted_vendors_buyer ON buyer_trusted_vendors(buyer_jid)`,
  `CREATE TABLE IF NOT EXISTS relationship_scores (
    id SERIAL PRIMARY KEY,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    buyer_jid TEXT NOT NULL,
    completed_orders INT DEFAULT 0,
    disputed_orders INT DEFAULT 0,
    avg_confirmation_hrs DECIMAL,
    trust_level TEXT DEFAULT 'new',
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(vendor_id, buyer_jid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relationship_scores_vendor ON relationship_scores(vendor_id)`,
  `CREATE TABLE IF NOT EXISTS pending_trust_orders (
    id SERIAL PRIMARY KEY,
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    buyer_jid TEXT NOT NULL,
    buyer_phone TEXT,
    item_name TEXT NOT NULL,
    item_sku TEXT NOT NULL,
    amount_kobo INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_trust_orders_vendor ON pending_trust_orders(vendor_id)`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_collected_at TIMESTAMPTZ`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS verified_vendor BOOLEAN DEFAULT false`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS verified_vendor_at TIMESTAMPTZ`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS verified_vendor_tier TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_name_edits_used BOOLEAN DEFAULT false`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS role TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS message_count INT DEFAULT 0`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_state TEXT`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_state_data JSONB`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS list_offset INTEGER DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS buyer_name TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS buyer_name_source TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS payment_link_sent_at TIMESTAMPTZ`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sessions_buyer_vendor_unique ON sessions(buyer_jid, vendor_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_buyer_vendor ON sessions(buyer_jid, vendor_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transactions_vendor_status ON transactions(vendor_id, status)`,
  `CREATE INDEX IF NOT EXISTS transactions_buyer_vendor ON transactions(buyer_jid, vendor_id)`,
  `CREATE INDEX IF NOT EXISTS transactions_mono_ref ON transactions(mono_ref)`,
  `CREATE INDEX IF NOT EXISTS transactions_created ON transactions(created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vendors_store_code_unique ON vendors(store_code) WHERE store_code IS NOT NULL AND store_code != ''`,
  `CREATE INDEX IF NOT EXISTS vendors_phone ON vendors(whatsapp_number)`,
  `CREATE INDEX IF NOT EXISTS vendors_status ON vendors(status) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS inventory_products ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE, sku TEXT NOT NULL, name TEXT NOT NULL, description TEXT, category TEXT, has_variants BOOLEAN DEFAULT false, variant_types JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(vendor_id, sku) )`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_products_vendor ON inventory_products(vendor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_products_sku ON inventory_products(vendor_id, sku)`,
  `CREATE TABLE IF NOT EXISTS inventory_variants ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE, parent_sku TEXT NOT NULL, variant_sku TEXT NOT NULL, name TEXT NOT NULL, variant_label TEXT NOT NULL, price BIGINT NOT NULL, quantity INT DEFAULT 0, attributes JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(vendor_id, variant_sku) )`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_variants_vendor_parent ON inventory_variants(vendor_id, parent_sku)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_variants_sku ON inventory_variants(vendor_id, variant_sku)`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS variant_selections JSONB`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_variant_product_sku TEXT`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_variant_type TEXT`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]'`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS video_url TEXT`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`,
  `ALTER TABLE inventory_variants ADD COLUMN IF NOT EXISTS image_url TEXT`
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
