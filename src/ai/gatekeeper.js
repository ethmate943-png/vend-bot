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
 * Decide whether to respond at all. Stateless: we only block obvious noise
 * (empty, bare acks like ok/k/thanks, single emoji). No session/state — so the
 * model doesn't get triggered by "we're in a flow" and reply when it shouldn't.
 *
 * @param {string} text
 * @returns {{respond: boolean, override: string|null, reason?: string}}
 */
function shouldRespond(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { respond: false, override: null, reason: 'empty' };
  }

  if (isBareAck(trimmed)) {
    return { respond: false, override: null, reason: 'noise' };
  }

  return { respond: true, override: null, reason: 'pass_through' };
}

module.exports = { shouldRespond };

