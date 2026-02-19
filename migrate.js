require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

const migration = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number TEXT UNIQUE NOT NULL,
  business_name TEXT,
  bvn_verified BOOLEAN DEFAULT false,
  mono_account_id TEXT,
  sheet_id TEXT,
  sheet_tab TEXT DEFAULT 'Sheet1',
  status TEXT DEFAULT 'probation',
  total_transactions INT DEFAULT 0,
  yes_count INT DEFAULT 0,
  no_count INT DEFAULT 0,
  trust_score DECIMAL DEFAULT 0,
  negotiation_policy TEXT DEFAULT 'escalate',
  language TEXT DEFAULT 'english',
  daily_avg_transactions DECIMAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_jid TEXT NOT NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  last_item_sku TEXT,
  last_item_name TEXT,
  intent_state TEXT DEFAULT 'idle',
  pending_payment_ref TEXT,
  message_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(buyer_jid, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_buyer ON sessions(buyer_jid);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendors(id),
  buyer_jid TEXT NOT NULL,
  buyer_phone TEXT,
  item_name TEXT NOT NULL,
  item_sku TEXT,
  amount BIGINT NOT NULL,
  mono_ref TEXT UNIQUE,
  mono_link TEXT,
  status TEXT DEFAULT 'pending',
  delivery_confirmed BOOLEAN,
  escrow_release_at TIMESTAMPTZ,
  payout_released BOOLEAN DEFAULT false,
  sheet_row_updated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_txn_mono_ref ON transactions(mono_ref);
CREATE INDEX IF NOT EXISTS idx_txn_vendor ON transactions(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_escrow ON transactions(status, escrow_release_at);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  buyer_jid TEXT,
  vendor_id UUID REFERENCES vendors(id),
  reason TEXT,
  status TEXT DEFAULT 'open',
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

async function migrate() {
  try {
    console.log('Running migration...');
    await sql.query(migration);
    console.log('All 5 tables created successfully!');

    const res = await sql.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    console.log('\nTables in database:');
    res.rows.forEach(r => console.log(`  - ${r.table_name}`));
  } catch (err) {
    console.error('Migration failed:', err.message);
  }
}

migrate();
