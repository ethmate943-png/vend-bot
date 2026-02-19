const { query } = require('../db');

async function getEscrowHoldHours(vendorId) {
  const res = await query(
    'SELECT total_transactions FROM vendors WHERE id = $1',
    [vendorId]
  );
  const vendor = res.rows[0];
  if (!vendor) return Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);

  const isEstablished = vendor.total_transactions >= Number(process.env.ESTABLISHED_VENDOR_MIN_TRANSACTIONS);
  return isEstablished
    ? Number(process.env.ESCROW_HOLD_ESTABLISHED_HOURS)
    : Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);
}

async function getDuePayouts() {
  const res = await query(
    `SELECT t.*, v.whatsapp_number, v.business_name
     FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.status = 'paid' AND t.payout_released = false AND t.escrow_release_at <= NOW()`
  );
  return res.rows;
}

async function hasOpenDispute(transactionId) {
  const res = await query(
    "SELECT id FROM disputes WHERE transaction_id = $1 AND status = 'open' LIMIT 1",
    [transactionId]
  );
  return res.rows.length > 0;
}

module.exports = { getEscrowHoldHours, getDuePayouts, hasOpenDispute };
