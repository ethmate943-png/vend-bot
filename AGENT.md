# AGENT.md — VendBot Build Instructions

> Feed this file to your AI coding agent (Claude, Cursor, Copilot, etc.) as the first message.
> The agent must read this entire file before writing a single line of code.

---

## Who You Are

You are building **VendBot** — a WhatsApp-native AI commerce bot for Nigerian vendors.
You are a senior Node.js engineer. You write clean, minimal, production-ready code.
You follow instructions exactly. You do not add features not listed here.
You do not skip steps. You complete each task fully before moving to the next.

---

## What You Are Building

A Node.js backend service that:
1. Connects to WhatsApp via Baileys (open-source WhatsApp Web client)
2. Receives buyer messages and classifies intent using Groq AI
3. Reads vendor inventory from Google Sheets in real time
4. Generates payment links via Mono API when buyer is ready to purchase
5. Receives payment confirmation via Mono webhook
6. Updates Google Sheet inventory (decrements quantity) after confirmed sale
7. Notifies vendor and buyer via WhatsApp after every transaction
8. Enforces escrow hold before releasing vendor payout
9. Monitors transaction velocity to detect scam behaviour
10. Runs cron jobs for payment expiry and escrow release

---

## Non-Negotiables

- Use **Express.js** — not NestJS, not Fastify, not Hapi
- Use **Baileys** for WhatsApp — not the official Meta API
- Use **Groq SDK** for AI — not OpenAI, not Anthropic
- Use **Mono REST API** for payments — not Paystack, not Flutterwave
- Use **Supabase JS client** for database — or raw `pg` if DATABASE_URL is set
- Use **dotenv** — all secrets come from `.env`, never hardcoded
- Every file must have a single clear responsibility
- No TypeScript — plain JavaScript (ES6+) only
- No unnecessary dependencies — only install what is listed

---

## Build Sequence — Follow This Exactly

Complete each step. Confirm it works before proceeding. Do not jump ahead.

### STEP 1 — Scaffold Project Structure

Create this exact folder and file structure:

```
vendbot/
├── src/
│   ├── whatsapp/
│   │   ├── client.js
│   │   ├── listener.js
│   │   └── sender.js
│   ├── ai/
│   │   ├── classifier.js
│   │   └── responder.js
│   ├── inventory/
│   │   └── sheets.js
│   ├── payments/
│   │   ├── mono.js
│   │   └── webhook.js
│   ├── sessions/
│   │   └── manager.js
│   ├── vendors/
│   │   └── resolver.js
│   ├── safety/
│   │   ├── velocity.js
│   │   └── escrow.js
│   ├── db.js
│   ├── server.js
│   ├── cron.js
│   └── index.js
├── .env.example
├── .gitignore
├── render.yaml
├── package.json
└── README.md
```

Run:
```bash
npm init -y
git init
echo "node_modules/" >> .gitignore
echo ".env" >> .gitignore
echo "auth_info_baileys/" >> .gitignore
```

**Done when:** All folders and empty files exist. package.json created.

---

### STEP 2 — Install All Dependencies

```bash
npm install @whiskeysockets/baileys @hapi/boom
npm install groq-sdk
npm install googleapis
npm install @supabase/supabase-js
npm install express
npm install dotenv
npm install axios
npm install qrcode-terminal
npm install node-cron
npm install winston
npm install uuid
npm install --save-dev nodemon jest
```

Add to package.json scripts:
```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "test": "jest"
  }
}
```

**Done when:** `node_modules/` exists with all packages. No install errors.

---

### STEP 3 — Create .env.example

```env
# GROQ
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=llama3-8b-8192
GROQ_MODEL_SMART=llama3-70b-8192

# MONO
MONO_SECRET_KEY=live_sk_xxxxxxxxxxxxxxxxxxxx
MONO_PUBLIC_KEY=live_pk_xxxxxxxxxxxxxxxxxxxx
MONO_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxx
MONO_BASE_URL=https://api.mono.co/v2

# SUPABASE
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbxxxxxxxxxxxxxxxxxxxxxxx

# GOOGLE SHEETS
GOOGLE_SERVICE_ACCOUNT_EMAIL=vendbot@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nxxxxxx\n-----END RSA PRIVATE KEY-----

# APP
PORT=3000
NODE_ENV=development
APP_URL=https://vendbot.onrender.com

# ESCROW
ESCROW_HOLD_NEW_VENDOR_HOURS=72
ESCROW_HOLD_ESTABLISHED_HOURS=24
ESTABLISHED_VENDOR_MIN_TRANSACTIONS=20

# SAFETY
VELOCITY_MAX_DAILY_MULTIPLIER=10
PAYMENT_LINK_EXPIRY_MINUTES=30
DISPUTE_WHATSAPP_NUMBER=2348000000000
```

