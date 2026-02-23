   # VendBot — Complete Flow Documentation

End-to-end flows for vendors and buyers.

**Current architecture:** **One number per vendor (QR method).** Each vendor has a dedicated WhatsApp number. The vendor links that number to the bot by scanning the QR code (terminal or `/qr` page). Buyers message that same number to reach that vendor. We are **not** using single-number store-code routing yet.

---

## 🏪 VENDOR FLOW

### 1. **Vendor Onboarding** (First Time Setup)

**Trigger:** Vendor sends `VENDOR-SETUP` or `ADMIN` to the WhatsApp number they linked (the number they used when scanning the QR).

**Steps:**

1. **Business Name**
   - Bot: *"Welcome to VendBot! 🚀 Let's set up your store in 5 minutes. What is your business name?"*
   - Vendor: *"Amaka Fashion"*
   - Bot: *"Love it — Amaka Fashion 🔥 Now choose a store code. Short, memorable, all caps. Examples: AMAKA, SNEAKERHUB. What's your store code?"*

2. **Store Code**
   - Vendor: *"AMAKA"*
   - Bot checks if code is taken → if not:
   - Bot: *"AMAKA is yours! ✅ Your store link: wa.me/2348XXXXXXX?text=AMAKA. Share your Google Sheet link — or reply SKIP to add products via WhatsApp later."*

3. **Google Sheet** (Optional)
   - Vendor: *"https://docs.google.com/spreadsheets/d/ABC123..."* OR *"SKIP"*
   - Bot extracts sheet ID from URL or skips
   - Bot: *"Almost done! 🙌 How should the bot handle price negotiation? 1 — Fixed price (no negotiation). 2 — Alert me when buyer asks to negotiate. Reply 1 or 2"*

4. **Negotiation Policy**
   - Vendor: *"1"* or *"2"*
   - Bot: *"🎉 Your store is LIVE! Business: Amaka Fashion. Store code: AMAKA. Link: wa.me/2348XXXXXXX?text=AMAKA. Commands: add:, sold:, restock:, list, orders, broadcast:. First sale incoming 🚀"*
   - Vendor status set to `probation`, `onboarding_complete = true`

---

### 2. **Managing Inventory**

**Avenues:** WhatsApp text, WhatsApp voice notes, Google Sheet (if linked), or DB only (if no sheet). See **docs/INVENTORY_AVENUES.md** for the full list and improvement ideas.

#### A. **Text Commands**

- **Add items:** `add: Black sneakers, 25000, 3` or `add: name, price, qty, image URL` (image URL for DB inventory)
  - Bot extracts items using AI (Kimi K2), adds to Sheet or DB
  - Bot: *"Added 1 item(s) ✅ • Black sneakers — ₦25,000 (3 in stock)"*

- **Bulk add:** Multi-line under `add:` — each line can be "name, price, qty" or "name, price, qty, image URL"

- **Mark sold:** `sold: Black sneakers` — decrements quantity by 1

- **Restock/Set quantity:** `restock: Black sneakers, 10` or `set: Black sneakers, 10` — sets quantity; waitlisted buyers notified if applicable

- **Remove from list:** `remove: Black sneakers` — sets quantity to 0 (item no longer shown to buyers)

- **Set product image (DB only):** `image: Black sneakers, https://example.com/photo.jpg`

- **List:** `list` or `inventory` — see all in-stock items

- **Help:** `stock help` or `inventory help` — lists all inventory commands

#### B. **Voice Notes**

- Vendor sends voice note: *"Add black sneakers twenty-five thousand three, red bag fifteen thousand one"*
- Bot transcribes (Groq Whisper) → extracts items → adds to Sheet or DB

#### C. **Google Sheet** (if linked)

- Vendor edits sheet directly; bot reads from it when buyers ask. No image column in current sheet layout.

---

### 3. **Handling Orders**

