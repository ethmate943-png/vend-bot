const { query } = require('../db');
const { getInventory, getAllInventory, addItems, updateItemQty, updateItemPrice, decrementQty, setItemImage, setItemDescription, useSheets } = require('./manager');
const { extractInventoryFromText } = require('../ai/extractor');
const { validateItemPrice } = require('./parser');

/** Resolve items by query: exact SKU match returns one; else all where name or sku contains query. */
function matchItems(inventory, query) {
  const q = (query || '').trim();
  if (!q) return [];
  const exactSku = inventory.find((i) => String(i.sku || '').toLowerCase() === q.toLowerCase());
  if (exactSku) return [exactSku];
  const lower = q.toLowerCase();
  return inventory.filter(
    (i) =>
      (i.name && i.name.toLowerCase().includes(lower)) ||
      (i.sku && i.sku.toLowerCase().includes(lower))
  );
}

function disambiguationReply(matches, query, exampleCommand) {
  const lines = matches.slice(0, 15).map((i) => `• ${i.name} (sku: *${i.sku}*) — ₦${Number(i.price).toLocaleString()}, qty ${i.quantity}`);
  return (
    `Several items match "${query}". Use the *full name* or *SKU* so I know which one:\n\n` +
    lines.join('\n') +
    (matches.length > 15 ? `\n… and ${matches.length - 15} more.` : '') +
    (exampleCommand ? `\n\nExample: ${exampleCommand}` : '')
  );
}

