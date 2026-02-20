const express = require('express');
const crypto = require('crypto');
const qrcode = require('qrcode');
const PDFDocument = require('pdfkit');
const { handlePaymentSuccess } = require('./payments/webhook');
const { verifyTransaction } = require('./payments/mono');
const { getReceiptData } = require('./payments/receipt-data');
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
// Handle both /payment/callback and /payment/callback/ (trailing slash) so redirect always works.
async function paymentCallback(req, res) {
  const ref = req.query.reference || req.query.trxref;
  const { vendor } = req.query;
  console.log('[CALLBACK] GET /payment/callback', { reference: ref || 'none', vendor: vendor ? 'yes' : 'no', queryKeys: Object.keys(req.query) });

  try {
    if (ref) {
      const txn = await verifyTransaction(ref);
      if (txn.status === 'success') {
        console.log(`[CALLBACK] Payment verified for ref ${ref}, sending receipt...`);
        const receiptNumber = txn.receipt_number || txn.receipt || null;
        await handlePaymentSuccess({ reference: ref, receiptNumber });
        console.log('[CALLBACK] Receipt sent.');
      } else {
        console.warn('[CALLBACK] Verify status not success:', txn.status);
      }
    } else {
      console.warn('[CALLBACK] No reference or trxref in query');
    }
  } catch (err) {
    console.error('[CALLBACK] Error:', err.message);
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
}

app.get('/payment/callback', paymentCallback);
// With trailing slash: redirect to canonical URL so route always matches
app.get('/payment/callback/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
});

