# VendBot

WhatsApp-native AI commerce bot for Nigerian vendors. Buyers message your WhatsApp number, an AI assistant helps them browse your catalog and purchase — payments, receipts, inventory updates, and escrow all handled automatically.

## How It Works

```
Buyer: "Do you have black sneakers?"
Bot:   "Yes! Black Air Force 1 — ₦25,000. Only 2 left!"
Buyer: "I want it"
Bot:   [sends payment link]
Buyer: [pays via Paystack]
Bot → Buyer:  "✅ Payment receipt + Paystack receipt link"
Bot → Vendor: "🛍️ New Sale! Payout in 72hrs."
Sheet: Quantity auto-decremented from 2 → 1
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + Express.js |
| WhatsApp | Baileys (open-source WA Web client) |
| AI | Groq SDK (Llama 3.1 / 3.3) |
| Payments | Paystack API |
| Database | Neon (Serverless PostgreSQL) |
| Inventory | Google Sheets API (real-time) |
| Scheduling | node-cron |

## Project Structure

```
vendbot/
├── src/
│   ├── whatsapp/     # Baileys client, message listener, sender
│   ├── ai/           # Intent classifier + reply generator
│   ├── inventory/    # Google Sheets read/write
│   ├── payments/     # Paystack payment links + webhooks
│   ├── sessions/     # Buyer-vendor conversation state
│   ├── vendors/      # Vendor lookup + trust scoring
│   ├── safety/       # Velocity checks + escrow logic
│   ├── db.js         # Neon serverless database client
│   ├── server.js     # Express routes + webhook handler
│   ├── cron.js       # Scheduled jobs
│   └── index.js      # Entry point
├── migrate.js        # Database migration script
├── register_vendor.js # Vendor registration helper
├── Dockerfile        # Docker build for deployment
├── koyeb.yaml        # Koyeb app reference (port, volume, health check)
├── KOYEB.md          # Deploy to Koyeb (stable webhook URL)
└── .env.example      # Environment variable template
```

## Setup

1. **Clone and install**
   ```bash
   git clone <repo-url>
   cd vendbot
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Fill in your API keys (Groq, Paystack, Neon, Google Sheets)
   ```

3. **Run database migrations**
   ```bash
   node migrate.js
   ```

4. **Register a vendor**
   ```bash
   node register_vendor.js 234XXXXXXXXXX
   ```

5. **Start the bot**
   ```bash
   npm run dev
   ```
   Scan the QR code with WhatsApp to connect.

6. **Deploy to Koyeb (optional, for a stable webhook URL)**  
   Push the repo to GitHub, then follow **[KOYEB.md](KOYEB.md)** to create a Koyeb service (Dockerfile build), set env vars from `.env.example`, add a `/data` volume, and set your Paystack webhook to `https://YOUR_APP.koyeb.app/webhook/paystack`.

## Environment Variables

| Variable | Description |
|----------|------------|
| `GROQ_API_KEY` | Groq API key for AI |
| `GROQ_MODEL` | Fast model (llama-3.1-8b-instant) |
| `GROQ_MODEL_SMART` | Smart model (llama-3.3-70b-versatile) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key |
| `PAYSTACK_PUBLIC_KEY` | Paystack public key |
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Sheets service account |
| `GOOGLE_PRIVATE_KEY` | Google Sheets private key |
| `APP_URL` | Public URL for webhooks |
| `PORT` | Server port (default: 3000) |

## Safety Features

- **Escrow**: Funds held 72hrs (new vendors) / 24hrs (established) before payout
- **Velocity monitoring**: Blocks vendors exceeding 10x daily average transactions
- **Delivery confirmation**: Buyer pinged 3hrs after payment to confirm receipt
- **Trust scoring**: Vendors flagged/banned after repeated delivery failures
- **Webhook verification**: Paystack HMAC signature + server-side verify API call

## Cron Jobs

| Schedule | Job |
|----------|-----|
| Every 30 min | Expire unpaid payment links, notify buyer + vendor |
| Every hour | Release escrow payouts (if no dispute) |
| Daily 8am | Remind vendors to update inventory |

## License

ISC
