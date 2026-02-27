/**
 * Orphaned payment reconciliation: webhook never fired but buyer paid.
 * Cron every 15 minutes — find pending txns 15 mins–24 hours old, verify with Paystack, process if success.
 */
const { query } = require('../db');
const { verifyTransaction } = require('./paystack');
const { handlePaymentSuccess } = require('./webhook');

async function reconcileOrphanedPayments() {
  const { rows } = await query(`
    SELECT id, mono_ref, vendor_id, buyer_jid, buyer_phone, item_name, item_sku, amount, created_at
    FROM transactions
    WHERE status = 'pending'
      AND created_at <= NOW() - INTERVAL '15 minutes'
      AND created_at >= NOW() - INTERVAL '24 hours'
  `);

  for (const txn of rows) {
    try {
      const paystackData = await verifyTransaction(txn.mono_ref);
      if (paystackData && paystackData.status === 'success') {
        await handlePaymentSuccess({
          reference: txn.mono_ref,
          receiptNumber: paystackData.receipt_number || null
        });
        console.log(`[RECONCILE] Recovered orphaned payment ${txn.mono_ref}`);
      }
    } catch (err) {
      console.error(`[RECONCILE] Verify failed for ${txn.mono_ref}:`, err.message);
    }
  }
}

module.exports = { reconcileOrphanedPayments };
