# Testing All VendBot Features

Step-by-step guide to test the full stack: vendor flows, buyer flows, payments, inventory, and agents.

---

## Prerequisites

1. **Environment**
   - Copy `.env.example` to `.env` (or use existing `.env`).
   - Set: `GROQ_API_KEY`, `KIMI_API_KEY`, `KIMI_BASE_URL`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `DATABASE_URL`, `VENDBOT_NUMBER`.
   - Optional: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` for Sheet inventory; if omitted, use DB-only inventory.
   - For **live** tests (real WhatsApp): `ENABLE_DEV_SIMULATE=1`.

2. **Database**
   - Neon (or Postgres) with migrations applied:
     ```bash
     node scripts/run-migration.js
     ```
   - Tables: `vendors`, `buyers`, `transactions`, `sessions`, `buyer_vendor_relationships`, `waitlist`, `broadcast_log`, `inventory_items` (see `migrations/`).

3. **Paystack**
   - Use **test keys** in `.env` for testing.
   - In Paystack Dashboard: set **Callback URL** to your public URL, e.g. `https://your-app.koyeb.app/webhook/paystack` (or use ngrok for local: `https://xxxx.ngrok.io/webhook/paystack`).

4. **WhatsApp**
   - Start the app; scan QR (terminal or open `http://localhost:3000/qr`).
   - `VENDBOT_NUMBER` must match the number linked to that QR (one number per vendor in current setup).

---

## Testing Modes

| Mode | When to use | How |
|------|-------------|-----|
| **Dry-run** | No WhatsApp, no second phone | `node scripts/simulate-message.js <phone> "<message>"` — prints reply in terminal only. |
| **Live** | Real WhatsApp messages | App running + `ENABLE_DEV_SIMULATE=1`; use `curl -X POST .../dev/simulate` or message the bot from your phone. |

Use **dry-run** to verify logic; use **live** to verify end-to-end (QR, delivery, payment callback).

---

## 1. Vendor onboarding

**Goal:** Register a new vendor (business name, store code, optional sheet, negotiation policy).

- **Dry-run:**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "VENDOR-SETUP"
  ```
  Then follow prompts: business name → store code → sheet URL or SKIP → 1 or 2 for negotiation.

- **Live:**  
  From the number that will be the vendor (the one linked to the QR), send `VENDOR-SETUP` or `ADMIN`. Complete the flow on WhatsApp.

**Check:** Vendor row in DB with `onboarding_complete = true`, `store_code` set. Vendor gets a summary with store link and commands.

---

## 2. Inventory (vendor)

**Goal:** Add, list, restock, sold, remove, image (DB), help. Use the **vendor** number as `from_phone` in simulate.

- **Add (text)**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "add: Black sneakers, 25000, 3"
  ```
  Or with image (DB inventory): `add: Red bag, 15000, 2, https://example.com/bag.jpg`

- **List**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "list"
  ```

- **Sold / Restock / Remove**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "sold: Black sneakers"
  node scripts/simulate-message.js 2349159165954 "restock: Black sneakers, 5"
  node scripts/simulate-message.js 2349159165954 "remove: Red bag"
  ```

- **Image (DB only)**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "image: Black sneakers, https://example.com/sneakers.jpg"
  ```

- **Help**  
  ```bash
  node scripts/simulate-message.js 2349159165954 "stock help"
  ```
  Or: `help`, `commands`, `menu`, `?` — vendor gets full command list.

**Check:** Inventory in Sheet or `inventory_items`; list and help replies correct.

---

## 3. Buyer: browse and purchase

**Goal:** Buyer asks for a product, gets a match, says they want it, gets a payment link. Use a **buyer** number (e.g. your second phone or simulate with a different number).

- **Browse**  
  ```bash
  node scripts/simulate-message.js 2348012345678 "Do you have black sneakers?"
  ```
  Bot should reply with product(s); session goes to `querying` and stores `last_item_name`.

- **Purchase**  
  ```bash
  node scripts/simulate-message.js 2348012345678 "I want it"
  ```
  Or after selecting from list: `1` or `I'll take the first one`.

**Check:**  
- Transaction created (`status = 'pending'`), session `intent_state = 'awaiting_payment'`.  
- Buyer receives a message with payment link. Link should be **proxy** form: `https://your-domain/pay/<token>` (not raw Paystack URL).

**Live:** Message the vendor’s WhatsApp number from your buyer number: “Do you have X?” → “I want it” and confirm you get the proxy link.

---

## 4. Payment (Paystack)

**Goal:** Buyer pays; webhook runs; transaction marked paid; buyer and vendor notified.

1. Use **test card** in Paystack docs (e.g. `5060 6666 6666 6666 666`, expiry future, CVV any).
2. Open the payment link sent to the buyer (proxy URL `/pay/:token` redirects to Paystack).
3. Complete payment; Paystack sends webhook to your **Callback URL**.

**Check:**  
- `transactions.status = 'paid'`, `buyer_id` set.  
- Buyer gets “Payment confirmed” on WhatsApp.  
- Vendor gets “New Sale” with buyer link and delivery commands.  
- Inventory quantity decremented.

**Local testing:** Expose your app with ngrok and set Paystack callback to `https://xxxx.ngrok.io/webhook/paystack`. Or deploy to Koyeb and use that URL.

---

## 5. Receipt and delivery