**Done when:** `.env.example` exists. Developer copies it to `.env` and fills in real values.

---

### STEP 4 — Build src/db.js (Database Client)

```javascript
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = { supabase };
```

**Done when:** File exports supabase client. No errors on require.

---

### STEP 5 — Build src/whatsapp/client.js (Baileys Connection)

```javascript
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { handleMessage } = require('./listener');

let sock = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    getMessage: async () => ({ conversation: '' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('WhatsApp connected successfully');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });

  return sock;
}

function getSock() { return sock; }

module.exports = { startBot, getSock };
```

**Done when:** Running `node src/index.js` prints QR code. Scanning with WhatsApp connects successfully and logs "WhatsApp connected successfully".

---

### STEP 6 — Build src/whatsapp/sender.js

```javascript
async function sendMessage(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendWithDelay(sock, jid, text, delayMs = 1000) {
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(r => setTimeout(r, delayMs));
  await sendMessage(sock, jid, text);
  await sock.sendPresenceUpdate('paused', jid);
}

module.exports = { sendMessage, sendWithDelay };
```

---

### STEP 7 — Build src/inventory/sheets.js

```javascript
const { google } = require('googleapis');

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getInventory(sheetId, tab = 'Sheet1') {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A:F`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const [, ...data] = rows; // skip header
  return data
    .map(r => ({
      name: r[0] || '',
      sku: r[1] || '',
      price: Number(r[2]) || 0,
      quantity: Number(r[3]) || 0,
      category: r[4] || '',
    }))
    .filter(item => item.quantity > 0 && item.name);
}

async function decrementQty(sheetId, tab, sku) {
  const sheets = getSheetsClient();
  const inventory = await getInventory(sheetId, tab);
  const idx = inventory.findIndex(i => i.sku === sku);
  if (idx === -1) throw new Error(`SKU not found: ${sku}`);
  const excelRow = idx + 2; // +1 header, +1 one-indexed
  const newQty = Math.max(0, inventory[idx].quantity - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!D${excelRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[newQty]] },
  });
  return newQty;
}

module.exports = { getInventory, decrementQty };
```

**Done when:** `getInventory(sheetId)` returns an array of item objects from a test sheet.

---

### STEP 8 — Build src/ai/classifier.js

```javascript
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const VALID_INTENTS = ['QUERY', 'PURCHASE', 'NEGOTIATE', 'CANCEL', 'CONFIRM', 'OTHER'];

async function classifyIntent(message, sessionContext = {}) {
  const contextHint = sessionContext.intent_state === 'awaiting_payment'
    ? 'The buyer has already been sent a payment link.'
    : sessionContext.intent_state === 'querying'
    ? 'The buyer was just shown product info.'
    : '';

  const res = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama3-8b-8192',
    max_tokens: 10,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `Classify the buyer's WhatsApp message into exactly one of these intents:
QUERY - asking about product availability, details, or price
PURCHASE - ready to buy, saying yes, confirming they want the item
NEGOTIATE - asking for a lower price, discount, or better deal
CANCEL - no longer interested, wants to cancel
CONFIRM - confirming something (yes, okay, done, sure)
OTHER - anything not commerce-related
${contextHint}
Reply with ONLY the intent word. No punctuation. No explanation.`
      },
      { role: 'user', content: message }
    ]
  });

  const intent = res.choices[0].message.content.trim().toUpperCase();
  return VALID_INTENTS.includes(intent) ? intent : 'OTHER';
}

module.exports = { classifyIntent };
```

---

### STEP 9 — Build src/ai/responder.js

```javascript
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateReply(buyerMessage, inventory, vendorName) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i =>
        `- ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}, ${i.quantity} in stock${i.category ? `, Category: ${i.category}` : ''}`
      ).join('\n')
    : 'No items currently in stock.';

  const res = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL_SMART || 'llama3-70b-8192',
    max_tokens: 200,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `You are a friendly WhatsApp sales assistant for ${vendorName}.
Rules:
- ONLY use information from the inventory list below. Never make up prices or products.
- Keep replies to 2-3 sentences max.
- If item is out of stock or not listed, say so clearly and suggest alternatives from the list.
- Use natural Nigerian English. Be warm and helpful.
- If buyer asks about multiple items, address each one.
- When mentioning prices, always include the ₦ symbol.
- If quantity is 1-3, mention scarcity naturally ("Only 2 left!").

Current Inventory:
${inventoryText}`
      },
      { role: 'user', content: buyerMessage }
    ]
  });

  return res.choices[0].message.content.trim();
}

module.exports = { generateReply };
```

---

### STEP 10 — Build src/sessions/manager.js

```javascript
const { supabase } = require('../db');

