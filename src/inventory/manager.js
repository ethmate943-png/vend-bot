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
const inventoryCache = require('./cache');
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
  const cached = inventoryCache.get(vendor.id);
  if (cached) return cached;
  if (useSheets(vendor)) {
    try {
      const list = await sheets.getInventory(vendor.sheet_id || vendor.sheetId, tab || vendor.sheet_tab || 'Sheet1');
      const data = list.map((i) => ({ ...i, image_url: i.image_url || null }));
      inventoryCache.set(vendor.id, data);
      return data;
    } catch (err) {
      const code = err.code ?? err.response?.status;
      if (code === 403 || code === 404) {
        const phone = (vendor.whatsapp_number || '').replace(/\D/g, '');
        if (phone && getSock) {
          const sock = getSock();
          if (sock) {
            const serviceEmail = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
            await sendWithDelay(sock, `${phone}@s.whatsapp.net`,
              `⚠️ I can't access your inventory spreadsheet anymore.\n\n` +
              `Please make sure it's shared with:\n${serviceEmail || '(your service account email)'}\n\n` +
              `Buyers won't see your products until this is fixed.`
            );
          }
        }
        return [];
      }
      throw err;
    }
  }
  const data = await db.getInventoryDb(vendor.id);
  inventoryCache.set(vendor.id, data);
  return data;
}

/** All items including out-of-stock (for search, price, image). */
async function getAllInventory(vendor, tab) {
  if (!vendor) return [];
  if (useSheets(vendor)) {
    try {
      const list = await sheets.getInventoryAll(vendor.sheet_id || vendor.sheetId, tab || vendor.sheet_tab || 'Sheet1');
      return list.map((i) => ({ ...i, image_url: i.image_url || null }));
    } catch (err) {
      const code = err.code ?? err.response?.status;
      if (code === 403 || code === 404) {
        const phone = (vendor.whatsapp_number || '').replace(/\D/g, '');
        if (phone && getSock) {
          const sock = getSock();
          if (sock) {
            const serviceEmail = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
            await sendWithDelay(sock, `${phone}@s.whatsapp.net`,
              `⚠️ I can't access your inventory spreadsheet anymore.\n\n` +
              `Please make sure it's shared with:\n${serviceEmail || '(your service account email)'}\n\n` +
              `Buyers won't see your products until this is fixed.`
            );
          }
        }
        return [];
      }
      throw err;
    }
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
  } else {
    await db.addItemsDb(vendor.id, items);
  }
  inventoryCache.invalidate(vendor.id);
}

async function decrementQty(vendor, sku) {
  let res;
  if (useSheets(vendor)) {
    res = await sheets.decrementQty(vendor.sheet_id || vendor.sheetId, vendor.sheet_tab || 'Sheet1', sku);
  } else {
    res = await db.decrementQtyDb(vendor.id, sku);
  }
  inventoryCache.invalidate(vendor.id);
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
  inventoryCache.invalidate(vendor.id);
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
  useSheets,
  get inventoryCache() { return inventoryCache; }
};
