/**
 * Anti-ban: use baileys-antiban when available, otherwise a simple rate limiter.
 * Protects the WhatsApp number with human-like send delays and caps.
 */

const enabled = process.env.BAILEYS_ANTIBAN !== '0' && process.env.BAILEYS_ANTIBAN !== 'false';
const minDelayMs = Math.max(800, parseInt(process.env.BAILEYS_ANTIBAN_MIN_DELAY_MS || '1500', 10) || 1500);
const maxPerMinute = Math.min(60, Math.max(5, parseInt(process.env.BAILEYS_ANTIBAN_MAX_PER_MINUTE || '12', 10) || 12));

let lastSendAt = 0;
const sentInMinute = [];
const MINUTE_MS = 60 * 1000;

function trimSentInMinute() {
  const now = Date.now();
  while (sentInMinute.length && sentInMinute[0] < now - MINUTE_MS) sentInMinute.shift();
}

function simpleDelayMs() {
  const jitter = Math.floor((Math.random() * 0.4 + 0.8) * (minDelayMs * 0.5));
  return minDelayMs + jitter;
}

async function waitBeforeSend() {
  trimSentInMinute();
  if (sentInMinute.length >= maxPerMinute) {
    const wait = MINUTE_MS - (Date.now() - sentInMinute[0]);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    trimSentInMinute();
  }
  const sinceLast = Date.now() - lastSendAt;
  const delay = Math.max(0, simpleDelayMs() - sinceLast);
  if (delay > 0) await new Promise(r => setTimeout(r, delay));
  lastSendAt = Date.now();
  sentInMinute.push(lastSendAt);
}

function wrapWithSimpleLimiter(sock) {
  const orig = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, opts) => {
    await waitBeforeSend();
    return orig(jid, content, opts);
  };
  return sock;
}

let antibanModule = null;

async function loadAntibanModule() {
  if (antibanModule !== null) return antibanModule;
  try {
    antibanModule = await import('baileys-antiban');
    return antibanModule;
  } catch (e) {
    antibanModule = false;
    return false;
  }
}

/**
 * Wrap the socket with antiban when BAILEYS_ANTIBAN is enabled.
 * Uses baileys-antiban if the package loads, otherwise a simple delay/rate limit.
 * @param {object} rawSock - Baileys socket from makeWASocket
 * @returns {object} Socket (wrapped or original)
 */
async function wrapSocket(rawSock) {
  if (!enabled) return rawSock;

  const mod = await loadAntibanModule();
  if (mod && mod.wrapSocket) {
    try {
      const wrapped = mod.wrapSocket(rawSock);
      console.log('[WA] baileys-antiban enabled (rate limit + warm-up + health).');
      return wrapped;
    } catch (err) {
      console.warn('[WA] baileys-antiban wrap failed, using simple limiter:', err.message);
    }
  } else {
    if (enabled && mod === false) {
      console.log('[WA] baileys-antiban not available; using simple rate limiter (min delay + max/min).');
    }
  }

  return wrapWithSimpleLimiter(rawSock);
}

/**
 * Call when connection closes (so antiban can track disconnect reason).
 * @param {object} wrappedSock - Socket returned from wrapSocket (may have .antiban)
 * @param {number|undefined} statusCode - lastDisconnect?.error?.output?.statusCode
 */
function onDisconnect(wrappedSock, statusCode) {
  if (wrappedSock?.antiban?.onDisconnect) {
    try {
      wrappedSock.antiban.onDisconnect(statusCode);
    } catch (e) {
      // ignore
    }
  }
}

/**
 * Call when connection opens again.
 */
function onReconnect(wrappedSock) {
  if (wrappedSock?.antiban?.onReconnect) {
    try {
      wrappedSock.antiban.onReconnect();
    } catch (e) {
      // ignore
    }
  }
}

function getStats(wrappedSock) {
  if (wrappedSock?.antiban?.getStats) {
    try {
      return wrappedSock.antiban.getStats();
    } catch (e) {
      return null;
    }
  }
  return { enabled: true, fallback: 'simple', minDelayMs, maxPerMinute };
}

module.exports = {
  wrapSocket,
  onDisconnect,
  onReconnect,
  getStats,
  isEnabled: () => enabled,
};