**View pending orders:** `orders`
- Bot queries transactions where `status = 'paid'` and `delivery_confirmed IS NULL`
- Bot: *"📋 Pending orders (3). 1. Black sneakers — ₦25,000. Buyer: wa.me/2348123456789. Reply DETAILS for the latest order's buyer history. 2. Red bag — ₦15,000..."*

**View buyer details:** `DETAILS`
- Bot shows last pending order's buyer profile:
  - Phone, VIP status, total orders with vendor, total spent, recent orders
- Bot: *"👤 Buyer Profile. 📱 2348123456789. ⭐ VIP Customer. 🛍️ 5 orders with you. 💰 ₦125,000 total spent. Recent orders: 1. Black sneakers — ₦25,000 ✅..."*

**Mark delivery status:** `DELIVERED` / `TOMORROW` / `ISSUE`
- Bot updates `delivery_status` for last pending order
- Bot: *"Updated. Thanks!"*

---

### 4. **Broadcasting**

**Send message to all buyers:** `broadcast: Flash sale today! 20% off everything`
- Bot queries `buyer_vendor_relationships` for all buyers who purchased from this vendor
- Sends message to each buyer (with store link)
- Logs to `broadcast_log`
- Bot: *"Broadcast sent to 15 buyer(s)."*

---

### 5. **Trust Stages**

**New vendors start in `notification_only` stage:**

- When buyer wants to pay:
  - Bot: *"Amaka Fashion will send you payment details directly. Let me connect you now!"*
  - Bot notifies vendor: *"💬 Buyer ready to pay! Item: Black sneakers — ₦25,000. Buyer: wa.me/2348123456789. Reach out directly to collect payment."*
  - Vendor collects payment manually

**After 5 successful sales or manual upgrade:**
- Vendor moves to `payment_optional` or `payment_default`
- Bot generates Paystack links automatically

---

## 🛒 BUYER FLOW

### 1. **First Contact** (QR method — one number per vendor)

**Current implementation:** Each vendor has their own WhatsApp number. The vendor links it by **scanning the QR code** (terminal or `/qr`). Buyers message **that same number** to talk to that vendor’s store. The bot resolves the vendor with `getVendorByBotNumber` (no store-code routing).

- Buyer opens the vendor’s link (e.g. wa.me/2348XXXXXXX) or saves the number and messages it.
- Bot replies as that vendor’s store (inventory, orders, etc. for that vendor only).
- Session links buyer to that vendor for 24 hours.

**Future option (not in use yet):** Single shared number where the first message is a store code (e.g. "AMAKA") and the bot routes by `getVendorByStoreCode`.

---

### 2. **Browsing Products**

**Query:** *"Do you have black sneakers?"*

1. Bot classifies intent: `QUERY`
2. Bot reads inventory from Google Sheet
3. Bot matches products using AI
4. Bot generates reply (Kimi K2): *"Yes! We have Black Air Force 1 — ₦25,000. Only 2 left!"*
5. Bot updates session: `intent_state = 'querying'`, `last_item_name = 'Black Air Force 1'`

**Multiple matches:** Bot shows native WhatsApp list (tap to select)

**No matches:** Bot suggests similar items or says out of stock

---

### 3. **Purchase Intent**

**Buyer:** *"I want it"* or *"I'll take it"*

