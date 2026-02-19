const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const { setQR, setConnected } = require('./qr-store');

let sock = null;
let messageHandler = null;
let onConnectedCallback = null;
let retryCount = 0;
let connectedAt = 0;
const MAX_RETRIES = 5;

// Known Baileys noise (groups/decrypt/ack) — show one line instead of full JSON
const NOISE_PATTERNS = [
  /failed to decrypt message|No session found to decrypt/,
  /transaction failed, rolling back/,
  /received error in ack/
];
function getMsg(args) {
  if (args.length === 0) return '';
  const last = args[args.length - 1];
  if (typeof last === 'string') return last;
  if (args[0] && typeof args[0] === 'object' && args[0].msg) return args[0].msg;
  return '';
}
const baileysLogger = {
  child: () => baileysLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => {
    const msg = getMsg(args);
    if (NOISE_PATTERNS.some(p => p.test(msg))) {
      console.warn('[VendBot] WA: group/decrypt or ack noise (ignored)');
      return;
    }
    if (msg) console.warn('[WA]', msg);
  },
  error: (...args) => {
    const msg = getMsg(args);
    if (NOISE_PATTERNS.some(p => p.test(msg))) {
      console.warn('[VendBot] WA: group/decrypt or ack noise (ignored)');
      return;
    }
    if (msg) console.error('[WA]', msg);
  },
  fatal: () => {}
};

function setMessageHandler(handler) {
  messageHandler = handler;
}

function setOnConnected(cb) {
  onConnectedCallback = cb;
}

async function startBot() {
  const authPath = process.env.NODE_ENV === 'production'
    ? '/data/auth_info_baileys'
    : 'auth_info_baileys';

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: '' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      setQR(qr);
      // Terminal QR: kept in all environments (dev + prod) so you can test from the logs
      console.log('\n[WA] Scan this QR in terminal below, or open /qr on this server:\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      setConnected(false);
      setQR(null);

      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out — clearing session and restarting for fresh QR...');
        fs.rmSync(authPath, { recursive: true, force: true });
        await new Promise(r => setTimeout(r, 2000));
        startBot();
        return;
      }

      if (code === 440) {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          console.error('[WA] Too many conflict errors. Close WhatsApp Web in your browser, then restart the bot.');
          return;
        }
        const delay = retryCount * 5000;
        console.log(`[WA] Conflict (session replaced). Retry ${retryCount}/${MAX_RETRIES} in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        startBot();
        return;
      }

      retryCount = 0;
      console.log('[WA] Connection closed. Code:', code, '— Reconnecting in 3s...');
      await new Promise(r => setTimeout(r, 3000));
      startBot();
    } else if (connection === 'open') {
      retryCount = 0;
      connectedAt = Math.floor(Date.now() / 1000);
      setConnected(true);
      console.log('[WA] WhatsApp connected successfully (timestamp:', connectedAt + ')');
      if (onConnectedCallback) {
        try { onConnectedCallback(); } catch (e) { console.error('[WA] onConnected callback error:', e.message); }
      }
    }
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages || []) {
      const jid = msg.key?.remoteJid || '';

      // Only process DMs (skip groups, broadcasts, status)
      if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
      if (msg.key?.fromMe) continue;
      if (!msg.message) continue;

      // Skip messages from before we connected (offline/queued messages)
      const ts = typeof msg.messageTimestamp === 'object'
        ? msg.messageTimestamp.low
        : Number(msg.messageTimestamp) || 0;
      if (ts && ts < connectedAt) {
        continue;
      }

      const body = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';
      if (!body.trim()) continue;

      const phone = jid.replace('@s.whatsapp.net', '');
      console.log(`[WA] 📨 DM from ${phone}: "${body.slice(0, 60)}"`);

      try {
        if (messageHandler) {
          await messageHandler(sock, msg);
        }
      } catch (err) {
        console.error('[WA] Message handler error:', err.message);
      }
    }
  });

  return sock;
}

function getSock() { return sock; }

module.exports = { startBot, getSock, setMessageHandler, setOnConnected };
