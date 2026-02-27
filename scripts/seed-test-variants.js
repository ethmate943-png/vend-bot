#!/usr/bin/env node
/**
 * Seed the DB with phones (Pixel 9) and clothes (T-Shirt) variants for testing.
 * Uses vendor with whatsapp_number = VENDBOT_NUMBER from .env.
 * Run: node scripts/seed-test-variants.js
 */
require('dotenv').config();
const { query } = require('../src/db');

const VENDOR_PHONE = (process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
if (!VENDOR_PHONE) {
  console.error('Set VENDBOT_NUMBER in .env (e.g. 2349159165954)');
  process.exit(1);
}

async function main() {
  const vendorRes = await query(
    'SELECT id FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
    [VENDOR_PHONE]
  );
  const vendor = vendorRes.rows[0];
  if (!vendor) {
    console.error(`No vendor found for ${VENDOR_PHONE}. Create one first (e.g. message the bot).`);
    process.exit(1);
  }
  const vendorId = vendor.id;
  console.log('Vendor:', vendorId);

  // 1. inventory_products (parent products with variants)
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 'pixel-9', 'Pixel 9', 'Google Pixel 9 smartphone', 'Phones', true, '["storage","color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["storage","color"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 'tshirt', 'Classic T-Shirt', 'Cotton crew neck tee', 'Clothes', true, '["size","color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["size","color"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 'mbp-m1-2021', 'MacBook Pro M1 2021', 'Apple MacBook Pro M1 2021', 'Laptops', true, '["ram","storage"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["ram","storage"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 'iphone-case', 'iPhone Case', 'Protective iPhone case', 'Accessories', true, '["color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["color"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 's24', 'Samsung Galaxy S24', 'Samsung Galaxy S24 smartphone', 'Phones', true, '["storage","color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["storage","color"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 's24-plus', 'Samsung Galaxy S24 Plus', 'Samsung Galaxy S24 Plus smartphone', 'Phones', true, '["storage","color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["storage","color"]'`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_products (vendor_id, sku, name, description, category, has_variants, variant_types)
     VALUES ($1, 's24-ultra', 'Samsung Galaxy S24 Ultra', 'Samsung Galaxy S24 Ultra smartphone', 'Phones', true, '["storage","color"]')
     ON CONFLICT (vendor_id, sku) DO UPDATE SET has_variants = true, variant_types = '["storage","color"]'`,
    [vendorId]
  );
  console.log('OK: inventory_products');

  // 2. inventory_variants — Pixel 9 (storage + color)
  const pixelVariants = [
    ['pixel-9', 'pixel-9-128-black', 'Pixel 9 128GB Black', '128GB Black', 350000, 5, { storage: '128GB', color: 'Black' }],
    ['pixel-9', 'pixel-9-128-white', 'Pixel 9 128GB White', '128GB White', 350000, 3, { storage: '128GB', color: 'White' }],
    ['pixel-9', 'pixel-9-256-black', 'Pixel 9 256GB Black', '256GB Black', 420000, 4, { storage: '256GB', color: 'Black' }],
    ['pixel-9', 'pixel-9-256-white', 'Pixel 9 256GB White', '256GB White', 420000, 2, { storage: '256GB', color: 'White' }],
  ];
  for (const [parent, vSku, name, label, price, qty, attrs] of pixelVariants) {
    await query(
      `INSERT INTO inventory_variants (vendor_id, parent_sku, variant_sku, name, variant_label, price, quantity, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET quantity = $7, attributes = $8`,
      [vendorId, parent, vSku, name, label, price, qty, JSON.stringify(attrs)]
    );
  }
  console.log('OK: Pixel 9 variants');

  // 3. inventory_variants — T-Shirt (size + color)
  const sizes = ['S', 'M', 'L'];
  const colors = ['Black', 'White', 'Blue'];
  const basePrice = 5000; // ₦50
  for (const size of sizes) {
    for (const color of colors) {
      const vSku = `tshirt-${size.toLowerCase()}-${color.toLowerCase()}`;
      const label = `${size} ${color}`;
      const price = basePrice + (sizes.indexOf(size) * 200);
      await query(
        `INSERT INTO inventory_variants (vendor_id, parent_sku, variant_sku, name, variant_label, price, quantity, attributes)
         VALUES ($1, 'tshirt', $2, 'T-Shirt ' || $3, $3, $4, 10, $5)
         ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET quantity = 10`,
        [vendorId, vSku, label, price, JSON.stringify({ size, color })]
      );
    }
  }
  console.log('OK: T-Shirt variants');

  // 5. inventory_variants — MacBook Pro M1 2021 (RAM + storage)
  const mbpVariants = [
    // prices are in kobo here
    ['mbp-m1-2021', 'mbp-m1-2021-16-512', 'MacBook Pro M1 2021 16GB 512GB', '16GB RAM / 512GB SSD', 1200000 * 100, 3, { ram: '16GB', storage: '512GB' }],
    ['mbp-m1-2021', 'mbp-m1-2020-16-512', 'MacBook Pro M1 2020 16GB 512GB', 'M1 2020 – 16GB / 512GB', 950000 * 100, 3, { ram: '16GB', storage: '512GB', model: '2020' }],
    ['mbp-m1-2021', 'mbp-m1-2021-32-512', 'MacBook Pro M1 2021 32GB 512GB', '32GB RAM / 512GB SSD', 1500000 * 100, 2, { ram: '32GB', storage: '512GB' }]
  ];
  for (const [parent, vSku, name, label, price, qty, attrs] of mbpVariants) {
    await query(
      `INSERT INTO inventory_variants (vendor_id, parent_sku, variant_sku, name, variant_label, price, quantity, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET quantity = $7, attributes = $8`,
      [vendorId, parent, vSku, name, label, price, qty, JSON.stringify(attrs)]
    );
  }
  console.log('OK: MacBook variants');

  // 6. inventory_variants — iPhone Cases (color)
  const caseColors = ['Black', 'Blue', 'Red', 'Clear'];
  const casePriceNaira = 6000;
  for (const color of caseColors) {
    const vSku = `iphone-case-${color.toLowerCase()}`;
    const label = `${color} Case`;
    await query(
      `INSERT INTO inventory_variants (vendor_id, parent_sku, variant_sku, name, variant_label, price, quantity, attributes)
       VALUES ($1, 'iphone-case', $2, 'iPhone Case ' || $3, $3, $4, 20, $5)
       ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET quantity = 20`,
      [vendorId, vSku, label, casePriceNaira * 100, JSON.stringify({ color })]
    );
  }
  console.log('OK: iPhone Case variants');

  // 7. inventory_variants — Samsung Galaxy S24 family (storage + color)
  const s24Variants = [
    ['s24', 's24-256-black', 'Samsung Galaxy S24 256GB Black', '256GB Black', 650000 * 100, 3, { storage: '256GB', color: 'Black' }],
    ['s24', 's24-512-black', 'Samsung Galaxy S24 512GB Black', '512GB Black', 650000 * 100, 2, { storage: '512GB', color: 'Black' }],
    ['s24-plus', 's24-plus-256-black', 'Samsung Galaxy S24 Plus 256GB Black', '256GB Black', 780000 * 100, 3, { storage: '256GB', color: 'Black' }],
    ['s24-plus', 's24-plus-512-black', 'Samsung Galaxy S24 Plus 512GB Black', '512GB Black', 780000 * 100, 2, { storage: '512GB', color: 'Black' }],
    ['s24-ultra', 's24-ultra-256-black', 'Samsung Galaxy S24 Ultra 256GB Black', '256GB Black', 1200000 * 100, 3, { storage: '256GB', color: 'Black' }],
    ['s24-ultra', 's24-ultra-512-black', 'Samsung Galaxy S24 Ultra 512GB Black', '512GB Black', 1200000 * 100, 2, { storage: '512GB', color: 'Black' }]
  ];
  for (const [parent, vSku, name, label, price, qty, attrs] of s24Variants) {
    await query(
      `INSERT INTO inventory_variants (vendor_id, parent_sku, variant_sku, name, variant_label, price, quantity, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET quantity = $7, attributes = $8`,
      [vendorId, parent, vSku, name, label, price, qty, JSON.stringify(attrs)]
    );
  }
  console.log('OK: Samsung S24 variants');

  // 7. inventory_items so matchProducts finds them (quantity = sum of variant qty so they show in stock)
  const pixelQty = pixelVariants.reduce((s, v) => s + v[5], 0);
  const tshirtQty = sizes.length * colors.length * 10;
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'Pixel 9', 'pixel-9', 350000, $2, 'Phones', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET quantity = $2, updated_at = NOW()`,
    [vendorId, pixelQty]
  );
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'Classic T-Shirt', 'tshirt', 5000, $2, 'Clothes', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET quantity = $2, updated_at = NOW()`,
    [vendorId, tshirtQty]
  );
  const mbpQty = mbpVariants.reduce((s, v) => s + v[5], 0);
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'MacBook Pro M1', 'mbp-m1-2021', 1200000, $2, 'Laptops', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET quantity = $2, updated_at = NOW()`,
    [vendorId, mbpQty]
  );
  const casesQty = caseColors.length * 20;
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'iPhone Case', 'iphone-case', 6000, $2, 'Accessories', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET quantity = $2, updated_at = NOW()`,
    [vendorId, casesQty]
  );

  // Simple single-SKU items (no variants): AirPods and Samsung phones
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'AirPods Pro Gen 3', 'airpods-pro-gen3', 200000, 10, 'Accessories', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET price = 200000, quantity = 10, updated_at = NOW()`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'AirPods Pro Gen 4', 'airpods-pro-gen4', 280000, 10, 'Accessories', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET price = 280000, quantity = 10, updated_at = NOW()`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'Samsung Galaxy S24', 's24', 650000, 5, 'Phones', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET price = 650000, quantity = 5, updated_at = NOW()`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'Samsung Galaxy S24 Plus', 's24-plus', 780000, 5, 'Phones', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET price = 780000, quantity = 5, updated_at = NOW()`,
    [vendorId]
  );
  await query(
    `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, updated_at)
     VALUES ($1, 'Samsung Galaxy S24 Ultra', 's24-ultra', 1200000, 5, 'Phones', NOW())
     ON CONFLICT (vendor_id, sku) DO UPDATE SET price = 1200000, quantity = 5, updated_at = NOW()`,
    [vendorId]
  );

  console.log('OK: inventory_items');

  console.log('\n✅ Done. Try: "Pixel 9 please", "pixel 9", "I want a t-shirt", "tshirt".');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
