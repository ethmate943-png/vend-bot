/** Negotiating state (haggle replies) and NEGOTIATE intent entry */

const { sendMessage, sendWithDelay } = require('../../sender');
const { logReply } = require('../logger');
const { parseHaggle, floorAboveMin } = require('../utils');
const { extractOffer } = require('../../../ai/classifier');
const { upsertSession } = require('../../../sessions/manager');
const { handlePurchase } = require('./purchase');

async function handleNegotiationReply(ctx) {
  const { sock, buyerJid, vendor, session, inventory, history, text } = ctx;
  if (session.intent_state !== 'negotiating' || !session.last_item_name) return false;

  const item = inventory.find(i => i.name === session.last_item_name);
  if (!item) return false;

  const haggleData = parseHaggle(session.pending_payment_ref);
  const round = haggleData.round;
  const lastCounter = haggleData.counter || item.price;
  const lower = text.toLowerCase().trim();

  const buySignals = ['yes', 'ok', 'okay', 'deal', 'sure', 'fine', 'accept', 'i agree',
    'send', 'link', 'pay', 'buy', 'take it', 'i want', 'go ahead', 'proceed', 'nau', 'now', 'abeg'];
  if (buySignals.some(w => lower.includes(w))) {
    const acceptPrice = floorAboveMin(lastCounter, item.minPrice);
    const acceptLines = [
      `Okay you've twisted my arm 😩 *₦${acceptPrice.toLocaleString()}* for *${item.name}*. You won this one!`,
      `Alright alright, *₦${acceptPrice.toLocaleString()}*. But just for you o! 😅`,
      `Fine! *₦${acceptPrice.toLocaleString()}* — you're a tough negotiator! 😄`,
    ];
    const reply = acceptLines[round % acceptLines.length];
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await handlePurchase(sock, buyerJid, vendor, session, item, acceptPrice);
    return true;
  }

  const offer = await extractOffer(text);
  if (offer <= 0) {
    const reply = round < 2
      ? `Come on, give me a number! What can you do for *${item.name}*? 💬`
      : `My guy, just tell me your price. I'm listening 👂`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    return true;
  }
  if (offer >= lastCounter) {
    const reply = `Oya pay! *₦${lastCounter.toLocaleString()}* for *${item.name}* 💪`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await handlePurchase(sock, buyerJid, vendor, session, item, lastCounter);
    return true;
  }
  if (round === 1) {
    const midPoint = Math.round((lastCounter + Math.max(offer, item.minPrice)) / 2);
    const newCounter = floorAboveMin(midPoint, item.minPrice);
    const lines = [
      `Ah ₦${offer.toLocaleString()}? You want to wound me 😂\n\nOkay let me try... *₦${newCounter.toLocaleString()}*. That's my guy price.`,
      `Haba! ₦${offer.toLocaleString()} is too low o 😅\n\nI'll do *₦${newCounter.toLocaleString()}* for you — special price.`,
      `₦${offer.toLocaleString()}? E be like say you no want make I chop 😄\n\nLast price: *₦${newCounter.toLocaleString()}*`,
    ];
    const reply = lines[Math.floor(Math.random() * lines.length)];
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'negotiating',
      pending_payment_ref: `haggle:2:${newCounter}`,
      last_item_name: item.name,
      last_item_sku: item.sku
    });
    return true;
  }
  if (round >= 2) {
    if (offer >= item.minPrice) {
      const finalPrice = floorAboveMin(offer, item.minPrice);
      const lines = [
        `You've really pressed me o 😩 Fine, *₦${finalPrice.toLocaleString()}*. I'm doing this at a loss!`,
        `Okay okay, *₦${finalPrice.toLocaleString()}* FINAL. You sha know how to price 😂`,
        `My oga go finish me 😅 But okay, *₦${finalPrice.toLocaleString()}*. Deal!`,
      ];
      const reply = lines[Math.floor(Math.random() * lines.length)];
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await handlePurchase(sock, buyerJid, vendor, session, item, finalPrice);
      return true;
    }
    const firmPrice = floorAboveMin(item.minPrice, item.minPrice);
    const reply = `Ah my friend, ₦${offer.toLocaleString()} no go work at all 😔\n\n*₦${firmPrice.toLocaleString()}* is genuinely the lowest I can go for *${item.name}*. I swear, no profit inside this one.\n\nDeal? 🤝`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'negotiating',
      pending_payment_ref: `haggle:${round + 1}:${firmPrice}`,
      last_item_name: item.name,
      last_item_sku: item.sku
    });
    return true;
  }
  return true;
}

/** Handle NEGOTIATE intent (start or escalate negotiation) */
async function handleNegotiateIntent(ctx) {
  const { sock, buyerJid, vendor, session, inventory, text } = ctx;
  const matches = await require('../../../ai/classifier').matchProducts(text, inventory);
  const item = matches[0] || (session.last_item_name && inventory.find(i => i.name === session.last_item_name));

  if (vendor.negotiation_policy === 'escalate') {
    const reply = "Let me check with the vendor on that, give me a moment! 🙏";
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
      `💬 *Buyer wants to negotiate*\n\nItem: ${item?.name || session.last_item_name || 'unknown'}\nBuyer message: "${text}"\n\nReply to this to take over the chat.`
    );
    return;
  }
  if (vendor.negotiation_policy === 'fixed') {
    const priceText = item ? `₦${item.price.toLocaleString()}` : 'the listed price';
    const reply = `The price is fixed at ${priceText}. Ready to pay? 😊`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    return;
  }
  if (vendor.negotiation_policy === 'auto') {
    if (!item) {
      const reply = "Which item are you looking to negotiate on? Drop the name 💬";
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      return;
    }
    if (item.minPrice >= item.price) {
      const reply = `Ah, *₦${item.price.toLocaleString()}* is already the best price for *${item.name}* o! No room to move on this one 😅 Ready to pay?`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      return;
    }
    const offer = await extractOffer(text);
    const firstCounter = floorAboveMin(
      Math.round(item.minPrice + (item.price - item.minPrice) * 0.4),
      item.minPrice
    );
    if (offer <= 0) {
      const reply = `Haha you want to price *${item.name}*? 😄\n\nThe price is ₦${item.price.toLocaleString()} but... I fit do *₦${firstCounter.toLocaleString()}* for you. What do you say?`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'negotiating',
        pending_payment_ref: `haggle:1:${firstCounter}`,
        last_item_name: item.name,
        last_item_sku: item.sku
      });
    } else if (offer >= firstCounter) {
      const fakeCounter = Math.round((offer + item.price) / 2);
      const counter = Math.max(fakeCounter, firstCounter);
      const reply = `₦${offer.toLocaleString()}? Hmm that's close... but I need at least *₦${counter.toLocaleString()}* for *${item.name}* 🤔\n\nCan you come up a little?`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'negotiating',
        pending_payment_ref: `haggle:1:${counter}`,
        last_item_name: item.name,
        last_item_sku: item.sku
      });
    } else {
      const reply = `₦${offer.toLocaleString()} for *${item.name}*? Ah no o! 😂\n\nSee, the quality is top-notch. Best I can do is *₦${firstCounter.toLocaleString()}*. Your turn 💬`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'negotiating',
        pending_payment_ref: `haggle:1:${firstCounter}`,
        last_item_name: item.name,
        last_item_sku: item.sku
      });
    }
  }
}

module.exports = { handleNegotiationReply, handleNegotiateIntent };
