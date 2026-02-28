/** Main message router: extract text, resolve vendor, delegate to handlers */

const { getSession, getChatHistory, appendMessage, clearSession, getConversationHistory, appendConversationExchange, setSessionRole, appendHistory, upsertSession, getAnyActiveBuyerSession } = require('../../sessions/manager');
const { getVendorByBotNumber, getVendorByStoreCode, getVendorById } = require('../../vendors/resolver');
const { handleLandingPageEntry } = require('../../vendors/onboarding');
const { resolveIdentity, setOnboardingSession } = require('../../identity/resolver');
const { getBuyerDisplayNameFromMessage, extractNameFromMessage, buildGreeting } = require('../../identity/buyer');
const { getInventory } = require('../../inventory/manager');
const { sendWithDelay } = require('../sender');
const { logReply, logMessage, logSessionContext } = require('./logger');
const { classifyIntent } = require('../../ai/classifier');
const { shouldRespond } = require('../../ai/gatekeeper');
const { handleAdminCommand } = require('./handlers/admin');
const { handleVendorMessage } = require('./handlers/vendor');
const { handlePurchase } = require('./handlers/purchase');
const { handleNegotiationReply } = require('./handlers/negotiation');
const { handleSelectingItem } = require('./handlers/selecting-item');
const { handleCartMessage } = require('./handlers/cart');
const { handleBuyerIntent } = require('./handlers/buyer-intent');
const { generateCancelReply } = require('../../ai/responder');
const { handleDeliveryReply, handlePaymentSuccess } = require('../../payments/webhook');
const { sendReceiptForReference } = require('../../payments/receipt-data');
const { verifyTransaction } = require('../../payments/paystack');
const { query } = require('../../db');
const { isDuplicate } = require('../dedup');
const { getBuyerQueue } = require('../queue');
const { isRateLimited } = require('../../safety/ratelimit');

