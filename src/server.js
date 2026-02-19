const express = require('express');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { handlePaymentSuccess } = require('./payments/webhook');
const { verifyTransaction } = require('./payments/mono');
const { getState } = require('./whatsapp/qr-store');

const app = express();

app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'vendbot',
  timestamp: new Date().toISOString()
}));

// QR page so phone users can scan WhatsApp without using the terminal
app.get('/qr', async (req, res) => {
  const secret = process.env.QR_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(401).send('<html><body><p>Invalid or missing key. Use ?key=YOUR_QR_SECRET</p></body></html>');
  }

  const { qr, connected } = getState();

  if (connected) {
    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
      .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:380px}
      h2{margin-top:0}</style></head>
      <body><div class="card"><h2>✅ WhatsApp connected</h2><p>You can close this page. The bot is running.</p></div></body></html>
    `);
  }

  if (qr) {
    try {
      const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:system-ui;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
        .card{background:#128C7E;padding:1.5rem;border-radius:1rem;max-width:320px}
        h2{margin-top:0;font-size:1.25rem}p{font-size:0.95rem}
        img{display:block;margin:1rem auto;border-radius:8px}</style></head>
        <body><div class="card">
        <h2>Link your WhatsApp</h2>
        <p>Open WhatsApp → Settings → Linked devices → Link a device</p>
        <p>Then scan this QR code:</p>
        <img src="${dataUrl}" alt="QR code" width="280" height="280"/>
        <p><small>Page refreshes when a new QR is generated.</small></p>
        </div></body></html>
      `);
    } catch (err) {
      console.error('[QR] toDataURL error:', err.message);
      return res.status(500).send('<html><body><p>Error generating QR. Try again.</p></body></html>');
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="3">
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
    .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:380px}</style></head>
    <body><div class="card"><h2>⏳ Connecting…</h2><p>Refresh in a moment to see the QR code.</p></div></body></html>
  `);
});

// Payment callback: Paystack redirects the buyer's browser here after they pay.
// We verify, then redirect to WhatsApp chat. Receipt is sent by the WEBHOOK (server-to-server), not here.
app.get('/payment/callback', async (req, res) => {
  const { reference, vendor } = req.query;
  console.log('[CALLBACK] GET /payment/callback', { reference: reference ? 'yes' : 'no', vendor: vendor ? 'yes' : 'no' });

  try {
    if (reference) {
      const txn = await verifyTransaction(reference);
      if (txn.status === 'success') {
        console.log(`[CALLBACK] Payment verified for ref ${reference}`);
        handlePaymentSuccess({
          reference,
          receiptNumber: txn.receipt_number
        }).catch(err =>
          console.error('[CALLBACK] handlePaymentSuccess error:', err.message)
        );
      }
    }
  } catch (err) {
    console.error('[CALLBACK] Verify error:', err.message);
  }

  if (vendor) {
    const waUrl = `https://wa.me/${String(vendor).replace(/\D/g, '')}`;
    console.log('[CALLBACK] Redirecting to WhatsApp:', waUrl);
    return res.redirect(302, waUrl);
  }

  res.send(`
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
    .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.3)}
    h2{margin-top:0}a{color:#25D366;font-weight:bold;font-size:1.1rem}</style></head>
    <body><div class="card">
    <h2>✅ Payment Received!</h2>
    <p>Your receipt has been sent to your WhatsApp chat.</p>
    <p>Go back to WhatsApp to see your confirmation.</p>
    </div></body></html>
  `);
});

// Webhook: Paystack calls this when a payment succeeds (server-to-server).
// This is what sends the receipt and notifies the vendor. The callback URL only redirects the buyer.
app.post('/webhook/paystack', async (req, res) => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🔔 PAYSTACK WEBHOOK HIT!', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('[WEBHOOK] ❌ Invalid Paystack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);
  console.log('[WEBHOOK] ✅ Signature verified');
  console.log('[WEBHOOK] 📦 Paystack event:', event.event);
  if (event.data?.reference) {
    console.log('[WEBHOOK] 🔗 Reference:', event.data.reference);
  }

  if (event.event === 'charge.success') {
    console.log('[WEBHOOK] 💰 Processing successful payment...');
    try {
      const txnData = await verifyTransaction(event.data.reference);
      if (txnData.status === 'success') {
        console.log('\n📋 ─── RECEIPT DETAILS ───');
        console.log(`🧾 Receipt Number: ${txnData.receipt_number || 'N/A'}`);
        console.log(`🔗 Reference: ${txnData.reference}`);
        console.log(`💰 Amount: ₦${(txnData.amount / 100).toLocaleString()}`);
        console.log(`📧 Customer: ${txnData.customer?.email || 'N/A'}`);
        console.log(`📅 Paid At: ${txnData.paid_at || 'N/A'}`);
        console.log(`💳 Channel: ${txnData.channel || 'N/A'}`);
        console.log(`🏦 Bank: ${txnData.authorization?.bank || txnData.authorization?.card_type || 'N/A'}`);
        console.log('─────────────────────────────\n');
        
        console.log('[WEBHOOK] ✅ Payment verified, sending notifications...');
        await handlePaymentSuccess({
          reference: event.data.reference,
          receiptNumber: txnData.receipt_number
        });
        console.log('[WEBHOOK] ✅ Payment processing complete!\n');
      } else {
        console.warn('[WEBHOOK] ⚠️ Paystack verify status:', txnData.status);
      }
    } catch (err) {
      console.error('[WEBHOOK] ❌ Verify failed, processing anyway:', err.message);
      await handlePaymentSuccess({ reference: event.data.reference });
    }
  } else {
    console.log(`[WEBHOOK] ℹ️ Event type: ${event.event} (not processing)\n`);
  }

  res.status(200).json({ received: true });
});

// Catch-all: so wrong paths don't show "Cannot GET /route" (e.g. bad callback URL)
app.use((req, res) => {
  console.warn('[SERVER] No route for', req.method, req.path);
  res.status(404).send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:system-ui;text-align:center;padding:2rem;">
    <h2>Page not found</h2>
    <p>This URL is not used by VendBot. Valid paths: <code>/health</code>, <code>/qr</code>, <code>/payment/callback</code>.</p>
    </body></html>
  `);
});

module.exports = app;
