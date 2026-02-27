/**
 * WhatsApp Cloud API adapter for VendBot.
 * Used when WHATSAPP_PROVIDER=cloud-api. Provides same send/handler contract as Baileys
 * so the rest of the app (listener, sender, cron, webhooks) works unchanged.
 */

const https = require('https');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BASE_URL = `graph.facebook.com`;

let messageHandler = null;
let onConnectedCallback = null;
let cloudSock = null;
let isReady = false;

function setMessageHandler(handler) {
  messageHandler = handler;
}

function setOnConnected(cb) {
  onConnectedCallback = cb;
}

function getSock() {
  return cloudSock;
}

/** POST to Graph API */
function graphPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`https://${BASE_URL}/${path}`);
    const opts = {
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data, 'utf8')
      }
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); }
        } else {
          reject(new Error(`Cloud API ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Build Baileys-like message for the listener */
function normalizeWebhookMessage(entry) {
  const value = entry?.value || {};
  const messages = value.messages || [];
  const contacts = (value.contacts || []).reduce((acc, c) => {
    if (c.wa_id) acc[c.wa_id] = c;
    return acc;
  }, {});

  return messages
    .filter(m => !(m.from === undefined || m.id === undefined))
    .map(m => {
      const from = String(m.from || '').replace(/\D/g, '');
      const jid = from ? `${from}@s.whatsapp.net` : '';
      let message = {};
      if (m.type === 'text' && m.text?.body) {
        message.conversation = m.text.body;
      } else if (m.type === 'interactive') {
        const ir = m.interactive;
        const listReply = ir?.type === 'list_reply' ? ir.list_reply?.id : null;
        const buttonReply = ir?.type === 'button_reply' ? ir.button_reply?.id : null;
        if (listReply) {
          message.listResponseMessage = { singleSelectReply: { selectedRowId: listReply } };
          message.conversation = listReply;
        } else if (buttonReply) {
          message.buttonsResponseMessage = { selectedButtonId: buttonReply };
          message.conversation = buttonReply;
        } else {
          message.conversation = '';
        }
      } else if (m.type === 'image' || m.type === 'video') {
        const caption = m.image?.caption || m.video?.caption || '';
        message[`${m.type}Message`] = { caption };
        if (caption) message.extendedTextMessage = { text: caption };
        message.conversation = caption;
      } else {
        message.conversation = '';
      }

      const timestamp = Number(m.timestamp) || Math.floor(Date.now() / 1000);
      return {
        key: { remoteJid: jid, fromMe: false, id: m.id },
        message,
        messageTimestamp: timestamp,
        _cloudContact: contacts[m.from]
      };
    });
}

/**
 * Call this from the webhook POST handler with the parsed JSON body.
 * Delivers normalized messages to the registered message handler.
 */
async function receiveWebhookPayload(body) {
  if (!messageHandler || !cloudSock) return;
  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    const messages = normalizeWebhookMessage(entry);
    for (const msg of messages) {
      const jid = msg.key?.remoteJid || '';
      if (!jid.endsWith('@s.whatsapp.net')) continue;
      const bodyText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const hasList = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
      const hasButton = msg.message?.buttonsResponseMessage?.selectedButtonId;
      if (!bodyText.trim() && !hasList && !hasButton) continue;

      const phone = jid.replace('@s.whatsapp.net', '');
      if (process.env.PRIVACY_NO_CHAT_LOGS === 'true' || process.env.PRIVACY_NO_CHAT_LOGS === '1') {
        console.log('[WA Cloud] 📨 DM received');
      } else {
        console.log(`[WA Cloud] 📨 DM from ${phone}: "${(bodyText || '(list/button)').slice(0, 60)}"`);
      }

      try {
        await messageHandler(cloudSock, msg);
      } catch (err) {
        console.error('[WA Cloud] Message handler error:', err.message);
        try {
          await sendText(jid, 'Something went wrong on our end — please try again in a moment.');
        } catch (_) {}
      }
    }
  }
}

/** Send text message */
async function sendText(jid, text) {
  const to = (jid || '').replace(/@s\.whatsapp\.net|@lid.*$/g, '').replace(/\D/g, '');
  if (!to || !PHONE_NUMBER_ID || !ACCESS_TOKEN) return null;
  const path = `${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  return graphPost(path, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { body: String(text).slice(0, 4096) }
  });
}

/** Send image with optional caption */
async function sendImage(jid, imageUrl, caption) {
  const to = (jid || '').replace(/@s\.whatsapp\.net|@lid.*$/g, '').replace(/\D/g, '');
  if (!to || !PHONE_NUMBER_ID || !ACCESS_TOKEN) return null;
  const path = `${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  return graphPost(path, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'image',
    image: { link: imageUrl },
    caption: caption ? String(caption).slice(0, 1024) : undefined
  });
}

/** Interactive list (Cloud API format) */
async function sendList(jid, listPayload) {
  const to = (jid || '').replace(/@s\.whatsapp\.net|@lid.*$/g, '').replace(/\D/g, '');
  if (!to || !PHONE_NUMBER_ID || !ACCESS_TOKEN || !listPayload?.sections?.length) return null;
  const section = listPayload.sections[0];
  const rows = (section.rows || []).slice(0, 10).map((row) => ({
    id: String(row.rowId || row.id || '').slice(0, 200),
    title: String(row.title || '').slice(0, 24),
    description: row.description ? String(row.description).slice(0, 72) : undefined
  }));
  const path = `${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  return graphPost(path, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: (listPayload.title || 'Options').slice(0, 60) },
      body: { text: (listPayload.text || 'Pick an option').slice(0, 1024) },
      footer: listPayload.footer ? { text: listPayload.footer.slice(0, 60) } : undefined,
      action: {
        button: (listPayload.buttonText || 'Choose').slice(0, 20),
        sections: [{ rows }]
      }
    }
  });
}

/** Cloud API "sock" adapter: same surface as Baileys for sender.js */
function createCloudSock() {
  return {
    sendMessage: async (jid, payload) => {
      if (payload.text != null) {
        const res = await sendText(jid, payload.text);
        return res?.messages?.[0] ? { key: { id: res.messages[0].id } } : res;
      }
      if (payload.image?.url) {
        const res = await sendImage(jid, payload.image.url, payload.caption);
        return res?.messages?.[0] ? { key: { id: res.messages[0].id } } : res;
      }
      if (payload.sections?.length) {
        const res = await sendList(jid, payload);
        return res?.messages?.[0] ? { key: { id: res.messages[0].id } } : res;
      }
      return null;
    },
    sendPresenceUpdate: async (_type, _jid) => {
      /* Cloud API typing is optional; no-op keeps sender API compatible */
    }
  };
}

async function start() {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.warn('[WA Cloud] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN; Cloud API disabled.');
    return null;
  }
  cloudSock = createCloudSock();
  isReady = true;
  console.log('[WA Cloud] Adapter ready. Incoming messages via POST /webhook/whatsapp.');
  if (onConnectedCallback) {
    try { onConnectedCallback(); } catch (e) { console.error('[WA Cloud] onConnected error:', e.message); }
  }
  return cloudSock;
}

module.exports = {
  setMessageHandler,
  setOnConnected,
  getSock,
  start,
  receiveWebhookPayload,
  isCloudApiReady: () => !!cloudSock && isReady
};
