# AGENT_UPDATE.md — VendBot Updates

> This file patches the original AGENT.md.
> Read the original AGENT.md first, then apply everything in this file on top of it.
> Where this file conflicts with the original — this file wins.

---

## What Changed & Why

| Area | Change | Reason |
|------|--------|--------|
| Architecture | Single number, store codes | Vendors share a link not a SIM |
| Payments | Mono → Paystack | No AML certificate required |
| AI responses | Groq only → Groq + Kimi K2 | Better tool-calling, free via NVIDIA |
| Inventory input | Sheets only → voice/text/commands | Most vendors won't use spreadsheets |
| Post-sale | Nothing → full CRM layer | Vendor needs to reach buyer after sale |
| Agents | None → 3 autonomous agents | Content, abandonment recovery, pricing |
| Onboarding | Manual DB insert → conversational | Vendor never leaves WhatsApp |
| Trust | Plain escrow → progressive trust stages | Most vendors won't trust platform initially |

---

## UPDATE 1 — Architecture: Single Number, Multi-Vendor

**Replace** the architecture section in AGENT.md with this:

Every buyer messages ONE VendBot number. The first message is a store code that routes them to the correct vendor. Sessions persist 24 hours.

```
Vendor shares: wa.me/2348XXXXXXX?text=AMAKA
Buyer taps link → WhatsApp opens → sends "AMAKA" automatically
Bot: "Welcome to Amaka Fashion! What are you looking for?"
All subsequent messages → routed to Amaka's store
```

**Add** `store_code` to the vendors table:

```sql
ALTER TABLE vendors ADD COLUMN store_code TEXT UNIQUE NOT NULL DEFAULT '';
ALTER TABLE vendors ADD COLUMN onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE vendors ADD COLUMN onboarding_step TEXT DEFAULT 'start';
CREATE INDEX idx_vendors_store_code ON vendors(store_code);
```

**Add** to `src/vendors/resolver.js`:

```javascript
async function getVendorByStoreCode(code) {
  const { data } = await supabase
    .from('vendors')
    .select('*')
    .eq('store_code', code.toUpperCase().trim())
    .single();
  return data || null;
}
module.exports = { ...existing, getVendorByStoreCode };
```

---

## UPDATE 2 — Payments: Mono → Paystack

**Replace** `src/payments/mono.js` entirely with `src/payments/paystack.js`:

```javascript
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../db');

async function generatePaymentLink({ amount, itemName, itemSku, buyerJid, vendorId }) {
  const reference = `VBOT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const buyerPhone = buyerJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

  const res = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email: `${buyerPhone}@vendbot.app`,
      amount: amount * 100,
      reference,
      callback_url: `${process.env.APP_URL}/payment/callback`,
      metadata: { vendorId, buyerPhone, itemName, itemSku }
    },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );

  const paymentLink = res.data.data.authorization_url;

  await supabase.from('transactions').insert({
    vendor_id: vendorId,
    buyer_jid: buyerJid,
    buyer_phone: buyerPhone,
    item_name: itemName,
    item_sku: itemSku,
    amount: amount * 100,
    paystack_ref: reference,
    payment_link: paymentLink,
    status: 'pending'
  });

  return { link: paymentLink, reference };
}

module.exports = { generatePaymentLink };
```

**Replace** Mono webhook in `src/server.js` with Paystack webhook:

```javascript
const crypto = require('crypto');

// Replace /webhook/mono route with:
app.use('/webhook/paystack', express.raw({ type: 'application/json' }));

app.post('/webhook/paystack', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);
  if (event.event === 'charge.success') {
    await handlePaymentSuccess(event.data.reference);
  }
  res.status(200).json({ received: true });
});
```

**Update** `.env` — remove Mono keys, add Paystack:

```env
# Remove:
# MONO_SECRET_KEY
# MONO_PUBLIC_KEY
# MONO_WEBHOOK_SECRET
# MONO_BASE_URL

