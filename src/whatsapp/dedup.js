// Simple in-memory deduplication for incoming WhatsApp messages.
// WhatsApp can occasionally deliver the same message twice (especially on reconnect).
// We track recently seen message IDs for a short window and skip exact duplicates.

const seen = new Map(); // id -> timestamp (ms)
const WINDOW_MS = 5 * 60 * 1000; // keep 5 minutes of IDs

function isDuplicate(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  const ts = seen.get(messageId);
  if (ts && now - ts < WINDOW_MS) {
    return true;
  }
  seen.set(messageId, now);
  return false;
}

function cleanup() {
  const now = Date.now();
  for (const [id, ts] of seen.entries()) {
    if (now - ts > WINDOW_MS) {
      seen.delete(id);
    }
  }
}

setInterval(cleanup, 60 * 1000).unref?.();

module.exports = { isDuplicate };

