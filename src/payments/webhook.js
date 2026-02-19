const { query } = require('../db');
const { decrementQty } = require('../inventory/sheets');
const { sendWithDelay } = require('../whatsapp/sender');

function getSock() {
  return require('../whatsapp/client').getSock();
}

async function handlePaymentSuccess(data) {
  const { reference, receiptNumber } = data;
  const sock = getSock();

  const txnRes = await query(
    `SELECT t.*, v.whatsapp_number, v.business_name, v.total_transactions,
            v.sheet_id, v.sheet_tab, v.id as vid
     FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.mono_ref = $1 LIMIT 1`,
    [reference]
  );

  const txn = txnRes.rows[0];
  if (!txn) { console.error('[WEBHOOK] Transaction not found:', reference); return; }
  if (txn.status === 'paid') { console.log('[WEBHOOK] Already processed:', reference); return; }

  const isEstablished = txn.total_transactions >= Number(process.env.ESTABLISHED_VENDOR_MIN_TRANSACTIONS);
  const holdHours = isEstablished
    ? Number(process.env.ESCROW_HOLD_ESTABLISHED_HOURS)
    : Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);
  const releaseAt = new Date(Date.now() + holdHours * 3_600_000).toISOString();

  await query(
    `UPDATE transactions SET status = 'paid', escrow_release_at = $1 WHERE id = $2`,
    [releaseAt, txn.id]
  );

  await query(
    `UPDATE vendors SET total_transactions = total_transactions + 1 WHERE id = $1`,
    [txn.vid]
  );

  try {
    await decrementQty(txn.sheet_id, txn.sheet_tab, txn.item_sku);
    await query('UPDATE transactions SET sheet_row_updated = true WHERE id = $1', [txn.id]);
  } catch (e) {
    console.error('[SHEET UPDATE ERROR]', e.message);
  }

  const amountFormatted = `₦${(txn.amount / 100).toLocaleString()}`;
  const date = new Date().toLocaleDateString('en-NG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  if (sock) {
    const receiptLink = receiptNumber
      ? `\n🔗 View receipt: https://paystack.com/receipt/${receiptNumber}\n`
      : '';

    // Receipt to buyer
    await sendWithDelay(sock, txn.buyer_jid,
      `✅ *PAYMENT RECEIPT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏪 *${txn.business_name}*\n\n` +
      `📦 Item: *${txn.item_name}*\n` +
      `💰 Amount: *${amountFormatted}*\n` +
      `🧾 Ref: \`${reference}\`\n` +
      `📅 Date: ${date}\n` +
      receiptLink +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      `Your payment has been received and your order is confirmed.\n\n` +
      `*${txn.business_name}* will contact you to arrange delivery.\n\n` +
      `_Your funds are held in escrow for ${holdHours} hours for your protection. ` +
      `If anything goes wrong, contact wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER}_`
    );

    // Notification to vendor
    await sendWithDelay(sock, `${txn.whatsapp_number}@s.whatsapp.net`,
      `🛍️ *NEW SALE!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 Item: *${txn.item_name}*\n` +
      `💰 Amount: *${amountFormatted}*\n` +
      `👤 Buyer: ${txn.buyer_phone}\n` +
      `🧾 Ref: \`${reference}\`\n` +
      `📅 Date: ${date}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Please arrange delivery for the buyer.\n\n` +
      `💸 Payout: *${holdHours} hours* after delivery is confirmed.\n` +
      `_Inventory has been auto-updated on your sheet._`
    );

    // Delivery check after 3 hours
    setTimeout(async () => {
      try {
        await sendWithDelay(sock, txn.buyer_jid,
          `Hi! Did you receive your *${txn.item_name}* from *${txn.business_name}*?\n\nReply *YES* ✅ or *NO* ❌`
        );
      } catch (err) {
        console.error('[DELIVERY PING ERROR]', err.message);
      }
    }, 3 * 60 * 60 * 1000);
  }
}

async function handleDeliveryReply(buyerJid, vendorId, reply) {
  const confirmed = reply.toLowerCase().includes('yes');

  const txnRes = await query(
    `SELECT * FROM transactions
     WHERE buyer_jid = $1 AND vendor_id = $2 AND status = 'paid' AND delivery_confirmed IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [buyerJid, vendorId]
  );

  const txn = txnRes.rows[0];
  if (!txn) return;

  await query(
    'UPDATE transactions SET delivery_confirmed = $1 WHERE id = $2',
    [confirmed, txn.id]
  );

  if (!confirmed) {
    const { incrementNoCount } = require('../vendors/resolver');
    await incrementNoCount(vendorId);
    const sock = getSock();
    if (sock) {
      await sendWithDelay(sock, buyerJid,
        `Sorry to hear that. We've flagged this for review. Please contact us at wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER} to raise a dispute and we will resolve it within 48 hours.`
      );
    }
  }
}

module.exports = { handlePaymentSuccess, handleDeliveryReply };
