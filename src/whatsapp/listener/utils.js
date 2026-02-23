/** Shared helpers for listener (haggle ref, price floor) */

function parseHaggle(ref) {
  if (!ref || !ref.startsWith('haggle:')) return { round: 0, counter: 0 };
  const parts = ref.split(':');
  return { round: parseInt(parts[1], 10) || 0, counter: parseInt(parts[2], 10) || 0 };
}

function floorAboveMin(price, minPrice) {
  const buffer = Math.max(Math.round(minPrice * 0.05), 500);
  return Math.max(price, minPrice + buffer);
}

module.exports = { parseHaggle, floorAboveMin };