- **Receipt (buyer):** Open `https://your-domain/receipt/<reference>` (reference from “Payment confirmed” message). PDF: `/receipt/:reference/pdf`.
- **Vendor: orders**  
  From vendor number: `orders` — should list pending (paid, not yet delivered).  
  `DETAILS` — last order’s buyer profile.  
  `DELIVERED` / `TOMORROW` / `ISSUE` — update delivery status for last order.

**Check:** Receipt page loads; `orders` and `DETAILS` show correct data; delivery status updates.

---

## 6. Resend link / cancel

- **Resend (buyer, while awaiting payment)**  
  Buyer: `resend` or `send link` — bot sends payment link again (same transaction).
- **Cancel (buyer)**  
  Buyer: `cancel` or `nevermind` — session cleared to `idle`, no payment link.

Use simulate or live with a buyer number that has an active `awaiting_payment` session.

---

## 7. Negotiation

- Set vendor’s `negotiation_policy` to `fixed` or `escalate` or `auto` (DB or during onboarding).
- Buyer: “Can you do ₦20,000?”  
  - **Fixed:** Bot says price is fixed.  
  - **Escalate:** Vendor is notified to handle.  
  - **Auto:** Bot counters with a new price and continues negotiation.

Test with:  
```bash
node scripts/simulate-message.js 2348012345678 "Can you do 20000?"
```

---

## 8. Waitlist (out of stock)

- Set an item’s quantity to 0 (e.g. `restock: Black sneakers, 0` or `remove: Black sneakers`).
- Buyer asks for that item → bot says out of stock and offers waitlist.
- Buyer: `YES` → waitlist entry created.
- Vendor: `restock: Black sneakers, 5` → waitlisted buyers get “back in stock” message.

**Check:** `waitlist` table; buyer receives notification after restock.

---

## 9. Broadcast

From **vendor** number:

```bash
node scripts/simulate-message.js 2349159165954 "broadcast: Flash sale today! 20% off"
```

**Check:** All buyers who have purchased from this vendor get the message; `broadcast_log` updated.

---

## 10. Abandonment recovery

**Goal:** Bot sends one nudge when a payment link is abandoned (pending 35 min–6 h, buyer inactive 45+ min).

1. Create an abandoned state: buyer got a payment link, didn’t pay, didn’t message for 45+ minutes (or adjust DB for testing: old `transactions.created_at`, old `sessions.updated_at`, `intent_state = 'awaiting_payment'`).
2. With app running and `ENABLE_DEV_SIMULATE=1`:
   ```bash
   curl -X POST http://localhost:3000/dev/run-abandonment
   ```
3. Check logs for `[ABANDONMENT]`; if conditions are met, buyer gets the “link about to expire” message.

Details: **FLOW_DOCUMENTATION.md** → “Testing without another person” → “Abandonment agent”.

---

## 11. Content agent (daily copy)

Runs on cron at 7 AM Nigeria time. For **on-demand test** with `ENABLE_DEV_SIMULATE=1`:

```bash
curl -X POST http://localhost:3000/dev/run-content
```

**Check:** Each active/probation vendor gets WhatsApp Status + Instagram copy in their WhatsApp (to vendor number).

---

## 12. Pricing agent (weekly report)

Runs on cron Sunday 8 PM Nigeria. For **on-demand test** with `ENABLE_DEV_SIMULATE=1`:

```bash
curl -X POST http://localhost:3000/dev/run-pricing
```

**Check:** Each active/probation vendor gets the weekly business report on WhatsApp.

---

## 13. Health and QR

- **Health:** `GET http://localhost:3000/health` → `{ "ok": true }`.
- **QR:** Open `http://localhost:3000/qr` in browser to scan and link WhatsApp (when not using terminal QR).

---

## Quick checklist

| Feature | Dry-run | Live |
|--------|---------|------|
| Vendor onboarding | `simulate-message.js` with vendor number + VENDOR-SETUP | Message VENDOR-SETUP from linked number |
| Inventory add/list/sold/restock/remove/help | `simulate-message.js` with vendor number | Same commands from vendor WhatsApp |
| Buyer browse + purchase | `simulate-message.js` with buyer number | Message vendor number from buyer phone |
| Payment | — | Pay with test card; check webhook + notifications |
| Receipt / delivery | — | Open /receipt/:ref; vendor: orders, DELIVERED |
| Resend / cancel | simulate or live | Same |
| Negotiation | simulate “Can you do 20k?” | Same |
| Waitlist | restock 0 → buyer YES → restock 5 | Same |
| Broadcast | simulate from vendor | Same |
| Abandonment | — | Setup data + `POST /dev/run-abandonment` |
| Content agent | — | `POST /dev/run-content` |
| Pricing agent | — | `POST /dev/run-pricing` |

---

## Troubleshooting

- **“WhatsApp not connected”** — Scan QR; ensure `VENDBOT_NUMBER` matches the linked number.
- **Vendor not found** — One-number-per-vendor: the number that scanned the QR is the vendor; use that as `VENDBOT_NUMBER` and for vendor commands.
- **Payment webhook not firing** — Check Paystack callback URL, HTTPS, and server logs; use Paystack Dashboard “Test webhook” if needed.
- **No abandonment nudge** — Transaction must be 35 min–6 h old, session `awaiting_payment`, buyer inactive 45+ min; only one nudge per buyer per run.
- **AI/classifier** — Commerce-only replies; greetings/small talk may be ignored (by design). Use product/purchase-related messages for buyer tests.
