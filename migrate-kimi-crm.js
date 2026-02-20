require('dotenv').config();
const { query } = require('./src/db');

const statements = [
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS store_code TEXT DEFAULT ''`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS onboarding_step TEXT DEFAULT 'start'`,
  `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS trust_stage TEXT DEFAULT 'payment_default'`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivery_status TEXT`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer_id UUID`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat_history TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_store_code ON vendors(store_code) WHERE store_code != ''`,
  `CREATE TABLE IF NOT EXISTS buyers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT NOT NULL,
    whatsapp_jid TEXT UNIQUE NOT NULL,
    first_name TEXT,
    total_purchases INT DEFAULT 0,
    total_spent BIGINT DEFAULT 0,
    dispute_count INT DEFAULT 0,
    first_seen TIMESTAMPTZ DEFAULT now(),
    last_seen TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_buyers_jid ON buyers(whatsapp_jid)`,
  `CREATE TABLE IF NOT EXISTS buyer_vendor_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID REFERENCES buyers(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    total_orders INT DEFAULT 0,
    total_spent BIGINT DEFAULT 0,
    last_order_at TIMESTAMPTZ,
    notes TEXT,
    is_vip BOOLEAN DEFAULT false,
    UNIQUE(buyer_id, vendor_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bvr_vendor ON buyer_vendor_relationships(vendor_id)`,
  `CREATE TABLE IF NOT EXISTS waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_jid TEXT NOT NULL,
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    item_sku TEXT NOT NULL,
    item_name TEXT,
    notified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(buyer_jid, vendor_id, item_sku)
  )`,
  `CREATE TABLE IF NOT EXISTS broadcast_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
    message TEXT,
    recipient_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`
];

async function run() {
  try {
    console.log('Running Kimi/CRM migration...');
    for (const sql of statements) {
      await query(sql);
      console.log('  OK:', sql.slice(0, 55) + '...');
    }
    try {
      await query(`ALTER TABLE transactions ADD CONSTRAINT transactions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES buyers(id)`);
      console.log('  OK: transactions.buyer_id FK');
    } catch (e) {
      if (!e.message.includes('already exists')) console.warn('  Skip FK (may exist):', e.message);
    }
    console.log('Migration completed.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
