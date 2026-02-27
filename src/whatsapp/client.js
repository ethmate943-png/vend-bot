const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const { setQR, setConnected } = require('./qr-store');
const { isOutgoingMessageId } = require('./sender');

let sock = null;
let messageHandler = null;
let onConnectedCallback = null;
let retryCount = 0;
let connectedAt = 0;
const MAX_RETRIES = 5;

function useCloudApi() {
  return process.env.WHATSAPP_PROVIDER === 'cloud-api' ||
    process.env.USE_WHATSAPP_CLOUD_API === '1' ||
    process.env.USE_WHATSAPP_CLOUD_API === 'true';
}

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
  if (useCloudApi()) {
    const cloud = require('./cloud-api');
    cloud.setMessageHandler(messageHandler);
    cloud.setOnConnected(onConnectedCallback);
    return cloud.start();
  }

  const authPath = process.env.NODE_ENV === 'production'
    ? '/app/auth_info_baileys'
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

  const processedIds = new Set();
  const DEDUPE_TTL_MS = 60000;

  sock.ev.on('messages.upsert', async (upsert) => {
    for (const msg of upsert.messages || []) {
      const jid = msg.key?.remoteJid || '';
      const msgId = msg.key?.id;

      // Ignore echoes of messages that this process sent (especially in self-chat/@lid)
      if (msgId && isOutgoingMessageId(msgId)) continue;

      // Only process DMs (skip groups, broadcasts, status)
      if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
      // Skip our own messages to others, but allow \"message yourself\" / @lid so vendor can chat with the bot
      const botNum = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
      const remoteNum = jid.replace('@s.whatsapp.net', '').replace(/@lid.*$/, '').replace(/\D/g, '');
      const isSelfChat = remoteNum === botNum || jid.endsWith('@lid');
      if (msg.key?.fromMe && !isSelfChat) continue;
      if (!msg.message) continue;

      if (msgId) {
        if (processedIds.has(msgId)) continue;
        processedIds.add(msgId);
        setTimeout(() => processedIds.delete(msgId), DEDUPE_TTL_MS);
      }

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
      const ir = msg.message?.interactiveResponseMessage;
      const hasListReply = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || ir?.listReply?.singleSelectReply?.selectedRowId
        || ir?.listReply?.id
        || ir?.listReply?.selectedRowId
        || ir?.list_reply?.id
        || ir?.list_reply?.selectedRowId
        || msg.message?.templateButtonReplyMessage?.selectedId
        || !!ir; // pass through any interactive response so listener can try to parse
      const hasButtonReply = msg.message?.buttonsResponseMessage?.selectedButtonId;
      if (!body.trim() && !hasListReply && !hasButtonReply) continue;

      const phone = jid.replace('@s.whatsapp.net', '');
      if (process.env.PRIVACY_NO_CHAT_LOGS === 'true' || process.env.PRIVACY_NO_CHAT_LOGS === '1') {
        console.log('[WA] 📨 DM received');
      } else {
        console.log(`[WA] 📨 DM from ${phone}: "${body.slice(0, 60)}"`);
      }

      try {
        if (messageHandler) {
          await messageHandler(sock, msg);
        }
      } catch (err) {
        const status = err.status ?? err.response?.status ?? err.statusCode;
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
        console.error('[WA] Message handler error:', err.message, status ? `(${status})` : '', body || '');
        try {
          const jid = msg.key?.remoteJid;
          if (jid && sock && !msg.key?.fromMe) {
            await sock.sendMessage(jid, { text: 'Something went wrong on our end — please try again in a moment.' });
          }
        } catch (_) {}
      }
    }
  });

  return sock;
}

function getSock() {
  if (useCloudApi()) return require('./cloud-api').getSock();
  return sock;
}

module.exports = { startBot, getSock, setMessageHandler, setOnConnected };