/** Deep-search for list/button selection id anywhere in the object (Baileys/Cloud API vary). */
function findSelectionId(o, depth = 0) {
  if (depth > 12 || !o || typeof o !== 'object') return null;
  const v1 = o.selectedRowId || o.selectedButtonId || o.selectedId;
  if (typeof v1 === 'string' && v1.trim().length > 0 && v1.length < 300) return v1.trim();
  if (typeof o.id === 'string' && o.id.trim().length > 0 && o.id.length <= 120) return o.id.trim();
  for (const k of Object.keys(o)) {
    if (k === 'title' || k === 'description' || k === 'key') continue;
    if (typeof o[k] === 'object' && o[k] !== null) {
      const found = findSelectionId(o[k], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractText(msg) {
  let text = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  ).trim();
  const ir = msg.message?.interactiveResponseMessage;
  let listReply =
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ir?.listReply?.singleSelectReply?.selectedRowId ||
    ir?.listReply?.id ||
    ir?.listReply?.selectedRowId ||
    ir?.list_reply?.id ||
    ir?.list_reply?.selectedRowId ||
    msg.message?.templateButtonReplyMessage?.selectedId;
  if (!listReply && ir && typeof ir === 'object') {
    const sub = ir.listReply || ir.list_reply || ir.singleSelectReply;
    listReply = sub && (sub.id || sub.selectedRowId) ? (sub.id || sub.selectedRowId) : null;
  }
  if (!listReply && msg.message && typeof msg.message === 'object') {
    listReply = findSelectionId(msg.message);
    if (!listReply && msg.message.viewOnceMessageV2?.message) listReply = findSelectionId(msg.message.viewOnceMessageV2.message);
    if (!listReply && msg.message.viewOnceMessage?.message) listReply = findSelectionId(msg.message.viewOnceMessage.message);
  }
  if (!listReply && msg && typeof msg === 'object') {
    listReply = findSelectionId(msg);
  }
  const buttonReply = msg.message?.buttonsResponseMessage?.selectedButtonId || (listReply ? null : findSelectionId(msg.message || msg));
  if (listReply) {
    text = String(listReply).trim();
    console.log('[LIST] Selected row id:', text);
  } else if (buttonReply) text = String(buttonReply).trim();

  return text || '';
}

async function handleAmbiguousVendor(sock, jid, text, vendor) {
  const trimmed = (text || '').trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const isVendorSetup = upper.startsWith('VENDOR-SETUP');

  // For explicit vendor setup flows, never reuse a previous buyer session.
  if (!isVendorSetup) {
    const active = await getAnyActiveBuyerSession(jid);
    if (active && active.vendor_id && active.vendor_id === vendor.id) {
      const sessionRow = await getSession(jid, vendor.id) || {};
      const session = { ...sessionRow, conversation_history: getConversationHistory(sessionRow) };
      const inventory = await getInventory(vendor);
      const history = getChatHistory(session);
      const ctx = { sock, buyerJid: jid, vendor, session, inventory, history, text };
      if (await handleCartMessage(ctx)) return;
      if (await handleNegotiationReply(ctx)) return;
      if (await handleSelectingItem(ctx)) return;
      const intent = await classifyIntent(text, {}, [], vendor);
      logMessage(vendor.business_name, jid, text, intent);
      const trimmed = text.trim();
      const vagueRef = /^(it|that\s*one?|this\s*one|the\s*(bag|one|item|first\s*one|sneakers|pair)|how\s*much|price|cost|amount|how\s*much\s*again|price\s*\?|send\s*link|pls|please)\s*[?.!]*$/i.test(trimmed)
        || (trimmed.length <= 20 && /^(that|this|the\s*one|again)\s*[?.!]*$/i.test(trimmed));
      const lastItemAsMatch = vagueRef && session.last_item_name
        ? inventory.find(i => i.name === session.last_item_name)
        : null;
      await handleBuyerIntent(ctx, intent, lastItemAsMatch);
      return;
    }
  }

  // Interpret direct replies to the prompt so we don't keep looping.
  const pickedManage =
    lower === '1' ||
    /^manage\b/.test(lower) ||
    /\bmy store\b/.test(lower) ||
    /\bvendor\b/.test(lower);
  const pickedShop =
    lower === '2' ||
    /\bshop\b/.test(lower) ||
    /\bbuy\b/.test(lower);

  if (pickedManage && vendor && vendor.id) {
    await setSessionRole(jid, vendor.id, 'vendor');
    await sendWithDelay(sock, jid,
      `Got it — I'll treat this chat as *store management*.\n\n` +
      `You can reply *HELP* to see all vendor commands, or send inventory updates like *add: name, price, qty*.`
    );
    logReply('[Ambiguous vendor — chose manage store]');
    return;
  }

  if (pickedShop && vendor && vendor.id) {
    await setSessionRole(jid, vendor.id, 'buyer');
    await sendWithDelay(sock, jid,
      `No wahala — I'll help you *shop* from this store.\n\n` +
      `Tell me what you're looking for (e.g. "black sneakers 42", "air fryer", "rice and stew").`
    );
    logReply('[Ambiguous vendor — chose shop]');
    return;
  }

  const name = vendor.business_name || 'there';
  await sendWithDelay(sock, jid,
    `Hi ${name} 👋\n\nAre you managing your store or shopping?\n\n` +
    `*1* — Manage my store\n` +
    `*2* — Shop from another store\n\n` +
    `Or just send a store code to start shopping.`
  );
  logReply('[Ambiguous vendor — asked store vs shop]');
}

async function handleUnknown(sock, jid, text, vendor) {
  const code = (vendor.store_code || '').toUpperCase().trim();
  const storeLabel = vendor.business_name || 'this store';
  const line = code
    ? `Send *${code}* to see our catalogue, or tell me what you're looking for.`
    : `Welcome to *${storeLabel}*. What are you looking for?`;
  await sendWithDelay(sock, jid, `Hi! ${line}`);
  logReply('[Unknown — invited to send store code or query]');
}

async function handleMessage(sock, msg) {
  if (!msg.message) return;
  const buyerJid = msg.key.remoteJid;
  if (!buyerJid || buyerJid.endsWith('@g.us')) return;
  if (!buyerJid.endsWith('@s.whatsapp.net') && !buyerJid.endsWith('@lid')) return;

  const messageId = msg.key.id;
  if (messageId && isDuplicate(messageId)) {
    console.log('[LISTENER] Duplicate message', messageId, '— skipping');
    return;
  }
  if (isRateLimited(buyerJid)) {
    console.log('[LISTENER] Rate limited', buyerJid);
    return;
  }

  const queue = getBuyerQueue(buyerJid);
  await queue.add(async () => {
    await handleBuyerMessage(sock, msg, buyerJid);
  });
}

async function handleBuyerMessage(sock, msg, buyerJid) {
  // Cloud API has no sock.user; use VENDBOT_NUMBER (display phone of the Cloud API number)
  const botNum = (sock.user?.id || process.env.VENDBOT_NUMBER || '').split(':')[0].replace(/\D/g, '');
  let text = extractText(msg);

  const adminPhone = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
  if (adminPhone && buyerJid === adminPhone + '@s.whatsapp.net' && (text || '').trim()) {
    await handleAdminCommand(sock, (text || '').trim(), buyerJid);
    return;
  }

  // Landing-page onboarding token: MOOV-[TOKEN] has highest priority.
  const trimmedTextForToken = (text || '').trim();
  const upperForToken = trimmedTextForToken.toUpperCase();
  if (upperForToken.startsWith('MOOV-')) {
    await handleLandingPageEntry(sock, buyerJid, trimmedTextForToken);
    return;
  }

  const storeVendor = await getVendorByBotNumber(botNum);
  if (!storeVendor || storeVendor.status === 'banned' || storeVendor.status === 'suspended') return;

  // Buyer sent image — use caption as query or redirect
  if (msg.message?.imageMessage) {
    const cap = (msg.message.imageMessage.caption || '').trim();
    if (cap) {
      text = cap;
    } else {
      try { await sock.sendPresenceUpdate('composing', buyerJid); } catch (_) {}
      await sendWithDelay(sock, buyerJid,
        `I can see you sent a photo 😊\n\n` +
        `I can't search by image yet — but tell me what you're looking for and I'll check if we have it.`
      );
      return;
    }
  }

  // Location shared — acknowledge and give delivery info
  if (msg.message?.locationMessage) {
    const coverage = storeVendor.delivery_coverage === 'nationwide'
      ? 'deliver anywhere in Nigeria 🇳🇬'
      : `deliver within ${storeVendor.location || 'our area'}`;
    await sendWithDelay(sock, buyerJid,
      `Thanks for sharing your location!\n\n` +
      `If you're checking if we deliver to you — we ${coverage}.\n\n` +
      `What would you like to order?`
    );
    return;
  }
  // Contact card — can't process
  if (msg.message?.contactMessage) {
    await sendWithDelay(sock, buyerJid,
      `I received a contact but I can only process text messages and orders.\n\n` +
      `What are you looking for?`
    );
    return;
  }

  const hasVendorVoice = (msg.message?.audioMessage || msg.message?.pttMessage);
  if (!text && !hasVendorVoice) return;

  const identity = await resolveIdentity(buyerJid, text, botNum);
  let vendor = identity.storeVendor || storeVendor;
  // Vendor flows: use sender's vendor (so we update the right store); for "VENDOR-SETUP <CODE>" use store by code
  if (identity.context === 'vendor_onboarding' || identity.context === 'vendor_management') {
    const upper = (text || '').trim().toUpperCase();
    if (upper.startsWith('VENDOR-SETUP ')) {
      const after = upper.slice(12).trim();
      const code = (after.split(/\s+/)[0] || '').replace(/[^A-Z0-9-]/g, '');
      if (code.length >= 2) {
        const vByCode = await getVendorByStoreCode(code);
        if (vByCode) vendor = vByCode;
      }
    }
    if (identity.vendor) vendor = identity.vendor;
  }
  const vendorPhone = (vendor.whatsapp_number || '').replace(/\D/g, '');
  const vendorJid = `${vendorPhone}@s.whatsapp.net`;

  switch (identity.context) {
    case 'vendor_onboarding':
    case 'vendor_management':
      const upperText = (text || '').trim().toUpperCase();
      if (identity.context === 'vendor_onboarding' && (upperText === 'VENDOR-SETUP' || upperText.startsWith('VENDOR-SETUP '))) {
        await clearSession(buyerJid, vendor.id);
        setOnboardingSession(buyerJid, vendor);
      }
      // Refetch vendor so onboarding_step is current (important after numeric replies like "6")
      if (identity.context === 'vendor_onboarding' && vendor?.id) {
        const fresh = await getVendorById(vendor.id);
        if (fresh) vendor = fresh;
      }
      await handleVendorMessage(sock, msg, vendor, text || '', buyerJid);
      return;
    case 'vendor_or_buyer':
      await handleAmbiguousVendor(sock, buyerJid, text, vendor);
      return;
    case 'unknown':
      await handleUnknown(sock, buyerJid, text, vendor);
      return;
    default:
      break;
  }

  // Typing indicator immediately — buyer sees activity while we work
  try { await sock.sendPresenceUpdate('composing', buyerJid); } catch (_) {}

  // Parallel DB reads — session + inventory together (cache is invalidated only when stock actually changes)
  const [sessionRow, inventoryEarly] = await Promise.all([
    getSession(buyerJid, vendor.id),
    getInventory(vendor)
  ]);
  const sessionRowResolved = sessionRow || {};
  const lowerCommand = (text || '').trim().toLowerCase();
  if (lowerCommand === 'test:mode vendor' || lowerCommand === 'test:vendor') {
    await setSessionRole(buyerJid, vendor.id, 'vendor');
    await sendWithDelay(sock, buyerJid, 'Test mode: this chat will now be treated as *vendor* messages until you switch back.');
    return;
  }
  if (lowerCommand === 'test:mode buyer' || lowerCommand === 'test:buyer') {
    await setSessionRole(buyerJid, vendor.id, 'buyer');
    await sendWithDelay(sock, buyerJid, 'Test mode: this chat will now be treated as *buyer* messages again.');
    return;
  }

  const trimmedText = (text || '').trim();
  if (/^vendor[\s-]*setup$/i.test(trimmedText)) {
    const storeLabel = vendor.business_name && !/something went wrong on our end/i.test(vendor.business_name)
      ? vendor.business_name
      : 'this store';
    const msgText =
      `Got it — you want to *set up your own store*.\n\n` +
      `This WhatsApp line is the assistant for *${storeLabel}* — it's for their buyers.\n\n` +
      `To set up *your own* VendBot store, use the number that will own the store and reply *VENDOR-SETUP* there.\n\n` +
      `If you're just trying to buy from *${storeLabel}*, tell me what you're looking for.`;
    await sendWithDelay(sock, buyerJid, msgText);
    logReply(msgText);
    await appendMessage(buyerJid, vendor.id, 'bot', msgText);
    return;
  }

  const session = {
    ...sessionRowResolved,
    conversation_history: getConversationHistory(sessionRowResolved)
  };
  // Log high-level session context for debugging (vendor/buyer, role, state, buyer name).
  const vendorLabel = vendor.business_name || vendor.store_code || 'Store';
  logSessionContext(vendorLabel, buyerJid, session);
  const lowerText = text.toLowerCase().trim();

  // Capture buyer name from WhatsApp profile (pushName) or from conversation
  const fromMsg = getBuyerDisplayNameFromMessage(msg);
  if (fromMsg && !session.buyer_name) {
    await upsertSession(buyerJid, vendor.id, { buyer_name: fromMsg.slice(0, 80), buyer_name_source: 'whatsapp_profile' });
    session.buyer_name = fromMsg.slice(0, 80);
  }
  const fromConversation = extractNameFromMessage(text, session.buyer_name);
  if (fromConversation) {
    await upsertSession(buyerJid, vendor.id, { buyer_name: fromConversation, buyer_name_source: 'conversation' });
    session.buyer_name = fromConversation;
  }
  const displayName = session.buyer_name || fromMsg;

  // First-time / idle, non-vendor chats: identify vendor from store code in message, then show stock
  const isNewSession = !sessionRowResolved || !sessionRowResolved.intent_state || session.intent_state === 'idle';
  const upperText = trimmedText.toUpperCase();

  // Try to identify vendor from store code in the message (e.g. "AMAKA", "hi AMAKA", "AMAKA hi")
  const words = trimmedText.split(/\s+/).filter(Boolean);
  let vendorForGreet = vendor;
  for (const w of words) {
    const code = w.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length >= 2) {
      const vByCode = await getVendorByStoreCode(code);
      if (vByCode && (vByCode.whatsapp_number || '').replace(/\D/g, '') === botNum) {
        vendorForGreet = vByCode;
        break;
      }
    }
  }
  const storeCodeInMessage = (vendorForGreet.store_code || '').toUpperCase().trim();
  const messageHasStoreCode = storeCodeInMessage && upperText.includes(storeCodeInMessage);
  const greetPattern = /^(hi+|hello+|he+y+s*|hey there|hi there|how far|sup|what'?s up|good (morning|afternoon|evening)|good day|evening|morning|i have a question|can i ask a question)\b/i;
  const isGreeting = greetPattern.test(lowerText);
  const looksLikeStoreCodeEntry = storeCodeInMessage && (upperText === storeCodeInMessage || (upperText.includes(storeCodeInMessage) && upperText.length <= storeCodeInMessage.length + 15));
  const isStoreCodeWithGreeting = messageHasStoreCode && upperText.length <= (storeCodeInMessage.length + 15); // e.g. "EAZIGADGETS hi" — always show stock

  // New session: greeting or store code → welcome + stock. Any session: message is store code + short greeting → show stock.
  if ((isNewSession && (isGreeting || looksLikeStoreCodeEntry || messageHasStoreCode)) || isStoreCodeWithGreeting) {
    const inventory = await getInventory(vendorForGreet);
    const name = vendorForGreet.business_name || 'this store';
    const recentTx = await query(
      'SELECT 1 FROM transactions WHERE buyer_jid = $1 AND vendor_id = $2 AND status = $3 LIMIT 1',
      [buyerJid, vendorForGreet.id, 'paid']
    );
    const isReturning = !!(recentTx.rows && recentTx.rows.length > 0);
    const greeting = buildGreeting(vendorForGreet, session, isReturning, displayName);
    if (!inventory.length) {
      const reply =
        `${greeting} Welcome to *${name}* 👋\n\n` +
        `The vendor hasn't loaded items yet. You can still tell me what you're looking for, and they'll update their stock.`;
      await sendWithDelay(sock, buyerJid, reply);
      logReply(reply);
      await appendMessage(buyerJid, vendor.id, 'bot', reply);
      return;
    }
    const top = inventory.slice(0, 10);
    const list = top
      .map((i, idx) => `${idx + 1}. ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`)
      .join('\n');
    const moreLine = inventory.length > top.length
      ? `\n\n…and ${inventory.length - top.length} more item(s) in stock.`
      : '';
    const reply =
      `${greeting} Welcome to *${name}* 👋\n\n` +
      `Here's what's in stock right now (${inventory.length} item${inventory.length === 1 ? '' : 's'}):\n\n` +
      `${list}${moreLine}\n\n` +
      `Reply with a number to choose (e.g. *1*–*10*), or type *11* for the next 10 items.`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    if (inventory.length > 1) {
      await upsertSession(buyerJid, vendor.id, {
        intent_state: 'selecting_item',
        list_skus: inventory.map(i => i.sku).join(','),
        list_offset: 0,
        last_item_name: null,
        last_item_sku: null
      });
    }
    return;
  }

  if (isNewSession) {
    const displayName = vendor.business_name && !/something went wrong on our end/i.test(vendor.business_name)
      ? vendor.business_name
      : null;
    const sellChoicePattern = /^(2|sell|selling|vendor|open store|set up store|setup store|start selling)\b/i;
    const sellPhrasePattern = /(set\s*up\s+my\s+store|setup\s+my\s+store|open\s+my\s+store|start\s+my\s+store|start\s+selling\b|i\s+want\s+to\s+sell\b|become\s+a\s+vendor\b)/i;

    // If they explicitly say they want to sell, guide them to vendor setup
    if (sellChoicePattern.test(lowerText) || sellPhrasePattern.test(lowerText)) {
      const storeLabel = displayName || 'this store';
      const msgText =
        `Got it — you want to *sell*.\n\n` +
        `This WhatsApp line is the assistant for *${storeLabel}* — it's for their buyers.\n\n` +
        `To set up *your own* VendBot store, use the number that will own the store and reply *VENDOR-SETUP* there.\n\n` +
        `If you're just trying to buy from *${storeLabel}*, reply *1* or tell me what you're looking for.`;
      await sendWithDelay(sock, buyerJid, msgText);
      logReply(msgText);
      await appendMessage(buyerJid, vendor.id, 'bot', msgText);
      return;
    }
  }

  // Gatekeeper: stateless — only drop obvious noise so the model doesn't over-respond.
  const gate = shouldRespond(text);
  if (!gate.respond) {
    await appendHistory(buyerJid, vendor.id, 'buyer', text);
    return;
  }
  if (gate.override) {
    await sendWithDelay(sock, buyerJid, gate.override);
    logReply(gate.override);
    await appendMessage(buyerJid, vendor.id, 'bot', gate.override);
    await appendHistory(buyerJid, vendor.id, 'buyer', text);
    await appendHistory(buyerJid, vendor.id, 'bot', gate.override);
    return;
  }

  const inventory = inventoryEarly;
  const history = getChatHistory(session);
  await appendMessage(buyerJid, vendor.id, 'buyer', text);
  await appendHistory(buyerJid, vendor.id, 'buyer', text);

  const ctx = { sock, buyerJid, vendor, session, inventory, history, text };

  // Global reset / \"something else\" intent: clear previous context and invite them to say what they want.
  const resetPattern = /(reset( chat| conversation)?|start (again|over)|clear (chat|conversation|everything)|forget (this|that|it|everything)|i (need|want) something else|i don'?t want that (anymore)?)/i;
  if (resetPattern.test(text)) {
    await clearSession(buyerJid, vendor.id);
    const reply = await generateCancelReply(text, inventory, vendor.business_name);
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  // If there's no commerce context yet, ignore bare confirmations like "yes", "ok", "k"
  const isBareConfirm = /^(yes|ok|okay|k|kk|sure|yup|yeah|yep)[.!?]*$/.test(lowerText);
  const hasCommerceHistory = history.some(m => m.role === 'bot');
  const hasContextState = ['querying', 'selecting_item', 'selecting_variant', 'variant_ready', 'negotiating', 'awaiting_payment', 'awaiting_delivery_confirm']
    .includes(session.intent_state);
  if (isBareConfirm && !hasCommerceHistory && !hasContextState && !session.last_item_name) {
    console.log('  [SKIP] Bare confirmation without commerce context, ignoring.');
    return;
  }

  if (session.intent_state === 'selecting_variant') {
    if (/^(cancel|never mind|forget it|something else|no)$/i.test(trimmedText)) {
      const { upsertSessionFields } = require('../../sessions/manager');
      await upsertSessionFields(buyerJid, vendor.id, {
        intent_state: 'querying',
        variant_selections: null,
        pending_variant_product_sku: null,
        pending_variant_type: null
      });
      await sendWithDelay(sock, buyerJid, `No problem. What would you like to see instead?`);
      return;
    }
    const { handleVariantReply } = require('../../inventory/variants');
    await handleVariantReply(sock, buyerJid, text, vendor, session);
    return;
  }

  if (session.intent_state === 'variant_ready') {
    const { getProductBySku, handleVariantSelection } = require('../../inventory/variants');
    const { handlePurchase } = require('./handlers/purchase');
    const { upsertSessionFields } = require('../../sessions/manager');
    const lower = trimmedText.toLowerCase();

    // Buyer is happy with the chosen variant and wants to pay
    if (/^(yes|continue|go|go ahead|ok|okay|sure|send link|send payment|pay now|i(?:'ll| will) (take|get)|ready|proceed)$/i.test(trimmedText) ||
        /\b(send (me )?(the )?link|payment link|i want to pay|ready to pay)\b/i.test(lower)) {
      let item = inventory.find(i => i.sku === session.last_item_sku || i.name === session.last_item_name);
      if (!item && session.last_item_sku && session.last_item_name && session.last_item_price != null) {
        item = { sku: session.last_item_sku, name: session.last_item_name, price: session.last_item_price };
      }
      if (item) {
        await upsertSessionFields(buyerJid, vendor.id, {
          intent_state: 'querying',
          variant_selections: null,
          pending_variant_product_sku: null
        });
        await handlePurchase(sock, buyerJid, vendor, session, item);
      }
      return;
    }

    // Buyer wants to change variant options (e.g. "change RAM", "different color")
    if (/\b(what (storage|color|colour|size|ram)|change|different|switch)\b/i.test(lower) && session.pending_variant_product_sku) {
      const product = await getProductBySku(vendor.id, session.pending_variant_product_sku);
      if (product) {
        const variantTypes = Array.isArray(product.variant_types) ? product.variant_types : [];
        const mWhat = lower.match(/what\s+(storage|color|colour|size|ram)/);
        const mChange = lower.match(/change\s+(storage|color|colour|size|ram)/);
        let changeType = (mWhat && mWhat[1]) || (mChange && mChange[1]) || null;
        if (changeType) {
          changeType = changeType.replace('colour', 'color');
        }
        if (!changeType) {
          if (lower.includes('storage')) changeType = 'storage';
          else if (lower.includes('color') || lower.includes('colour')) changeType = 'color';
          else if (lower.includes('size')) changeType = 'size';
          else if (lower.includes('ram')) changeType = 'ram';
        }

        let newSelections = { ...(session.variant_selections || {}) };

        // If they didn't specify which attribute, fall back to the last selected one
        if (!changeType && variantTypes.length) {
          const reversed = [...variantTypes].reverse();
          changeType = reversed.find(t => newSelections[t]);
        }

        if (changeType && variantTypes.includes(changeType)) {
          delete newSelections[changeType];
          await upsertSessionFields(buyerJid, vendor.id, {
            intent_state: 'selecting_variant',
            variant_selections: newSelections,
            pending_variant_type: changeType
          });
          await handleVariantSelection(sock, buyerJid, vendor, { ...session, variant_selections: newSelections });
          return;
        }

        // Fallback: if we still don't know what to change, re-run variant selection from current state
        await upsertSessionFields(buyerJid, vendor.id, {
          intent_state: 'selecting_variant'
        });
        await handleVariantSelection(sock, buyerJid, vendor, { ...session, variant_selections: newSelections });
      }
      return;
    }
  }

  if (session.intent_state === 'awaiting_delivery_confirm') {
    await handleDeliveryReply(buyerJid, vendor.id, text);
    return;
  }

  // Proactive delivery confirmation: "I've received the order", "received", "got it" etc.
  const deliveryConfirmPattern = /\b(received|got\s+it|collected|i'?ve?\s+received|i\s+received\s+(the\s+)?order|order\s+received|delivery\s+received)\b/i;
  if (deliveryConfirmPattern.test(trimmedText)) {
    await handleDeliveryReply(buyerJid, vendor.id, text);
    return;
  }

  // Buyer claims they've already paid: look for paid txn and resend receipt; if none, verify pending with Paystack (webhook may have been missed).
  const paymentDonePattern = /\b(payment\s*(made|done|completed)|i\s*(just\s*)?paid|have\s+paid|i'?ve\s+paid|paid\s+already|just\s+paid)\b/i;
  if (paymentDonePattern.test(trimmedText)) {
    let res = await query(
      `SELECT mono_ref
       FROM transactions
       WHERE buyer_jid = $1
         AND vendor_id = $2
         AND status = 'paid'
         AND created_at >= NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [buyerJid, vendor.id]
    );
    let row = res.rows && res.rows[0];
    if (!row) {
      const pendingRes = await query(
        `SELECT mono_ref FROM transactions
         WHERE buyer_jid = $1 AND vendor_id = $2 AND status = 'pending'
           AND created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC LIMIT 1`,
        [buyerJid, vendor.id]
      );
      const pending = pendingRes.rows && pendingRes.rows[0];
      if (pending) {
        try {
          const paystackData = await verifyTransaction(pending.mono_ref);
          if (paystackData && paystackData.status === 'success') {
            await handlePaymentSuccess({
              reference: pending.mono_ref,
              receiptNumber: paystackData.receipt_number || null
            });
            logReply('[Payment verified on demand after "I\'ve paid" — receipt sent]');
            return;
          }
        } catch (err) {
          console.error('[LISTENER] Verify payment on "I\'ve paid":', err.message);
        }
      }
      await sendWithDelay(
        sock,
        buyerJid,
        'I could not find any recent paid order for this chat in the last 30 minutes. If you just paid and nothing is showing, ask the seller to confirm the reference so we can check.'
      );
      logReply('No recent paid order for claimed payment');
      return;
    }
    await sendWithDelay(sock, buyerJid, "Here's the receipt for your most recent order 👇");
    await sendReceiptForReference(sock, row.mono_ref, null);
    logReply('[Receipt re-sent after claimed payment]');
    return;
  }

  if (session.intent_state === 'awaiting_payment' && session.pending_payment_ref) {
    const resendWords = ['resend', 'link', 'send link', 'send', 'again', 'yes', 'pay', 'payment', 'how', 'where', 'what', 'get', 'give'];
    const breakdownPattern = /\b(failed|not working|doesn't work|don't work|broken|expired|error|can'?t pay|cannot pay|won'?t work|no link|didn'?t get|didnt get|breakdown|problem|issue)\b/i;
    const wantsLinkOrHelp = resendWords.some(w => text.toLowerCase().includes(w)) || breakdownPattern.test(trimmedText);
    if (wantsLinkOrHelp) {
      const txnRes = await query(
        'SELECT item_name, amount, mono_link, pay_token, status FROM transactions WHERE mono_ref = $1 LIMIT 1',
        [session.pending_payment_ref]
      );
      const txn = txnRes.rows && txnRes.rows[0];
      if (txn && txn.status === 'pending' && txn.mono_link) {
        const amt = `₦${(txn.amount / 100).toLocaleString()}`;
        const isBreakdown = breakdownPattern.test(trimmedText);
        const extra = isBreakdown ? '\n\n_If this link still doesn\'t work, tell the seller — they can help or send another._' : '';
        await sendWithDelay(sock, buyerJid,
          `🔗 *Payment link for ${txn.item_name}* (${amt}):\n\n${txn.mono_link}\n\n_Link is for this order only. Expires in 30 minutes._${extra}`
        );
        logReply(isBreakdown ? ' [Resent payment link after breakdown]' : ' [Resent payment link]');
        return;
      }
    }
  }

  // Any message mentioning "receipt": resend receipt for paid txn; if none, verify pending with Paystack (e.g. webhook missed, no redirect to chat).
  const mentionsReceipt = /\breceipts?\b/i.test(trimmedText);
  if (mentionsReceipt) {
    let res = await query(
      `SELECT mono_ref
       FROM transactions
       WHERE buyer_jid = $1
         AND vendor_id = $2
         AND status = 'paid'
         AND created_at >= NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [buyerJid, vendor.id]
    );
    let row = res.rows && res.rows[0];
    if (!row) {
      const pendingRes = await query(
        `SELECT mono_ref FROM transactions
         WHERE buyer_jid = $1 AND vendor_id = $2 AND status = 'pending'
           AND created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC LIMIT 1`,
        [buyerJid, vendor.id]
      );
      const pending = pendingRes.rows && pendingRes.rows[0];
      if (pending) {
        try {
          const paystackData = await verifyTransaction(pending.mono_ref);
          if (paystackData && paystackData.status === 'success') {
            await handlePaymentSuccess({
              reference: pending.mono_ref,
              receiptNumber: paystackData.receipt_number || null
            });
            logReply('[Payment verified on demand for receipt — receipt sent]');
            return;
          }
        } catch (err) {
          console.error('[LISTENER] Verify payment for receipt:', err.message);
        }
      }
      await sendWithDelay(sock, buyerJid, 'I could not find any recent paid order for this chat. If you just paid and nothing is showing, ask the seller to confirm the reference so we can check.');
      logReply('No recent paid order for receipt');
      return;
    }
    await sendWithDelay(sock, buyerJid, "Here's the receipt for your most recent order 👇");
    await sendReceiptForReference(sock, row.mono_ref, null);
    logReply('[Receipt re-sent]');
    return;
  }

  if (await handleCartMessage(ctx)) return;
  if (await handleNegotiationReply(ctx)) return;

  // Product/stock queries go through QUERY flow (match DB, show what we have) — skip list handler
  const isProductQuery = /\b(phone|iphone|pixel|samsung|shirt|tee|need|want|looking for|what'?s? in stock|what do you have|do you have|you have|you get|wetin you get|what you sell|wetin you sell|anything available|what'?s? available|options|browsing|show me)\b/i.test(trimmedText)
    || /^(what'?s? in stock|what (do you )?have|do you have|an? (iphone|pixel|phone|shirt)\b)/i.test(trimmedText);
  if (!isProductQuery && (await handleSelectingItem(ctx))) return;

  if (lowerText === 'help' || lowerText === 'menu' || lowerText === 'options') {
    const reply = `Here's how I can help:\n\n• Ask what's in stock (e.g. "Do you have sneakers?")\n• Say what you want to buy (e.g. "I want the black one")\n• Reply with a number when I show you a list\n• Say *cancel* if you change your mind\n\nWhat are you looking for? 😊`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  // Repetition: same or very similar message again — handle by state instead of re-classifying
  const recentUser = (history || []).filter(h => h.role === 'buyer' || h.role === 'user').slice(-4).map(h => (h.text || h.content || '').toLowerCase().trim());
  const currentNorm = trimmedText.toLowerCase().trim();
  const isExactRepeat = recentUser.includes(currentNorm);
  const isShortSimilar = currentNorm.length < 25 && recentUser.some(prev => prev.length < 25 && prev !== currentNorm && (prev.includes(currentNorm) || currentNorm.includes(prev)));
  if (isExactRepeat || isShortSimilar) {
    console.log('[LISTENER] Repetition detected — handling by state');
    if (session.intent_state === 'awaiting_payment' && session.pending_payment_ref) {
      await sendWithDelay(sock, buyerJid,
        `I already sent you a payment link just now.\n\nCheck your messages above — the link is there. It expires in 30 minutes.`
      );
      return;
    }
    if ((session.intent_state === 'querying' || session.intent_state === 'selecting_item') && session.last_item_name) {
      const lastItem = inventory.find(i => i.name === session.last_item_name) || inventory.find(i => i.sku === session.last_item_sku);
      if (lastItem) {
        await handlePurchase(sock, buyerJid, vendor, session, lastItem);
        return;
      }
    }
    await sendWithDelay(sock, buyerJid, `Let me try again — what exactly do you need?`);
    return;
  }

  const intent = await classifyIntent(text, {}, [], vendor);
  logMessage(vendor.business_name, buyerJid, text, intent);

  const trimmed = text.trim();
  const vagueRef = /^(it|that\s*one?|this\s*one|the\s*(bag|one|item|first\s*one|sneakers|pair)|how\s*much|price|cost|amount|how\s*much\s*again|price\s*\?|send\s*link|pls|please)\s*[?.!]*$/i.test(trimmed)
    || (trimmed.length <= 20 && /^(that|this|the\s*one|again)\s*[?.!]*$/i.test(trimmed));
  const lastItemAsMatch = vagueRef && session.last_item_name
    ? inventory.find(i => i.name === session.last_item_name)
    : null;

  await handleBuyerIntent(ctx, intent, lastItemAsMatch);
}

module.exports = { handleMessage };
