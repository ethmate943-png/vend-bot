const { COMMERCE_SIGNALS } = require('../sessions/pattern');

function hasCommerceSignal(text) {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;
  return COMMERCE_SIGNALS.some(sig => lower.includes(sig));
}

function isSingleEmojiOrChar(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (trimmed.length === 1) return true;
  // crude emoji-only check
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(trimmed);
}

function isBareAck(text) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  if (['ok', 'k', 'kk', 'okay', 'sure', 'yes', 'yup', 'yeah', 'yep', 'thanks', 'thank you', 'tnx', 'thx'].includes(lower)) {
    return true;
  }
  return isSingleEmojiOrChar(text);
}

function isGreetingOnly(text) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  return /^(hi+|hello+|he+y+s*|hey there|hi there|how far|sup|what'?s up|good (morning|afternoon|evening)|good day|evening|morning)$/.test(lower);
}

function isIdentityQuestion(text) {
  const lower = (text || '').trim().toLowerCase();
  if (!lower) return false;
  return /(who (are|r) (you|u)|what (is|\'s) this|what can you do|wetin you (be|do)|who be this)/i.test(lower);
}

/**
 * Decide whether to respond at all, and optionally provide an override message.
 * - When commerce signals are present → always respond, no override.
 * - For first message, we may override with a welcome or intro.
 * - For pure acks/emoji-only with no context → can skip.
 *
 * @param {string} text
 * @param {object} vendor
 * @param {object} session
 * @returns {{respond: boolean, override: string|null, reason?: string}}
 */
function shouldRespond(text, vendor, session = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { respond: false, override: null, reason: 'empty' };
  }

  const lower = trimmed.toLowerCase();
  const messageCount = Number(session.message_count || 0);
  const name = vendor && vendor.business_name ? vendor.business_name : 'this store';

  // Anything with clear commerce signal should go through as-is.
  if (hasCommerceSignal(trimmed)) {
    return { respond: true, override: null, reason: 'commerce_signal' };
  }

  // Active conversation (we've seen at least one message before).
  if (messageCount > 0) {
    if (isBareAck(trimmed)) {
      return { respond: false, override: null, reason: 'bare_ack' };
    }
    return { respond: true, override: null, reason: 'active_conversation' };
  }

  // Fresh conversation (first message in this session).
  if (isGreetingOnly(trimmed)) {
    const welcome =
      `Hi, this is the assistant for *${name}*.\n` +
      `Tell me what you want to buy or ask about, and I'll help.`;
    return { respond: true, override: welcome, reason: 'greeting' };
  }

  if (isIdentityQuestion(trimmed)) {
    const intro =
      `I'm the WhatsApp assistant for *${name}*.\n` +
      `I help with questions about products, prices and orders.`;
    return { respond: true, override: intro, reason: 'identity' };
  }

  if (isBareAck(trimmed)) {
    return { respond: false, override: null, reason: 'fresh_ack' };
  }

  // Short ambiguous messages with no commerce: let the AI decide; we pass through.
  return { respond: true, override: null, reason: 'default' };
}

module.exports = { shouldRespond };

