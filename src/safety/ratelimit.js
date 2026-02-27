/**
 * Per-JID rate limit: 15 messages per minute.
 * Used after dedup in listener to silent-ignore spam.
 */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 15;

const messageCount = new Map();

function isRateLimited(jid) {
  if (!jid) return false;
  const now = Date.now();
  const history = messageCount.get(jid) || [];
  const recent = history.filter(ts => now - ts < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    return true;
  }
  recent.push(now);
  messageCount.set(jid, recent);
  return false;
}

/** Call from cron every 5 mins to prune old entries. */
function cleanup() {
  const now = Date.now();
  for (const [jid, history] of messageCount.entries()) {
    const recent = history.filter(ts => now - ts < WINDOW_MS);
    if (recent.length === 0) messageCount.delete(jid);
    else messageCount.set(jid, recent);
  }
}

module.exports = { isRateLimited, cleanup };