1. Bot classifies intent: `PURCHASE` or `CONFIRM`
2. Bot uses `last_item_name` from session or matches from message
3. Bot checks trust stage:
   - **`notification_only`:** Facilitates manual payment (see vendor flow #5)
   - **Other:** Generates Paystack link
4. Bot creates transaction: `status = 'pending'`, `mono_ref = 'VBOT-ABC12345'`
5. Bot sends payment link: *"🛒 Order Summary. Item: Black Air Force 1. Price: ₦25,000. SKU: BLACK-AF1. 🔗 Pay here: [Paystack link]. Pay via card, bank transfer, or USSD. Link expires in 30 minutes."*
6. Bot updates session: `intent_state = 'awaiting_payment'`, `pending_payment_ref = 'VBOT-ABC12345'`

---

### 4. **Payment**

**Buyer clicks Paystack link → pays → Paystack webhook fires:**

1. **Webhook handler (`handlePaymentSuccess`):**
   - Verifies transaction with Paystack
   - Updates transaction: `status = 'paid'`, sets `escrow_release_at`
   - Increments vendor `total_transactions`
   - Upserts buyer in `buyers` table
   - Creates/updates `buyer_vendor_relationships`
   - Decrements inventory quantity in Google Sheet
   - Updates transaction: `buyer_id`, `sheet_row_updated = true`

2. **Buyer notification:**
   - Bot: *"✅ Payment confirmed! You just copped from Amaka Fashion. 🛍️ Black Air Force 1. 💦 ₦25,000. Ref: VBOT-ABC12345. 🔗 Paystack receipt: [link]. Your funds are held in escrow for 72 hours. Issue? Contact wa.me/2348000000000"*

3. **Vendor notification:**
   - Bot: *"🛍️ New Sale! Item: Black Air Force 1. Amount: ₦25,000. Buyer: 2348123456789. Ref: VBOT-ABC12345. 👇 Open buyer chat: wa.me/2348123456789. Reply: DELIVERED — mark delivered. TOMORROW — delivering tomorrow. ISSUE — flag problem. DETAILS — buyer history"*

4. **VIP check:**
   - If buyer has 3+ orders with vendor → flags as VIP
   - Bot notifies vendor: *"⭐ New VIP Customer! 2348123456789 has placed 3 orders totalling ₦125,000. Reply VIP-MSG to send them a thank you."*

5. **Delivery ping (after 3 hours):**
   - Bot: *"Hi! Did you receive your Black Air Force 1 from Amaka Fashion? Reply YES ✅ or NO ❌"*
   - If NO → increments vendor `no_count`, flags dispute

---

### 5. **Price Negotiation**

**Buyer:** *"Can you do ₦20,000?"*

1. Bot classifies intent: `NEGOTIATE`
2. Bot checks vendor `negotiation_policy`:
   - **`fixed`:** Bot: *"The price is fixed at ₦25,000. Ready to pay? 😊"*
   - **`escalate`:** Bot alerts vendor, vendor takes over chat
   - **`auto`:** Bot negotiates automatically:
     - Extracts offer: ₦20,000
     - Calculates first counter: 40% of gap above min price
     - Bot: *"Haha you want to price Black Air Force 1? 😄 The price is ₦25,000 but... I fit do ₦22,000 for you. What do you say?"*
     - Updates session: `intent_state = 'negotiating'`, `pending_payment_ref = 'haggle:1:22000'`
     - Buyer counters → Round 2, Round 3, etc.
     - Eventually accepts or buyer pays at final price

---

### 6. **Out of Stock / Waitlist**

**Buyer asks for item with quantity = 0:**

- Bot: *"Sorry, Black Air Force 1 is out of stock. Would you like me to notify you when it's back? Reply YES to join the waitlist."*
- Buyer: *"YES"*
- Bot creates `waitlist` entry: `buyer_jid`, `vendor_id`, `item_sku`, `notified = false`
- When vendor restocks: Bot notifies all waitlisted buyers: *"Amaka Fashion: Black Air Force 1 is back in stock! Reply to order."*
- Bot updates waitlist: `notified = true`

---

### 7. **Abandonment Recovery**

**Agent runs every 35 minutes:**

- Finds transactions: `status = 'pending'`, created 30 mins - 6 hours ago
- Checks session: `intent_state = 'awaiting_payment'`
- Bot: *"Hey! Your payment link for Black Air Force 1 from Amaka Fashion is about to expire 😅 Still interested? Reply YES and I'll send a fresh one instantly."*
- Updates session: `intent_state = 'awaiting_recovery'`
- If buyer replies YES → resends payment link

---

### 8. **Resending Payment Link**

**Buyer:** *"resend"* or *"send link"* (while `awaiting_payment`)

- Bot finds transaction by `pending_payment_ref`
- Bot: *"🔗 Payment link for Black Air Force 1 (₦25,000): [Paystack link]. Link expires in 30 minutes."*

---

### 9. **Canceling Order**

**Buyer:** *"cancel"* or *"nevermind"*

- Bot classifies intent: `CANCEL`
- Bot: *"No problem at all! Feel free to message anytime you're ready. 👋"*
- Bot clears session: `intent_state = 'idle'`, clears `pending_payment_ref`, `last_item_name`, `last_item_sku`

---

## 🤖 AUTONOMOUS AGENTS

### 1. **Content Agent** (Daily 7 AM)

- Runs for all `active`/`probation` vendors
- Reads top 5 items from inventory
- Generates WhatsApp Status + Instagram copy (Kimi K2)
- Bot: *"📢 Your content for today. WhatsApp Status: [copy with store link]. Instagram: [copy with hashtags]"*

### 2. **Abandonment Agent** (Every 35 Minutes)

- Finds abandoned payment links (30 mins - 6 hours old)
- Sends recovery message (see buyer flow #7)

### 3. **Pricing Agent** (Sunday 8 PM)

- Runs for all `active`/`probation` vendors
- Queries sales from last 7 days
- Reads current inventory
- Generates weekly business report (Kimi K2)
- Bot: *"📊 Weekly Report — Amaka Fashion. [AI-generated report with sales, inventory insights, actionable suggestions]"*

---

## 🔄 SESSION MANAGEMENT

**Sessions persist for 24 hours** (per AGENT_UPDATE.md)

**Session states:**
- `idle` — No active conversation
- `querying` — Buyer browsing products
- `selecting_item` — Buyer choosing from list
- `negotiating` — Price negotiation in progress
- `awaiting_payment` — Payment link sent
- `awaiting_recovery` — Abandonment recovery sent
- `awaiting_delivery_confirm` — Waiting for delivery confirmation

**Session data:**
- `buyer_jid` + `vendor_id` (unique key)
- `intent_state`
- `pending_payment_ref`
- `last_item_name`, `last_item_sku`
- `chat_history` (last 10 messages)

---

## 🗄️ DATABASE (NEON) — Why Neon serverless instead of pg Pool

- **Neon serverless works.** We use Neon’s own driver (`@neondatabase/serverless`) so everything goes through Neon’s proxy (HTTP or WebSockets). No need for the generic `pg` (node-postgres) package.
- **Why we’re not using `pg` Pool:** AGENT_UPDATE_V2 originally specified `pg` Pool as a generic “pooled Postgres” setup. Neon provides a **direct alternative**: its serverless driver’s **Pool** (over WebSockets), which is API-compatible with node-postgres. Using Neon’s Pool gives:
  - One driver for Neon (no TCP connection limits to manage).
  - Same `query()` and `withTransaction(client => ...)` usage.
  - Works on long-running servers (e.g. Koyeb) and uses Neon’s connection handling.
- **Neon’s “alternative” to pg Pool:** Use **`Pool` from `@neondatabase/serverless`** with your `DATABASE_URL`. In Node we set `neonConfig.webSocketConstructor = ws` so WebSockets work. No `pg` dependency required.

---

## 📊 DATABASE TABLES

**Core:**
- `vendors` — Store info, trust_stage, onboarding_step
- `buyers` — Buyer profiles, total_purchases, total_spent
- `transactions` — Orders, payments, escrow
- `sessions` — Buyer-vendor conversation state

**CRM:**
- `buyer_vendor_relationships` — Per-vendor buyer stats, VIP flags
- `waitlist` — Out-of-stock notifications
- `broadcast_log` — Broadcast history

**Inventory:**
- **Google Sheets** — When a vendor links a sheet (`sheet_id`), we read/write there (existing behaviour).
- **Neon DB** — When a vendor has *no* sheet, we use the `inventory_items` table in Neon (same commands: add:, sold:, restock:, list). Supports **product images** via `image_url` (add with URL in "add: name, price, qty, image_url" or set later).
- Run `migrations/neon-inventory-and-pay-token.sql` on your Neon database (see `migrations/README.md`).

---

## 🧪 TESTING WITHOUT ANOTHER PERSON

**Full feature testing walkthrough:** See **docs/TESTING_FULL_FEATURES.md** for a step-by-step guide to testing vendor onboarding, inventory, buyer flow, payment, abandonment, content and pricing agents, and dev routes.

You can test buyer and vendor flows without asking someone else to message the bot.

**1. Terminal dry-run (no WhatsApp, no second phone)**  
From the project root:

```bash
node scripts/simulate-message.js <from_phone> <message>
```

Examples:

- Buyer flow: `node scripts/simulate-message.js 2348012345678 "AMAKA"` then `"1"`, `"Black sneakers"`, etc.
- Vendor flow: use the vendor’s number as `from_phone`, e.g. `node scripts/simulate-message.js 2348098765432 "list"`

The script runs the same handler as the real bot and **prints what the bot would reply** in the terminal. It does not send any WhatsApp message. Set `VENDBOT_NUMBER` in `.env` so the script knows which vendor to use.

**2. Live test (real replies on your WhatsApp)**  
With the bot running and WhatsApp connected:

1. In `.env` set `ENABLE_DEV_SIMULATE=1`.
2. Restart the app.
3. Send a simulated message with curl; the bot will reply to that number on WhatsApp:

```bash
curl -X POST http://localhost:3000/dev/simulate -H "Content-Type: application/json" -d "{\"from\":\"2348012345678\",\"text\":\"AMAKA\"}"
```

Use your own number as `from` so you receive the reply. Leave `ENABLE_DEV_SIMULATE` unset or `0` in production.

**3. Abandonment agent (run once on demand)**  
With the bot running, `ENABLE_DEV_SIMULATE=1`, and WhatsApp connected:

```bash
curl -X POST http://localhost:3000/dev/run-abandonment
```

The agent will run once (same logic as the 12-hour cron). For it to actually send a nudge you need:

- A **pending** transaction (same DB as Paystack): `created_at` between **35 minutes** and **6 hours** ago.
- A **session** for that buyer + vendor with `intent_state = 'awaiting_payment'`.
- **Buyer inactive** for at least **45 minutes** (so `sessions.updated_at` older than 45 min, or no recent message from that buyer).

If any of these aren’t met, the agent will still run but send no messages. Check server logs for `[ABANDONMENT]` and `[CRON] Abandonment agent ran`.

---

## ⚠️ CURRENT LIMITATIONS / TODO

1. **Vendor identification:** We use the **QR-per-vendor** method: vendor resolves via `getVendorByBotNumber` (one number per vendor, linked by scanning QR). Single-number store-code routing (`getVendorByStoreCode` for first message) is not implemented and is a possible future change.

2. **Payment link expiry:** Cron job expires links after 30 minutes, but abandonment agent checks 30 mins - 6 hours (may miss some).

3. **Voice extraction:** Requires `GROQ_API_KEY` for transcription. Falls back gracefully if missing.

---

## 🎯 KEY FEATURES SUMMARY

✅ **Vendor onboarding** via WhatsApp  
✅ **Multi-method inventory** (text, voice, sheet)  
✅ **AI-powered responses** (Kimi K2 + Groq)  
✅ **Paystack payments** with escrow  
✅ **CRM layer** (buyers, relationships, VIP, waitlist)  
✅ **Broadcasting** to past buyers  
✅ **Auto negotiation** (configurable)  
✅ **Abandonment recovery**  
✅ **Content generation** (daily)  
✅ **Business intelligence** (weekly reports)  
✅ **Progressive trust stages**  
✅ **QR-per-vendor** (vendors scan QR to link their number; one number per vendor)