async function handleInventoryCommand(text, vendor) {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return null;

  if (lower === 'stock help' || lower === 'inventory help' || lower === 'help stock') {
    return (
      `📦 *Inventory commands*\n\n` +
      `• *add:* name, price, qty — or add: name, price, qty, image URL\n` +
      `• *sold:* item name or SKU — mark one sold\n` +
      `• *restock:* item name or SKU, new qty — or *set:* item, qty\n` +
      `• *price:* item name or SKU, new price — update price\n` +
      `• *list* or *inventory* — see all items (or *list: macbook* to filter)\n` +
      `• *find:* keyword or *search:* keyword — search by name or SKU\n` +
      (useSheets(vendor)
        ? ''
        : `• *remove:* item name or SKU — remove (set qty to 0)\n` +
          `• *image:* item or SKU, URL — set product image (or send a photo after)\n` +
          `• *image:* item or SKU, none — clear image\n` +
          `• *specs:* item or SKU, text — set description/specs (e.g. 16GB RAM, 512GB)\n`) +
      `\nUse *SKU* when you have many similar items. Image URL must be a direct link to a photo (.jpg/.png).`
    );
  }

  if (lower.startsWith('add:') || lower.startsWith('add ')) {
    let content = text.replace(/^add:?\s*/i, '').trim();
    if (content.includes('\n')) {
      content = content.split(/\n+/).map(l => l.trim()).filter(Boolean).join('. ');
    }
    const items = await extractInventoryFromText(content);
    if (!items.length) return 'Could not understand. Try: "add: item name, price, quantity" or "add: name, price, qty, image URL"';
    for (const i of items) {
      const err = validateItemPrice(i.price);
      if (err && (err.includes('must be') || err.includes('greater than zero'))) return err;
    }
    let warnMsg = '';
    for (const i of items) {
      const err = validateItemPrice(i.price);
      if (err && (err.includes('too low') || err.includes('very high'))) { warnMsg = err; break; }
    }
    await addItems(vendor, items);
    const summary = items.map(i => `• ${i.name} — ₦${Number(i.price).toLocaleString()} (${i.quantity} in stock)`).join('\n');
    return `Added ${items.length} item(s) ✅\n\n${summary}` + (warnMsg ? `\n\n_${warnMsg}_` : '');
  }

  if (lower.startsWith('sold:') || lower.startsWith('sold ')) {
    const itemName = text.replace(/^sold:?\s*/i, '').trim();
    if (!itemName) return 'Use: sold: item name or SKU';
    const inventory = await getInventory(vendor);
    const matches = matchItems(inventory, itemName);
    if (matches.length === 0) return `Could not find "${itemName}". Check spelling or use *find: ${itemName}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemName, 'sold: MBP14-M2');
    const item = matches[0];
    const { newQty } = await decrementQty(vendor, item.sku);
    return `Marked as sold ✅\n${item.name} — ${newQty} remaining`;
  }

  if (lower.startsWith('restock:') || lower.startsWith('restock ') || lower.startsWith('set:') || lower.startsWith('set ')) {
    const restockText = text.replace(/^restock:?\s*/i, '').replace(/^set:?\s*/i, '').trim();
    const parts = restockText.split(',');
    const itemName = parts[0]?.trim();
    const newQty = parseInt(parts[1]?.trim(), 10);
    if (!itemName || isNaN(newQty)) return 'Format: "restock: item name or SKU, new quantity" or "set: item, qty"';
    const inventory = await getAllInventory(vendor);
    const matches = matchItems(inventory, itemName);
    if (matches.length === 0) return `Could not find "${itemName}". Try *find: ${itemName}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemName, 'restock: MBP14-M2, 5');
    const item = matches[0];
    await updateItemQty(vendor, item.sku, newQty);
    const waitRes = await query(
      'SELECT buyer_jid FROM waitlist WHERE vendor_id = $1 AND item_sku = $2 AND notified = false',
      [vendor.id, item.sku]
    );
    const waitlistBuyers = waitRes.rows || [];
    return { reply: `Updated ✅ ${item.name} — ${newQty} in stock`, waitlistBuyers, restockedItem: item };
  }

  if (lower.startsWith('price:') || lower.startsWith('set price:') || lower.startsWith('set price ')) {
    const rest = text.replace(/^set price:?\s*/i, '').replace(/^price:?\s*/i, '').trim();
    const lastComma = rest.lastIndexOf(',');
    const itemName = lastComma > 0 ? rest.slice(0, lastComma).trim() : '';
    const priceText = lastComma > 0 ? rest.slice(lastComma + 1).trim() : '';
    const newPrice = parseInt(priceText.replace(/[^0-9]/g, ''), 10);
    if (!itemName || Number.isNaN(newPrice)) {
      return 'Format: "price: item name or SKU, new price" (e.g. price: MBP14-M2, 25000).';
    }
    const priceErr = validateItemPrice(newPrice);
    if (priceErr && (priceErr.includes('must be') || priceErr.includes('greater than zero'))) return priceErr;
    const inventory = await getAllInventory(vendor);
    const matches = matchItems(inventory, itemName);
    if (matches.length === 0) return `Could not find "${itemName}". Try *find: ${itemName}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemName, 'price: MBP14-M2, 25000');
    const item = matches[0];
    const finalPrice = await updateItemPrice(vendor, item.sku, newPrice);
    const warn = (priceErr && (priceErr.includes('too low') || priceErr.includes('very high'))) ? `\n\n_${priceErr}_` : '';
    return `Price updated ✅ ${item.name} — ₦${Number(finalPrice).toLocaleString()}` + warn;
  }

  if (lower === 'find' || lower === 'search' || lower.startsWith('find:') || lower.startsWith('find ') || lower.startsWith('search:') || lower.startsWith('search ')) {
    const searchQuery = text.replace(/^(find|search):?\s*/i, '').trim();
    if (!searchQuery) return 'Send *find: keyword* to search (e.g. find: macbook or find: MBP14).';
    const inventory = await getAllInventory(vendor);
    const matches = matchItems(inventory, searchQuery);
    if (matches.length === 0) return `No items match "${searchQuery}". Try a different word or SKU.`;
    const maxShow = 25;
    const lines = matches.slice(0, maxShow).map(
      (i) => `${i.name} (sku: *${i.sku}*) — ₦${Number(i.price).toLocaleString()}, qty ${i.quantity}${i.image_url ? ' 📷' : ''}`
    );
    const reply =
      `🔍 *Found ${matches.length} item(s) for "${searchQuery}"*\n\n` +
      lines.join('\n') +
      (matches.length > maxShow ? `\n… and ${matches.length - maxShow} more. Use *SKU* in commands.` : '') +
      `\n\nUse SKU in commands, e.g. *price: ${matches[0].sku}, 30000* or *image: ${matches[0].sku}, https://...*`;
    return reply;
  }

  if (lower === 'list' || lower === 'inventory' || lower.startsWith('list:') || lower.startsWith('list ')) {
    const filterQuery = (lower.startsWith('list:') || lower.startsWith('list '))
      ? text.replace(/^list:?\s*/i, '').trim()
      : '';
    const inventory = await getInventory(vendor);
    const list = filterQuery ? matchItems(inventory, filterQuery) : inventory;
    if (!list.length) {
      const emptyGuidance =
        `There's nothing in your inventory yet. You can:\n` +
        `• Paste your Google Sheet link to load your stock, or\n` +
        `• Type *add: name, price, qty* to add items (e.g. *add: Black Sneakers, 25000, 5*)\n\n` +
        `Say *stock help* for all commands.`;
      if (filterQuery) {
        return `No in-stock items match "${filterQuery}". Try *find: ${filterQuery}* to see all (including out of stock).\n\n` +
          `To add something new: *add: name, price, qty* — or paste your Google Sheet link.`;
      }
      return emptyGuidance;
    }
    const intro = filterQuery
      ? `📦 Matching "${filterQuery}" (${list.length} in stock). Tap to view.`
      : `📦 Your inventory (${list.length} items). Tap to view.`;
    return { list: true, items: list, intro, buttonTitle: 'View items' };
  }

  if (lower.startsWith('remove:') || lower.startsWith('remove ')) {
    const itemName = text.replace(/^remove:?\s*/i, '').trim();
    if (!itemName) return 'Use: remove: item name or SKU';
    const inventory = await getInventory(vendor);
    const matches = matchItems(inventory, itemName);
    if (matches.length === 0) return `Could not find "${itemName}". Try *find: ${itemName}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemName, 'remove: MBP14-M2');
    const item = matches[0];
    await updateItemQty(vendor, item.sku, 0);
    return `Removed from list ✅ ${item.name} (qty set to 0).`;
  }

  if ((lower.startsWith('image:') || lower.startsWith('set image:') || lower.startsWith('set image ')) && !useSheets(vendor)) {
    const rest = text.replace(/^(image|set image):?\s*/i, '').trim();
    const lastComma = rest.lastIndexOf(',');
    const itemName = lastComma > 0 ? rest.slice(0, lastComma).trim() : '';
    const imagePart = lastComma > 0 ? rest.slice(lastComma + 1).trim() : '';
    const lowerImage = (imagePart || '').toLowerCase();
    const isClear = lowerImage === 'none' || lowerImage === 'no image' || lowerImage === 'remove' || lowerImage === 'clear';
    const imageUrl = isClear ? '' : imagePart;
    if (!itemName) {
      return 'Use: image: item or SKU, URL — or image: item, none — or send *image: item* then send the photo in the next message.';
    }
    const inventory = await getAllInventory(vendor);
    const matches = matchItems(inventory, itemName);
    if (matches.length === 0) return `Could not find "${itemName}". Try *find: ${itemName}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemName, 'image: MBP14-M2, https://...');
    const item = matches[0];
    if (isClear) {
      await setItemImage(vendor, item.sku, '');
      return `Image cleared ✅ for ${item.name}.`;
    }
    const hasValidUrl = imageUrl && imageUrl.startsWith('http');
    if (hasValidUrl) {
      await setItemImage(vendor, item.sku, imageUrl);
      return `Image set ✅ for ${item.name}.`;
    }
    return { pendingImage: true, sku: item.sku, itemName: item.name };
  }

  if ((lower.startsWith('specs:') || lower.startsWith('description:') || lower.startsWith('specs ') || lower.startsWith('description ')) && !useSheets(vendor)) {
    const rest = text.replace(/^(specs|description):?\s*/i, '').trim();
    const firstComma = rest.indexOf(',');
    const itemRef = firstComma > 0 ? rest.slice(0, firstComma).trim() : '';
    const specText = firstComma > 0 ? rest.slice(firstComma + 1).trim() : '';
    if (!itemRef || !specText) return 'Use: specs: item or SKU, description (e.g. specs: MBP14, 16GB RAM 512GB SSD)';
    const inventory = await getAllInventory(vendor);
    const matches = matchItems(inventory, itemRef);
    if (matches.length === 0) return `Could not find "${itemRef}". Try *find: ${itemRef}* to search.`;
    if (matches.length > 1) return disambiguationReply(matches, itemRef, 'specs: MBP14-M2, 16GB RAM 512GB');
    await setItemDescription(vendor, matches[0].sku, specText);
    return `Specs set ✅ for ${matches[0].name}.`;
  }

  return null;
}

module.exports = { handleInventoryCommand };
