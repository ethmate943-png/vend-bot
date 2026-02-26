const { COMMERCE_SIGNALS } = require('../sessions/pattern');

function hasCommerceSignal(text) {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;
  return COMMERCE_SIGNALS.some(sig => lower.includes(sig));
}

/**
 * Decide whether to respond at all.
 * Hard rule: only respond to messages that clearly look like commerce
 * (price, buy, pay, order, delivery, stock, help/menu/options, etc.).
 * Everything else (pure chat, jokes, meta talk) is ignored completely.
 *
 * @param {string} text
 * @param {object} _vendor
 * @param {object} _session
 * @returns {{respond: boolean, override: string|null, reason?: string}}
 */
function shouldRespond(text, _vendor, _session = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { respond: false, override: null, reason: 'empty' };
  }

  const lower = trimmed.toLowerCase();

  // Strong commerce keywords (including help/menu/options as commands).
  if (hasCommerceSignal(trimmed)) {
    return { respond: true, override: null, reason: 'commerce_signal' };
  }

  const commercePattern = /(do you have|have any|looking for|want to buy|i want (to )?buy|i wan buy|how much|price|amount|delivery|deliver|send to|in stock|available|order|place an order|pay now|payment|paystack|cart|add to cart)/i;
  if (commercePattern.test(lower)) {
    return { respond: true, override: null, reason: 'commerce_phrase' };
  }

  const commandPattern = /^(help|menu|options|cancel|reset|cart|view cart)\b/i;
  if (commandPattern.test(lower)) {
    return { respond: true, override: null, reason: 'command' };
  }

  // Everything else is treated as normal conversation; bot stays silent.
  return { respond: false, override: null, reason: 'non_commerce' };
}

module.exports = { shouldRespond };

