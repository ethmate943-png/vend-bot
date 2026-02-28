const cron = require('node-cron');
const { query } = require('./db');
const { sendMessage, sendWithDelay } = require('./whatsapp/sender');
const { getDuePayouts, hasOpenDispute } = require('./safety/escrow');
const { runContentAgent } = require('./agents/content');
const { runAbandonmentAgent } = require('./agents/abandonment');
const { runPricingAgent } = require('./agents/pricing');
const { runVendorTierGraduation, runDemotionChecks } = require('./verified-vendor');
const { reconcileOrphanedPayments } = require('./payments/reconcile');
const { cleanup: cleanupRateLimit } = require('./safety/ratelimit');

const CRON_SLOW_MS = 5000;
const VENDOR_REMINDER_BATCH_SIZE = 5;
const VENDOR_REMINDER_PAUSE_MS = 2000;

function getSock() {
  return require('./whatsapp/client').getSock();
}

/**
 * Schedule a cron job in a non-blocking way: use setImmediate so the scheduler
 * fires on time, then run the task with try/catch and duration logging.
 * One failing or slow job does not block the next scheduled run.
 */
function scheduleSafe(expression, name, fn) {
  cron.schedule(expression, () => {
    setImmediate(async () => {
      const start = Date.now();
      try {
        await fn();
        const duration = Date.now() - start;
        if (duration > CRON_SLOW_MS) {
          console.warn(`[CRON] ${name} took ${duration}ms — consider optimizing`);
        }
      } catch (err) {
        console.error(`[CRON] ${name} failed:`, err.message);
      }
    });
  });
}

/** Daily 8am vendor reminder — process in batches so we don't block the event loop. */
async function runVendorReminders() {
  const sock = getSock();
  if (!sock) return;
  const res = await query("SELECT id, whatsapp_number, store_code FROM vendors WHERE status = 'active'");
  const vendors = res.rows || [];
  if (!vendors.length) return;

  console.log(`[CRON] Sending vendor reminders to ${vendors.length} vendors`);
  const msg = '📦 Good morning! Please check your Google Sheet is up to date before buyers start messaging today. Reply DONE when ready.';

  for (let i = 0; i < vendors.length; i += VENDOR_REMINDER_BATCH_SIZE) {
    const batch = vendors.slice(i, i + VENDOR_REMINDER_BATCH_SIZE);
    await Promise.all(
      batch.map((v) =>
        sendMessage(sock, `${v.whatsapp_number}@s.whatsapp.net`, msg).catch((err) =>
          console.error(`[CRON] Vendor reminder failed for ${v.store_code || v.id}:`, err.message)
        )
      )
    );
    if (i + VENDOR_REMINDER_BATCH_SIZE < vendors.length) {
      await new Promise((resolve) => setTimeout(resolve, VENDOR_REMINDER_PAUSE_MS));
    }
  }
  console.log('[CRON] Vendor reminders done');
}

function startCronJobs() {
  // Every 30 mins — expire unpaid payment links
  scheduleSafe('*/30 * * * *', 'paymentExpiry', async () => {
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
  });

  // Every 15 minutes — reconcile orphaned payments (webhook missed)
  scheduleSafe('*/15 * * * *', 'reconcilePayments', () => reconcileOrphanedPayments());

  // Every 5 minutes — prune rate limit map
  scheduleSafe('*/5 * * * *', 'rateLimitCleanup', () => cleanupRateLimit());

  // Every hour — release escrow payouts
  scheduleSafe('0 * * * *', 'escrowRelease', async () => {
    const due = await getDuePayouts();
    for (const txn of due) {
      const disputed = await hasOpenDispute(txn.id);
      if (!disputed) {
        await query('UPDATE transactions SET payout_released = true WHERE id = $1', [txn.id]);
        console.log(`[CRON] Released payout for txn ${txn.id}`);
      }
    }
  });

  // Daily 6am UTC — content agent (Status + Instagram copy)
  scheduleSafe('0 6 * * *', 'contentAgent', async () => {
    await runContentAgent();
    console.log('[CRON] Content agent ran');
  });

  // Every 12 hours — abandonment recovery
  scheduleSafe('0 */12 * * *', 'abandonmentAgent', async () => {
    await runAbandonmentAgent();
    console.log('[CRON] Abandonment agent ran');
  });

  // Sunday 7pm UTC — weekly pricing report
  scheduleSafe('0 19 * * 0', 'pricingAgent', async () => {
    await runPricingAgent();
    console.log('[CRON] Pricing agent ran');
  });

  // Midnight UTC daily — graduate eligible standard vendors to verified (legacy tier)
  scheduleSafe('0 23 * * *', 'vendorGraduation', async () => {
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
  });

  // 1am UTC daily — verified vendor tier graduation then demotion
  scheduleSafe('0 1 * * *', 'verifiedVendorTier', async () => {
    await runVendorTierGraduation();
    console.log('[CRON] Verified vendor tier graduation ran');
  });
  scheduleSafe('0 1 * * *', 'verifiedVendorDemotion', async () => {
    await runDemotionChecks();
    console.log('[CRON] Verified vendor demotion checks ran');
  });

  // Sunday 11pm UTC — reset weekly volume baseline
  scheduleSafe('0 22 * * 0', 'volumeBaselineReset', async () => {
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
  });

  // Daily 8am UTC — stock accuracy reminder (batched to avoid blocking)
  scheduleSafe('0 8 * * *', 'vendorReminders', runVendorReminders);

  console.log('[CRON] Scheduled jobs started');
}

module.exports = { startCronJobs };
