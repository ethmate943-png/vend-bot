/**
 * Parse bulk price lists and single-item captions for inventory addition.
 */

const { extractInventoryFromText } = require('../ai/extractor');

/**
 * Validate item price. Returns null if valid, or an error message string.
 * Blocks zero/negative; warns (but does not block) on very low/high.
 */
function validateItemPrice(price) {
  if (price == null || price === '') return 'Price must be a number';
  const n = Number(price);
  if (Number.isNaN(n)) return 'Price must be a number';
  if (n <= 0) return 'Price must be greater than zero';
  if (n < 100) return 'Price seems too low — is that right?'; // warn, caller may allow
  if (n > 10000000) return 'Price seems very high — please confirm'; // warn
  return null;
}

/** Heuristic: message looks like a multi-line price list (several lines, numbers/prices). */
function detectBulkMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.trim().split(/\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return false;
  const withNumbers = lines.filter(l => /\d{2,}/.test(l) || /\d+\s*k\b/i.test(l) || /\d+\s*thousand/i.test(l));
  return withNumbers.length >= 2;
}

/**
 * Parse a bulk price list (multiple items) with AI. Returns array of { name, sku, price, quantity, category }.
 * @param {string} text - Raw vendor message (price list, forwarded catalogue, etc.)
 * @param {object} [vendor] - Optional vendor for category hint
 * @returns {Promise<Array<{name, sku, price, quantity, category}>>}
 */
async function parseBulkInventory(text, vendor) {
  if (!text || !text.trim()) return [];
  return extractInventoryFromText(text);
}

/**
 * Parse a single item from a caption (e.g. image caption). Returns one item or null.
 * @param {string} caption - e.g. "Black sneakers 25000 x5"
 * @param {string} [category] - Optional category hint
 * @returns {Promise<{name, sku, price, quantity, category}|null>}
 */
async function parseSingleItem(caption, category) {
  if (!caption || !caption.trim()) return null;
  const items = await extractInventoryFromText(caption.trim());
  if (!items.length) return null;
  const first = items[0];
  if (category) first.category = category;
  return first;
}

/**
 * Parse Sheet column F variant string: "storage:128GB,256GB,512GB|color:Black,White,Blue"
 * Pipe separates variant types; comma separates options within a type.
 * Returns { variantTypes: string[], optionsByType: Record<string, string[]> }.
 */
function parseSheetVariants(variantString) {
  if (!variantString || typeof variantString !== 'string') return { variantTypes: [], optionsByType: {} };
  const trimmed = variantString.trim();
  if (!trimmed) return { variantTypes: [], optionsByType: {} };

  const variantTypes = [];
  const optionsByType = {};

  const parts = trimmed.split('|').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const type = part.slice(0, colon).trim().replace(/\s+/g, '_').toLowerCase();
    const opts = part.slice(colon + 1).split(',').map(s => s.trim()).filter(Boolean);
    if (type && opts.length) {
      variantTypes.push(type);
      optionsByType[type] = opts;
    }
  }

  return { variantTypes, optionsByType };
}

/**
 * Parse natural-language variant definition from vendor message (e.g. "128gb 256gb 512gb", "black and white").
 * Stub: returns null for now; can be extended with AI or regex patterns.
 * @param {string} text - Vendor message
 * @param {string} [category] - Optional category hint
 * @returns {Promise<{ variantTypes: string[], optionsByType: Record<string, string[]>, pricesByOption?: Record<string, number> }|null>}
 */
async function parseVariantDefinition(text, category) {
  if (!text || !text.trim()) return null;
  return null;
}

module.exports = {
  detectBulkMessage,
  parseBulkInventory,
  parseSingleItem,
  validateItemPrice,
  parseSheetVariants,
  parseVariantDefinition
};