async function getSession(buyerJid, vendorId) {
  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('buyer_jid', buyerJid)
    .eq('vendor_id', vendorId)
    .single();
  return data || null;
}

async function upsertSession(buyerJid, vendorId, updates) {
  const { error } = await supabase
    .from('sessions')
    .upsert(
      { buyer_jid: buyerJid, vendor_id: vendorId, ...updates, updated_at: new Date().toISOString() },
      { onConflict: 'buyer_jid,vendor_id' }
    );
  if (error) console.error('[SESSION ERROR]', error.message);
}

async function clearSession(buyerJid, vendorId) {
  await supabase
    .from('sessions')
    .update({ intent_state: 'idle', pending_payment_ref: null, last_item_sku: null, last_item_name: null })
    .eq('buyer_jid', buyerJid)
    .eq('vendor_id', vendorId);
}

module.exports = { getSession, upsertSession, clearSession };
```

---

### STEP 11 — Build src/vendors/resolver.js

```javascript
const { supabase } = require('../db');

async function getVendorByBotNumber(botNumber) {
  const clean = botNumber.replace(/[^0-9]/g, '');
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('whatsapp_number', clean)
    .single();
  if (error) return null;
  return data;
}

async function incrementNoCount(vendorId) {
  const { data: vendor } = await supabase
    .from('vendors').select('no_count, status').eq('id', vendorId).single();
  const newCount = (vendor?.no_count || 0) + 1;
  const updates = { no_count: newCount };
  if (newCount >= 5) updates.status = 'banned';
  else if (newCount >= 3) updates.status = 'flagged';
  await supabase.from('vendors').update(updates).eq('id', vendorId);
  return newCount;
}

module.exports = { getVendorByBotNumber, incrementNoCount };
```

---

### STEP 12 — Build src/payments/mono.js

```javascript
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../db');

async function generatePaymentLink({ amount, itemName, itemSku, buyerJid, vendorId }) {
  const reference = `VBOT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const buyerPhone = buyerJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

  const res = await axios.post(
    `${process.env.MONO_BASE_URL}/payments/initiate`,
    {
      amount: amount * 100, // convert to kobo
      type: 'onetime-debit',
      description: `Payment for ${itemName}`,
      reference,
      redirect_url: `${process.env.APP_URL}/payment/callback`,
      meta: { vendorId, buyerPhone, itemName, itemSku }
    },
    { headers: { 'mono-sec-key': process.env.MONO_SECRET_KEY } }
  );

  const monoLink = res.data.data.mono_url;

  // Store pending transaction
  await supabase.from('transactions').insert({
    vendor_id: vendorId,
    buyer_jid: buyerJid,
    buyer_phone: buyerPhone,
    item_name: itemName,
    item_sku: itemSku,
    amount: amount * 100,
    mono_ref: reference,
    mono_link: monoLink,
    status: 'pending'
  });

  return { link: monoLink, reference };
}

module.exports = { generatePaymentLink };
```

---

### STEP 13 — Build src/payments/webhook.js

```javascript
const { supabase } = require('../db');
const { decrementQty } = require('../inventory/sheets');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');
const { incrementNoCount } = require('../vendors/resolver');

async function handlePaymentSuccess(data) {
  const { reference } = data;
  const sock = getSock();

  const { data: txn } = await supabase
    .from('transactions')
    .select('*, vendors(*)')
    .eq('mono_ref', reference)
    .single();

  if (!txn) { console.error('[WEBHOOK] Transaction not found:', reference); return; }
  if (txn.status === 'paid') return; // idempotent

  const vendor = txn.vendors;
  const isEstablished = vendor.total_transactions >= Number(process.env.ESTABLISHED_VENDOR_MIN_TRANSACTIONS);
  const holdHours = isEstablished
    ? Number(process.env.ESCROW_HOLD_ESTABLISHED_HOURS)
    : Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);
  const releaseAt = new Date(Date.now() + holdHours * 3_600_000).toISOString();

  // Update transaction
  await supabase.from('transactions').update({
    status: 'paid',
    escrow_release_at: releaseAt
  }).eq('id', txn.id);

  // Update vendor stats
  await supabase.from('vendors').update({
    total_transactions: vendor.total_transactions + 1
  }).eq('id', vendor.id);

  // Decrement Google Sheet
  try {
    await decrementQty(vendor.sheet_id, vendor.sheet_tab, txn.item_sku);
    await supabase.from('transactions').update({ sheet_row_updated: true }).eq('id', txn.id);
  } catch (e) {
    console.error('[SHEET UPDATE ERROR]', e.message);
  }

  const amountFormatted = `₦${(txn.amount / 100).toLocaleString()}`;

  // Notify buyer
  await sendWithDelay(sock, txn.buyer_jid,
    `✅ *Payment confirmed!*\n\nYour order for *${txn.item_name}* (${amountFormatted}) has been placed.\n\n${vendor.business_name} will contact you shortly to arrange delivery.\n\n_Ref: ${reference}_`
  );

  // Notify vendor
  await sendWithDelay(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
    `🛍️ *New Sale!*\n\nItem: ${txn.item_name}\nAmount: ${amountFormatted}\nBuyer: ${txn.buyer_phone}\n\nPayout in ${holdHours}hrs if no dispute raised.\nRef: ${reference}`
  );

  // Delivery confirmation ping after 3 hours
  setTimeout(async () => {
    await sendWithDelay(sock, txn.buyer_jid,
      `Hi! Did you receive your *${txn.item_name}* from ${vendor.business_name}?\n\nReply *YES* ✅ or *NO* ❌`
    );
  }, 3 * 60 * 60 * 1000);
}

async function handleDeliveryReply(buyerJid, vendorId, reply) {
  const confirmed = reply.toLowerCase().includes('yes');
  const { data: txn } = await supabase
    .from('transactions')
    .select('*')
    .eq('buyer_jid', buyerJid)
    .eq('vendor_id', vendorId)
    .eq('status', 'paid')
    .eq('delivery_confirmed', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!txn) return;
  await supabase.from('transactions')
    .update({ delivery_confirmed: confirmed })
    .eq('id', txn.id);

  if (!confirmed) {
    const { incrementNoCount } = require('../vendors/resolver');
    await incrementNoCount(vendorId);
    const sock = getSock();
    await sendWithDelay(sock, buyerJid,
      `Sorry to hear that. We've flagged this for review. Please contact us at wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER} to raise a dispute and we will resolve it within 48 hours.`
    );
  }
}

