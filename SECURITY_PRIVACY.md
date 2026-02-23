# Security & Privacy — Chat Monitoring

VendBot does **not** monitor or surveil users. This doc explains what data is used for the bot to work and how to minimise storage and logging of chat content.

---

## What we do by default

| Data | Where | Purpose |
|------|--------|--------|
| **Chat history (last 10 messages)** | `sessions.chat_history` in DB | Gives the AI recent context so it can answer “I want that one” or “what about the red one?” correctly. |
| **Console logs** | Server stdout | Incoming message text and bot replies are logged (vendor name, buyer phone, intent) for debugging. |

We do **not**:

- Send chat content to any third party except the AI providers (Groq, Kimi/NVIDIA) for classification and replies.
- Record or store voice note content beyond transcribing it once to add inventory (vendor only).
- Use chat content for advertising or analytics.

---

## How to avoid storing and logging chats (privacy mode)

You can turn on **privacy mode** so we do **not** store chat content and do **not** log message/reply text.

Add to your `.env`:

```env
PRIVACY_NO_CHAT_STORAGE=true
PRIVACY_NO_CHAT_LOGS=true
```

### Effect

- **`PRIVACY_NO_CHAT_STORAGE=true`**
  - We **do not** write to `sessions.chat_history`.
  - `getChatHistory()` always returns `[]`, so the AI gets no prior messages — only the current message and session state (e.g. “awaiting_payment”, “last item: Black sneakers”).
  - Conversation flow (payment, negotiation, selection) still works; replies may be slightly less context-aware (e.g. “I want it” with no history may need a follow-up).

- **`PRIVACY_NO_CHAT_LOGS=true`**
  - We **do not** log message or reply text to the console.
  - We log only that a message was received and a reply was sent; buyer identifier is redacted as `[redacted]`.
  - In `client.js`, we log only “DM received”, not the message body.

So with both set, we **circumvent** storing and logging user chats for security/privacy.

---

## What we still need to store (even in privacy mode)

To run the bot we still keep:

- **Session state:** `intent_state`, `pending_payment_ref`, `last_item_name`, `last_item_sku` (no free‑form chat).
- **Transactions:** item name, amount, buyer phone/jid, reference (for payments and receipts).
- **CRM:** buyer phone/jid, order counts, spend (for VIP, broadcast, waitlist).
- **Vendor data:** business name, store code, sheet id, etc.

None of this is “monitoring” of chats; it’s the minimum needed for orders, payments, and support.

---

## Payment link binding (mitigating interception)

To reduce the risk of payment links being intercepted or forwarded to the wrong person, we **do not send the raw Paystack URL** to the buyer. Instead we send a **proxy link** that is bound to a single transaction (buyer + vendor + order):

- When we create a payment, we store a one-time **pay_token** for that transaction and return a link like `https://your-app.com/pay/TOKEN`.
- The buyer only ever sees this `/pay/TOKEN` link. The real Paystack URL is stored server-side and used only when the buyer clicks: we look up the transaction by token, check it’s still valid and for that order, then redirect to Paystack.
- So the link is **strictly for this transaction**: same buyer, same vendor, same item. Expired or already-paid links show a clear message instead of redirecting.
- Run the migration `migrations/pay-token.sql` so the `transactions.pay_token` column exists.

---

## Summary

- By default we store a short chat history and log message/reply text for context and debugging.
- For **no chat monitoring / no chat storage and no chat logs**, set:
  - `PRIVACY_NO_CHAT_STORAGE=true`
  - `PRIVACY_NO_CHAT_LOGS=true`
- That way we do **not** monitor or retain user chat content beyond what’s strictly needed for the current request and for order/payment/CRM data.
