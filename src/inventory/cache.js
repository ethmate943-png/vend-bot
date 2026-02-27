/**
 * In-memory inventory cache per vendor. TTL 5 minutes.
 * Invalidated only when inventory actually changes (add/restock/sold), not on every chat message.
 */
const TTL_MS = 5 * 60 * 1000;

const store = new Map();

function get(vendorId) {
  const entry = store.get(vendorId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(vendorId);
    return null;
  }
  return entry.data;
}

function set(vendorId, data) {
  store.set(vendorId, { data, ts: Date.now() });
}

function invalidate(vendorId) {
  if (store.has(vendorId)) {
    store.delete(vendorId);
    console.log(`[CACHE] Invalidated inventory for vendor ${vendorId}`);
  }
}

module.exports = { get, set, invalidate };