# Add:
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxxxxxxxxxxxxxx
```

**Update** `transactions` table — rename column:

```sql
ALTER TABLE transactions RENAME COLUMN mono_ref TO paystack_ref;
ALTER TABLE transactions RENAME COLUMN mono_link TO payment_link;
```

---

## UPDATE 3 — AI: Add Kimi K2 via NVIDIA NIMs (Free)

**Install:**

```bash
npm install openai
```

**Add** to `.env`:

```env
KIMI_API_KEY=nvapi_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
KIMI_BASE_URL=https://integrate.api.nvidia.com/v1
KIMI_MODEL=moonshotai/kimi-k2
```

Get free key at `build.nvidia.com` → search "Kimi K2" → Get API Key. No card needed.

**Replace** `src/ai/responder.js` entirely:

```javascript
require('dotenv').config();
const { OpenAI } = require('openai');

const kimi = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: process.env.KIMI_BASE_URL
});

async function generateReply(buyerMessage, inventory, vendorName, sessionContext = {}) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i => {
        const scarcity = i.quantity === 1 ? ' — LAST ONE'
          : i.quantity <= 3 ? ` — only ${i.quantity} left` : '';
        return `- ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}${scarcity}`;
      }).join('\n')
    : 'No items currently in stock.';

  const context = sessionContext.last_item_name
    ? `\nLast discussed: ${sessionContext.last_item_name} at ₦${sessionContext.last_item_price?.toLocaleString()}`
    : '';

  const res = await kimi.chat.completions.create({
    model: process.env.KIMI_MODEL,
    max_tokens: 220,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `You are a WhatsApp sales assistant for ${vendorName} in Nigeria.
Be warm, brief (2-3 sentences max), natural Nigerian English.
Only reference items listed below. Never invent products or prices.
If quantity is 1, mention it — "last one remaining!"
${context}
INVENTORY:
${inventoryText}`
      },
      { role: 'user', content: buyerMessage }
    ]
  });

  return res.choices[0].message.content.trim();
}

module.exports = { generateReply };
```

Keep `src/ai/classifier.js` unchanged — Groq stays for classification.

---

## UPDATE 4 — New File: src/ai/extractor.js

Extracts structured inventory from voice notes and natural language text.

```javascript
require('dotenv').config();
const { OpenAI } = require('openai');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const kimi = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: process.env.KIMI_BASE_URL
});

async function extractInventoryFromText(text) {
  const res = await kimi.chat.completions.create({
    model: process.env.KIMI_MODEL,
    max_tokens: 500,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `Extract inventory items from vendor message.
Return valid JSON array only. No explanation. No markdown.
Format: [{"name":"...","sku":"...","price":0,"quantity":0,"category":"..."}]
Generate SKU from name if not given. Price is Naira number only.`
      },
      { role: 'user', content: text }
    ]
  });

  try {
    return JSON.parse(res.choices[0].message.content.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('[EXTRACTOR] Parse failed:', e.message);
    return [];
  }
}

async function extractInventoryFromVoice(audioBuffer, mimeType = 'audio/ogg') {
  const transcription = await groq.audio.transcriptions.create({
    file: new File([audioBuffer], 'audio.ogg', { type: mimeType }),
    model: 'whisper-large-v3',
    language: 'en'
  });
  console.log('[VOICE]', transcription.text);
  return extractInventoryFromText(transcription.text);
}

module.exports = { extractInventoryFromText, extractInventoryFromVoice };
```

---

## UPDATE 5 — New File: src/inventory/commands.js

Vendors manage stock entirely via WhatsApp. No spreadsheet knowledge needed.

```javascript
const { getInventory, addItemsToSheet, updateItemQty, decrementQty } = require('./sheets');
const { extractInventoryFromText } = require('../ai/extractor');
const { supabase } = require('../db');

