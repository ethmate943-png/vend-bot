/** Cart: add to cart, my cart, remove, checkout. */
const { getCart, addToCart, updateCartItem, clearCart, getCartTotalKobo } = require('../../../cart/manager');
const { sendWithDelay } = require('../../sender');
const { logReply } = require('../logger');
const { appendMessage, upsertSession } = require('../../../sessions/manager');
const { generatePaymentLink, checkVendorCap } = require('../../../payments/paystack');
const { getVendorBadgeLineForPayment } = require('../../../verified-vendor');

/** Resolve item from session (last item or list index). */
function resolveItemFromContext(session, inventory) {
  const listSkus = (session.list_skus || '').split(',').filter(Boolean);
  const lastSku = session.last_item_sku;
  const lastName = session.last_item_name;
  if (lastSku || lastName) {
    const item = inventory.find(i => i.sku === lastSku || i.name === lastName);
    if (item) return item;
  }
  return null;
}

/** Parse "add 2" or "add number 3" -> list index (0-based). */
function parseListIndex(text) {
  const m = text.match(/(?:add|put)\s*(?:number\s*)?(\d+)/i) || text.match(/(\d+)\s*(?:to\s*cart)?/);
  if (m) {
    const idx = parseInt(m[1], 10);
    if (idx >= 1 && idx <= 10) return idx - 1;
  }
  return null;
}

/**
 * @param ctx { sock, buyerJid, vendor, session, inventory, history, text }
 * @returns {Promise<boolean>} true if message was cart-related and handled
 */
