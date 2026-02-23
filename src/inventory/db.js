/**
 * DB-backed inventory (Neon). Used when vendor has no Google Sheet.
 * Same shape as Sheets inventory: { name, sku, price, quantity, category, minPrice, image_url }.
 */
const { query } = require('../db');

async function getInventoryDb(vendorId) {
  const res = await query(
    `SELECT name, sku, price, quantity, category, min_price, image_url
     FROM inventory_items WHERE vendor_id = $1 AND quantity > 0 AND name IS NOT NULL AND name != ''
     ORDER BY name`,
    [vendorId]
  );
  return (res.rows || []).map((r) => ({
    name: r.name,
    sku: r.sku || r.name,
    price: Number(r.price),
    quantity: Number(r.quantity),
    category: r.category || '',
    minPrice: r.min_price != null && r.min_price > 0 ? Number(r.min_price) : Number(r.price),
    image_url: r.image_url || null
  }));
}

async function addItemsDb(vendorId, items) {
  if (!items || items.length === 0) return;
  for (const i of items) {
    const sku = (i.sku || i.name || '').trim() || null;
    const name = (i.name || '').trim();
    const price = Math.max(0, Math.floor(Number(i.price) || 0));
    const quantity = Math.max(0, Math.floor(Number(i.quantity) || 1));
    const category = (i.category || '').trim();
    const minPrice = i.minPrice != null ? Math.max(0, Math.floor(Number(i.minPrice))) : null;
    const imageUrl = (i.image_url || i.imageUrl || '').trim() || null;
    if (!name) continue;
    await query(
      `INSERT INTO inventory_items (vendor_id, name, sku, price, quantity, category, min_price, image_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (vendor_id, sku) DO UPDATE SET
         name = EXCLUDED.name,
         price = EXCLUDED.price,
         quantity = inventory_items.quantity + EXCLUDED.quantity,
         category = COALESCE(NULLIF(EXCLUDED.category,''), inventory_items.category),
         min_price = COALESCE(EXCLUDED.min_price, inventory_items.min_price),
         image_url = COALESCE(EXCLUDED.image_url, inventory_items.image_url),
         updated_at = NOW()`,
      [vendorId, name, sku || name, price, quantity, category, minPrice || price, imageUrl]
    );
  }
}

async function decrementQtyDb(vendorId, sku) {
  const res = await query(
    `UPDATE inventory_items SET quantity = GREATEST(0, quantity - 1), updated_at = NOW()
     WHERE vendor_id = $1 AND sku = $2 RETURNING quantity`,
    [vendorId, sku]
  );
  const row = res.rows && res.rows[0];
  if (!row) throw new Error(`SKU not found: ${sku}`);
  return { newQty: Number(row.quantity) };
}

async function updateItemQtyDb(vendorId, sku, newQty) {
  const qty = Math.max(0, Math.floor(Number(newQty)));
  const res = await query(
    `UPDATE inventory_items SET quantity = $3, updated_at = NOW() WHERE vendor_id = $1 AND sku = $2 RETURNING id`,
    [vendorId, sku, qty]
  );
  if (!res.rows || res.rows.length === 0) throw new Error(`SKU not found: ${sku}`);
  return qty;
}

/** Set or clear image_url for an item. */
async function setItemImageDb(vendorId, sku, imageUrl) {
  const url = (imageUrl || '').trim() || null;
  await query(
    `UPDATE inventory_items SET image_url = $3, updated_at = NOW() WHERE vendor_id = $1 AND sku = $2`,
    [vendorId, sku, url]
  );
}

module.exports = {
  getInventoryDb,
  addItemsDb,
  decrementQtyDb,
  updateItemQtyDb,
  setItemImageDb
};