async function handleInventoryCommand(text, vendor) {
  const lower = text.toLowerCase().trim();

  // ADD: "add: black sneakers size 42, 25000, 3 in stock"
  if (lower.startsWith('add:') || lower.startsWith('add ')) {
    const content = text.replace(/^add:?\s*/i, '');
    const items = await extractInventoryFromText(content);
    if (!items.length) return 'Could not understand. Try: "add: item name, price, quantity"';
    await addItemsToSheet(vendor.sheet_id, vendor.sheet_tab, items);
    const summary = items.map(i => `• ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`).join('\n');
    return `Added ${items.length} item(s) ✅\n\n${summary}`;
  }

  // SOLD: "sold: black sneakers" — decrements by 1
  if (lower.startsWith('sold:') || lower.startsWith('sold ')) {
    const itemName = text.replace(/^sold:?\s*/i, '').trim();
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}". Check spelling.`;
    const { newQty } = await decrementQty(vendor.sheet_id, vendor.sheet_tab, item.sku);
    return `Marked as sold ✅\n${item.name} — ${newQty} remaining`;
  }

  // RESTOCK: "restock: black sneakers, 10"
  if (lower.startsWith('restock:') || lower.startsWith('restock ')) {
    const parts = text.replace(/^restock:?\s*/i, '').split(',');
    const itemName = parts[0]?.trim();
    const newQty = parseInt(parts[1]?.trim());
    if (!itemName || isNaN(newQty)) return 'Format: "restock: item name, new quantity"';
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
    const item = inventory.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `Could not find "${itemName}".`;
    await updateItemQty(vendor.sheet_id, vendor.sheet_tab, item.sku, newQty);

    // Notify waitlist buyers
    const { data: waiters } = await supabase
      .from('waitlist').select('buyer_jid')
      .eq('vendor_id', vendor.id).eq('item_sku', item.sku).eq('notified', false);

    return { reply: `Updated ✅ ${item.name} — ${newQty} in stock`, waitlistBuyers: waiters || [], restockedItem: item };
  }

  // LIST: show full inventory
  if (lower === 'list' || lower === 'inventory') {
    const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
    if (!inventory.length) return 'Your inventory is empty. Send "add: [item], [price], [qty]" to add items.';
    return `📦 *Your Inventory (${inventory.length} items)*\n\n` +
      inventory.map((i, n) => `${n + 1}. ${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} in stock)`).join('\n');
  }

  return null; // not an inventory command
}

module.exports = { handleInventoryCommand };
```

---

## UPDATE 6 — New File: src/vendors/onboarding.js

Full vendor onboarding via WhatsApp conversation. Vendor types `VENDOR-SETUP` to begin.

```javascript
const { supabase } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');

async function handleOnboarding(sock, jid, text, vendor) {
  const step = vendor?.onboarding_step || 'start';

  if (step === 'start') {
    await sendWithDelay(sock, jid,
      `Welcome to VendBot! 🚀\n\nLet's set up your store in 5 minutes.\n\n*What is your business name?*`
    );
    await supabase.from('vendors').update({ onboarding_step: 'business_name' }).eq('id', vendor.id);
    return;
  }

  if (step === 'business_name') {
    await supabase.from('vendors').update({ business_name: text.trim(), onboarding_step: 'store_code' }).eq('id', vendor.id);
    await sendWithDelay(sock, jid,
      `Love it — *${text.trim()}* 🔥\n\nNow choose a *store code*. Short, memorable, all caps.\nExamples: AMAKA, SNEAKERHUB, FASHIONBYCHI\n\n*What's your store code?*`
    );
    return;
  }

  if (step === 'store_code') {
    const code = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { data: existing } = await supabase.from('vendors').select('id').eq('store_code', code).single();
    if (existing && existing.id !== vendor.id) {
      await sendWithDelay(sock, jid, `"${code}" is taken 😅 Try another.`);
      return;
    }
    await supabase.from('vendors').update({ store_code: code, onboarding_step: 'sheet_link' }).eq('id', vendor.id);
    await sendWithDelay(sock, jid,
      `*${code}* is yours! ✅\n\nYour store link:\nwa.me/${process.env.VENDBOT_NUMBER}?text=${code}\n\nNow share your *Google Sheet link* — or reply *SKIP* to add products via WhatsApp commands later.`
    );
    return;
  }

  if (step === 'sheet_link') {
    if (text.trim().toUpperCase() !== 'SKIP') {
      const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!match) {
        await sendWithDelay(sock, jid, `That doesn't look right. Paste the full Google Sheet URL, or reply SKIP.`);
        return;
      }
      await supabase.from('vendors').update({ sheet_id: match[1], onboarding_step: 'negotiation' }).eq('id', vendor.id);
    } else {
      await supabase.from('vendors').update({ onboarding_step: 'negotiation' }).eq('id', vendor.id);
    }
    await sendWithDelay(sock, jid,
      `Almost done! 🙌\n\nHow should the bot handle price negotiation?\n\n*1* — Fixed price (no negotiation)\n*2* — Alert me when buyer asks to negotiate\n\nReply 1 or 2`
    );
    return;
  }

  if (step === 'negotiation') {
    const policy = text.trim() === '1' ? 'firm' : 'escalate';
    const { data: v } = await supabase.from('vendors')
      .update({ negotiation_policy: policy, onboarding_step: 'complete', onboarding_complete: true, status: 'probation' })
      .eq('id', vendor.id).select().single();

    await sendWithDelay(sock, jid,
      `🎉 *Your store is LIVE!*\n\n` +
      `Business: ${v.business_name}\n` +
      `Store code: ${v.store_code}\n` +
      `Link: wa.me/${process.env.VENDBOT_NUMBER}?text=${v.store_code}\n\n` +
      `Share this link in your Instagram bio, WhatsApp Status, everywhere.\n\n` +
      `*Your commands:*\n` +
      `• "add: [item], [price], [qty]"\n` +
      `• "sold: [item]"\n` +
      `• "restock: [item], [qty]"\n` +
      `• "list" — see inventory\n` +
      `• "orders" — pending orders\n` +
      `• "broadcast: [message]" — message all buyers\n\n` +
      `First sale incoming 🚀`
    );
  }
}

