# WhatsApp Business API (Cloud) – integration & migration

Use this when you want to switch from Baileys to the official **WhatsApp Cloud API** (e.g. after setting up a WhatsApp Business Profile in Meta Business Suite).

## What you need before switching

1. **Meta Developer App** with WhatsApp product (Cloud API)  
   - [developers.facebook.com](https://developers.facebook.com) → Create App → Business type → Add product **WhatsApp**.
2. **WhatsApp Business Account**  
   - Linked to your Meta Business (you may already have this with your Business Profile).
3. **Phone number**  
   - In Meta Business Suite / WhatsApp Manager: add and verify the number you’ll use for the bot.  
   - If that number is currently used with Baileys, you’ll need to remove it from the linked device and then add it to the Business API (or use a different number for the API).
4. **Access token**  
   - System User or long‑lived token with `whatsapp_business_messaging` and `whatsapp_business_management`.  
   - In App Dashboard → WhatsApp → API Setup you can get a temporary token; for production use a System User token.
5. **Webhook URL**  
   - Must be **HTTPS** and publicly reachable (e.g. `https://your-domain.com/webhook/whatsapp`).  
   - In App Dashboard → WhatsApp → Configuration → Webhook: set URL and **Verify token** (any secret string you choose).

## Environment variables (Cloud API)

Set these **only when** you want to use the Cloud API (see “How to switch” below).

| Variable | Description |
|----------|-------------|
| `WHATSAPP_PROVIDER` | Set to `cloud-api` to use Business API instead of Baileys. Omit or set to `baileys` to keep current behaviour. |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID from WhatsApp Manager / API Setup (numeric). |
| `VENDBOT_NUMBER` | **Required for Cloud API.** The display phone number (digits) of your business number, e.g. `19809077055708`. Used to resolve which vendor/store receives messages. |
| `WHATSAPP_ACCESS_TOKEN` | Permanent or long‑lived access token with WhatsApp permissions. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Same string you set in Meta’s webhook “Verify token” field (used for GET verification). |

Optional:

- `WHATSAPP_API_VERSION` – Graph API version (default: `v21.0`).

## How to switch (migrate when ready)

1. Complete the setup above (number, token, webhook URL).
2. In your `.env` add:
   ```env
   WHATSAPP_PROVIDER=cloud-api
   WHATSAPP_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_ACCESS_TOKEN=EAAYPwkHiXd8BQ53rEx8AR9ErFMuGBDapMC5XTBZAZCvUhxTrebzxiMqsrvqOBLWES4rH5gO2QZCpmF2y7MJuf7lOkr0jVi4oaL5phuSffN4XHxFI5cqHtSElKBPf4baRTqvRsrJQLJoLvjta4CErO9a5aVOTpJM7o9AsiayQVCXbheAAIB14uKE4zZBpO8OPBwZDZD
   WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_verify_token
   ```
3. In Meta’s webhook configuration set:
   - **Callback URL:** `https://your-domain.com/webhook/whatsapp`
   - **Verify token:** same as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
4. Subscribe to **messages** (and optionally **message_echoes** if you need sent-message tracking).
5. Restart VendBot. It will use the Cloud API instead of Baileys: no QR, messages come via webhook.

To switch back to Baileys, remove `WHATSAPP_PROVIDER` or set `WHATSAPP_PROVIDER=baileys` and restart.

## Behaviour with Cloud API

- **Incoming:** Meta sends events to `POST /webhook/whatsapp`. VendBot normalises them to the same shape the rest of the app expects, so the existing listener and handlers stay unchanged.
- **Outgoing:** All sends (text, image, list, etc.) go through the Cloud API “Send messages” endpoint; `getSock()` returns an adapter that talks to the API.
- **No QR:** Connection is “always on” once the webhook is verified and the app is running.

## Number / Business Profile

- The number in your WhatsApp Business Profile should be the one added in WhatsApp Manager and used as `WHATSAPP_PHONE_NUMBER_ID`.
- If that number is currently linked to Baileys (WhatsApp multi-device), you must unlink it before adding it to the Business API, or use a different number for the API.

---

## Message types: what’s needed for testing and flows

Official reference: [Send messages – WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages).

### Already implemented (ready to test)

| Type | Cloud API | Use in VendBot |
|------|-----------|-----------------|
| **Text** | `type: "text"` | All replies, confirmations, help, payment links, vendor commands. |
| **Image** | `type: "image"`, `image.link` + `caption` | Product photos, receipt images, vendor “set image” flow. |
| **Interactive list** | `type: "interactive"`, `interactive.type: "list"` | Product choice (buyer: “pick item”), vendor inventory list (“View items”). Up to 10 rows; tap returns `list_reply.id` (we use SKU). |

With these three you can **test the full current flow**: buyer browse → list → number/SKU → purchase; vendor add/restock/list; receipts and payment links.

### Wanted for richer flows (vendors adding items, buyers requesting variants)

| Type | Cloud API | Why we want it |
|------|-----------|----------------|
| **Reply buttons** | `type: "interactive"`, `interactive.type: "button"` | Up to 3 buttons (e.g. “Add item”, “View list”, “Cancel”). Good for vendor “what next?” and buyer “Size?” / “Color?” quick choices without a full list. |
| **Flow messages** | `type: "interactive"`, `interactive.type: "flow"` | **Highly needed.** Multi-step forms: (1) **Vendor add item** – name, price, qty, optional image in one guided flow. (2) **Buyer variants** – size, color, storage, etc. in one flow instead of several list messages. Requires building and publishing a Flow in Meta’s Flow Builder and sending it via the API. |

Flow docs: [Interactive Flow messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-flow-messages/).

### Summary: what to implement for testing vs flows

- **To test Business API now:** Use existing implementation (text + image + interactive list). Set `WHATSAPP_PROVIDER=cloud-api` and the env vars above; all current buyer/vendor behaviour works.
- **To add next for flows:**  
  1. **Reply buttons** – optional; improves UX for 2–3 option choices (vendor menu, variant type).  
  2. **Flow messages** – high value for vendor “add something” and buyer “request variants of goods”; need Flow JSON built in Meta and `sendMessage` support for `interactive.flow` in `src/whatsapp/cloud-api.js`.
