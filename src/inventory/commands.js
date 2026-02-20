const { query } = require('../db');
const { getInventory, addItemsToSheet, updateItemQty, decrementQty } = require('./sheets');
const { extractInventoryFromText } = require('../ai/extractor');

async function handleInventoryCommand(text, vendor) {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return null;

  if (lower.startsWith('add:') || lower.startsWith('add ')) {
    const content = text.replace(/^add:?\s*/i, '').trim();
    const items = await extractInventoryFromText(content);
    if (!items.length) return 'Could not understand. Try: "add: item name, price, quantity"';
    if (!vendor.sheet_id) return 'No Google Sheet linked. Set up your sheet first.';
    await addItemsToSheet(vendor.sheet_id, vendor.sheet_tab || 'Sheet1', items);
    const summary = items.map(i => `• ${i.name} — ₦${Number(i.price).toLocaleString()} (${i.quantity} in stock)`).join('\n');
    return `Added ${items.length} item(s) ✅\n\n${summary}`;
  }

  if (lower.startsWith('sold:') || lower.startsWith('sold ')) {
    const itemName = text.replace(/^sold:?\s*/i, '').trim();
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab || 'Sheet1');
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}". Check spelling.`;
    const { newQty } = await decrementQty(vendor.sheet_id, vendor.sheet_tab || 'Sheet1', item.sku);
    return `Marked as sold ✅\n${item.name} — ${newQty} remaining`;
  }

  if (lower.startsWith('restock:') || lower.startsWith('restock ')) {
    const parts = text.replace(/^restock:?\s*/i, '').split(',');
    const itemName = parts[0]?.trim();
    const newQty = parseInt(parts[1]?.trim(), 10);
    if (!itemName || isNaN(newQty)) return 'Format: "restock: item name, new quantity"';
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab || 'Sheet1');
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}".`;
    await updateItemQty(vendor.sheet_id, vendor.sheet_tab || 'Sheet1', item.sku, newQty);
    const waitRes = await query(
      'SELECT buyer_jid FROM waitlist WHERE vendor_id = $1 AND item_sku = $2 AND notified = false',
      [vendor.id, item.sku]
    );
    const waitlistBuyers = waitRes.rows || [];
    return { reply: `Updated ✅ ${item.name} — ${newQty} in stock`, waitlistBuyers, restockedItem: item };
  }

  if (lower === 'list' || lower === 'inventory') {
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab || 'Sheet1');
    if (!inventory.length) return 'Your inventory is empty. Send "add: [item], [price], [qty]" to add items.';
    return `📦 *Your Inventory (${inventory.length} items)*\n\n` +
      inventory.map((i, n) => `${n + 1}. ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`).join('\n');
  }

  return null;
}

module.exports = { handleInventoryCommand };
