// Per-JID message queue to avoid race conditions for the same chat.
// Messages for one buyer JID are processed one at a time, in order.
// Different JIDs can still be handled in parallel.

const queues = new Map(); // jid -> { add, lastUsed }
const IDLE_MS = 30 * 60 * 1000; // 30 minutes

function getBuyerQueue(jid) {
  if (!jid) {
    // Fallback: a no-op queue that just runs immediately.
    return {
      add: (fn) => Promise.resolve().then(fn),
      lastUsed: Date.now()
    };
  }

  let entry = queues.get(jid);
  if (!entry) {
    let chain = Promise.resolve();
    entry = {
      add(fn) {
        // Chain tasks sequentially for this JID.
        chain = chain
          .then(() => fn())
          .catch((err) => {
            console.error('[QUEUE] Error in buyer queue for', jid, err);
          });
        return chain;
      },
      lastUsed: Date.now()
    };
    queues.set(jid, entry);
  }
  entry.lastUsed = Date.now();
  return entry;
}

function cleanupQueues() {
  const now = Date.now();
  for (const [jid, entry] of queues.entries()) {
    if (now - (entry.lastUsed || 0) > IDLE_MS) {
      queues.delete(jid);
    }
  }
}

setInterval(cleanupQueues, 10 * 60 * 1000).unref?.();

module.exports = { getBuyerQueue };