async function handleCartMessage(ctx) {
  const { sock, buyerJid, vendor, session, inventory, text } = ctx;
  const lower = (text || '').toLowerCase().trim();
  const trimmed = (text || '').trim();

  // —— My cart / show cart ——
  if (/^(my\s+)?cart|show\s+(my\s+)?cart|what'?s?\s+in\s+my\s+cart|view\s+cart$/i.test(lower)) {
    const items = await getCart(buyerJid, vendor.id);
    if (items.length === 0) {
      const reply = `Your cart is empty.\n\nReply *add to cart* after viewing an item, or tell me what you're looking for.`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      return true;
    }
    const lines = items.map((i, idx) => `${idx + 1}. ${i.name} — ₦${i.price.toLocaleString()} × ${i.quantity}`).join('\n');
    const totalKobo = await getCartTotalKobo(buyerJid, vendor.id);
    const totalNaira = (totalKobo / 100).toLocaleString();
    const reply =
      `🛒 *Your cart* (${items.length} item${items.length === 1 ? '' : 's'})\n\n${lines}\n\n` +
      `Total: *₦${totalNaira}*\n\n` +
      `Say *checkout* to pay, or *remove [item]* to remove something.`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return true;
  }

  // —— Add to cart ——
  const addMatch = /add\s+(?:to\s+)?(?:my\s+)?cart|add\s+this|add\s+it\s*(?:to\s*cart)?|put\s+(?:it\s+)?in\s+(?:my\s+)?cart/i.test(lower);
  const addWithNumber = /^(?:add|put)\s*(?:number\s*)?\d+/i.test(trimmed);
  if (addMatch || addWithNumber) {
    let item = null;
    const listSkus = (session.list_skus || '').split(',').filter(Boolean);
    const listIndex = parseListIndex(trimmed);
    if (listIndex != null && listSkus.length > 0) {
      const sku = listSkus[listIndex];
      item = inventory.find(i => i.sku === sku);
    }
    if (!item) item = resolveItemFromContext(session, inventory);
    if (!item) {
      const reply = `I'm not sure which item to add. Pick something from the list (e.g. reply *2*), or ask about an item first, then say *add to cart*.`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      return true;
    }
    const qtyMatch = trimmed.match(/(\d+)\s*(?:pieces?|pcs?|x)?\s*(?:to\s*cart)?$/i) || trimmed.match(/add\s+(?:to\s+cart\s+)?(\d+)/i);
    const qty = qtyMatch ? Math.max(1, parseInt(qtyMatch[1], 10)) : 1;
    await addToCart(buyerJid, vendor.id, { sku: item.sku, name: item.name, price: item.price }, qty);
    const reply = `Added *${item.name}* × ${qty} to your cart ✅\n\nSay *my cart* to see your cart or *checkout* when ready.`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return true;
  }

  // —— Remove from cart ——
  const removeMatch = /remove\s+(.+)\s+from\s+(?:my\s+)?cart|remove\s+(.+)|delete\s+(.+)\s+from\s+cart/i.exec(trimmed);
  if (removeMatch) {
    const cart = await getCart(buyerJid, vendor.id);
    if (cart.length === 0) {
      await sendWithDelay(sock, buyerJid, `Your cart is empty. Nothing to remove.`);
      return true;
    }
    const key = (removeMatch[1] || removeMatch[2] || removeMatch[3] || '').trim().toLowerCase();
    const byIndex = /^\d+$/.test(key) ? parseInt(key, 10) : null;
    const entry = byIndex != null && byIndex >= 1 && byIndex <= cart.length
      ? cart[byIndex - 1]
      : cart.find(i => i.name.toLowerCase().includes(key) || i.sku.toLowerCase() === key);
    if (!entry) {
      await sendWithDelay(sock, buyerJid, `I couldn't find that in your cart. Reply *my cart* to see what's there.`);
      return true;
    }
    await updateCartItem(buyerJid, vendor.id, entry.sku, 0);
    const reply = `Removed *${entry.name}* from your cart ✅`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return true;
  }

  // —— Clear cart ——
  if (/clear\s+(?:my\s+)?cart|empty\s+(?:my\s+)?cart/i.test(lower)) {
    await clearCart(buyerJid, vendor.id);
    await sendWithDelay(sock, buyerJid, `Cart cleared. Add items again whenever you're ready.`);
    return true;
  }

  // —— Checkout: one payment link for full cart
  if (/^checkout$/i.test(lower)) {
    const items = await getCart(buyerJid, vendor.id);
    if (items.length === 0) {
      await sendWithDelay(sock, buyerJid, `Your cart is empty. Add items first, then say *checkout*.`);
      return true;
    }
    const totalKobo = await getCartTotalKobo(buyerJid, vendor.id);
    const totalNaira = totalKobo / 100;
    const capCheck = await checkVendorCap(vendor, totalKobo);
    if (!capCheck.allowed) {
      await sendWithDelay(sock, buyerJid,
        `Daily limit reached for this store. Try again tomorrow or pay for items one by one.`
      );
      return true;
    }
    try {
      const { link, reference } = await generatePaymentLink({
        amount: totalNaira,
        itemName: `Cart (${items.length} item${items.length === 1 ? '' : 's'})`,
        itemSku: 'CART',
        buyerJid,
        vendorId: vendor.id,
        vendorPhone: vendor.whatsapp_number,
        cartItems: items
      });
      await clearCart(buyerJid, vendor.id);
      const badgeLine = getVendorBadgeLineForPayment(vendor);
      const payMsg =
        `🛒 *Cart checkout*\n\n` +
        `Total: *₦${totalNaira.toLocaleString()}* (${items.length} item${items.length === 1 ? '' : 's'})\n\n` +
        `🔗 Pay here: ${link}\n\n` +
        `_Link expires in 30 mins._` +
        (badgeLine || '\n\n_Your payment is held safely until you confirm delivery._');
      await sendWithDelay(sock, buyerJid, payMsg);
      logReply(payMsg);
      await appendMessage(buyerJid, vendor.id, 'bot', payMsg);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'awaiting_payment',
        pending_payment_ref: reference,
        last_item_name: null,
        last_item_sku: null
      });
    } catch (err) {
      console.error('[CART CHECKOUT ERROR]', err.message || err);
      await sendWithDelay(sock, buyerJid, `Could not create payment link. Please try again or pay for items one by one.`);
    }
    return true;
  }

  return false;
}

module.exports = { handleCartMessage };
