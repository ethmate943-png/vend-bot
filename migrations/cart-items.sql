-- Cart per buyer per vendor. Run against Neon (e.g. SQL Editor or psql).
-- Items stored with snapshot (name, price at add time) for checkout.

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  buyer_jid VARCHAR(255) NOT NULL,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  sku VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  price_kobo INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(buyer_jid, vendor_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_buyer_vendor ON cart_items(buyer_jid, vendor_id);

COMMENT ON TABLE cart_items IS 'Buyer cart per vendor; price stored at add time for checkout.';

-- Cart checkout: store line items on transaction so webhook can decrement inventory.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cart_items_json TEXT;
COMMENT ON COLUMN transactions.cart_items_json IS 'JSON array of { sku, quantity } for cart checkouts; NULL for single-item orders.';