module.exports = { handleOnboarding };
```

---

## UPDATE 7 — New Tables: CRM Layer

**Run in Supabase SQL Editor:**

```sql
-- Buyer profiles
CREATE TABLE buyers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           TEXT NOT NULL,
  whatsapp_jid    TEXT UNIQUE NOT NULL,
  first_name      TEXT,
  total_purchases INT DEFAULT 0,
  total_spent     BIGINT DEFAULT 0,
  dispute_count   INT DEFAULT 0,
  first_seen      TIMESTAMPTZ DEFAULT now(),
  last_seen       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_buyers_jid ON buyers(whatsapp_jid);

-- Per-vendor buyer relationships
CREATE TABLE buyer_vendor_relationships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id      UUID REFERENCES buyers(id),
  vendor_id     UUID REFERENCES vendors(id),
  total_orders  INT DEFAULT 0,
  total_spent   BIGINT DEFAULT 0,
  last_order_at TIMESTAMPTZ,
  notes         TEXT,
  is_vip        BOOLEAN DEFAULT false,
  UNIQUE(buyer_id, vendor_id)
);

-- Waitlist for out-of-stock items
CREATE TABLE waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_jid  TEXT NOT NULL,
  vendor_id  UUID REFERENCES vendors(id),
  item_sku   TEXT NOT NULL,
  item_name  TEXT,
  notified   BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(buyer_jid, vendor_id, item_sku)
);

-- Broadcast history
CREATE TABLE broadcast_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID REFERENCES vendors(id),
  message         TEXT,
  recipient_count INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Fast view for vendor pending orders
CREATE VIEW vendor_pending_orders AS
SELECT
  t.id, t.item_name, t.amount, t.created_at,
  t.status, t.delivery_status, t.paystack_ref,
  t.vendor_id,
  b.phone AS buyer_phone,
  b.first_name AS buyer_name,
  bvr.total_orders AS buyer_total_orders,
  bvr.is_vip
FROM transactions t
LEFT JOIN buyers b ON b.whatsapp_jid = t.buyer_jid
LEFT JOIN buyer_vendor_relationships bvr
  ON bvr.buyer_id = b.id AND bvr.vendor_id = t.vendor_id
WHERE t.status = 'paid' AND t.delivery_confirmed IS NULL
ORDER BY t.created_at DESC;
```

**Add** `delivery_status` and `buyer_id` columns to transactions:

```sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer_id UUID REFERENCES buyers(id);
```

---

## UPDATE 8 — New File: src/crm/manager.js

```javascript
const { supabase } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');