module.exports = { handlePaymentSuccess, handleDeliveryReply };
```

---

### STEP 14 — Build src/whatsapp/listener.js (Main Message Router)

```javascript
const { classifyIntent } = require('../ai/classifier');
const { generateReply } = require('../ai/responder');
const { getInventory } = require('../inventory/sheets');
const { getVendorByBotNumber } = require('../vendors/resolver');
const { getSession, upsertSession } = require('../sessions/manager');
const { generatePaymentLink } = require('../payments/mono');
const { sendMessage, sendWithDelay } = require('./sender');
const { handleDeliveryReply } = require('../payments/webhook');

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const buyerJid = msg.key.remoteJid;
  if (buyerJid.includes('broadcast') || buyerJid.includes('status')) return;

  const text = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ''
  ).trim();
  if (!text) return;

  const botNumber = sock.user.id.split(':')[0];
  const vendor = await getVendorByBotNumber(botNumber);
  if (!vendor || vendor.status === 'banned' || vendor.status === 'suspended') return;

  const session = await getSession(buyerJid, vendor.id) || {};

  // Handle delivery confirmation replies
  if (session.intent_state === 'awaiting_delivery_confirm') {
    await handleDeliveryReply(buyerJid, vendor.id, text);
    return;
  }

  const intent = await classifyIntent(text, session);
  console.log(`[${vendor.business_name}] Buyer: "${text}" → Intent: ${intent}`);

  // ── QUERY ──
  if (intent === 'QUERY') {
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
    const reply = await generateReply(text, inventory, vendor.business_name);
    await sendWithDelay(sock, buyerJid, reply);
    await upsertSession(buyerJid, vendor.id, { intent_state: 'querying' });
  }

  // ── PURCHASE or CONFIRM after querying ──
  else if (intent === 'PURCHASE' || (intent === 'CONFIRM' && session.intent_state === 'querying')) {
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
    const lowerText = text.toLowerCase();
    const item = inventory.find(i =>
      lowerText.includes(i.name.toLowerCase()) ||
      (session.last_item_name && lowerText.includes('it') || lowerText.includes('this') || lowerText.includes('that'))
        ? i.name === session.last_item_name
        : false
    ) || (session.last_item_name && inventory.find(i => i.name === session.last_item_name));

    if (!item) {
      await sendWithDelay(sock, buyerJid, "Which item would you like to buy? Please mention the name.");
      return;
    }

    const { link, reference } = await generatePaymentLink({
      amount: item.price,
      itemName: item.name,
      itemSku: item.sku,
      buyerJid,
      vendorId: vendor.id
    });

    await sendWithDelay(sock, buyerJid,
      `Perfect! Here's your payment link for *${item.name}* — *₦${item.price.toLocaleString()}*\n\n🔗 ${link}\n\n_Pay via card, bank transfer, or USSD. Link expires in 30 minutes._`
    );

    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'awaiting_payment',
      pending_payment_ref: reference,
      last_item_sku: item.sku,
      last_item_name: item.name
    });
  }

  // ── NEGOTIATE ──
  else if (intent === 'NEGOTIATE') {
    if (vendor.negotiation_policy === 'escalate') {
      await sendWithDelay(sock, buyerJid, "Let me check with the vendor on that, give me a moment! 🙏");
      await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `💬 *Buyer wants to negotiate*\n\nItem: ${session.last_item_name || 'unknown'}\nBuyer message: "${text}"\n\nReply to this to take over the chat.`
      );
    } else {
      await sendWithDelay(sock, buyerJid, `The price is fixed at ₦${session.last_item_price || 'the listed price'}. Ready to pay? 😊`);
    }
  }

  // ── CANCEL ──
  else if (intent === 'CANCEL') {
    await sendWithDelay(sock, buyerJid, "No problem at all! Feel free to message anytime you're ready. 👋");
    await upsertSession(buyerJid, vendor.id, { intent_state: 'idle', last_item_name: null, last_item_sku: null });
  }

  // ── OTHER ──
  else {
    await sendWithDelay(sock, buyerJid, `Hi! I'm the shopping assistant for *${vendor.business_name}*. Ask me what's available and I'll help you find it! 😊`);
  }
}

