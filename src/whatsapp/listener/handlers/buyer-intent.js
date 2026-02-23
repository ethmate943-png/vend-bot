/** Intent-based buyer flow: QUERY, PURCHASE, CONFIRM, NEGOTIATE, CANCEL, IGNORE, OTHER */

const { matchProducts } = require('../../../ai/classifier');
const { generateReply, generateCancelReply, generateCatalogReply } = require('../../../ai/responder');
const { sendMessage, sendWithDelay, sendListMessage, sendImageWithCaption } = require('../../sender');
const { logReply } = require('../logger');
const { listIntroFirst, listIntroPurchase, noMatch } = require('../../../ai/human-phrases');
const { upsertSession, appendMessage, clearSession } = require('../../../sessions/manager');
const { handlePurchase } = require('./purchase');
const { handleNegotiateIntent } = require('./negotiation');
const { COLORS } = require('../logger');

async function handleBuyerIntent(ctx, intent, lastItemAsMatch) {
  const { sock, buyerJid, vendor, session, inventory, history, text } = ctx;

  if (intent === 'QUERY') {
    let matches = await matchProducts(text, inventory);
    if (matches.length === 0 && lastItemAsMatch) matches = [lastItemAsMatch];

    if (matches.length === 1) {
      const item = matches[0];
      const reply = await generateReply(text, inventory, vendor.business_name, history, session);
      if (item.image_url) {
        await sendImageWithCaption(sock, buyerJid, item.image_url, reply);
      } else {
        await sendWithDelay(sock, buyerJid, reply);
      }
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'querying',
        last_item_name: item.name,
        last_item_sku: item.sku,
        last_item_price: item.price,
        last_item_price_quoted_at: new Date().toISOString()
      });
    } else if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, listIntroFirst(), 'Choose option', matches);
      logReply('[List]');
      await appendMessage(buyerJid, vendor.id, 'bot', '[List]');
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'selecting_item',
        last_item_name: null,
        last_item_sku: null,
        list_skus: matches.map(m => m.sku).join(',')
      });
    } else {
      const catalogAsk = /what\s+(do\s+you\s+)?have|what'?s?\s+in\s+stock|show\s+me\s+(what\s+you\s+have|your\s+stuff|everything)|list\s+(everything|all)|what\s+do\s+you\s+sell|your\s+products|anything\s+available|do\s+you\s+have\s+anything/i.test(text);
      const reply = catalogAsk
        ? await generateCatalogReply(text, inventory, vendor.business_name, history)
        : noMatch();
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'idle',
        last_item_name: null,
        last_item_sku: null,
        list_skus: null
      });
    }
    return;
  }

  if (intent === 'PURCHASE' || intent === 'CONFIRM') {
    const matches = await matchProducts(text, inventory);
    let item = matches.length === 1 ? matches[0] : null;
    if (!item && session.last_item_name) {
      item = inventory.find(i => i.name === session.last_item_name);
    }
    if (item) {
      await handlePurchase(sock, buyerJid, vendor, session, item);
      return;
    }
    if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, listIntroPurchase(), 'Choose item', matches);
      logReply('[List]');
      await upsertSession(buyerJid, vendor.id, { intent_state: 'selecting_item', list_skus: matches.map(m => m.sku).join(',') });
      return;
    }
    await sendWithDelay(sock, buyerJid, noMatch());
    await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null });
    return;
  }

  if (intent === 'NEGOTIATE') {
    await handleNegotiateIntent(ctx);
    return;
  }

  if (intent === 'CANCEL') {
    await clearSession(buyerJid, vendor.id);
    const reply = await generateCancelReply(text, inventory, vendor.business_name);
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  if (intent === 'IGNORE') {
    console.log(`  ${COLORS.dim}[SKIP] Not commerce-related, ignoring${COLORS.reset}\n`);
    return;
  }

  if (intent === 'OTHER') {
    const hasCommerceHistory = history.some(m => m.role === 'bot');
    if (hasCommerceHistory && (session.intent_state === 'querying' || session.intent_state === 'selecting_item' || session.intent_state === 'negotiating')) {
      const reply = `Need help with that item? Ask the price or say what you're looking for. 😊`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
    } else {
      console.log(`  ${COLORS.dim}[SKIP] Not a product enquiry, ignoring${COLORS.reset}\n`);
    }
  }
}

module.exports = { handleBuyerIntent };
