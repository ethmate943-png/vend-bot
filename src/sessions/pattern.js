const COMMERCE_SIGNALS = [
  'price',
  'cost',
  '₦',
  'naira',
  'buy',
  'pay',
  'payment',
  'order',
  'orders',
  'available',
  'in stock',
  'stock',
  'delivery',
  'deliver',
  'pickup',
  'size',
  'colour',
  'color',
  'quantity',
  'qty'
];

function isUserMessage(entry) {
  if (!entry) return false;
  if (entry.role === 'user' || entry.role === 'buyer') return true;
  // conversation_history entries use { role, content }
  if (entry.role === 'assistant' || entry.role === 'bot') return false;
  return entry.role === 'user';
}

function textOf(entry) {
  return (entry && (entry.content || entry.text || '')).toString();
}

/**
 * Read the recent conversation pattern.
 * @param {Array<{role: string, content?: string, text?: string}>} history
 * @returns {'fresh'|'just_talking'|'mostly_talking'|'shopping_mode'|'mixed'}
 */
function readConversationPattern(history) {
  const h = Array.isArray(history) ? history.slice(-10) : [];
  const userMessages = h.filter(isUserMessage);
  if (userMessages.length === 0) return 'fresh';

  let commerceHits = 0;
  for (const msg of userMessages) {
    const lower = textOf(msg).toLowerCase();
    if (!lower) continue;
    if (COMMERCE_SIGNALS.some(sig => lower.includes(sig))) {
      commerceHits += 1;
    }
  }

  const ratio = commerceHits / userMessages.length;

  if (commerceHits === 0 && userMessages.length >= 4) {
    return 'just_talking';
  }
  if (ratio > 0.7) {
    return 'shopping_mode';
  }
  if (ratio < 0.3 && userMessages.length >= 4) {
    return 'mostly_talking';
  }
  return 'mixed';
}

module.exports = { readConversationPattern, COMMERCE_SIGNALS };

