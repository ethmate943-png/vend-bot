const express = require('express');
const crypto = require('crypto');
const { handlePaymentSuccess } = require('./payments/webhook');
const { verifyTransaction } = require('./payments/mono');

const app = express();

app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'vendbot',
  timestamp: new Date().toISOString()
}));

app.get('/payment/callback', async (req, res) => {
  const { reference, vendor } = req.query;

  try {
    if (reference) {
      const txn = await verifyTransaction(reference);
      if (txn.status === 'success') {
        console.log(`[CALLBACK] Payment verified for ref ${reference}`);
        handlePaymentSuccess({
          reference,
          receiptNumber: txn.receipt_number
        }).catch(err =>
          console.error('[CALLBACK] Webhook follow-up error:', err.message)
        );
      }
    }
  } catch (err) {
    console.error('[CALLBACK] Verify error:', err.message);
  }

  if (vendor) {
    return res.redirect(`https://wa.me/${vendor}`);
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

module.exports = app;
