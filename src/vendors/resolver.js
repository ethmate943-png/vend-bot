const { query } = require('../db');

async function getVendorByBotNumber(botNumber) {
  const clean = botNumber.replace(/[^0-9]/g, '');
  const res = await query(
    'SELECT * FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
    [clean]
  );
  return res.rows[0] || null;
}

async function incrementNoCount(vendorId) {
  const res = await query(
    'SELECT no_count, status FROM vendors WHERE id = $1',
    [vendorId]
  );
  const vendor = res.rows[0];
  if (!vendor) return 0;

  const newCount = (vendor.no_count || 0) + 1;
  let newStatus = vendor.status;
  if (newCount >= 5) newStatus = 'banned';
  else if (newCount >= 3) newStatus = 'flagged';

  await query(
    'UPDATE vendors SET no_count = $1, status = $2 WHERE id = $3',
    [newCount, newStatus, vendorId]
  );
  return newCount;
}

module.exports = { getVendorByBotNumber, incrementNoCount };
