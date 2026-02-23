/** Main message router: extract text, resolve vendor, delegate to handlers */

const { getSession, getChatHistory, appendMessage } = require('../../sessions/manager');
const { getVendorByBotNumber } = require('../../vendors/resolver');
const { getInventory } = require('../../inventory/manager');
const { sendWithDelay } = require('../sender');
const { logReply, logMessage } = require('./logger');
const { classifyIntent } = require('../../ai/classifier');
const { handleAdminCommand } = require('./handlers/admin');
const { handleVendorMessage } = require('./handlers/vendor');
const { handlePurchase } = require('./handlers/purchase');
const { handleNegotiationReply } = require('./handlers/negotiation');
const { handleSelectingItem } = require('./handlers/selecting-item');
const { handleBuyerIntent } = require('./handlers/buyer-intent');
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

  const isVendorChat =
    buyerJid.endsWith('@lid') ||
    chatPhone === botNum ||
    (chatPhone && vendorPhone && chatPhone === vendorPhone);
  const isVendorMessage =
    isVendorChat &&
    (msg.key.fromMe || (chatPhone && chatPhone === vendorPhone));
  const hasVendorVoice = isVendorMessage && (msg.message?.audioMessage || msg.message?.pttMessage);
  if (!text && !hasVendorVoice) return;

  if (isVendorMessage) {
    const vendorJid = isSelfChat ? buyerJid : (chatPhone ? `${chatPhone}@s.whatsapp.net` : `${vendorPhone}@s.whatsapp.net`);
    await handleVendorMessage(sock, msg, vendor, text || '', vendorJid);
    return;
  }

  const session = await getSession(buyerJid, vendor.id) || {};
  const inventory = await getInventory(vendor);
  const history = getChatHistory(session);
  await appendMessage(buyerJid, vendor.id, 'buyer', text);

  const ctx = { sock, buyerJid, vendor, session, inventory, history, text };

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

  if (await handleNegotiationReply(ctx)) return;
  if (await handleSelectingItem(ctx)) return;

  const lowerText = text.toLowerCase().trim();
  if (lowerText === 'help' || lowerText === 'menu' || lowerText === 'options') {
    const reply = `Here's how I can help:\n\n• Ask what's in stock (e.g. "Do you have sneakers?")\n• Say what you want to buy (e.g. "I want the black one")\n• Reply with a number when I show you a list\n• Say *cancel* if you change your mind\n\nWhat are you looking for? 😊`;
    await sendWithDelay(sock, buyerJid, reply);
    logReply(reply);
    await appendMessage(buyerJid, vendor.id, 'bot', reply);
    return;
  }

  const intent = await classifyIntent(text, session, history);
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
