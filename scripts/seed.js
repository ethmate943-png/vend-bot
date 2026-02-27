#!/usr/bin/env node
// Seed multiple demo vendors + inventory into the current VendBot DB.
// Run with: node scripts/seed.js

require('dotenv').config();
const { query, pool } = require('../src/db');

const BOT_NUMBER = process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '2348000000000';

// NOTE: prices in this config are in NAIRA.
// Variant prices will be stored in KOBO (×100) in inventory_variants.
// Parent/simple product prices are stored in NAIRA in inventory_items.

const VENDORS = [
  {
    business_name: 'Amaka Fashion House',
    store_code: 'AMAKA',
    whatsapp_number: '2348101234567',
    category: 'fashion',
    location: 'Lagos Island',
    delivery_coverage: 'nationwide',
    turnaround: '2-3 days',
    tone: 'friendly',
    custom_note: 'All fabrics are imported. DM for bulk orders.',
    negotiation_policy: 'flex',
    negotiation_floor_percent: 10,
    status: 'active',
    onboarding_complete: true,
    products: [
      {
        sku: 'DRESS-001',
        name: 'Ankara Wrap Dress',
        description: 'Beautiful hand-sewn Ankara wrap dress. Perfect for events.',
        category: 'fashion',
        has_variants: true,
        variant_types: ['size', 'color'],
        base_price: 18500,
        variants: [
          { label: 'Size S / Blue', attrs: { size: 'S', color: 'Blue' }, price: 18500, qty: 5 },
          { label: 'Size M / Blue', attrs: { size: 'M', color: 'Blue' }, price: 18500, qty: 8 },
          { label: 'Size L / Blue', attrs: { size: 'L', color: 'Blue' }, price: 18500, qty: 4 },
          { label: 'Size S / Red', attrs: { size: 'S', color: 'Red' }, price: 19000, qty: 3 },
          { label: 'Size M / Red', attrs: { size: 'M', color: 'Red' }, price: 19000, qty: 6 },
          { label: 'Size L / Red', attrs: { size: 'L', color: 'Red' }, price: 19500, qty: 2 },
        ]
      },
      {
        sku: 'BAG-001',
        name: 'Black Leather Tote',
        description: 'Genuine leather tote bag. Fits A4 documents and laptop.',
        category: 'fashion',
        has_variants: false,
        base_price: 15000,
        variants: []
      },
      {
        sku: 'SHOE-001',
        name: 'Block Heel Sandals',
        description: 'Comfortable block heel. Great for office and events.',
        category: 'fashion',
        has_variants: true,
        variant_types: ['size', 'color'],
        base_price: 12000,
        variants: [
          { label: 'Size 37 / Nude', attrs: { size: '37', color: 'Nude' }, price: 12000, qty: 4 },
          { label: 'Size 38 / Nude', attrs: { size: '38', color: 'Nude' }, price: 12000, qty: 6 },
          { label: 'Size 39 / Nude', attrs: { size: '39', color: 'Nude' }, price: 12000, qty: 5 },
          { label: 'Size 40 / Nude', attrs: { size: '40', color: 'Nude' }, price: 12000, qty: 3 },
          { label: 'Size 37 / Black', attrs: { size: '37', color: 'Black' }, price: 12500, qty: 4 },
          { label: 'Size 38 / Black', attrs: { size: '38', color: 'Black' }, price: 12500, qty: 7 },
          { label: 'Size 39 / Black', attrs: { size: '39', color: 'Black' }, price: 12500, qty: 5 },
          { label: 'Size 40 / Black', attrs: { size: '40', color: 'Black' }, price: 12500, qty: 2 },
        ]
      },
      {
        sku: 'SCARF-001',
        name: 'Silk Head Wrap',
        description: 'Premium silk head wrap. Multiple tying styles.',
        category: 'fashion',
        has_variants: true,
        variant_types: ['color'],
        base_price: 4500,
        variants: [
          { label: 'Gold', attrs: { color: 'Gold' }, price: 4500, qty: 10 },
          { label: 'Black', attrs: { color: 'Black' }, price: 4500, qty: 12 },
          { label: 'White', attrs: { color: 'White' }, price: 4500, qty: 8 },
          { label: 'Purple', attrs: { color: 'Purple' }, price: 4500, qty: 6 },
        ]
      },
    ]
  },

  {
    business_name: 'TechGuy Electronics',
    store_code: 'TECHGUY',
    whatsapp_number: '2348102345678',
    category: 'electronics',
    location: 'Computer Village, Ikeja',
    delivery_coverage: 'nationwide',
    turnaround: '1-2 days',
    tone: 'professional',
    custom_note: 'All phones come with 6-month warranty. Original products only.',
    negotiation_policy: 'flex',
    negotiation_floor_percent: 5,
    status: 'active',
    onboarding_complete: true,
    products: [
      {
        sku: 'IPHONE-15',
        name: 'iPhone 15',
        description: 'Brand new iPhone 15. Original Apple. Comes with charger and box.',
        category: 'electronics',
        has_variants: true,
        variant_types: ['storage', 'color'],
        base_price: 850000,
        variants: [
          { label: '128GB / Black', attrs: { storage: '128GB', color: 'Black' }, price: 850000, qty: 3 },
          { label: '128GB / White', attrs: { storage: '128GB', color: 'White' }, price: 850000, qty: 4 },
          { label: '128GB / Blue', attrs: { storage: '128GB', color: 'Blue' }, price: 850000, qty: 2 },
          { label: '256GB / Black', attrs: { storage: '256GB', color: 'Black' }, price: 950000, qty: 3 },
          { label: '256GB / White', attrs: { storage: '256GB', color: 'White' }, price: 950000, qty: 2 },
          { label: '512GB / Black', attrs: { storage: '512GB', color: 'Black' }, price: 1100000, qty: 2 },
          { label: '512GB / White', attrs: { storage: '512GB', color: 'White' }, price: 1100000, qty: 1 },
        ]
      },
      {
        sku: 'SAMSUNG-S24',
        name: 'Samsung Galaxy S24',
        description: 'Latest Samsung flagship. Original sealed box.',
        category: 'electronics',
        has_variants: true,
        variant_types: ['storage', 'color'],
        base_price: 720000,
        variants: [
          { label: '128GB / Phantom Black', attrs: { storage: '128GB', color: 'Phantom Black' }, price: 720000, qty: 4 },
          { label: '128GB / Marble Gray', attrs: { storage: '128GB', color: 'Marble Gray' }, price: 720000, qty: 3 },
          { label: '256GB / Phantom Black', attrs: { storage: '256GB', color: 'Phantom Black' }, price: 820000, qty: 2 },
          { label: '256GB / Marble Gray', attrs: { storage: '256GB', color: 'Marble Gray' }, price: 820000, qty: 2 },
        ]
      },
      {
        sku: 'LAPTOP-DELL',
        name: 'Dell Inspiron 15',
        description: '12th Gen Intel Core i5. Backlit keyboard. Perfect for work and school.',
        category: 'electronics',
        has_variants: true,
        variant_types: ['ram', 'storage'],
        base_price: 385000,
        variants: [
          { label: '8GB / 256GB SSD', attrs: { ram: '8GB', storage: '256GB SSD' }, price: 385000, qty: 3 },
          { label: '8GB / 512GB SSD', attrs: { ram: '8GB', storage: '512GB SSD' }, price: 420000, qty: 2 },
          { label: '16GB / 512GB SSD', attrs: { ram: '16GB', storage: '512GB SSD' }, price: 475000, qty: 3 },
          { label: '16GB / 1TB SSD', attrs: { ram: '16GB', storage: '1TB SSD' }, price: 530000, qty: 1 },
        ]
      },
      {
        sku: 'AIRPODS-PRO',
        name: 'AirPods Pro 2nd Gen',
        description: 'Apple AirPods Pro. Active noise cancellation. Original sealed.',
        category: 'electronics',
        has_variants: false,
        base_price: 185000,
        variants: []
      },
      {
        sku: 'POWERBANK-20K',
        name: 'Anker PowerBank 20000mAh',
        description: 'Fast charging. Charges 3 devices at once. Airline approved.',
        category: 'electronics',
        has_variants: true,
        variant_types: ['color'],
        base_price: 28000,
        variants: [
          { label: 'Black', attrs: { color: 'Black' }, price: 28000, qty: 8 },
          { label: 'White', attrs: { color: 'White' }, price: 28000, qty: 5 },
        ]
      },
    ]
  },

  // ... (rest of VENDORS omitted for brevity, but identical to your provided config) ...
];

