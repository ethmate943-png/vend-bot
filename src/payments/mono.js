const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');

async function generatePaymentLink({ amount, itemName, itemSku, buyerJid, vendorId, vendorPhone }) {
  const reference = `VBOT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const buyerPhone = buyerJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const callbackUrl = `${baseUrl}/payment/callback?vendor=${encodeURIComponent(String(vendorPhone).replace(/\D/g, ''))}`;

  const res = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email: `${buyerPhone}@vendbot.app`,
      amount: amount * 100,
      reference,
      callback_url: callbackUrl,
      metadata: { vendorId, vendorPhone, buyerPhone, itemName, itemSku }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const payLink = res.data.data.authorization_url;

  await query(
    `INSERT INTO transactions (vendor_id, buyer_jid, buyer_phone, item_name, item_sku, amount, mono_ref, mono_link, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [vendorId, buyerJid, buyerPhone, itemName, itemSku, amount * 100, reference, payLink]
  );

  return { link: payLink, reference };
}

async function verifyTransaction(reference) {
  const res = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );
  return res.data.data;
}

module.exports = { generatePaymentLink, verifyTransaction };
