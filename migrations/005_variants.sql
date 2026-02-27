-- Variant-capable products and their specific variant rows.
-- Parent product (one row per product that has options).
CREATE TABLE IF NOT EXISTS inventory_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  sku          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  category     TEXT,
  has_variants BOOLEAN DEFAULT false,
  variant_types JSONB DEFAULT '[]',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vendor_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_products_vendor ON inventory_products(vendor_id);
CREATE INDEX IF NOT EXISTS idx_inventory_products_sku ON inventory_products(vendor_id, sku);

-- Each row is one specific variant combination (e.g. iPhone 15 256GB White).
CREATE TABLE IF NOT EXISTS inventory_variants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  parent_sku   TEXT NOT NULL,
  variant_sku  TEXT NOT NULL,
  name         TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  price        BIGINT NOT NULL,
  quantity     INT DEFAULT 0,
  attributes   JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vendor_id, variant_sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_variants_vendor_parent ON inventory_variants(vendor_id, parent_sku);
CREATE INDEX IF NOT EXISTS idx_inventory_variants_sku ON inventory_variants(vendor_id, variant_sku);
