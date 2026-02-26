/**
 * Unified inventory: Google Sheets or Neon DB. All operations are per-vendor (dynamic).
 * For each vendor we decide once per call:
 * - If USE_DB_INVENTORY_ONLY is set (env) → always use Neon DB.
 * - Else if vendor.sheet_id is set → use Google Sheets for that vendor.
 * - Otherwise → use inventory_items table in Neon for that vendor.
 * So "add stock", restock, sold, list, etc. all go to Sheets or DB according to that vendor's setup.
 * Same item shape everywhere: { name, sku, price, quantity, category, minPrice, image_url? }.
 */
const sheets = require('./sheets');
const db = require('./db');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');

/** When true, always use DB (live inventory); ignore vendor sheet_id. */
const useDbOnly = /^(1|true|yes)$/i.test(String(process.env.USE_DB_INVENTORY_ONLY || '').trim());

function useSheets(vendor) {
  if (useDbOnly) return false;
  return !!(vendor && (vendor.sheet_id || vendor.sheetId));
}

async function getInventory(vendor, tab) {
  if (!vendor) return [];
  if (useSheets(vendor)) {
    const list = await sheets.getInventory(vendor.sheet_id || vendor.sheetId, tab || vendor.sheet_tab || 'Sheet1');
    return list.map((i) => ({ ...i, image_url: i.image_url || null }));
  }
  return db.getInventoryDb(vendor.id);
}

/** All items including out-of-stock (for search, price, image). */
async function getAllInventory(vendor, tab) {
  if (!vendor) return [];
  if (useSheets(vendor)) {
    const list = await sheets.getInventoryAll(vendor.sheet_id || vendor.sheetId, tab || vendor.sheet_tab || 'Sheet1');
    return list.map((i) => ({ ...i, image_url: i.image_url || null }));
  }
  return db.getInventoryDbAll(vendor.id);
}

async function maybeNotifyLowStock(vendor, sku, newQty) {
  const threshold = Number(process.env.LOW_STOCK_THRESHOLD || 1);
  if (Number.isNaN(threshold) || newQty == null) return;
  if (newQty > threshold) return;
  const phone = (vendor.whatsapp_number || '').replace(/\D/g, '');
  if (!phone) return;
  const sock = getSock && getSock();
  if (!sock) return;
  const vendorJid = `${phone}@s.whatsapp.net`;
  const statusText = newQty === 0 ? 'is now *out of stock*' : `has only *${newQty}* left`;
  const msg =
    `Heads up: SKU *${sku}* ${statusText}.\n` +
    `Reply *list* to see your inventory or *restock: item name, qty* to top up.`;
  try {
    await sendWithDelay(sock, vendorJid, msg, 800);
  } catch (e) {
    console.error('[LOW STOCK ALERT ERROR]', e.message || e);
  }
}

/** Add stock: goes to Google Sheets or DB depending on this vendor (sheet_id or not). */
async function addItems(vendor, items) {
  if (!vendor || !items || items.length === 0) return;
  if (useSheets(vendor)) {
    await sheets.addItemsToSheet(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', items);
    return;
  }
  await db.addItemsDb(vendor.id, items);
}

async function decrementQty(vendor, sku) {
  let res;
  if (useSheets(vendor)) {
    res = await sheets.decrementQty(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku);
  } else {
    res = await db.decrementQtyDb(vendor.id, sku);
  }
  const newQty = res && typeof res.newQty === 'number' ? res.newQty : null;
  if (newQty != null) await maybeNotifyLowStock(vendor, sku, newQty);
  return res;
}

async function updateItemQty(vendor, sku, newQty) {
  let qty;
  if (useSheets(vendor)) {
    qty = await sheets.updateItemQty(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku, newQty);
  } else {
    qty = await db.updateItemQtyDb(vendor.id, sku, newQty);
  }
  if (qty != null) await maybeNotifyLowStock(vendor, sku, Number(qty));
  return qty;
}

async function updateItemPrice(vendor, sku, newPrice) {
  if (useSheets(vendor)) {
    return sheets.updateItemPrice(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku, newPrice);
  }
  return db.updateItemPriceDb(vendor.id, sku, newPrice);
}

async function setItemImage(vendor, sku, imageUrl) {
  if (useSheets(vendor)) return; // Sheets don't support image_url in our current schema
  return db.setItemImageDb(vendor.id, sku, imageUrl);
}

async function setItemDescription(vendor, sku, description) {
  if (useSheets(vendor)) return;
  return db.setItemDescriptionDb(vendor.id, sku, description);
}

module.exports = {
  getInventory,
  getAllInventory,
  addItems,
  decrementQty,
  updateItemQty,
  updateItemPrice,
  setItemImage,
  setItemDescription,
  useSheets
};
