-- Media columns for inventory_items and inventory_variants.
-- image_url already exists on inventory_items; add gallery and video.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_urls JSONB DEFAULT '[]';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

ALTER TABLE inventory_variants ADD COLUMN IF NOT EXISTS image_url TEXT;
