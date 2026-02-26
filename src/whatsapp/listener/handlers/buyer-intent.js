/** Intent-based buyer flow: QUERY, PURCHASE, CONFIRM, NEGOTIATE, CANCEL, IGNORE, OTHER */

const { query } = require('../../../db');
const { matchProducts } = require('../../../ai/classifier');
const { generateReply, generateCancelReply, generateCatalogReply } = require('../../../ai/responder');
const { sendMessage, sendWithDelay, sendListMessage, sendImageWithCaption, sendQuickReplyOptions } = require('../../sender');
const { logReply } = require('../logger');
const { listIntroFirst, listIntroSearch, listIntroPurchase, noMatch } = require('../../../ai/human-phrases');
const { upsertSession, appendMessage, clearSession, appendConversationExchange } = require('../../../sessions/manager');
const { handlePurchase } = require('./purchase');
const { sendReceiptForReference } = require('../../../payments/receipt-data');
const { handleNegotiateIntent } = require('./negotiation');
const { COLORS } = require('../logger');

async function handleBuyerIntent(ctx, intent, lastItemAsMatch) {
  const { sock, buyerJid, vendor, session, inventory, history, text } = ctx;
  const lowerText = (text || '').toLowerCase();

  // Explicit receipt request: any message that mentions "receipt".
  const trimmed = (text || '').trim();
  if (/\breceipts?\b/i.test(trimmed)) {
    const res = await query(
      `SELECT mono_ref, receipt_number
       FROM transactions
       WHERE buyer_jid = $1
         AND vendor_id = $2
         AND status = 'paid'
         AND created_at >= NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [buyerJid, vendor.id]
    );
    const row = res.rows && res.rows[0];
    if (!row) {
      await sendWithDelay(sock, buyerJid, 'I could not find any recent paid order for this chat. If you just paid and nothing is showing, ask the seller to confirm the reference so we can check.');
      logReply('No recent paid order for receipt');
      return;
    }
    await sendWithDelay(sock, buyerJid, "Here's the receipt for your most recent order 👇");
    await sendReceiptForReference(sock, row.mono_ref, row.receipt_number || null);
    logReply('[Receipt re-sent]');
    return;
  }

  // First-time greeting: if they just say "hi/hello" and we have stock, show a friendly list.
  if ((!session.intent_state || session.intent_state === 'idle') &&
      inventory && inventory.length > 0 &&
      /^(hi|hello|hey)\b/i.test(text || '')) {
    const name = vendor.business_name || 'this store';
    const intro =
      `Hi, this is *${name}* 👋\n` +
      `You can tap something below to browse, or just tell me what you're looking for.`;
    const list = inventory.slice(0, 10);
    await sendListMessage(sock, buyerJid, intro, 'See items', list);
    await sendQuickReplyOptions(sock, buyerJid);
    logReply('[Greeting list]');
    await appendMessage(buyerJid, vendor.id, 'bot', '[Greeting list]');
    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'selecting_item',
      last_item_name: null,
      last_item_sku: null,
      list_skus: list.map(i => i.sku).join(',')
    });
    return;
  }

  // If they talk about delivery/pickup and we have a last item, keep context instead of "no match".
  const hasDeliveryWords = /(delivery|deliver|pickup|pick up|drop off|drop at|send to|ship to)/i.test(text || '');
  const hasContextItem = !!session.last_item_name || !!session.last_item_sku || !!lastItemAsMatch;
  if (hasDeliveryWords && hasContextItem && (session.intent_state === 'querying' || session.intent_state === 'negotiating' || session.intent_state === 'selecting_item' || session.intent_state === 'awaiting_payment')) {
    const item =
      inventory.find(i => i.name === session.last_item_name)
      || inventory.find(i => i.sku === session.last_item_sku)
      || lastItemAsMatch
      || null;
    if (item) {
      let reusePrice = null;
      if (session.last_item_price != null && session.last_item_name === item.name && session.last_item_price_quoted_at) {
        const t = new Date(session.last_item_price_quoted_at).getTime();
        if (!Number.isNaN(t) && Date.now() - t <= 5 * 60 * 1000) {
          reusePrice = session.last_item_price;
        }
      }
      const confirm = `Got it — *${item.name}* with ${text.trim()}.\nI'll pass that delivery option to the vendor for this order.`;
      await sendWithDelay(sock, buyerJid, confirm);
      logReply(confirm);
      await appendMessage(buyerJid, vendor.id, 'bot', confirm);
      await handlePurchase(sock, buyerJid, vendor, session, item, reusePrice);
      return;
    }
  }

  if (intent === 'QUERY') {
    let matches = await matchProducts(text, inventory);
    if (matches.length === 0 && lastItemAsMatch) matches = [lastItemAsMatch];

    if (matches.length === 1) {
      const item = matches[0];
      const reply = await generateReply(text, inventory, vendor, history, session);
      const caption = item.description ? `${reply}\n\n${item.description}` : reply;
      if (item.image_url) {
        await sendImageWithCaption(sock, buyerJid, item.image_url, caption);
      } else {
        await sendWithDelay(sock, buyerJid, reply);
      }
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await appendConversationExchange(buyerJid, vendor.id, text, reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'querying',
        last_item_name: item.name,
        last_item_sku: item.sku,
        last_item_price: item.price,
        last_item_price_quoted_at: new Date().toISOString()
      });
      await sendQuickReplyOptions(sock, buyerJid);
    } else if (matches.length > 1) {
      const firstQuery = !session.intent_state || session.intent_state === 'idle';
      const explicitListAsk = /what\s+(other|else|do\s+you\s+have)|options?|list\s+(all|everything)|show\s+me/i.test(text);

      // Only show a new list on the first broad query, or when they explicitly ask for options.
      if (!firstQuery && !explicitListAsk) {
        const item = matches[0];
        const reply = await generateReply(text, inventory, vendor, history, {
          ...session,
          last_item_name: item.name,
          last_item_price: item.price
        });
        const caption = item.description ? `${reply}\n\n${item.description}` : reply;
        if (item.image_url) {
          await sendImageWithCaption(sock, buyerJid, item.image_url, caption);
        } else {
          await sendWithDelay(sock, buyerJid, reply);
        }
        logReply(reply);
        await appendMessage(buyerJid, vendor.id, 'bot', reply);
        await appendConversationExchange(buyerJid, vendor.id, text, reply);
        await upsertSession(buyerJid, vendor.id, {
          intent_state: 'querying',
          last_item_name: item.name,
          last_item_sku: item.sku,
          last_item_price: item.price,
          last_item_price_quoted_at: new Date().toISOString()
        });
        await sendQuickReplyOptions(sock, buyerJid);
      } else {
        const isSearchLike = /looking for|do you have|any (one|of)|i('m| am) looking|i need (a|an|some)|get me|find me|you get|wetin you get/i.test(text || '');
        const intro = isSearchLike ? listIntroSearch() : listIntroFirst();
        await sendListMessage(sock, buyerJid, intro, 'Choose option', matches);
        await sendQuickReplyOptions(sock, buyerJid);
        logReply('[List]');
        await appendMessage(buyerJid, vendor.id, 'bot', '[List]');
        await upsertSession(buyerJid, vendor.id, {
          intent_state: 'selecting_item',
          last_item_name: null,
          last_item_sku: null,
          list_skus: matches.map(m => m.sku).join(',')
        });
      }
    } else {
      // "What else do you have (in stock)" and other broad catalog asks should show a list, not "don't have that one".
      const catalogAsk = /what\s+(?:else\s+)?(?:do\s+you\s+)?have|what'?s?\s+in\s+stock|show\s+me\s+(what\s+you\s+have|your\s+stuff|everything)|list\s+(everything|all)|what\s+do\s+you\s+sell|your\s+products|anything\s+available|do\s+you\s+have\s+anything/i.test(text);
      const hasExplicitCommerceWords = /(price|how much|buy|order|delivery|deliver|send to|in stock|available|do you have|you have|i need|i want|cart|pay|payment|link\b)/i.test(text || '');

      // If there are no matches and they didn't actually ask a clear commerce question,
      // stay silent instead of sending a generic "no match".
      if (!catalogAsk && !hasExplicitCommerceWords) {
        return;
      }

      const reply = catalogAsk
        ? await generateCatalogReply(text, inventory, vendor, history)
        : noMatch();
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await appendConversationExchange(buyerJid, vendor.id, text, reply);
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
    // Meta chat about WhatsApp tagging/flagging numbers etc. — don't over-explain, just stay quiet.
    const metaNumberSafety = /(they\s+can\s+tag\s+it|avoid\s+that|whatsapp\s+(may|might)\s+tag|tag\s+my\s+number|flag\s+my\s+number)/i.test(text || '');
    if (metaNumberSafety) return;
    const matches = await matchProducts(text, inventory);
    let item = matches.length === 1 ? matches[0] : null;
    if (!item && session.last_item_name) {
      item = inventory.find(i => i.name === session.last_item_name);
    }
    if (item) {
      const hasContextItem = !!item || !!session.last_item_name || !!session.last_item_sku;
      const explicitPaymentWords = /\b(pay(ment)?|send( me)? (the )?(payment )?link|payment link|checkout|check out|pay now|i('m| am)? ready to pay|i (wan|want to) pay|make i pay|let me pay|i go pay|i don pay|i have paid|i paid|proceed to payment)\b/i.test(lowerText);
      const strongPurchaseWords = /\bi('ll| will)?\s*(take|get|collect|buy)\b|\bi want (it|this|that|one)\b|\bbook it for me\b|\breserve it\b/i.test(lowerText);

      // Only trigger payment link when the conversation clearly shows intent to actually buy/pay,
      // not just vague replies like "ok" or normal chat.
      if (!hasContextItem || (!explicitPaymentWords && !strongPurchaseWords)) {
        const reply = await generateReply(text, inventory, vendor, history, session);
        await sendWithDelay(sock, buyerJid, reply);
        logReply(reply);
        await appendMessage(buyerJid, vendor.id, 'bot', reply);
        await appendConversationExchange(buyerJid, vendor.id, text, reply);
        return;
      }
      let reusePrice = null;
      if (session.last_item_price != null && session.last_item_name === item.name && session.last_item_price_quoted_at) {
        const t = new Date(session.last_item_price_quoted_at).getTime();
        if (!Number.isNaN(t) && Date.now() - t <= 5 * 60 * 1000) {
          reusePrice = session.last_item_price;
        }
      }
      await handlePurchase(sock, buyerJid, vendor, session, item, reusePrice);
      return;
    }
    if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, listIntroPurchase(), 'Choose item', matches);
      await sendQuickReplyOptions(sock, buyerJid);
      logReply('[List]');
      await upsertSession(buyerJid, vendor.id, { intent_state: 'selecting_item', list_skus: matches.map(m => m.sku).join(',') });
      return;
    }
    // Vague "another thing/item" purchase intent: ask them to name what they want instead of saying "no match".
    const vagueNewItem = /\bi\s*(need|want|get)\s*(another|something\s*else|a\s*different)\s*(thing|item|one)?\b/i.test(text);
    if (vagueNewItem) {
      const reply = `No wahala, you want something else.\n\nTell me what you're looking for — e.g. "iPhone 12", "black sneakers size 43", or the product name.`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', list_skus: null });
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
    // Only send a cancel reply when the text clearly means "I'm not buying anymore".
    const explicitCancel =
      /(forget it|leave it|no thanks|not now|maybe later|next time|changed my mind|cancel( the order)?|i no dey buy again|i'm not buying|i am not buying)/i.test(text || '');
    await clearSession(buyerJid, vendor.id);
    if (!explicitCancel) {
      // Treat meta lines like "I don't want to forget" as non-commerce: clear state but stay silent.
      return;
    }
    const reply = await generateCancelReply(text, inventory, vendor.business_name);
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    await appendConversationExchange(buyerJid, vendor.id, text, reply);
    return;
  }

  // For OTHER/IGNORE (normal chit-chat / non-commerce), do not reply at all.
  if (intent === 'IGNORE' || intent === 'OTHER') {
    return;
  }
}

module.exports = { handleBuyerIntent };
