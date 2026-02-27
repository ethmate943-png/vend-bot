/**
 * Score-based in-memory search for Sheets inventory (no DB).
 * Use for fast matching without LLM when inventory is already in memory.
 */

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getCharOverlap(a, b) {
  const setA = new Set([...a].filter(c => c !== ' '));
  const setB = new Set([...b].filter(c => c !== ' '));
  const intersection = [...setA].filter(c => setB.has(c));
  return setA.size && setB.size ? intersection.length / Math.max(setA.size, setB.size) : 0;
}

/**
 * Search in-memory inventory by query. Returns up to 5 items sorted by score.
 * No LLM — pure scoring: exact match, contains, word overlap, character overlap.
 */
function searchInMemoryInventory(query, inventory) {
  if (!query || !inventory || !inventory.length) return [];
  const normQuery = normalise(query);
  const queryWords = normQuery.split(/\s+/).filter(w => w.length >= 2);

  const normCategory = (c) => normalise(c || '');
  const stopwords = new Set(['need', 'want', 'have', 'get', 'do', 'you', 'any', 'what', 'in', 'stock', 'looking', 'for', 'a', 'an', 'the', 'something', 'else', 'wetin', 'that', 'this', 'available', 'options', 'show', 'me', 'browsing', 'checking', 'just']);
  const productTypeWords = queryWords.filter(w => !stopwords.has(w) && w.length >= 2);

  // When query mentions a product type (sneaker, phone, bag, shirt, etc.), filter to items in that category
  const inStock = inventory.filter(item => (item.quantity || 0) > 0);
  const matchesProductType = (item) => {
    const normCat = normCategory(item.category);
    const normName = normalise(item.name);
    return productTypeWords.some(w =>
      normCat.includes(w) || normName.includes(w) ||
      normName.split(/\s+/).some(t => t.startsWith(w) || w.startsWith(t))
    );
  };
  const filtered = productTypeWords.length
    ? inStock.filter(matchesProductType)
    : inStock;
  const toScore = filtered.length > 0 ? filtered : inStock;

  const scored = toScore
    .map(item => {
      const normName = normalise(item.name);
      const normCat = normCategory(item.category);
      let score = 0;

      if (normName === normQuery) score += 100;
      if (normName.includes(normQuery)) score += 50;
      if (normQuery.includes(normName) && normName.length >= 3) score += 40;

      for (const word of queryWords) {
        if (normName.includes(word)) score += 20;
        if (normName.split(/\s+/).some(w => w.startsWith(word) || word.startsWith(w))) score += 10;
      }

      // Category/name match for any product type the vendor sells
      for (const w of productTypeWords) {
        if (normCat.includes(w) || normName.includes(w)) score += 35;
      }

      const overlap = getCharOverlap(normQuery, normName);
      score += overlap * 5;

      if (item.sku && normQuery.includes(normalise(item.sku))) score += 30;

      return { item, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(r => r.item);

  return scored;
}

module.exports = { searchInMemoryInventory, normalise, getCharOverlap };
