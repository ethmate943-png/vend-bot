-- Performance indexes and session upsert support
-- Run after 003_identity_buyer_name.sql

-- Session column for "link sent at" (used by state machine)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS payment_link_sent_at TIMESTAMPTZ;

-- Sessions: allow reliable ON CONFLICT (buyer_jid, vendor_id) for upsertSessionFields
CREATE UNIQUE INDEX IF NOT EXISTS sessions_buyer_vendor_unique ON sessions(buyer_jid, vendor_id);

-- Sessions — most queried table
CREATE INDEX IF NOT EXISTS sessions_buyer_vendor ON sessions(buyer_jid, vendor_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_intent_state ON sessions(intent_state) WHERE intent_state IS NOT NULL;

-- Transactions — heavy query table (use mono_ref; paystack_ref may not exist)
CREATE INDEX IF NOT EXISTS transactions_vendor_status ON transactions(vendor_id, status);
CREATE INDEX IF NOT EXISTS transactions_buyer_vendor ON transactions(buyer_jid, vendor_id);
CREATE INDEX IF NOT EXISTS transactions_mono_ref ON transactions(mono_ref);
CREATE INDEX IF NOT EXISTS transactions_created ON transactions(created_at DESC);

-- Vendors — store code lookup must be instant
CREATE UNIQUE INDEX IF NOT EXISTS vendors_store_code_unique ON vendors(store_code) WHERE store_code IS NOT NULL AND store_code != '';
CREATE INDEX IF NOT EXISTS vendors_phone ON vendors(whatsapp_number);
CREATE INDEX IF NOT EXISTS vendors_status ON vendors(status) WHERE status = 'active';
