# Deploy VendBot on Koyeb (stable webhook URL)

Deploy to Koyeb so Paystack (and payment callbacks) use a **fixed URL** instead of ngrok.

**Repo is Koyeb-ready:** `Dockerfile`, `koyeb.yaml` (reference), and `.env.example` (env template). Follow the steps below.

---

## 1. Push your code to GitHub

```bash
git add .
git commit -m "Add Koyeb deployment"
git remote add origin https://github.com/YOUR_USERNAME/vendbot.git
git push -u origin main
```

---

## 2. Create a Koyeb account and service

1. Go to [koyeb.com](https://www.koyeb.com) and sign up / log in.
2. **Create App** → **Docker**.
3. Connect your GitHub and select the **vendbot** repo.
4. **Builder**: choose **Dockerfile** (Koyeb will use the repo’s `Dockerfile`).
5. **Service name**: e.g. `vendbot`.
6. **Region**: pick one close to you (e.g. Frankfurt, Washington).

Optional: the repo includes **`koyeb.yaml`** as a reference for service name, port, health check, and volume path. If your Koyeb CLI or dashboard supports importing it, you can use it; otherwise configure the same in the UI (see below).

---

## 3. Environment variables

In the Koyeb service → **Settings** → **Environment variables**, add the same vars as in your `.env` (no quotes needed in the UI):

| Name | Example / note |
|------|------------------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Koyeb sets this automatically; you can leave it) |
| `APP_URL` | **Your Koyeb URL** (see step 4) |
| `GROQ_API_KEY` | Your key |
| `GROQ_MODEL` | `llama-3.1-8b-instant` |
| `GROQ_MODEL_SMART` | `llama-3.3-70b-versatile` |
| `PAYSTACK_SECRET_KEY` | `sk_live_...` or `sk_test_...` |
| `PAYSTACK_PUBLIC_KEY` | `pk_live_...` or `pk_test_...` |
| `DATABASE_URL` | Neon connection string |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | Full private key (with `\n` for newlines) |
| `ESCROW_HOLD_NEW_VENDOR_HOURS` | e.g. `72` |
| `ESCROW_HOLD_ESTABLISHED_HOURS` | e.g. `24` |
| `ESTABLISHED_VENDOR_MIN_TRANSACTIONS` | e.g. `20` |
| `VELOCITY_MAX_DAILY_MULTIPLIER` | e.g. `10` |
| `PAYMENT_LINK_EXPIRY_MINUTES` | e.g. `30` |
| `DISPUTE_WHATSAPP_NUMBER` | e.g. `2349159165954` |

---

## 4. Set the public URL (APP_URL and webhook)

1. In Koyeb, open your service → **Settings** → **Domains**.
2. You’ll see a URL like:  
   `https://vendbot-XXXXX.koyeb.app`  
   (or a custom domain if you add one.)
3. Set **APP_URL** to that URL (no trailing slash), e.g.:  
   `APP_URL=https://vendbot-XXXXX.koyeb.app`
4. **Paystack webhook URL** (in [Paystack Dashboard](https://dashboard.paystack.com) → Settings → API Keys & Webhooks):

   ```
   https://vendbot-XXXXX.koyeb.app/webhook/paystack
   ```

   Replace `vendbot-XXXXX.koyeb.app` with your real Koyeb domain. This is the **stable URL** Paystack will call when a payment succeeds.

---

## 5. Persistent storage (WhatsApp session)

So the bot stays logged in across restarts:

1. In Koyeb service → **Settings** → **Volumes**.
2. **Add volume**:
   - **Path in container**: `/data`
   - **Size**: e.g. 1 GB (or minimum allowed).
3. Redeploy so the container has `/data`. The app already uses `/data/auth_info_baileys` when `NODE_ENV=production`.

---

## 6. First run and QR login

1. Deploy the service. After the first deploy, open **Logs**.
2. The app will start and show a **QR code** in the logs. Scan it with WhatsApp (same number you use for the vendor).
3. After scanning, the session is stored in the `/data` volume, so the next restarts won’t ask for QR again (unless you’re logged out).

---

## 7. Check that the webhook is online

- **Health**:  
  `https://YOUR_KOYEB_DOMAIN.koyeb.app/health`  
  Should return: `{"status":"ok","service":"vendbot",...}`

- **Webhook**: Paystack will send POST requests to  
  `https://YOUR_KOYEB_DOMAIN.koyeb.app/webhook/paystack`  
  When a payment succeeds you should see in Koyeb logs:  
  `🔔 PAYSTACK WEBHOOK HIT!` and the receipt lines.

---

## Summary

| What | URL |
|------|-----|
| App / health | `https://YOUR_SERVICE.koyeb.app/health` |
| Paystack webhook (set in Paystack Dashboard) | `https://YOUR_SERVICE.koyeb.app/webhook/paystack` |
| Callback (used automatically in payment links) | `https://YOUR_SERVICE.koyeb.app/payment/callback` |

Set **APP_URL** and the **Paystack webhook URL** to your Koyeb domain so the webhook is online and stable.