module.exports = { handleMessage };
```

---

### STEP 15 — Build src/server.js (Express + Webhook)

```javascript
const express = require('express');
const crypto = require('crypto');
const { handlePaymentSuccess } = require('./payments/webhook');

const app = express();

// Raw body for webhook signature verification — must come before json middleware
app.use('/webhook/mono', express.raw({ type: 'application/json' }));
app.use(express.json());

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'vendbot', timestamp: new Date().toISOString() }));

// Payment callback (buyer redirect after paying)
app.get('/payment/callback', (req, res) => {
  res.send('<h2>Payment received! Return to WhatsApp to see your confirmation.</h2>');
});

// Mono webhook
app.post('/webhook/mono', async (req, res) => {
  const sig = req.headers['mono-signature'];
  if (!sig) return res.status(401).json({ error: 'No signature' });

  const hash = crypto
    .createHmac('sha512', process.env.MONO_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== sig) {
    console.warn('[WEBHOOK] Invalid signature — possible spoofed request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);
  console.log('[WEBHOOK] Event received:', event.event);

  if (event.event === 'payment.successful') {
    await handlePaymentSuccess(event.data);
  }

  res.status(200).json({ received: true });
});

module.exports = app;
```

---

### STEP 16 — Build src/cron.js

```javascript
const cron = require('node-cron');
const { supabase } = require('./db');
const { getSock } = require('./whatsapp/client');
const { sendMessage } = require('./whatsapp/sender');

function startCronJobs() {
  // Every 30 mins — expire unpaid payment links
  cron.schedule('*/30 * * * *', async () => {
    const cutoff = new Date(Date.now() - Number(process.env.PAYMENT_LINK_EXPIRY_MINUTES) * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('transactions')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('created_at', cutoff);
    if (count > 0) console.log(`[CRON] Expired ${count} payment links`);
  });

  // Every hour — release escrow payouts
  cron.schedule('0 * * * *', async () => {
    const now = new Date().toISOString();
    const { data: due } = await supabase
      .from('transactions')
      .select('*, vendors(*)')
      .eq('status', 'paid')
      .eq('payout_released', false)
      .lte('escrow_release_at', now);

    for (const txn of due || []) {
      const { data: dispute } = await supabase
        .from('disputes')
        .select('id')
        .eq('transaction_id', txn.id)
        .eq('status', 'open')
        .single();

      if (!dispute) {
        // TODO: Call Mono disbursement API here
        await supabase.from('transactions').update({ payout_released: true }).eq('id', txn.id);
        console.log(`[CRON] Released payout for txn ${txn.id}`);
      }
    }
  });

  // Daily 8am — stock accuracy reminder to vendors
  cron.schedule('0 8 * * *', async () => {
    const sock = getSock();
    if (!sock) return;
    const { data: vendors } = await supabase
      .from('vendors').select('whatsapp_number').eq('status', 'active');
    for (const v of vendors || []) {
      await sendMessage(sock, `${v.whatsapp_number}@s.whatsapp.net`,
        '📦 Good morning! Please check your Google Sheet is up to date before buyers start messaging today. Reply DONE when ready.'
      );
    }
  });

  console.log('[CRON] Scheduled jobs started');
}

module.exports = { startCronJobs };
```

---

### STEP 17 — Build src/index.js (Entry Point)

```javascript
require('dotenv').config();
const { startBot } = require('./whatsapp/client');
const { startCronJobs } = require('./cron');
const app = require('./server');

async function main() {
  console.log('🚀 Starting VendBot...');

  // Start Express server
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });

  // Start WhatsApp bot
  await startBot();

  // Start scheduled jobs
  startCronJobs();

  console.log('✅ VendBot running. Waiting for messages...');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

---

### STEP 18 — Create render.yaml

```yaml
services:
  - type: web
    name: vendbot
    env: node
    plan: starter
    region: oregon
    buildCommand: npm install
    startCommand: node src/index.js
    healthCheckPath: /health
    disk:
      name: auth-storage
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: NODE_ENV
        value: production
      - key: GROQ_API_KEY
        sync: false
      - key: GROQ_MODEL
        value: llama3-8b-8192
      - key: GROQ_MODEL_SMART
        value: llama3-70b-8192
      - key: MONO_SECRET_KEY
        sync: false
      - key: MONO_PUBLIC_KEY
        sync: false
      - key: MONO_WEBHOOK_SECRET
        sync: false
      - key: MONO_BASE_URL
        value: https://api.mono.co/v2
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      - key: GOOGLE_SERVICE_ACCOUNT_EMAIL
        sync: false
      - key: GOOGLE_PRIVATE_KEY
        sync: false
      - key: APP_URL
        sync: false
      - key: PAYMENT_LINK_EXPIRY_MINUTES
        value: '30'
      - key: ESCROW_HOLD_NEW_VENDOR_HOURS
        value: '72'
      - key: ESCROW_HOLD_ESTABLISHED_HOURS
        value: '24'
      - key: ESTABLISHED_VENDOR_MIN_TRANSACTIONS
        value: '20'
      - key: VELOCITY_MAX_DAILY_MULTIPLIER
        value: '10'
      - key: DISPUTE_WHATSAPP_NUMBER
        sync: false
```

> Note: The `disk` block mounts persistent storage for Baileys auth state.
> Update Baileys auth path to `/data/auth_info_baileys` instead of `auth_info_baileys`.

---

### STEP 19 — Run Database Migrations

Run this SQL in your Supabase SQL Editor:

```sql
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number TEXT UNIQUE NOT NULL,
  business_name TEXT,
  bvn_verified BOOLEAN DEFAULT false,
  mono_account_id TEXT,
  sheet_id TEXT,
  sheet_tab TEXT DEFAULT 'Sheet1',
  status TEXT DEFAULT 'probation',
  total_transactions INT DEFAULT 0,
  yes_count INT DEFAULT 0,
  no_count INT DEFAULT 0,
  trust_score DECIMAL DEFAULT 0,
  negotiation_policy TEXT DEFAULT 'escalate',
  language TEXT DEFAULT 'english',
  daily_avg_transactions DECIMAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_jid TEXT NOT NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  last_item_sku TEXT,
  last_item_name TEXT,
  intent_state TEXT DEFAULT 'idle',
  pending_payment_ref TEXT,
  message_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(buyer_jid, vendor_id)
);
CREATE INDEX idx_sessions_buyer ON sessions(buyer_jid);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendors(id),
  buyer_jid TEXT NOT NULL,
  buyer_phone TEXT,
  item_name TEXT NOT NULL,
  item_sku TEXT,
  amount BIGINT NOT NULL,
  mono_ref TEXT UNIQUE,
  mono_link TEXT,
  status TEXT DEFAULT 'pending',
  delivery_confirmed BOOLEAN,
  escrow_release_at TIMESTAMPTZ,
  payout_released BOOLEAN DEFAULT false,
  sheet_row_updated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_txn_mono_ref ON transactions(mono_ref);
CREATE INDEX idx_txn_vendor ON transactions(vendor_id, created_at DESC);
CREATE INDEX idx_txn_escrow ON transactions(status, escrow_release_at);

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  buyer_jid TEXT,
  vendor_id UUID REFERENCES vendors(id),
  reason TEXT,
  status TEXT DEFAULT 'open',
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

### STEP 20 — End-to-End Test Checklist

Before marking build complete, verify every item:

- [ ] `GET /health` returns `{status: "ok"}`
- [ ] Bot connects to WhatsApp after QR scan
- [ ] Buyer message "do you have X?" returns AI reply from sheet
- [ ] Buyer "I want to buy it" generates Mono payment link
- [ ] Paying via Mono sandbox triggers webhook
- [ ] Webhook updates transaction to `paid` in Supabase
- [ ] Google Sheet quantity decrements by 1
- [ ] Buyer receives receipt message on WhatsApp
- [ ] Vendor receives sale notification on WhatsApp
- [ ] 30-min cron expires unpaid links correctly
- [ ] "NO" reply from buyer increments vendor `no_count`

---

## Rules You Must Follow

1. **Never hardcode secrets** — all from `.env`
2. **Never skip error handling** — wrap all async calls in try/catch or handle errors explicitly
3. **Never modify Google Sheet structure** — only update the quantity column (column D)
4. **Always verify Mono webhook signature** — reject any request without valid HMAC
5. **Always use `getSock()`** — never pass `sock` as a prop through many layers
6. **Log everything** — use `console.log` with `[MODULE_NAME]` prefix on every significant event
7. **Test each step before moving on** — do not chain-build without verification

---

## You Are Done When

A complete buyer journey works end-to-end:

```
Buyer: "Do you have black sneakers?"
Bot:   "Yes! Black Air Force 1 — ₦25,000. Only 2 left. Want one?"
Buyer: "Yes I want it"
Bot:   "Here's your payment link: [link]. Expires in 30 mins."
Buyer: [pays via Mono]
Bot → Buyer: "✅ Payment confirmed! Your order is placed."
Bot → Vendor: "🛍️ New Sale! Black Air Force 1 — ₦25,000. Payout in 72hrs."
Sheet: Quantity reduced from 2 to 1.
```

**That's the definition of done. Ship it.**

---

## Conversation Engine Updates (VendBot)

> VENDBOT — CONVERSATION ENGINE UPDATES ONLY  
> All updates from this session. Add to AGENT.md.

### New Files

- `src/sessions/pattern.js`
  - `readConversationPattern(history)`
  - Looks at last 10 user messages
  - Counts commerce signal ratio
  - Returns: `fresh` | `just_talking` | `mostly_talking` | `shopping_mode` | `mixed`
  - `COMMERCE_SIGNALS` array:
    - price/cost/₦, buy/pay/order, available/in stock, delivery, size/colour

- `src/ai/gatekeeper.js`
  - `shouldRespond(text, vendor, session)`
  - Two modes based on conversation state:
    - **Active conversation** (`message_count > 0`):
      - Only block: "ok/k/kk", "lol/lmao", single emoji, single character
      - Everything else passes through
    - **Fresh conversation**:
      - Block: greeting only, acknowledgement, emoji only, identity questions, farewell
      - Greetings → return welcome override
      - Identity → return assistant intro override
      - Ambiguous short message → AI relevance check
      - Anything with commerce signal → always passes

- `src/sessions/context.js`
  - `buildContext(buyerJid, vendor, session)`
  - `extractDiscussedItems(history)`
  - `detectCurrentFocus(history, session)` → returns: `multi_item` | `topic_switch` | `single_item`
  - Returns full context object:
    - `intentState`, `messageCount`, `lastItem`, `cart`, `cartTotal`, `history`, `discussedItems`, `currentFocus`, `recentTransactions`, `isReturning`

- `src/inventory/matcher.js`
  - `normalise(str)`
  - `findItemInText(text, inventory)`
    - exact match first
    - then fuzzy word-level levenshtein ≤ 2
  - `findMultipleItemsInText(text, inventory)`
    - finds **all** items mentioned in one message
    - used for `PURCHASE_MULTI` intent

### Updated Files

- `src/ai/responder.js`
  - Add `detectBuyerEnergy(message)`:
    - checks for Pidgin keywords, excitement, message length, formal language
    - returns: `pidgin` | `excited` | `casual` | `formal` | `neutral`
  - Add `ENERGY_GUIDE` map:
    - `pidgin` → match fully, use Pidgin naturally
    - `excited` → match warmly, one exclamation max
    - `casual` → 2 sentences max, don't over-explain
    - `formal` → professional, full sentences
    - `neutral` → warm Nigerian English
  - Add `CATEGORY_PERSONA` map:
    - `fashion` → good taste, knows what works
    - `food` → warm like aunty, genuine enthusiasm
    - `electronics` → knowledgeable, simplify specs
    - `beauty` → encouraging, knows what works
    - `furniture` → practical, help them visualise
    - `other` → warm helpful Nigerian energy
  - Extend `buildSystemPrompt`:
    - Inject energy guide and category persona
    - Add **variety rules**:
      - never start two replies the same way
      - rotate confirmation words
      - vary answer structure
      - one follow-up question max, only if helpful
      - short message = short reply
    - Add **natural language examples** block:
      - available, scarcity, price, unavailable, post-payment — style only, not word for word
    - Add **banned words** list:
      - Absolutely, Certainly, Of course, Great choice, Feel free, Don't hesitate, I'd be happy to, Wonderful, Fantastic, Noted
    - Inject **state hints**:
      - `querying` → what item was last discussed
      - `awaiting_payment` → link already sent
      - `awaiting_delivery_confirm` → waiting for reply
  - Add `generateContextualResponse(text, vendor, history, pattern)`:
    - Used when pattern is `just_talking` or `mostly_talking`
    - Pattern-specific:
      - `just_talking`:
        - do **not** sell anything
        - do **not** suggest products
        - do **not** ask "are you looking for something"
        - respond like a warm human, short, match energy, let them lead
      - `mostly_talking`:
        - respond naturally
        - acknowledge product mentions if they come up
        - do not push, suggest, or nudge
        - let them lead
      - `mixed`:
        - follow their lead
        - engage commerce angle only if they raised it
        - never force commerce into non-commerce message
  - Update `generateReply` signature:
    - `generateReply(message, inventory, vendor, history, session)`
    - Pass `history` and `session` (state hints) into the model

- `src/ai/classifier.js`
  - Add new intents:
    - `PURCHASE_MULTI` — buying multiple items at once
    - `ADD_TO_CART` — add item, keep browsing
    - `VIEW_CART` — wants to see cart
    - `TOPIC_SWITCH` — moving to a different item entirely
  - Update classifier prompt:
    - Accept and use **full context** object, not just `session`
    - Include recent 6 messages as conversation snippet
    - Include current state hint and cart state
    - Include `currentFocus` hint
    - Add explicit Nigerian Pidgin examples per intent
    - Add negative examples to prevent misrouting:
      - "yes" after product = `PURCHASE`
      - "yes" after question = `CONFIRM`
      - "how much" alone = `QUERY` (not `PURCHASE`)
      - "abeg reduce am" = `NEGOTIATE`
      - delivery/size questions = `QUERY`

- `src/sessions/manager.js`
  - Add `appendHistory(buyerJid, vendorId, role, content)`:
    - appends `{ role, content, ts }` to `conversation_history`
    - trims to last 12 messages
  - Ensure `getSession` returns `conversation_history`
  - Track first message always regardless of gatekeeper:
    - `isFirstMessage = message_count === 0`
    - if first message → save to history even if blocked
  - Track blocked messages as placeholders:
    - gatekeeper blocks mid-convo →
    - append `{ role: 'user', content: '[acknowledgement]' }`

- `src/whatsapp/sender.js`
  - Update `sendWithDelay`:
    - Calculate typing time from word count:
      - `delayMs = clamp(600 + wordCount * 120, 600, 2500)`
    - Show composing indicator during delay, paused after send

- `src/whatsapp/listener.js` (buyer flow)
  - At top of `handleBuyerFlow`:
    - `isFirstMessage` check
    - `bot_paused` check
  - **Layer 1 — gatekeeper**:
    - import `shouldRespond`
    - if `!gate.respond`:
      - if first message → `appendHistory` with actual text
      - else → `appendHistory` with `[reason]` placeholder
      - return early
    - if `gate.override`:
      - send override
      - `appendHistory` both sides
      - increment `message_count`
      - return
  - **Layer 2 — context builder**:
    - import `buildContext`
    - call before `classifyIntent`
    - pass context to all downstream calls
  - **Layer 3 — pattern reader**:
    - import `readConversationPattern`
    - call after `buildContext`
    - if `just_talking` or `mostly_talking`:
      - skip classification
      - call `generateContextualResponse` with pattern
      - `appendHistory` both sides
      - return early
  - Update intent handling:
    - Pass full context into classifier
    - Add `TOPIC_SWITCH` handler:
      - clear `last_item_*` and `last_item_price_*` in session
      - rebuild context, treat as fresh `QUERY`
    - Add `PURCHASE_MULTI` handler:
      - use `findMultipleItemsInText`
      - add all found items to cart
      - send cart summary with total
      - invite to PAY or keep browsing
    - Add `ADD_TO_CART` handler:
      - use `findItemInText` or `lastItem`
      - add to cart
      - confirm addition with cart count/total
    - Add `VIEW_CART` handler:
      - get cart
      - format and send
    - Update `OTHER` intent handler:
      - if conversation active → `generateContextualResponse`
      - if fresh → welcome message and ask what they want
  - Always call `appendHistory` after every exchange (user + bot)

### Database

- `migrations/002_conversation_updates.sql`
  - `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS conversation_history JSONB DEFAULT '[]';`
  - `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS message_count INT DEFAULT 0;`
  - `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_state TEXT;`
  - `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_state_data JSONB;`

### Build Order

1. `migrations/002_conversation_updates.sql`
2. `src/sessions/pattern.js`
3. `src/inventory/matcher.js`
4. `src/sessions/context.js`
5. `src/ai/gatekeeper.js`
6. `src/sessions/manager.js` (appendHistory update)
7. `src/whatsapp/sender.js` (typing delay update)
8. `src/ai/classifier.js` (new intents + context)
9. `src/ai/responder.js` (energy + persona + contextual)
10. `src/whatsapp/listener.js` (full handleBuyerFlow update)
