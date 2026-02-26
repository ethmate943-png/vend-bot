const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { getTierCapMultiplier } = require('../verified-vendor');

async function checkVendorCap(vendor, amountKobo) {
  if (process.env.DISABLE_VENDOR_CAP === '1' || process.env.DISABLE_VENDOR_CAP === 'true') {
    return { allowed: true };
  }

  const lastReset = new Date(vendor.volume_reset_at || 0);
  const now = new Date();
  const isNewDay = lastReset.toDateString() !== now.toDateString();

  if (isNewDay) {
    await query(
      'UPDATE vendors SET daily_volume_kobo = 0, volume_reset_at = NOW() WHERE id = $1',
      [vendor.id]
    );
    vendor.daily_volume_kobo = 0;
  }

  const baseCap = vendor.custom_daily_cap_kobo ?? vendor.daily_cap_kobo ?? 5000000;
  const capMultiplier = getTierCapMultiplier(vendor.verified_vendor_tier);
  const effectiveCap = Math.floor(Number(baseCap) * capMultiplier);
  const currentVolume = Number(vendor.daily_volume_kobo || 0);
  const projected = currentVolume + amountKobo;

  if (projected > effectiveCap) {
    return {
      allowed: false,
      remaining: Math.max(0, effectiveCap - currentVolume),
      cap: effectiveCap
    };
  }
  return { allowed: true };
}

async function generatePaymentLink({ amount, itemName, itemSku, buyerJid, vendorId, vendorPhone, cartItems = null }) {
  const reference = `VBOT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const payToken = uuidv4().replace(/-/g, '').slice(0, 32); // token for /pay/:token — binds link to this transaction
  const buyerPhone = buyerJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

  const vRes = await query('SELECT * FROM vendors WHERE id = $1', [vendorId]);
  const vendor = vRes.rows[0];
  if (!vendor) throw new Error('Vendor not found');

  const reservePercent = Number(vendor.reserve_percent || 10);
  const amountKobo = Math.round(Number(amount) * 100);
  const vendorAmountKobo = Math.floor(amountKobo * (1 - reservePercent / 100));

  let callbackBase = (process.env.CALLBACK_BASE_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  try {
    callbackBase = new URL(callbackBase).origin;
  } catch (_) {}
  if (!callbackBase) throw new Error('CALLBACK_BASE_URL or APP_URL must be set for payment callback');
  const callbackUrl = `${callbackBase}/payment/callback?vendor=${encodeURIComponent(String(vendorPhone || vendor.whatsapp_number).replace(/\D/g, ''))}`;

  const body = {
    email: `${buyerPhone}@vendbot.app`,
    amount: amountKobo, // Paystack expects kobo
    reference,
    callback_url: callbackUrl,
    metadata: { vendorId, buyerPhone, itemName, itemSku }
  };

  if (vendor.paystack_subaccount_code) {
    body.subaccount = vendor.paystack_subaccount_code;
    body.bearer = 'subaccount';
    body.transaction_charge = vendorAmountKobo;
  }

  const res = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    body,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const paystackUrl = res.data.data.authorization_url;
  const cartJson = cartItems && cartItems.length > 0
    ? JSON.stringify(cartItems.map(i => ({ sku: i.sku, quantity: i.quantity })))
    : null;

  await query(
    `INSERT INTO transactions (vendor_id, buyer_jid, buyer_phone, item_name, item_sku, amount, mono_ref, mono_link, pay_token, status, cart_items_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
    [vendorId, buyerJid, buyerPhone, itemName, itemSku, amountKobo, reference, paystackUrl, payToken, cartJson]
  );

  // Return the actual Paystack payment link and current business name (from the row we just loaded)
  return { link: paystackUrl, reference, business_name: vendor.business_name || '' };
}

async function verifyTransaction(reference) {
  const res = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return res.data.data;
}

async function checkDuplicatePayment(buyerJid, vendorId, itemSku) {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const res = await query(
    `SELECT * FROM transactions
     WHERE buyer_jid = $1 AND vendor_id = $2
       AND status = 'paid' AND created_at >= $3
     LIMIT 1`,
    [buyerJid, vendorId, fiveMinutesAgo]
  );
  return res.rows[0] || null;
}

module.exports = { generatePaymentLink, checkVendorCap, checkDuplicatePayment, verifyTransaction };
