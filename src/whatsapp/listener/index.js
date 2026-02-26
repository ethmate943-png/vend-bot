/** Main message router: extract text, resolve vendor, delegate to handlers */

const { getSession, getChatHistory, appendMessage, clearSession, getConversationHistory, appendConversationExchange, setSessionRole, appendHistory } = require('../../sessions/manager');
const { getVendorByBotNumber } = require('../../vendors/resolver');
const { getInventory } = require('../../inventory/manager');
const { sendWithDelay } = require('../sender');
const { logReply, logMessage } = require('./logger');
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
const { handleDeliveryReply } = require('../../payments/webhook');
const { query } = require('../../db');

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
    const findRowId = (o, depth = 0) => {
      if (depth > 8 || !o) return null;
      if (typeof o.selectedRowId === 'string' && o.selectedRowId.trim()) return o.selectedRowId.trim();
      if (typeof o.id === 'string' && o.id.trim().length < 200) return o.id.trim();
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'object' && o[k] !== null) {
          const found = findRowId(o[k], depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    listReply = findRowId(msg.message);
    if (!listReply && msg.message.viewOnceMessageV2?.message) listReply = findRowId(msg.message.viewOnceMessageV2.message);
    if (!listReply && msg.message.viewOnceMessage?.message) listReply = findRowId(msg.message.viewOnceMessage.message);
  }
  const buttonReply = msg.message?.buttonsResponseMessage?.selectedButtonId;
  if (listReply) {
    text = String(listReply).trim();
    console.log('[LIST] Selected row id:', text);
  } else if (buttonReply) text = String(buttonReply).trim();

  if (!text && msg.message && !msg.message.conversation && !msg.message.extendedTextMessage?.text) {
    const keys = Object.keys(msg.message);
    console.log('[LIST_DEBUG] List tap? Keys:', keys.join(', '));
  }
  return text;
}

