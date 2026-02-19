# VendBot Setup Guide

> Complete environment setup from zero to a running bot.
> Follow every step in order. Do not skip.

---

## Prerequisites

Before you start, make sure you have:

- Node.js v18 or higher — check with `node -v`
- npm v9+ — check with `npm -v`
- Git installed — check with `git --version`
- A Nigerian phone number SIM dedicated to the bot (MTN or Airtel)
- A Google account
- Access to [console.groq.com](https://console.groq.com)
- Access to [app.mono.co](https://app.mono.co)
- Access to [supabase.com](https://supabase.com)
- Access to [render.com](https://render.com)

---

## Step 1 — Clone and Install

```bash
git clone https://github.com/yourusername/vendbot.git
cd vendbot
npm install
cp .env.example .env
```

---

## Step 2 — Get Your Groq API Key

**Time required: 5 minutes | Cost: Free**

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up with Google
3. Click **API Keys** in the left sidebar
4. Click **Create API Key**
5. Name it `vendbot-mvp`
6. Copy the key immediately — it only shows once

Add to your `.env`:
```
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=llama3-8b-8192
GROQ_MODEL_SMART=llama3-70b-8192
```

> **Free tier limits:** 30 requests/min, 14,400/day. More than enough for MVP.

---

## Step 3 — Get Your Mono API Keys

**Time required: 5 min (sandbox) | 1–2 days (live) | Cost: Free + 1.5% per transaction**

### Sandbox Keys (use these first)

1. Go to [app.mono.co/signup](https://app.mono.co/signup)
2. Create an account
3. Dashboard → **Settings** → **API Keys**
4. Copy **Test Secret Key** and **Test Public Key**

### Set Up Webhook

1. Dashboard → **Webhooks** → **Add Endpoint**
2. URL: `https://your-render-url.onrender.com/webhook/mono`
   *(Use a placeholder for now — update after Render deployment)*
3. Select event: `payment.successful`
4. Copy the **Webhook Secret** shown

Add to your `.env`:
```
MONO_SECRET_KEY=test_sk_your_key
MONO_PUBLIC_KEY=test_pk_your_key
MONO_WEBHOOK_SECRET=whsec_your_secret
MONO_BASE_URL=https://api.mono.co/v2
```

### Go Live (when ready for real transactions)

Dashboard → **Settings** → **Business Verification** → upload:
- CAC certificate (or BN registration)
- Valid ID (NIN or driver's licence)

Approval takes 24–48 hours. Replace test keys with live keys in `.env`.

> ⚠️ Never mix sandbox and live keys. Sandbox keys are prefixed `test_`, live keys are prefixed `live_`.

---

## Step 4 — Set Up Google Sheets API

**Time required: 15–20 minutes | Cost: Free**

### Create Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click **New Project** → name it `vendbot` → **Create**
3. Make sure the new project is selected in the top bar

### Enable Sheets API

1. **APIs & Services** → **Library**
2. Search `Google Sheets API`
3. Click it → **Enable**

### Create Service Account

1. **APIs & Services** → **Credentials**
2. **Create Credentials** → **Service Account**
3. Name: `vendbot-sheets`
4. Click **Done** (skip optional steps)

### Download JSON Key

1. Click the service account you just created
2. **Keys** tab → **Add Key** → **Create New Key** → **JSON**
3. Download the file — keep it safe, never commit it

### Extract Values

Open the downloaded JSON file:

```json
{
  "client_email": "vendbot-sheets@your-project.iam.gserviceaccount.com",
  "private_key": "-----BEGIN RSA PRIVATE KEY-----\nABC...\n-----END RSA PRIVATE KEY-----\n"
}
```

Add to `.env`:
```
GOOGLE_SERVICE_ACCOUNT_EMAIL=vendbot-sheets@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nABC...\n-----END RSA PRIVATE KEY-----\n
```

> ⚠️ The `\n` characters in the private key must stay exactly as-is in `.env`.
> The code handles conversion with `.replace(/\\n/g, '\n')`.

### Share Vendor Sheets

Every vendor must share their Google Sheet with the service account email above.

Tell vendors:
1. Open their Google Sheet
2. Click **Share** (top right)
3. Paste the `client_email` value
4. Set permission to **Editor**
5. Click **Send**

---

## Step 5 — Set Up Supabase

**Time required: 5 minutes | Cost: Free tier**

1. Go to [supabase.com](https://supabase.com) → **New Project**
2. Name: `vendbot`
3. Set a strong database password (save it)
4. Region: **US East** (lowest latency to Nigeria)
5. Click **Create Project** — wait ~2 minutes

### Get API Keys

1. **Project Settings** (gear icon) → **API**
2. Copy **Project URL** and **service_role** key

> Use `service_role` not `anon` — service role bypasses Row Level Security which is what you want for your backend.

Add to `.env`:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhb...your_service_role_key
```

### Run Database Migrations

1. Left sidebar → **SQL Editor** → **New Query**
2. Paste and run the following SQL:

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

3. Verify: **Table Editor** in sidebar should show all 5 tables.

---

## Step 6 — Prepare Vendor's Google Sheet

Every vendor needs their inventory in this exact format:

| A (name) | B (sku) | C (price) | D (quantity) | E (category) | F (image_url) |
|----------|---------|-----------|--------------|--------------|---------------|
| Black Leather Tote | BAG-BLK-001 | 18500 | 3 | Bags | |
| Red Mini Dress | DRESS-RED-M | 12000 | 1 | Clothing | |

Rules for vendors:
- Column A: product name exactly as they want it described
- Column B: unique SKU — no spaces, no special characters
- Column C: price in Naira, whole number only (no ₦ sign, no commas)
- Column D: current quantity — set to 0 when out of stock
- Row 1 must be the header row exactly as shown above
- First tab should be named `Sheet1` unless configured otherwise

Copy the Google Sheet ID from the URL:
```
https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit
```

---

## Step 7 — Register First Vendor in Database

Run this in Supabase SQL Editor (replace values):

```sql
INSERT INTO vendors (whatsapp_number, business_name, sheet_id, sheet_tab, status)
VALUES ('2348012345678', 'Amaka Fashion', 'your_google_sheet_id', 'Sheet1', 'probation');
```

The bot's own WhatsApp number is how VendBot knows which vendor to load when a buyer messages it.

---

## Step 8 — Test Locally

```bash
npm run dev
```

You will see a QR code printed in the terminal. Scan it with the dedicated bot SIM card's WhatsApp.

Once connected you should see:
```
✅ Server running on port 3000
WhatsApp connected successfully
✅ VendBot running. Waiting for messages...
[CRON] Scheduled jobs started
```

Test by sending a WhatsApp message to the bot number from another phone:
```
"Do you have any bags?"
```

The bot should reply with inventory from the connected Google Sheet.

---

## Step 9 — Deploy to Render

**Cost: $7/month (Starter plan — always on)**

### Create Web Service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml` — confirm the settings
4. Click **Create Web Service**

### Add Environment Variables

Render dashboard → your service → **Environment** tab → add every key from your `.env`:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `GROQ_API_KEY` | your key |
| `GROQ_MODEL` | `llama3-8b-8192` |
| `GROQ_MODEL_SMART` | `llama3-70b-8192` |
| `MONO_SECRET_KEY` | your key |
| `MONO_PUBLIC_KEY` | your key |
| `MONO_WEBHOOK_SECRET` | your secret |
| `MONO_BASE_URL` | `https://api.mono.co/v2` |
| `SUPABASE_URL` | your URL |
| `SUPABASE_SERVICE_KEY` | your key |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | your email |
| `GOOGLE_PRIVATE_KEY` | paste full key including `-----BEGIN...-----END` |
| `APP_URL` | `https://your-service.onrender.com` |
| `PAYMENT_LINK_EXPIRY_MINUTES` | `30` |
| `ESCROW_HOLD_NEW_VENDOR_HOURS` | `72` |
| `ESCROW_HOLD_ESTABLISHED_HOURS` | `24` |
| `ESTABLISHED_VENDOR_MIN_TRANSACTIONS` | `20` |
| `VELOCITY_MAX_DAILY_MULTIPLIER` | `10` |
| `DISPUTE_WHATSAPP_NUMBER` | `2348000000000` |

### Scan QR on First Boot

1. Open Render logs
2. Look for the QR code printed as ASCII art
3. Open WhatsApp on the bot SIM → **Linked Devices** → **Link a Device**
4. Scan the QR code

### Update Mono Webhook URL

Mono dashboard → **Webhooks** → edit your webhook → update URL to:
```
https://your-service.onrender.com/webhook/mono
```

---

## Step 10 — Final Verification

Check every item before going live with real vendors:

| # | Check | How to Verify |
|---|-------|--------------|
| 1 | App is live | Visit `https://your-url.onrender.com/health` — returns `{status: "ok"}` |
| 2 | WhatsApp connected | Render logs show "WhatsApp connected successfully" |
| 3 | AI replies work | Send "do you have X?" — bot replies with real inventory data |
| 4 | Payment link generates | Send "I want to buy it" — Mono link arrives in WhatsApp |
| 5 | Webhook fires | Complete sandbox payment — transaction in Supabase updates to `paid` |
| 6 | Sheet decrements | After payment — Google Sheet quantity reduces by 1 |
| 7 | Buyer gets receipt | Buyer WhatsApp receives confirmation message |
| 8 | Vendor gets notified | Vendor WhatsApp receives sale alert |
| 9 | Payment expiry works | Wait 30+ mins with unpaid link — status updates to `expired` |
| 10 | Mono webhook URL correct | Mono dashboard shows webhook as active/green |

---

## Common Issues & Fixes

**QR code not appearing in Render logs**
→ Check that `printQRInTerminal: true` is set in `client.js`. Check Render logs under the Logs tab not the Events tab.

**Google Sheets returning empty array**
→ Check the service account email has Editor access on the sheet. Check sheet ID in the database matches the actual URL.

**Mono webhook returning 401**
→ The raw body parsing must come before `express.json()`. Make sure `/webhook/mono` route uses `express.raw()`.

**Bot not responding to messages**
→ Check the bot number registered in the vendors table matches the actual WhatsApp number exactly (digits only, no + or spaces).

**GOOGLE_PRIVATE_KEY error on Render**
→ When pasting into Render, paste the full key as a single line. The `\n` characters should be literal backslash-n, not actual newlines.

**Baileys session lost after Render redeploy**
→ The render.yaml includes a persistent disk mounted at `/data`. Update auth path in `client.js` to `/data/auth_info_baileys`.

---

## Monthly Costs at MVP Stage

| Service | Cost |
|---------|------|
| Render Starter | $7 (~₦11,200) |
| Render Disk (auth persistence) | $1 (~₦1,600) |
| Groq API | Free tier or ~$5 (~₦8,000) |
| Supabase | Free tier |
| Google Sheets API | Free |
| Mono | Free + 1.5% per transaction |
| **Total fixed** | **~₦20,800/month** |

Break-even: **7 paying vendors at ₦3,000/month each.**

---

## Support & Disputes

Buyer disputes go to the WhatsApp number set in `DISPUTE_WHATSAPP_NUMBER`.

Vendor banning logic:
- 3 NO delivery confirmations → account flagged, manual review
- 5 NO delivery confirmations → account automatically banned

BVN blacklist entries are stored in the `blacklist` table. Cross-reference before activating new vendors.

---

*VendBot Setup Guide — v1.0 — February 2026*
