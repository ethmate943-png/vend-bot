const { classifyIntent, extractOffer, matchProducts } = require('../ai/classifier');
const { generateReply } = require('../ai/responder');
const { getInventory } = require('../inventory/sheets');
const { getVendorByBotNumber } = require('../vendors/resolver');
const { getSession, upsertSession, getChatHistory, appendMessage } = require('../sessions/manager');
const { generatePaymentLink } = require('../payments/mono');
const { sendMessage, sendWithDelay, sendButtons, sendListMessage } = require('./sender');
const { handleDeliveryReply } = require('../payments/webhook');
const { checkVelocity } = require('../safety/velocity');

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

function logMessage(vendor, buyerJid, text, intent) {
  const phone = buyerJid.replace('@s.whatsapp.net', '');
  const time = new Date().toLocaleTimeString();
  console.log(`\n${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.green}📩 INCOMING MESSAGE${COLORS.reset}  ${COLORS.dim}${time}${COLORS.reset}`);
  console.log(`${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`  ${COLORS.bright}Vendor:${COLORS.reset}  ${vendor}`);
  console.log(`  ${COLORS.bright}Buyer:${COLORS.reset}   ${phone}`);
  console.log(`  ${COLORS.bright}Message:${COLORS.reset} ${COLORS.yellow}"${text}"${COLORS.reset}`);
  console.log(`  ${COLORS.bright}Intent:${COLORS.reset}  ${COLORS.magenta}${intent}${COLORS.reset}`);
  console.log(`${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
}

function logReply(text) {
  console.log(`  ${COLORS.bright}${COLORS.blue}💬 REPLY:${COLORS.reset} ${text.replace(/\n/g, '\n          ')}`);
  console.log('');
}

function parseHaggle(ref) {
  if (!ref || !ref.startsWith('haggle:')) return { round: 0, counter: 0 };
  const parts = ref.split(':');
  return { round: parseInt(parts[1], 10) || 0, counter: parseInt(parts[2], 10) || 0 };
}

function floorAboveMin(price, minPrice) {
  const buffer = Math.max(Math.round(minPrice * 0.05), 500);
  return Math.max(price, minPrice + buffer);
}

async function handlePurchase(sock, buyerJid, vendor, session, item, negotiatedPrice) {
  const velocity = await checkVelocity(vendor.id);
  if (velocity.blocked) {
    await sendWithDelay(sock, buyerJid, 'This vendor is temporarily unavailable. Please try again later.');
    return;
  }

  const finalPrice = negotiatedPrice || item.price;
  const isDiscounted = negotiatedPrice && negotiatedPrice < item.price;

  try {
    const { link, reference } = await generatePaymentLink({
      amount: finalPrice,
      itemName: item.name,
      itemSku: item.sku,
      buyerJid,
      vendorId: vendor.id,
      vendorPhone: vendor.whatsapp_number
    });

    const discountLine = isDiscounted
      ? `~₦${item.price.toLocaleString()}~ → *₦${finalPrice.toLocaleString()}* 🎉\n`
      : `Price: *₦${finalPrice.toLocaleString()}*\n`;

    const payMsg = `🛒 *Order Summary*\n\n` +
      `Item: *${item.name}*\n` +
      discountLine +
      `SKU: ${item.sku}\n\n` +
      `🔗 Pay here: ${link}\n\n` +
      `_Pay via card, bank transfer, or USSD.\nLink expires in 30 minutes._`;

    await sendWithDelay(sock, buyerJid, payMsg);
    logReply(payMsg);

    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'awaiting_payment',
      pending_payment_ref: reference,
      last_item_sku: item.sku,
      last_item_name: item.name
    });
  } catch (err) {
    console.error('[PAYMENT ERROR]', err.response?.data || err.message);
    await sendWithDelay(sock, buyerJid, 'Sorry, we couldn\'t generate a payment link right now. Please try again in a moment.');
  }
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const buyerJid = msg.key.remoteJid;
  if (!buyerJid) return;
  // Only respond to direct 1-on-1 messages
  if (!buyerJid.endsWith('@s.whatsapp.net') && !buyerJid.endsWith('@lid')) return;

  // Normal text or list/button response (native interactive)
  let text = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ''
  ).trim();
  const listReply = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;
  const buttonReply = msg.message.buttonsResponseMessage?.selectedButtonId;
  if (listReply) text = listReply;
  else if (buttonReply) text = buttonReply;
  if (!text) return;

  const botNumber = sock.user.id.split(':')[0];
  const vendor = await getVendorByBotNumber(botNumber);
  if (!vendor || vendor.status === 'banned' || vendor.status === 'suspended') return;

  const session = await getSession(buyerJid, vendor.id) || {};
  const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
  const history = getChatHistory(session);

  await appendMessage(buyerJid, vendor.id, 'buyer', text);

  if (session.intent_state === 'awaiting_delivery_confirm') {
    await handleDeliveryReply(buyerJid, vendor.id, text);
    return;
  }

  // Handle active negotiation replies
  if (session.intent_state === 'negotiating' && session.last_item_name) {
    const item = inventory.find(i => i.name === session.last_item_name);
    if (item) {
      const haggleData = parseHaggle(session.pending_payment_ref);
      const round = haggleData.round;
      const lastCounter = haggleData.counter || item.price;
      const lower = text.toLowerCase().trim();

      // Buyer accepts OR wants to just pay
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
        return;
      }

      const offer = await extractOffer(text);

      if (offer <= 0) {
        const reply = round < 2
          ? `Come on, give me a number! What can you do for *${item.name}*? 💬`
          : `My guy, just tell me your price. I'm listening 👂`;
        await sendWithDelay(sock, buyerJid, reply);
        logReply(reply);
        return;
      }

      if (offer >= lastCounter) {
        const reply = `Oya pay! *₦${lastCounter.toLocaleString()}* for *${item.name}* 💪`;
        await sendWithDelay(sock, buyerJid, reply);
        logReply(reply);
        await handlePurchase(sock, buyerJid, vendor, session, item, lastCounter);
        return;
      }

      if (round === 1) {
        // Round 2: come down a little but stay above min
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
        return;
      }

      if (round >= 2) {
        if (offer >= item.minPrice) {
          // They're above min — "reluctantly" accept but keep it above min
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
          return;
        } else {
          // Below min — hold firm above min
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
          return;
        }
      }
    }
  }

  // Handle selection: number, list row id (sku), or product name match
  if (session.intent_state === 'selecting_item') {
    const bySku = inventory.find((i) => i.sku === text.trim());
    if (bySku) {
      await handlePurchase(sock, buyerJid, vendor, session, bySku);
      return;
    }
    const num = parseInt(text.trim(), 10);
    if (num >= 1 && num <= inventory.length) {
      const item = inventory[num - 1];
      await handlePurchase(sock, buyerJid, vendor, session, item);
      return;
    }
    const matches = await matchProducts(text, inventory);
    if (matches.length === 1) {
      await handlePurchase(sock, buyerJid, vendor, session, matches[0]);
      return;
    }
    await sendWithDelay(sock, buyerJid, `Please reply with a number (1-${inventory.length}) or tap the list to select an item.`);
    return;
  }

  const intent = await classifyIntent(text, session, history);
  logMessage(vendor.business_name, buyerJid, text, intent);

  // ── QUERY ──
  if (intent === 'QUERY') {
    const matches = await matchProducts(text, inventory);

    if (matches.length === 1) {
      const item = matches[0];
      const reply = await generateReply(text, inventory, vendor.business_name, history);
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'querying',
        last_item_name: item.name,
        last_item_sku: item.sku
      });
    } else if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, 'I found a few options for you. Tap to pick one:', 'Choose option', matches);
      logReply(' [List] I found a few options for you.');
      await appendMessage(buyerJid, vendor.id, 'bot', '[List] I found a few options for you.');
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'selecting_item',
        last_item_name: null,
        last_item_sku: null
      });
    } else {
      const reply = await generateReply(text, inventory, vendor.business_name, history);
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'querying',
        last_item_name: session.last_item_name || null,
        last_item_sku: session.last_item_sku || null
      });
    }
  }

  // ── PURCHASE / CONFIRM ──
  else if (intent === 'PURCHASE' || intent === 'CONFIRM') {
    // 1) Use AI to match what the buyer wants
    const matches = await matchProducts(text, inventory);
    let item = matches.length === 1 ? matches[0] : null;

    // 2) If no AI match, use the item from the last query
    if (!item && session.last_item_name) {
      item = inventory.find(i => i.name === session.last_item_name);
    }

    // 3) If we have exactly one item, go to payment
    if (item) {
      await handlePurchase(sock, buyerJid, vendor, session, item);
      return;
    }

    // 4) Multiple matches — native list (tap to select)
    if (matches.length > 1) {
      await sendListMessage(sock, buyerJid, 'Which one would you like to buy?', 'Choose item', matches);
      logReply(' [List] Which one would you like to buy?');
      await upsertSession(buyerJid, vendor.id, { intent_state: 'selecting_item' });
      return;
    }

    // 5) No match at all — show full catalog as native list
    await sendListMessage(sock, buyerJid, 'Which item would you like to buy?', 'Choose item', inventory);
    logReply(' [List] Which item would you like to buy?');
    await upsertSession(buyerJid, vendor.id, { intent_state: 'selecting_item' });
  }

  // ── NEGOTIATE ──
  else if (intent === 'NEGOTIATE') {
    const matches = await matchProducts(text, inventory);
    const item = matches[0]
      || (session.last_item_name && inventory.find(i => i.name === session.last_item_name));

    if (vendor.negotiation_policy === 'escalate') {
      const reply = "Let me check with the vendor on that, give me a moment! 🙏";
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `💬 *Buyer wants to negotiate*\n\nItem: ${item?.name || session.last_item_name || 'unknown'}\nBuyer message: "${text}"\n\nReply to this to take over the chat.`
      );
    } else if (vendor.negotiation_policy === 'fixed') {
      const priceText = item ? `₦${item.price.toLocaleString()}` : 'the listed price';
      const reply = `The price is fixed at ${priceText}. Ready to pay? 😊`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
    } else if (vendor.negotiation_policy === 'auto') {
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
      // First counter: 40% of the gap above min, guaranteed above min
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
        // Good offer but don't accept round 1 — push back slightly
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

  // ── CANCEL ──
  else if (intent === 'CANCEL') {
    const reply = "No problem at all! Feel free to message anytime you're ready. 👋";
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', last_item_name: null, last_item_sku: null });
  }

  // ── IGNORE — normal personal chat, stay silent ──
  else if (intent === 'IGNORE') {
    console.log(`  ${COLORS.dim}[SKIP] Not commerce-related, staying silent${COLORS.reset}\n`);
  }

  // ── OTHER — might be commerce, nudge gently ──
  else if (intent === 'OTHER') {
    const hasCommerceHistory = history.some(m => m.role === 'bot');
    if (hasCommerceHistory) {
      const reply = `Need help with anything from our store? Just ask what's available! 😊`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
    } else {
      console.log(`  ${COLORS.dim}[SKIP] No commerce context, staying silent${COLORS.reset}\n`);
    }
  }
}

module.exports = { handleMessage };
