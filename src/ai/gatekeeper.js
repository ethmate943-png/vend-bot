// Simple gatekeeper:
// - Drop only true noise (empty, pure "ok/k/kk", "lol", single emoji/char).
// - Let everything else go through to the classifier, which already decides
//   if it's commerce (QUERY/PURCHASE/NEGOTIATE/...) or non-commerce (OTHER/IGNORE).

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
  if (['ok', 'k', 'kk', 'okay', 'sure', 'yes', 'yup', 'yeah', 'yep', 'thanks', 'thank you', 'tnx', 'thx', 'lol', 'lmao'].includes(lower)) {
    return true;
  }
  return isSingleEmojiOrChar(text);
}

/**
 * Decide whether to respond at all.
 * We only block obvious noise. All other messages are passed to the AI/classifier,
 * and buyer-intent will already ignore non-commerce intents (OTHER/IGNORE).
 *
 * @param {string} text
 * @param {object} _vendor
 * @param {object} _session
 * @returns {{respond: boolean, override: string|null, reason?: string}}
 */
function shouldRespond(text, _vendor, session = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { respond: false, override: null, reason: 'empty' };
  }

  // When picking from a list, numbers 1–99 are valid selections — don't block them.
  if (session?.intent_state === 'selecting_item' && /^\s*\d{1,2}\s*$/.test(trimmed)) {
    return { respond: true, override: null, reason: 'list_selection' };
  }

  if (isBareAck(trimmed)) {
    return { respond: false, override: null, reason: 'noise' };
  }

  // Everything else goes through to classifier + buyer-intent.
  return { respond: true, override: null, reason: 'pass_through' };
}

module.exports = { shouldRespond };

