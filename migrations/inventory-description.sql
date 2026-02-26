-- Optional specs/description per item (e.g. "16GB RAM, 512GB SSD").
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS description TEXT;