async function upsertBuyerAndRelationship(buyerJid, buyerPhone, vendorId, amountKobo) {
  const { data: buyer } = await supabase
    .from('buyers')
    .upsert({ whatsapp_jid: buyerJid, phone: buyerPhone, last_seen: new Date().toISOString() }, { onConflict: 'whatsapp_jid' })
    .select().single();
  if (!buyer) return null;

  await supabase.from('buyers').update({
    total_purchases: buyer.total_purchases + 1,
    total_spent: buyer.total_spent + amountKobo
  }).eq('id', buyer.id);

  const { data: rel } = await supabase.from('buyer_vendor_relationships').select('*')
    .eq('buyer_id', buyer.id).eq('vendor_id', vendorId).single();

  if (rel) {
    await supabase.from('buyer_vendor_relationships').update({
      total_orders: rel.total_orders + 1,
      total_spent: rel.total_spent + amountKobo,
      last_order_at: new Date().toISOString()
    }).eq('id', rel.id);
  } else {
    await supabase.from('buyer_vendor_relationships').insert({
      buyer_id: buyer.id, vendor_id: vendorId,
      total_orders: 1, total_spent: amountKobo,
      last_order_at: new Date().toISOString()
    });
  }
  return buyer;
}

async function checkAndFlagVip(buyerJid, vendorId, sock) {
  const { data: buyer } = await supabase.from('buyers').select('id').eq('whatsapp_jid', buyerJid).single();
  if (!buyer) return;

  const { data: rel } = await supabase.from('buyer_vendor_relationships').select('*, vendors(*)')
    .eq('buyer_id', buyer.id).eq('vendor_id', vendorId).single();
  if (!rel || rel.is_vip || rel.total_orders < 3) return;

  await supabase.from('buyer_vendor_relationships').update({ is_vip: true })
    .eq('buyer_id', buyer.id).eq('vendor_id', vendorId);

  await sendWithDelay(sock, `${rel.vendors.whatsapp_number}@s.whatsapp.net`,
    `⭐ *New VIP Customer!*\n\n${buyerJid.replace('@s.whatsapp.net','')} has placed 3 orders totalling ₦${(rel.total_spent / 100).toLocaleString()}.\n\nReply *VIP-MSG* to send them a personal thank you.`
  );
}

async function getBuyerProfile(buyerJid, vendorId) {
  const { data: buyer } = await supabase.from('buyers').select('*').eq('whatsapp_jid', buyerJid).single();
  if (!buyer) return null;
  const { data: rel } = await supabase.from('buyer_vendor_relationships').select('*')
    .eq('buyer_id', buyer.id).eq('vendor_id', vendorId).single();
  const { data: orders } = await supabase.from('transactions').select('item_name, amount, status, created_at')
    .eq('buyer_jid', buyerJid).eq('vendor_id', vendorId).order('created_at', { ascending: false }).limit(5);
  return { buyer, relationship: rel, recentOrders: orders || [] };
}

async function formatBuyerProfileMessage(profile) {
  if (!profile) return 'No profile found for this buyer.';
  const { buyer, relationship: rel, recentOrders } = profile;
  const orders = recentOrders.map((o, i) =>
    `${i + 1}. ${o.item_name} — ₦${(o.amount / 100).toLocaleString()} ${o.status === 'paid' ? '✅' : '⏳'}`
  ).join('\n');
  return `👤 *Buyer Profile*\n\n📱 ${buyer.phone}\n` +
    `${rel?.is_vip ? '⭐ VIP Customer\n' : ''}` +
    `🛍️ ${rel?.total_orders || 0} orders with you\n` +
    `💰 ₦${((rel?.total_spent || 0) / 100).toLocaleString()} total spent\n\n` +
    `*Recent orders:*\n${orders || 'None yet'}`;
}

module.exports = { upsertBuyerAndRelationship, checkAndFlagVip, getBuyerProfile, formatBuyerProfileMessage };
```

---

## UPDATE 9 — New File: src/crm/broadcast.js

```javascript
const { supabase } = require('../db');
const { getSock } = require('../whatsapp/client');
const { sendMessage } = require('../whatsapp/sender');