async function handleMessage(sock, msg) {
  if (!msg.message) return;
  const buyerJid = msg.key.remoteJid;
  if (buyerJid.endsWith('@g.us')) return;
  if (!buyerJid) return;
  if (!buyerJid.endsWith('@s.whatsapp.net') && !buyerJid.endsWith('@lid')) return;

  const botNum = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
  const text = extractText(msg);

  const adminPhone = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
  if (adminPhone && buyerJid === adminPhone + '@s.whatsapp.net' && (text || '').trim()) {
    await handleAdminCommand(sock, (text || '').trim(), buyerJid);
    return;
  }

  const vendor = await getVendorByBotNumber(botNum);
  if (!vendor || vendor.status === 'banned' || vendor.status === 'suspended') return;

  const vendorPhone = (vendor.whatsapp_number || '').replace(/\D/g, '');
  const chatPhone = buyerJid.endsWith('@lid')
    ? ''
    : (buyerJid || '').replace(/@s.whatsapp.net$/, '').replace(/\D/g, '');
  const isSelfChat = buyerJid.endsWith('@lid') || chatPhone === botNum;
  if (msg.key.fromMe && !isSelfChat) return;

  const sessionRow = await getSession(buyerJid, vendor.id) || {};
  const forcedRole = sessionRow.role === 'vendor' ? 'vendor' : sessionRow.role === 'buyer' ? 'buyer' : null;

  // Default to buyer. Only treat as vendor when we're sure: same phone as store owner, or role pinned.
  const isVendorChatBase =
    (chatPhone && vendorPhone && chatPhone === vendorPhone);

  const isVendorChat =
    forcedRole === 'vendor'
      ? true
      : forcedRole === 'buyer'
        ? false
        : isVendorChatBase;
  const isVendorMessage =
    isVendorChat &&
    (
      msg.key.fromMe ||
      (chatPhone && chatPhone === vendorPhone)
    );
  const hasVendorVoice = isVendorMessage && (msg.message?.audioMessage || msg.message?.pttMessage);
  if (!text && !hasVendorVoice) return;

  // Test helper: allow toggling how this chat is treated (buyer vs vendor)
  const lowerCommand = (text || '').trim().toLowerCase();
  if (lowerCommand === 'test:mode vendor') {
    await setSessionRole(buyerJid, vendor.id, 'vendor');
    await sendWithDelay(sock, buyerJid, 'Test mode: this chat will now be treated as *vendor* messages until you switch back.');
    return;
  }
  if (lowerCommand === 'test:mode buyer') {
    await setSessionRole(buyerJid, vendor.id, 'buyer');
    await sendWithDelay(sock, buyerJid, 'Test mode: this chat will now be treated as *buyer* messages again.');
    return;
  }

  if (isVendorMessage) {
    const vendorJid = isSelfChat ? buyerJid : (chatPhone ? `${chatPhone}@s.whatsapp.net` : `${vendorPhone}@s.whatsapp.net`);
    await handleVendorMessage(sock, msg, vendor, text || '', vendorJid);
    return;
  }

  // Non-vendor sending VENDOR-SETUP to a store bot: explain what to do instead
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
    ...sessionRow,
    conversation_history: getConversationHistory(sessionRow)
  };
  const lowerText = text.toLowerCase().trim();

  // First-time / idle, non-vendor chats: treat greetings specially
  const isNewSession = !sessionRow || !sessionRow.intent_state || session.intent_state === 'idle';

  // Buyer coming in via store link with the store code (possibly plus a short greeting):
  // wa.me/<bot>?text=STORECODE → welcome them and show what's in stock.
  const storeCode = (vendor.store_code || '').toUpperCase().trim();
  const upperText = trimmedText.toUpperCase();
  const looksLikePureCode = storeCode && upperText === storeCode;
  const looksLikeCodeWithShortExtra =
    storeCode &&
    upperText.includes(storeCode) &&
    upperText.length <= storeCode.length + 10; // allow "AMAKA hi", "hi AMAKA", etc.
  if (isNewSession && storeCode && (looksLikePureCode || looksLikeCodeWithShortExtra)) {
    const inventory = await getInventory(vendor);
    const name = vendor.business_name || 'this store';
    if (!inventory.length) {
      const reply =
        `Welcome to *${name}* 👋\n\n` +
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
      `Welcome to *${name}* 👋\n\n` +
      `Here's what's in stock right now (${inventory.length} item${inventory.length === 1 ? '' : 's'}):\n\n` +
      `${list}${moreLine}\n\n` +
      `Tell me what you're looking for or tap and mention any item.`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  if (isNewSession) {
    const displayName = vendor.business_name && !/something went wrong on our end/i.test(vendor.business_name)
      ? vendor.business_name
      : null;
    // Treat short greeting-ish messages ("hey", "heyy", "heys", "hi", "good evening", etc.) as a greet
    const greetPattern = /^(hi+|hello+|he+y+s*|hey there|hi there|how far|sup|what'?s up|good (morning|afternoon|evening)|good day|evening|morning|i have a question|can i ask a question)\b/i;
    const sellChoicePattern = /^(2|sell|selling|vendor|open store|set up store|setup store|start selling)\b/i;
    const sellPhrasePattern = /(set\s*up\s+my\s+store|setup\s+my\s+store|open\s+my\s+store|start\s+my\s+store|start\s+selling\b|i\s+want\s+to\s+sell\b|become\s+a\s+vendor\b)/i;

    // If they greet with no context, respond like an assistant and invite them to say what they need
    if (greetPattern.test(lowerText)) {
      const prompt =
        (displayName
          ? `Hi, I'm VendBot for *${displayName}* 👋\n\n`
          : `Hi, I'm VendBot 👋\n\n`) +
        `You can tell me what you want to buy from this store,\n` +
        `or, if you want to set up *your own* store, say something like \"I want to sell\" or \"set up my store\".\n\n` +
        `What do you need?`;
      await sendWithDelay(sock, buyerJid, prompt);
      logReply(prompt);
      await appendMessage(buyerJid, vendor.id, 'bot', prompt);
      return;
    }

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

  // Gatekeeper: decide if we should respond at all to this message.
  const gate = shouldRespond(text, vendor, session);
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

  const inventory = await getInventory(vendor);
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
  const hasContextState = ['querying', 'selecting_item', 'negotiating', 'awaiting_payment', 'awaiting_delivery_confirm']
    .includes(session.intent_state);
  if (isBareConfirm && !hasCommerceHistory && !hasContextState && !session.last_item_name) {
    console.log('  [SKIP] Bare confirmation without commerce context, ignoring.');
    return;
  }

  if (session.intent_state === 'awaiting_delivery_confirm') {
    await handleDeliveryReply(buyerJid, vendor.id, text);
    return;
  }

  if (session.intent_state === 'awaiting_payment' && session.pending_payment_ref) {
    const resendWords = ['resend', 'link', 'send link', 'send', 'again', 'yes', 'pay', 'payment'];
    if (resendWords.some(w => text.toLowerCase().includes(w))) {
      const txnRes = await query(
        'SELECT item_name, amount, mono_link, pay_token, status FROM transactions WHERE mono_ref = $1 LIMIT 1',
        [session.pending_payment_ref]
      );
      const txn = txnRes.rows && txnRes.rows[0];
      if (txn && txn.status === 'pending' && txn.mono_link) {
        const amt = `₦${(txn.amount / 100).toLocaleString()}`;
        await sendWithDelay(sock, buyerJid,
          `🔗 *Payment link for ${txn.item_name}* (${amt}):\n\n${txn.mono_link}\n\n_Link is for this order only. Expires in 30 minutes._`
        );
        logReply(' [Resent payment link]');
        return;
      }
    }
  }

  if (await handleCartMessage(ctx)) return;
  if (await handleNegotiationReply(ctx)) return;
  if (await handleSelectingItem(ctx)) return;

  if (lowerText === 'help' || lowerText === 'menu' || lowerText === 'options') {
    const reply = `Here's how I can help:\n\n• Ask what's in stock (e.g. "Do you have sneakers?")\n• Say what you want to buy (e.g. "I want the black one")\n• Reply with a number when I show you a list\n• Say *cancel* if you change your mind\n\nWhat are you looking for? 😊`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  const intent = await classifyIntent(text, session, history, vendor);
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
