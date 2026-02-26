/** Selecting-item state: list context intent (CANCEL / WANT_LIST_AGAIN / NEW_QUESTION / SELECT_ITEM), resolve by number/sku/name */

const { matchProducts, classifyListContextIntent } = require('../../../ai/classifier');
const { generateReply, generateCancelReply, generateCatalogReply } = require('../../../ai/responder');
const {
  outOfStock,
  listPrompt,
  listIntroFirst,
  listIntroAgain,
  selectionConfirm,
} = require('../../../ai/human-phrases');
const { sendWithDelay, sendListMessage, sendImageWithCaption } = require('../../sender');
const { logReply } = require('../logger');
const { upsertSession, appendMessage, clearSession, appendConversationExchange } = require('../../../sessions/manager');
const { handlePurchase } = require('./purchase');

const LIST_PAGE_SIZE = 10;

async function handleSelectingItem(ctx) {
  const { sock, buyerJid, vendor, session, inventory, history, text } = ctx;
  if (session.intent_state !== 'selecting_item') return false;

  const listSkus = (session.list_skus || '').split(',').map(s => s.trim()).filter(Boolean);
  const listOffset = Math.max(0, parseInt(session.list_offset, 10) || 0);
  const fullList = listSkus.length > 0
    ? listSkus.map(sku => inventory.find(i => i.sku === sku)).filter(Boolean)
    : inventory.filter(i => i.quantity > 0);
  const currentList = fullList.slice(listOffset, listOffset + LIST_PAGE_SIZE);

  const trimmed = (text || '').trim();
  const num = /^\s*\d+\s*$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;

  // "Next page": user typed 11 (or next/more) when we're showing first 10 — show next 10 items
  const askNextPage = num === currentList.length + 1 && listOffset + currentList.length < fullList.length;
  const askNextPageWords = /^(next|more|show\s+more)$/i.test(trimmed) && listOffset + LIST_PAGE_SIZE < fullList.length;
  if ((askNextPage || askNextPageWords) && fullList.length > LIST_PAGE_SIZE) {
    const nextOffset = listOffset + currentList.length;
    const nextPage = fullList.slice(nextOffset, nextOffset + LIST_PAGE_SIZE);
    const lines = nextPage.map((i, idx) => `${idx + 1}. ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`).join('\n');
    const remaining = fullList.length - (nextOffset + nextPage.length);
    const moreLine = remaining > 0 ? `\n\n…and ${remaining} more. Reply *${nextPage.length + 1}* for the next 10.` : '';
    const reply = `📦 *Next items*\n\n${lines}${moreLine}\n\nReply with a number to choose (1–${nextPage.length}).`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    await upsertSession(buyerJid, vendor.id, { list_offset: nextOffset });
    return true;
  }

  const isNumericSelection = !isNaN(num) && num >= 1 && num <= 20 && currentList.length > 0;
  const bySkuDirect = inventory.find((i) => i.sku === trimmed) && currentList.some(i => i.sku === trimmed);

  let listIntent = 'SELECT_ITEM';
  if (!isNumericSelection && !bySkuDirect) {
    listIntent = await classifyListContextIntent(text, currentList.map(i => i.name));
  }

  if (listIntent === 'CANCEL') {
    await clearSession(buyerJid, vendor.id);
    const reply = await generateCancelReply(text, inventory, vendor.business_name);
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    await appendConversationExchange(buyerJid, vendor.id, text, reply);
    return true;
  }
  if (listIntent === 'WANT_LIST_AGAIN' && currentList.length > 0) {
    await sendListMessage(sock, buyerJid, listIntroAgain(currentList.length), 'Choose option', currentList);
    logReply('[List resent]');
    await appendMessage(buyerJid, vendor.id, 'bot', '[List resent]');
    return true;
  }
  if (listIntent === 'NEW_QUESTION') {
    await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null, list_offset: 0 });
    const matches = await matchProducts(text, inventory);
    if (matches.length === 1) {
      const item = matches[0];
      if (item.quantity < 1) {
        const out = outOfStock(item.name);
        await sendWithDelay(sock, buyerJid, out);
        logReply(out);
        await appendMessage(buyerJid, vendor.id, 'bot', 'Out of stock.');
      } else {
        const reply = await generateReply(text, inventory, vendor, history, session);
        const caption = item.description ? `${reply}\n\n${item.description}` : reply;
        if (item.image_url) await sendImageWithCaption(sock, buyerJid, item.image_url, caption);
        else await sendWithDelay(sock, buyerJid, reply);
        logReply(reply);
        await appendMessage(buyerJid, vendor.id, 'bot', reply);
        await appendConversationExchange(buyerJid, vendor.id, text, reply);
        await upsertSession(buyerJid, vendor.id, { intent_state: 'querying', last_item_name: item.name, last_item_sku: item.sku, last_item_price: item.price, last_item_price_quoted_at: new Date().toISOString() });
      }
      return true;
    }
    if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, listIntroFirst(), 'Choose option', matches);
      logReply('[List]');
      await upsertSession(buyerJid, vendor.id, { intent_state: 'selecting_item', list_skus: matches.map(m => m.sku).join(','), list_offset: 0, last_item_name: null, last_item_sku: null });
      await appendMessage(buyerJid, vendor.id, 'bot', '[List]');
      return true;
    }
    const reply = await generateCatalogReply(text, inventory, vendor, history, session);
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    await appendConversationExchange(buyerJid, vendor.id, text, reply);
    return true;
  }

  const bySku = inventory.find((i) => i.sku === text.trim());
  if (bySku && currentList.some(i => i.sku === bySku.sku)) {
    if (bySku.quantity < 1) {
      await sendWithDelay(sock, buyerJid, outOfStock(bySku.name));
      await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null });
    } else {
      await sendWithDelay(sock, buyerJid, selectionConfirm(bySku.name, bySku.price));
      await handlePurchase(sock, buyerJid, vendor, session, bySku);
    }
    return true;
  }
  if (!isNaN(num) && num >= 1 && num <= currentList.length) {
    const item = currentList[num - 1];
    if (item.quantity < 1) {
      await sendWithDelay(sock, buyerJid, outOfStock());
      await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null });
    } else {
      await sendWithDelay(sock, buyerJid, selectionConfirm(item.name, item.price));
      await handlePurchase(sock, buyerJid, vendor, session, item);
    }
    return true;
  }
  const matches = await matchProducts(text, inventory);
  if (matches.length === 1) {
    const one = matches[0];
    if (one.quantity < 1) {
      await sendWithDelay(sock, buyerJid, outOfStock(one.name));
      await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null });
    } else {
      await handlePurchase(sock, buyerJid, vendor, session, one);
    }
    return true;
  }
  const max = currentList.length;
  const fallbackReply = listPrompt(max);
  await sendWithDelay(sock, buyerJid, fallbackReply);
  logReply(fallbackReply);
  return true;
}

module.exports = { handleSelectingItem };
