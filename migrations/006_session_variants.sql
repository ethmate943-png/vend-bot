-- Session columns for variant selection flow.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS variant_selections JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_variant_product_sku TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_variant_type TEXT;
