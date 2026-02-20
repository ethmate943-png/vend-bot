const { query } = require('../db');
const { getSock } = require('../whatsapp/client');
const { sendMessage } = require('../whatsapp/sender');

const VENDBOT_NUMBER = (process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');

async function broadcastToAllBuyers(vendorId, message, vendor) {
  const sock = getSock();
  if (!sock) return { sent: 0 };

  const res = await query(
    `SELECT b.whatsapp_jid FROM buyer_vendor_relationships bvr
     JOIN buyers b ON b.id = bvr.buyer_id
     WHERE bvr.vendor_id = $1`,
    [vendorId]
  );
  const rows = res.rows || [];
  if (!rows.length) return { sent: 0 };

  const storeLink = vendor && vendor.store_code ? `wa.me/${VENDBOT_NUMBER}?text=${vendor.store_code}` : '';
  const fullMessage = storeLink ? `${message}\n\nShop now: ${storeLink}` : message;
  let sent = 0;

  for (const row of rows) {
    const jid = row.whatsapp_jid;
    if (!jid) continue;
    try {
      await sendMessage(sock, jid, fullMessage);
      await new Promise(r => setTimeout(r, 1200));
      sent++;
    } catch (e) {
      console.error('[BROADCAST]', e.message);
    }
  }

  await query(
    'INSERT INTO broadcast_log (vendor_id, message, recipient_count) VALUES ($1, $2, $3)',
    [vendorId, fullMessage, sent]
  );
  return { sent };
}

module.exports = { broadcastToAllBuyers };