async function broadcastToAllBuyers(vendorId, message, vendor) {
  const sock = getSock();
  const { data: relationships } = await supabase
    .from('buyer_vendor_relationships').select('buyers(whatsapp_jid)')
    .eq('vendor_id', vendorId);
  if (!relationships?.length) return { sent: 0 };

  const storeLink = `wa.me/${process.env.VENDBOT_NUMBER}?text=${vendor.store_code}`;
  const fullMessage = `${message}\n\nShop now: ${storeLink}`;
  let sent = 0;

  for (const rel of relationships) {
    if (!rel.buyers?.whatsapp_jid) continue;
    try {
      await sendMessage(sock, rel.buyers.whatsapp_jid, fullMessage);
      await new Promise(r => setTimeout(r, 1200));
      sent++;
    } catch (e) { console.error('[BROADCAST]', e.message); }
  }

  await supabase.from('broadcast_log').insert({ vendor_id: vendorId, message: fullMessage, recipient_count: sent });
  return { sent };
}

module.exports = { broadcastToAllBuyers };
```

---

## UPDATE 10 — Update src/payments/webhook.js

**Add** to `handlePaymentSuccess` — after the payout schedule block, before the notify buyer block:

```javascript
// Upsert buyer + relationship
const { upsertBuyerAndRelationship, checkAndFlagVip } = require('../crm/manager');
const buyer = await upsertBuyerAndRelationship(txn.buyer_jid, txn.buyer_phone, vendor.id, txn.amount);
if (buyer) await supabase.from('transactions').update({ buyer_id: buyer.id }).eq('id', txn.id);
```

**Replace** the vendor notification message with:

```javascript
await sendWithDelay(sock, vendorJid,
  `🛍️ *New Sale!*\n\n` +
  `*Item:* ${txn.item_name}\n` +
  `*Amount:* ₦${(txn.amount / 100).toLocaleString()}\n` +
  `*Buyer:* ${txn.buyer_phone}\n` +
  `*Ref:* ${reference}\n\n` +
  `👇 Open buyer chat:\nwa.me/${txn.buyer_phone}\n\n` +
  `Reply:\n*DELIVERED* — mark delivered\n*TOMORROW* — delivering tomorrow\n*ISSUE* — flag problem\n*DETAILS* — buyer history`
);
```

**Replace** buyer confirmation message with shareable receipt:

```javascript
await sendWithDelay(sock, txn.buyer_jid,
  `✅ *Payment confirmed!*\n\nYou just copped from *${vendor.business_name}*\n\n` +
  `🛍️ ${txn.item_name}\n💰 ₦${(txn.amount / 100).toLocaleString()}\n\n` +
  `_Ref: ${reference}_\n\n` +
  `_Powered by VendBot ⚡_\n_Shop more: wa.me/${process.env.VENDBOT_NUMBER}?text=${vendor.store_code}_`
);
```

**Add** after vendor notification — VIP check:

```javascript
await checkAndFlagVip(txn.buyer_jid, vendor.id, sock);
```

---

## UPDATE 11 — New File: src/agents/content.js

Runs daily at 7am. Sends each vendor ready-to-post WhatsApp Status copy.

```javascript
const { supabase } = require('../db');
const { getInventory } = require('../inventory/sheets');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');
const { OpenAI } = require('openai');

const kimi = new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: process.env.KIMI_BASE_URL });

async function runContentAgent() {
  const { data: vendors } = await supabase.from('vendors').select('*').eq('status', 'active');
  const sock = getSock();

  for (const vendor of vendors || []) {
    try {
      const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);
      if (!inventory.length) continue;

      const topItems = inventory.slice(0, 5)
        .map(i => `${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} left)`).join('\n');

      const res = await kimi.chat.completions.create({
        model: process.env.KIMI_MODEL,
        max_tokens: 300,
        temperature: 0.8,
        messages: [
          { role: 'system', content: 'Generate WhatsApp Status content for a Nigerian vendor. Return JSON only: {"status":"...","instagram":"..."}. Status: max 2 lines, emoji, use [LINK] as placeholder. Instagram: 3-4 lines + hashtags.' },
          { role: 'user', content: `Business: ${vendor.business_name}\nItems:\n${topItems}` }
        ]
      });

      const content = JSON.parse(res.choices[0].message.content.replace(/```json|```/g, '').trim());
      const storeLink = `wa.me/${process.env.VENDBOT_NUMBER}?text=${vendor.store_code}`;

      await sendWithDelay(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `📢 *Your content for today*\n\n*WhatsApp Status:*\n${content.status.replace('[LINK]', storeLink)}\n\n*Instagram:*\n${content.instagram}`
      );
    } catch (e) { console.error(`[CONTENT AGENT] ${vendor.store_code}:`, e.message); }
  }
}

