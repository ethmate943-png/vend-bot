const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');

async function upsertBuyerAndRelationship(buyerJid, buyerPhone, vendorId, amountKobo) {
  const phone = buyerPhone || buyerJid.replace('@s.whatsapp.net', '');
  const res = await query(
    `INSERT INTO buyers (whatsapp_jid, phone, last_seen)
     VALUES ($1, $2, NOW())
     ON CONFLICT (whatsapp_jid) DO UPDATE SET last_seen = NOW()
     RETURNING id, total_purchases, total_spent`,
    [buyerJid, phone]
  );
  const buyer = res.rows && res.rows[0];
  if (!buyer) return null;

  await query(
    'UPDATE buyers SET total_purchases = total_purchases + 1, total_spent = total_spent + $1 WHERE id = $2',
    [amountKobo, buyer.id]
  );

  const relRes = await query(
    'SELECT id, total_orders, total_spent FROM buyer_vendor_relationships WHERE buyer_id = $1 AND vendor_id = $2',
    [buyer.id, vendorId]
  );
  const rel = relRes.rows && relRes.rows[0];

  if (rel) {
    await query(
      'UPDATE buyer_vendor_relationships SET total_orders = total_orders + 1, total_spent = total_spent + $1, last_order_at = NOW() WHERE id = $2',
      [amountKobo, rel.id]
    );
  } else {
    await query(
      `INSERT INTO buyer_vendor_relationships (buyer_id, vendor_id, total_orders, total_spent, last_order_at)
       VALUES ($1, $2, 1, $3, NOW())`,
      [buyer.id, vendorId, amountKobo]
    );
  }
  return buyer;
}

async function checkAndFlagVip(buyerJid, vendorId, sock) {
  const buyerRes = await query('SELECT id FROM buyers WHERE whatsapp_jid = $1', [buyerJid]);
  const buyer = buyerRes.rows && buyerRes.rows[0];
  if (!buyer) return;

  const relRes = await query(
    `SELECT bvr.*, v.whatsapp_number, v.business_name FROM buyer_vendor_relationships bvr
     JOIN vendors v ON v.id = bvr.vendor_id
     WHERE bvr.buyer_id = $1 AND bvr.vendor_id = $2`,
    [buyer.id, vendorId]
  );
  const rel = relRes.rows && relRes.rows[0];
  if (!rel || rel.is_vip || rel.total_orders < 3) return;

  await query('UPDATE buyer_vendor_relationships SET is_vip = true WHERE buyer_id = $1 AND vendor_id = $2', [buyer.id, vendorId]);
  await sendWithDelay(sock, `${rel.whatsapp_number}@s.whatsapp.net`,
    `⭐ *New VIP Customer!*\n\n${buyerJid.replace('@s.whatsapp.net', '')} has placed 3 orders totalling ₦${(rel.total_spent / 100).toLocaleString()}.\n\nReply *VIP-MSG* to send them a thank you.`
  );
}

async function getBuyerProfile(buyerJid, vendorId) {
  const buyerRes = await query('SELECT * FROM buyers WHERE whatsapp_jid = $1', [buyerJid]);
  const buyer = buyerRes.rows && buyerRes.rows[0];
  if (!buyer) return null;

  const relRes = await query('SELECT * FROM buyer_vendor_relationships WHERE buyer_id = $1 AND vendor_id = $2', [buyer.id, vendorId]);
  const relationship = relRes.rows && relRes.rows[0];

  const ordersRes = await query(
    'SELECT item_name, amount, status, created_at FROM transactions WHERE buyer_jid = $1 AND vendor_id = $2 ORDER BY created_at DESC LIMIT 5',
    [buyerJid, vendorId]
  );
  const recentOrders = ordersRes.rows || [];

  return { buyer, relationship, recentOrders };
}

function formatBuyerProfileMessage(profile) {
  if (!profile) return 'No profile found for this buyer.';
  const { buyer, relationship: rel, recentOrders } = profile;
  const orders = (recentOrders || []).map((o, i) =>
    `${i + 1}. ${o.item_name} — ₦${(o.amount / 100).toLocaleString()} ${o.status === 'paid' ? '✅' : '⏳'}`
  ).join('\n');
  return `👤 *Buyer Profile*\n\n📱 ${buyer.phone}\n` +
    (rel && rel.is_vip ? '⭐ VIP Customer\n' : '') +
    `🛍️ ${rel ? rel.total_orders : 0} orders with you\n` +
    `💰 ₦${((rel ? rel.total_spent : 0) / 100).toLocaleString()} total spent\n\n` +
    `*Recent orders:*\n${orders || 'None yet'}`;
}

module.exports = { upsertBuyerAndRelationship, checkAndFlagVip, getBuyerProfile, formatBuyerProfileMessage };
