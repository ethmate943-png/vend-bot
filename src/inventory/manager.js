/**
 * Unified inventory: Google Sheets or Neon DB.
 * - If vendor.sheet_id is set → use Google Sheets (existing behaviour).
 * - Otherwise → use inventory_items table in Neon.
 * All functions return/accept the same item shape: { name, sku, price, quantity, category, minPrice, image_url? }.
 */
const sheets = require('./sheets');
const db = require('./db');

function useSheets(vendor) {
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

async function addItems(vendor, items) {
  if (!vendor || !items || items.length === 0) return;
  if (useSheets(vendor)) {
    await sheets.addItemsToSheet(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', items);
    return;
  }
  await db.addItemsDb(vendor.id, items);
}

async function decrementQty(vendor, sku) {
  if (useSheets(vendor)) {
    return sheets.decrementQty(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku);
  }
  return db.decrementQtyDb(vendor.id, sku);
}

async function updateItemQty(vendor, sku, newQty) {
  if (useSheets(vendor)) {
    return sheets.updateItemQty(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku, newQty);
  }
  return db.updateItemQtyDb(vendor.id, sku, newQty);
}

async function setItemImage(vendor, sku, imageUrl) {
  if (useSheets(vendor)) return; // Sheets don't support image_url in our current schema
  return db.setItemImageDb(vendor.id, sku, imageUrl);
}

module.exports = {
  getInventory,
  addItems,
  decrementQty,
  updateItemQty,
  setItemImage,
  useSheets
};
