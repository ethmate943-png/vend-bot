const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage, sendWithDelay } = require('./whatsapp/sender');
const { getDuePayouts, hasOpenDispute } = require('./safety/escrow');
const { runContentAgent } = require('./agents/content');
const { runAbandonmentAgent } = require('./agents/abandonment');
const { runPricingAgent } = require('./agents/pricing');
const { runVendorTierGraduation, runDemotionChecks } = require('./verified-vendor');

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

  // Daily 7am Nigeria (6am UTC) — content agent (Status + Instagram copy)
  cron.schedule('0 6 * * *', async () => {
    try {
      await runContentAgent();
      console.log('[CRON] Content agent ran');
    } catch (err) {
      console.error('[CRON] Content agent error:', err.message);
    }
  });

  // Every 12 hours — abandonment recovery (activity-based: only nudges when buyer inactive)
  cron.schedule('0 */12 * * *', async () => {
    try {
      await runAbandonmentAgent();
      console.log('[CRON] Abandonment agent ran');
    } catch (err) {
      console.error('[CRON] Abandonment agent error:', err.message);
    }
  });

  // Sunday 8pm Nigeria (7pm UTC) — weekly pricing report
  cron.schedule('0 19 * * 0', async () => {
    try {
      await runPricingAgent();
      console.log('[CRON] Pricing agent ran');
    } catch (err) {
      console.error('[CRON] Pricing agent error:', err.message);
    }
  });

  // Midnight UTC daily — graduate eligible standard vendors to verified (legacy tier)
  cron.schedule('0 23 * * *', async () => {
    try {
      await query(`
        UPDATE vendors SET
          vendor_tier = 'verified',
          daily_cap_kobo = 50000000,
          custom_payout_hold_hours = 24,
          status = 'active'
        WHERE vendor_tier = 'standard'
          AND (confirmed_deliveries >= 3 OR total_transactions >= 3)
          AND created_at <= NOW() - INTERVAL '30 days'
          AND status = 'probation'
      `);
      console.log('[CRON] Vendor graduation ran');
    } catch (err) {
      console.error('[CRON] Graduation error:', err.message);
    }
  });

  // 1am UTC daily — verified vendor tier graduation (rising/verified/trusted/elite) then demotion
  cron.schedule('0 1 * * *', async () => {
    try {
      await runVendorTierGraduation();
      console.log('[CRON] Verified vendor tier graduation ran');
    } catch (err) {
      console.error('[CRON] Verified vendor graduation error:', err.message);
    }
    try {
      await runDemotionChecks();
      console.log('[CRON] Verified vendor demotion checks ran');
    } catch (err) {
      console.error('[CRON] Verified vendor demotion error:', err.message);
    }
  });

  // Sunday 11pm UTC — reset weekly volume baseline
  cron.schedule('0 22 * * 0', async () => {
    try {
      await query(`
        UPDATE vendors SET
          baseline_weekly_volume = CASE
            WHEN baseline_weekly_volume = 0 OR baseline_weekly_volume IS NULL THEN COALESCE(current_week_volume, 0)
            ELSE (COALESCE(baseline_weekly_volume, 0) + COALESCE(current_week_volume, 0)) / 2
          END,
          current_week_volume = 0
        WHERE vendor_tier IS NOT NULL
      `);
      console.log('[CRON] Weekly volume baseline updated');
    } catch (err) {
      console.error('[CRON] Volume reset error:', err.message);
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
