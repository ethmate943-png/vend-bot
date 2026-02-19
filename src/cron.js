const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage, sendWithDelay } = require('./whatsapp/sender');
const { getDuePayouts, hasOpenDispute } = require('./safety/escrow');

function getSock() {
  return require('./whatsapp/client').getSock();
}

function startCronJobs() {
  // Every 30 mins — expire unpaid payment links
  cron.schedule('*/30 * * * *', async () => {
    try {
      const expiryMinutes = Number(process.env.PAYMENT_LINK_EXPIRY_MINUTES) || 30;
      const res = await query(
        `UPDATE transactions SET status = 'expired'
         WHERE status = 'pending' AND created_at < NOW() - INTERVAL '${expiryMinutes} minutes'
         RETURNING id, buyer_jid, buyer_phone, item_name, amount, vendor_id, mono_ref`
      );
      if (res.rowCount > 0) {
        console.log(`[CRON] Expired ${res.rowCount} payment links`);
        const sock = getSock();
        if (!sock) return;

        for (const txn of res.rows) {
          const amount = `₦${(txn.amount / 100).toLocaleString()}`;

          await sendWithDelay(sock, txn.buyer_jid,
            `⏰ *Payment Link Expired*\n\n` +
            `Your payment link for *${txn.item_name}* (${amount}) has expired.\n\n` +
            `If you'd still like to purchase, just message us again and we'll send a new link!`
          );

          const vendorRes = await query('SELECT whatsapp_number, business_name FROM vendors WHERE id = $1', [txn.vendor_id]);
          if (vendorRes.rows[0]) {
            await sendWithDelay(sock, `${vendorRes.rows[0].whatsapp_number}@s.whatsapp.net`,
              `⏰ *Payment Expired*\n\n` +
              `Buyer ${txn.buyer_phone} did not complete payment for:\n` +
              `Item: *${txn.item_name}*\n` +
              `Amount: ${amount}\n` +
              `Ref: ${txn.mono_ref}\n\n` +
              `_No action needed — they can re-order anytime._`
            );
          }
        }
      }
    } catch (err) {
      console.error('[CRON] Payment expiry error:', err.message);
    }
  });

  // Every hour — release escrow payouts
  cron.schedule('0 * * * *', async () => {
    try {
      const due = await getDuePayouts();
      for (const txn of due) {
        const disputed = await hasOpenDispute(txn.id);
        if (!disputed) {
          await query('UPDATE transactions SET payout_released = true WHERE id = $1', [txn.id]);
          console.log(`[CRON] Released payout for txn ${txn.id}`);
        }
      }
    } catch (err) {
      console.error('[CRON] Escrow release error:', err.message);
    }
  });

  // Daily 8am — stock accuracy reminder to vendors
  cron.schedule('0 8 * * *', async () => {
    try {
      const sock = getSock();
      if (!sock) return;
      const res = await query("SELECT whatsapp_number FROM vendors WHERE status = 'active'");
      for (const v of res.rows) {
        await sendMessage(sock, `${v.whatsapp_number}@s.whatsapp.net`,
          '📦 Good morning! Please check your Google Sheet is up to date before buyers start messaging today. Reply DONE when ready.'
        );
      }
    } catch (err) {
      console.error('[CRON] Vendor reminder error:', err.message);
    }
  });

  console.log('[CRON] Scheduled jobs started');
}

module.exports = { startCronJobs };