module.exports = { runContentAgent };
```

---

## UPDATE 12 — New File: src/agents/abandonment.js

Runs every 35 mins. Recovers buyers who got a payment link but didn't pay.

```javascript
const { supabase } = require('../db');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');

async function runAbandonmentAgent() {
  const sock = getSock();
  const cutoff30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const cutoff6h  = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: abandoned } = await supabase
    .from('transactions').select('*, vendors(*)')
    .eq('status', 'pending')
    .lt('created_at', cutoff30)
    .gt('created_at', cutoff6h);

  for (const txn of abandoned || []) {
    try {
      const { data: session } = await supabase.from('sessions').select('intent_state')
        .eq('buyer_jid', txn.buyer_jid).eq('vendor_id', txn.vendor_id).single();
      if (session?.intent_state !== 'awaiting_payment') continue;

      await sendWithDelay(sock, txn.buyer_jid,
        `Hey! Your payment link for *${txn.item_name}* from *${txn.vendors.business_name}* is about to expire 😅\n\nStill interested? Reply *YES* and I'll send a fresh one instantly.`
      );
      await supabase.from('sessions').update({ intent_state: 'awaiting_recovery' })
        .eq('buyer_jid', txn.buyer_jid).eq('vendor_id', txn.vendor_id);
    } catch (e) { console.error('[ABANDONMENT]', e.message); }
  }
}

module.exports = { runAbandonmentAgent };
```

---

## UPDATE 13 — New File: src/agents/pricing.js

Runs every Sunday at 8pm. Sends each vendor a weekly business intelligence report.

```javascript
const { supabase } = require('../db');
const { getInventory } = require('../inventory/sheets');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');
const { OpenAI } = require('openai');

const kimi = new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: process.env.KIMI_BASE_URL });

async function runPricingAgent() {
  const { data: vendors } = await supabase.from('vendors').select('*').eq('status', 'active');
  const sock = getSock();

  for (const vendor of vendors || []) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: sales } = await supabase.from('transactions').select('item_name, amount')
        .eq('vendor_id', vendor.id).eq('status', 'paid').gte('created_at', weekAgo);
      const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab);

      const salesText = sales?.map(s => `${s.item_name}: ₦${(s.amount/100).toLocaleString()}`).join('\n') || 'No sales this week';
      const invText = inventory.map(i => `${i.name}: ${i.quantity} in stock, ₦${i.price.toLocaleString()}`).join('\n');

      const res = await kimi.chat.completions.create({
        model: process.env.KIMI_MODEL,
        max_tokens: 400,
        temperature: 0.6,
        messages: [
          { role: 'system', content: 'Write a brief weekly business report for a Nigerian WhatsApp vendor. Be specific, actionable, encouraging. Max 200 words. Use emojis. No markdown headers.' },
          { role: 'user', content: `Business: ${vendor.business_name}\nWeek sales:\n${salesText}\nInventory:\n${invText}` }
        ]
      });

      await sendWithDelay(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `📊 *Weekly Report — ${vendor.business_name}*\n\n${res.choices[0].message.content.trim()}`
      );
    } catch (e) { console.error(`[PRICING AGENT] ${vendor.store_code}:`, e.message); }
  }
}

module.exports = { runPricingAgent };
```

---

## UPDATE 14 — Update src/cron.js

**Add** these imports at the top:

```javascript
const { runContentAgent } = require('./agents/content');
const { runAbandonmentAgent } = require('./agents/abandonment');
const { runPricingAgent } = require('./agents/pricing');
```

**Add** these three jobs inside `startCronJobs()`:

```javascript
// Daily 7am — content agent
cron.schedule('0 7 * * *', async () => {
  await runContentAgent();
  console.log('[CRON] Content agent ran');
});

// Every 35 mins — abandonment recovery
cron.schedule('*/35 * * * *', async () => {
  await runAbandonmentAgent();
  console.log('[CRON] Abandonment agent ran');
});