// Wrong callback URL (if APP_URL was set with /webhook/paystack): redirect to correct path
app.get('/webhook/paystack/payment/callback', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
});
app.get('/webhook/paystack/payment/callback/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
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

// Visual receipt: view in browser and download as PDF
function receiptBaseUrl() {
  const u = process.env.CALLBACK_BASE_URL || process.env.APP_URL || '';
  try { return new URL(u).origin; } catch (_) { return u || ''; }
}

app.get('/receipt/:reference', async (req, res) => {
  const reference = req.params.reference.replace(/\.pdf$/i, '');
  const data = await getReceiptData(reference);
  if (!data) {
    return res.status(404).send('<html><body><p>Receipt not found or payment not completed.</p></body></html>');
  }

  const base = receiptBaseUrl();
  const receiptUrl = `${base}/receipt/${encodeURIComponent(data.reference)}`;
  const pdfUrl = `${receiptUrl}/pdf`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Payment Receipt - ${escapeHtml(data.reference)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #e8e8e8; }
    .receipt { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.12); overflow: hidden; }
    .head { background: #075E54; color: #fff; padding: 1.5rem 1.5rem; text-align: center; }
    .head h1 { margin: 0; font-size: 1.1rem; font-weight: 600; letter-spacing: 0.02em; }
    .head .sub { margin: 0.4rem 0 0; font-size: 0.75rem; opacity: .92; text-transform: uppercase; letter-spacing: 0.08em; }
    .body { padding: 1.5rem 1.5rem 1.25rem; }
    .receipt-title { text-align: center; font-size: 0.85rem; font-weight: 700; color: #333; margin-bottom: 1.25rem; letter-spacing: 0.03em; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; padding: 0.5rem 0; border-bottom: 1px solid #eee; gap: 1rem; }
    .row:last-of-type { border-bottom: none; }
    .label { color: #666; font-size: 0.875rem; flex-shrink: 0; }
    .value { font-weight: 600; color: #222; text-align: right; font-size: 0.9rem; }
    .total-row { margin-top: 1rem; padding-top: 1rem; border-top: 2px solid #075E54; font-size: 1.15rem; }
    .total-row .value { color: #075E54; font-size: 1.2rem; }
    .amount-words { font-size: 0.8rem; color: #555; font-style: italic; margin-top: 0.35rem; }
    .footer-note { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px dashed #ddd; font-size: 0.8rem; color: #777; text-align: center; line-height: 1.45; }
    .payment-method { font-size: 0.8rem; color: #666; margin-top: 0.5rem; }
    .actions { padding: 1rem 1.5rem; background: #f7f7f7; text-align: center; border-top: 1px solid #eee; }
    .btn { display: inline-block; padding: 0.6rem 1.25rem; background: #25D366; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 0 0.35rem; font-size: 0.9rem; }
    .btn:hover { background: #20bd5a; }
    .btn.secondary { background: #075E54; }
    .btn.secondary:hover { background: #064a43; }
    @media print { body { background: #fff; padding: 0; } .receipt { box-shadow: none; } .actions { display: none; } }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="head">
      <h1>${escapeHtml(data.businessName)}</h1>
      <p class="sub">Official Payment Receipt</p>
    </div>
    <div class="body">
      <p class="receipt-title">OFFICIAL PAYMENT RECEIPT</p>
      <div class="row">
        <span class="label">Receipt No.</span>
        <span class="value">${escapeHtml(data.reference)}</span>
      </div>
      <div class="row">
        <span class="label">Date &amp; Time</span>
        <span class="value">${escapeHtml(data.date)}</span>
      </div>
      <div class="row">
        <span class="label">Description</span>
        <span class="value">${escapeHtml(data.itemName)}</span>
      </div>
      <div class="row total-row">
        <span class="label">Amount Paid</span>
        <span class="value">${escapeHtml(data.amountFormatted)}</span>
      </div>
      <div class="amount-words">${escapeHtml(data.amountInWords)}</div>
      <p class="payment-method">Payment method: Paystack</p>
      <div class="footer-note">
        Thank you for your purchase. This receipt confirms your payment. Keep it for your records.<br>
        <strong>${escapeHtml(data.businessName)}</strong> will contact you to arrange delivery.
      </div>
    </div>
    <div class="actions">
      <a href="${pdfUrl}" class="btn" download>Download PDF</a>
      <a href="javascript:window.print()" class="btn secondary">Print</a>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

app.get('/receipt/:reference/pdf', async (req, res) => {
  const reference = req.params.reference;
  const data = await getReceiptData(reference);
  if (!data) {
    return res.status(404).send('Receipt not found');
  }

  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${data.reference}.pdf"`);
  doc.pipe(res);

  doc.fontSize(16).fillColor('#075E54').text(data.businessName, { align: 'center' });
  doc.moveDown(0.35);
  doc.fontSize(9).fillColor('#333').text('OFFICIAL PAYMENT RECEIPT', { align: 'center' });
  doc.moveDown(1.2);

  doc.fontSize(9).fillColor('#666');
  doc.text('Receipt No.: ', { continued: true }).fillColor('#222').text(data.reference);
  doc.moveDown(0.5);
  doc.fillColor('#666').text('Date & Time: ', { continued: true }).fillColor('#222').text(data.date);
  doc.moveDown(0.5);
  doc.fillColor('#666').text('Description: ', { continued: true }).fillColor('#222').text(data.itemName);
  doc.moveDown(0.5);
  doc.fillColor('#666').text('Amount Paid: ', { continued: true }).fillColor('#075E54').fontSize(12).text(data.amountFormatted);
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#555').font('Helvetica-Oblique').text(data.amountInWords);
  doc.font('Helvetica');
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#666').text('Payment method: Paystack');
  doc.moveDown(1);

  doc.fontSize(8).fillColor('#777').text(
    'Thank you for your purchase. This receipt confirms your payment. ' +
    data.businessName + ' will contact you to arrange delivery.',
    { align: 'center', width: doc.page.width - 72 }
  );

  doc.end();
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Catch-all: so wrong paths don't show "Cannot GET /route" (e.g. bad callback URL)
app.use((req, res) => {
  console.warn('[SERVER] No route for', req.method, req.path);
  res.status(404).send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:system-ui;text-align:center;padding:2rem;">
    <h2>Page not found</h2>
    <p>This URL is not used by VendBot. Valid paths: <code>/health</code>, <code>/qr</code>, <code>/payment/callback</code>, <code>/receipt/:reference</code>.</p>
    </body></html>
  `);
});

module.exports = app;
