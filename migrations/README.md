# Migrations (Neon / Postgres)

Run these against your **Neon** database so the app has the required tables and columns.

## Option 1: Neon Console (easiest)

1. Open [Neon Console](https://console.neon.tech) → your project.
2. Go to **SQL Editor**.
3. Paste the contents of `neon-inventory-and-pay-token.sql` and run it.

## Option 2: psql

```bash
# Use your Neon connection string (pooled or direct)
psql "$DATABASE_URL" -f migrations/neon-inventory-and-pay-token.sql
```

If your connection string is in `.env`:

```bash
source .env   # or use dotenv
psql "$DATABASE_URL" -f migrations/neon-inventory-and-pay-token.sql
```

## What gets applied

- **transactions.pay_token** — Used for secure payment links (`/pay/:token`).
- **inventory_items** — Table for DB-backed inventory (when vendor doesn’t use Google Sheets). Supports `image_url` for product images.

After running, the app can use both Google Sheets and DB for inventory, and payment links use the proxy URL.
