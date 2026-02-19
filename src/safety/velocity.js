const { query } = require('../db');

async function checkVelocity(vendorId) {
  const res = await query(
    `SELECT COUNT(*) as count FROM transactions
     WHERE vendor_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [vendorId]
  );
  const todayCount = parseInt(res.rows[0].count, 10);

  const avgRes = await query(
    'SELECT daily_avg_transactions FROM vendors WHERE id = $1',
    [vendorId]
  );
  const dailyAvg = Math.max(Number(avgRes.rows[0]?.daily_avg_transactions) || 0, 5);
  const maxAllowed = dailyAvg * Number(process.env.VELOCITY_MAX_DAILY_MULTIPLIER || 10);

  if (todayCount >= maxAllowed) {
    console.warn(`[VELOCITY] Vendor ${vendorId} exceeded daily limit: ${todayCount}/${maxAllowed}`);
    return { blocked: true, todayCount, maxAllowed };
  }

  return { blocked: false, todayCount, maxAllowed };
}

module.exports = { checkVelocity };