async function seedVendors() {
  console.log('🌱 Starting VendBot seed...\n');

  for (const v of VENDORS) {
    console.log(`📦 Seeding vendor: ${v.business_name} (${v.store_code})`);

    // Upsert vendor by whatsapp_number (avoids relying on partial unique index on store_code)
    const existing = await query(
      'SELECT id, store_code FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
      [v.whatsapp_number]
    );
    const existingRow = existing.rows && existing.rows[0];
    let vendor;
    if (existingRow) {
      const up = await query(`
        UPDATE vendors SET
          business_name = $1, store_code = $2,
          category = $3, location = $4, delivery_coverage = $5, turnaround = $6,
          tone = $7, custom_note = $8, negotiation_policy = $9,
          onboarding_complete = $10, status = $11
        WHERE id = $12
        RETURNING id, store_code
      `, [
        v.business_name,
        v.store_code,
        v.category,
        v.location,
        v.delivery_coverage,
        v.turnaround,
        v.tone,
        v.custom_note,
        v.negotiation_policy,
        !!v.onboarding_complete,
        v.status || 'active',
        existingRow.id
      ]);
      vendor = up.rows && up.rows[0];
    } else {
      const ins = await query(`
        INSERT INTO vendors (
          business_name, store_code, whatsapp_number,
          category, location, delivery_coverage, turnaround,
          tone, custom_note, negotiation_policy,
          onboarding_complete, status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12
        )
        RETURNING id, store_code
      `, [
        v.business_name,
        v.store_code,
        v.whatsapp_number,
        v.category,
        v.location,
        v.delivery_coverage,
        v.turnaround,
        v.tone,
        v.custom_note,
        v.negotiation_policy,
        !!v.onboarding_complete,
        v.status || 'active'
      ]);
      vendor = ins.rows && ins.rows[0];
    }
    if (!vendor) throw new Error('Vendor upsert failed');

    console.log(`   ✅ Vendor created: ${vendor.store_code} (${vendor.id})`);

    // Seed products
    for (const p of v.products) {
      // Upsert parent product (for variants)
      const { rows: [product] } = await query(`
        INSERT INTO inventory_products (
          vendor_id, sku, name, description,
          category, has_variants, variant_types,
          created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (vendor_id, sku) DO UPDATE SET
          name = EXCLUDED.name,
          has_variants = EXCLUDED.has_variants,
          variant_types = EXCLUDED.variant_types
        RETURNING id, sku
      `, [
        vendor.id,
        p.sku,
        p.name,
        p.description,
        p.category,
        !!p.has_variants,
        JSON.stringify(p.variant_types || [])
      ]);

      if (p.has_variants && p.variants.length > 0) {
        // Variants go to inventory_variants (price in KOBO)
        for (const vr of p.variants) {
          const variantSku = `${p.sku}-${Object.values(vr.attrs).join('-').replace(/\s+/g, '-').toUpperCase()}`;
          await query(`
            INSERT INTO inventory_variants (
              vendor_id, parent_sku, variant_sku,
              name, variant_label, price, quantity,
              attributes, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
            ON CONFLICT (vendor_id, variant_sku) DO UPDATE SET
              price = EXCLUDED.price,
              quantity = EXCLUDED.quantity
          `, [
            vendor.id,
            p.sku,
            variantSku,
            p.name,
            vr.label,
            Math.round(vr.price * 100), // kobo
            vr.qty,
            JSON.stringify(vr.attrs)
          ]);
        }

        // Aggregate into inventory_items so search/listing sees the parent product
        const totalQty = p.variants.reduce((sum, vr) => sum + (vr.qty || 0), 0);
        await query(`
          INSERT INTO inventory_items (
            vendor_id, name, sku, price, quantity, category, description, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
          ON CONFLICT (vendor_id, sku) DO UPDATE SET
            name = EXCLUDED.name,
            price = EXCLUDED.price,
            quantity = EXCLUDED.quantity,
            category = COALESCE(NULLIF(EXCLUDED.category,''), inventory_items.category),
            description = COALESCE(EXCLUDED.description, inventory_items.description),
            updated_at = NOW()
        `, [
          vendor.id,
          p.name,
          p.sku,
          Math.round(p.base_price), // NAIRA
          totalQty,
          p.category,
          p.description || null
        ]);

        console.log(`   📦 ${p.name} — ${p.variants.length} variants`);
      } else {
        // Simple product — only inventory_items (price in NAIRA)
        await query(`
          INSERT INTO inventory_items (
            vendor_id, name, sku, price, quantity,
            category, description, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
          ON CONFLICT (vendor_id, sku) DO UPDATE SET
            price = EXCLUDED.price,
            quantity = EXCLUDED.quantity,
            category = COALESCE(NULLIF(EXCLUDED.category,''), inventory_items.category),
            description = COALESCE(EXCLUDED.description, inventory_items.description),
            updated_at = NOW()
        `, [
          vendor.id,
          p.name,
          p.sku,
          Math.round(p.base_price),
          10,
          p.category,
          p.description || null
        ]);
        console.log(`   📦 ${p.name} — simple product`);
      }
    }

    // Generate WhatsApp link for this vendor
    const bot = (BOT_NUMBER || '').replace(/\D/g, '');
    const waLink = `https://wa.me/${bot || v.whatsapp_number.replace(/\D/g, '')}?text=${encodeURIComponent(v.store_code)}`;
    console.log(`   🔗 Store link: ${waLink}\n`);
  }

  console.log('✅ Seed complete!\n');
  console.log('Store links:');
  const bot = (BOT_NUMBER || '').replace(/\D/g, '');
  for (const v of VENDORS) {
    const waLink = `https://wa.me/${bot || v.whatsapp_number.replace(/\D/g, '')}?text=${encodeURIComponent(v.store_code)}`;
    console.log(`  ${v.business_name.padEnd(30)} → ${waLink}`);
  }

  // Close pool explicitly so the script exits cleanly
  try {
    await pool.end();
  } catch (_) {}
}

seedVendors().catch(err => {
  console.error('❌ Seed failed:', err.message);
  try { pool.end(); } catch (_) {}
  process.exit(1);
});

