const { query } = require('../db');
const { getInventory, addItems, updateItemQty, decrementQty, setItemImage, useSheets } = require('./manager');
const { extractInventoryFromText } = require('../ai/extractor');

async function handleInventoryCommand(text, vendor) {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return null;

  if (lower === 'stock help' || lower === 'inventory help' || lower === 'help stock') {
    return (
      `📦 *Inventory commands*\n\n` +
      `• *add:* name, price, qty — or add: name, price, qty, image URL\n` +
      `• *sold:* item name — mark one sold\n` +
      `• *restock:* item name, new qty — or *set:* item name, qty\n` +
      `• *list* or *inventory* — see all items\n` +
      (useSheets(vendor) ? '' : `• *remove:* item name — remove from list (set qty to 0)\n• *image:* item name, URL — set product image\n`) +
      `\nYou can also send a voice note: "Add black sneakers 25k 3..."`
    );
  }

  if (lower.startsWith('add:') || lower.startsWith('add ')) {
    let content = text.replace(/^add:?\s*/i, '').trim();
    if (content.includes('\n')) {
      content = content.split(/\n+/).map(l => l.trim()).filter(Boolean).join('. ');
    }
    const items = await extractInventoryFromText(content);
    if (!items.length) return 'Could not understand. Try: "add: item name, price, quantity" or "add: name, price, qty, image URL"';
    await addItems(vendor, items);
    const summary = items.map(i => `• ${i.name} — ₦${Number(i.price).toLocaleString()} (${i.quantity} in stock)`).join('\n');
    return `Added ${items.length} item(s) ✅\n\n${summary}`;
  }

  if (lower.startsWith('sold:') || lower.startsWith('sold ')) {
    const itemName = text.replace(/^sold:?\s*/i, '').trim();
    const inventory = await getInventory(vendor);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}". Check spelling.`;
    const { newQty } = await decrementQty(vendor, item.sku);
    return `Marked as sold ✅\n${item.name} — ${newQty} remaining`;
  }

  if (lower.startsWith('restock:') || lower.startsWith('restock ') || lower.startsWith('set:') || lower.startsWith('set ')) {
    const restockText = text.replace(/^restock:?\s*/i, '').replace(/^set:?\s*/i, '').trim();
    const parts = restockText.split(',');
    const itemName = parts[0]?.trim();
    const newQty = parseInt(parts[1]?.trim(), 10);
    if (!itemName || isNaN(newQty)) return 'Format: "restock: item name, new quantity" or "set: item name, new quantity"';
    const inventory = await getInventory(vendor);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}".`;
    await updateItemQty(vendor, item.sku, newQty);
    const waitRes = await query(
      'SELECT buyer_jid FROM waitlist WHERE vendor_id = $1 AND item_sku = $2 AND notified = false',
      [vendor.id, item.sku]
    );
    const waitlistBuyers = waitRes.rows || [];
    return { reply: `Updated ✅ ${item.name} — ${newQty} in stock`, waitlistBuyers, restockedItem: item };
  }

  if (lower === 'list' || lower === 'inventory') {
    const inventory = await getInventory(vendor);
    if (!inventory.length) return 'Your inventory is empty. Send *add: name, price, qty* or say *stock help* for all commands.';
    return `📦 *Your Inventory (${inventory.length} items)*\n\n` +
      inventory.map((i, n) => `${n + 1}. ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`).join('\n');
  }

  if (lower.startsWith('remove:') || lower.startsWith('remove ')) {
    const itemName = text.replace(/^remove:?\s*/i, '').trim();
    if (!itemName) return 'Use: remove: item name';
    const inventory = await getInventory(vendor);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}".`;
    await updateItemQty(vendor, item.sku, 0);
    return `Removed from list ✅ ${item.name} (qty set to 0).`;
  }

  if ((lower.startsWith('image:') || lower.startsWith('set image:') || lower.startsWith('set image ')) && !useSheets(vendor)) {
    const rest = text.replace(/^(image|set image):?\s*/i, '').trim();
    const lastComma = rest.lastIndexOf(',');
    const itemName = lastComma > 0 ? rest.slice(0, lastComma).trim() : '';
    const imageUrl = lastComma > 0 ? rest.slice(lastComma + 1).trim() : '';
    if (!itemName || !imageUrl || !imageUrl.startsWith('http')) {
      return 'Use: image: item name, image URL (e.g. https://...)';
    }
    const inventory = await getInventory(vendor);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}".`;
    await setItemImage(vendor, item.sku, imageUrl);
    return `Image set ✅ for ${item.name}.`;
  }

  return null;
}

module.exports = { handleInventoryCommand };