// Sunday 8pm — pricing intelligence
cron.schedule('0 20 * * 0', async () => {
  await runPricingAgent();
  console.log('[CRON] Pricing agent ran');
});
```

---

## UPDATE 15 — Trust: Progressive Stages

**Add** a `trust_stage` column to vendors:

```sql
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS trust_stage TEXT DEFAULT 'notification_only';
-- stages: notification_only | payment_optional | payment_default | full_escrow
```

**Logic in listener.js** — when a new vendor's first buyer tries to pay, check trust stage:

```javascript
// In purchase flow, before generatePaymentLink:
if (vendor.trust_stage === 'notification_only') {
  await sendWithDelay(sock, buyerJid,
    `${vendor.business_name} will send you payment details directly. Let me connect you now!`
  );
  await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
    `💬 *Buyer ready to pay!*\n\nItem: ${item.name} — ₦${item.price.toLocaleString()}\nBuyer: wa.me/${buyerJid.replace('@s.whatsapp.net','')}\n\nReach out directly to collect payment.`
  );
  return;
}
// Otherwise proceed with normal Paystack flow
```

Vendor graduates from `notification_only` to `payment_optional` manually or after 5 successful notification-assisted sales.

---

## Updated .env.example (Full)

```env
# GROQ — classification
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=llama3-8b-8192

# KIMI K2 via NVIDIA NIMs — responses + agents (free)
KIMI_API_KEY=nvapi_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
KIMI_BASE_URL=https://integrate.api.nvidia.com/v1
KIMI_MODEL=moonshotai/kimi-k2

# PAYSTACK — payments
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxxxxxxxxxxxxxx

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
VENDBOT_NUMBER=2348XXXXXXXXX
ADMIN_CODE=VENDOR-SETUP

# ESCROW
ESCROW_HOLD_NEW_VENDOR_HOURS=72
ESCROW_HOLD_ESTABLISHED_HOURS=24
ESTABLISHED_VENDOR_MIN_TRANSACTIONS=20

# SAFETY
VELOCITY_MAX_DAILY_MULTIPLIER=10
PAYMENT_LINK_EXPIRY_MINUTES=30
DISPUTE_WHATSAPP_NUMBER=2348000000000
```

---

## New Files to Create

The original AGENT.md has no knowledge of these files. Create them fresh:

| File | From Update |
|------|-------------|
| `src/ai/extractor.js` | Update 4 |
| `src/inventory/commands.js` | Update 5 |
| `src/vendors/onboarding.js` | Update 6 |
| `src/crm/manager.js` | Update 8 |
| `src/crm/broadcast.js` | Update 9 |
| `src/agents/content.js` | Update 11 |
| `src/agents/abandonment.js` | Update 12 |
| `src/agents/pricing.js` | Update 13 |

---

## Files to Modify

| File | What Changes |
|------|-------------|
| `src/payments/mono.js` | Replace entirely with Paystack (Update 2) |
| `src/server.js` | Swap Mono webhook → Paystack webhook (Update 2) |
| `src/ai/responder.js` | Replace entirely with Kimi K2 (Update 3) |
| `src/vendors/resolver.js` | Add getVendorByStoreCode (Update 1) |
| `src/payments/webhook.js` | Add CRM calls + new notification messages (Update 10) |
| `src/cron.js` | Add 3 new agent jobs (Update 14) |
| `.env` / `.env.example` | Swap Mono keys → Paystack + Kimi keys (Update 15) |

---

## Definition of Done

Same as original AGENT.md plus these additional checks:

- [ ] Vendor types `VENDOR-SETUP` → full onboarding flow completes in WhatsApp
- [ ] Vendor types `add: black sneakers, 25000, 3` → item appears in Google Sheet
- [ ] Vendor sends voice note describing items → items appear in sheet
- [ ] Out-of-stock item → buyer gets waitlist option → restock triggers notification
- [ ] After sale → vendor gets `wa.me/` link to buyer in notification
- [ ] Vendor types `orders` → sees pending orders with buyer links
- [ ] Vendor types `broadcast: flash sale today` → all past buyers receive message
- [ ] 3rd order from same buyer → vendor gets VIP notification
- [ ] 35 mins after unpaid link → buyer gets recovery message
- [ ] 7am daily → vendor receives WhatsApp Status copy
- [ ] Sunday 8pm → vendor receives weekly report
- [ ] New vendor in `notification_only` stage → payment collected manually, bot facilitates intro
