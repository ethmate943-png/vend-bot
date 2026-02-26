const { query } = require('../db');

async function getVendorByBotNumber(botNumber) {
  const clean = botNumber.replace(/[^0-9]/g, '');

  // Try existing vendor first
  let res = await query(
    'SELECT * FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
    [clean]
  );
  let vendor = res.rows[0];
  if (vendor) return vendor;

  // Auto-create a minimal vendor for this bot number so messaging yourself works
  const name =
    process.env.DEFAULT_VENDOR_NAME ||
    process.env.BUSINESS_NAME ||
    `My Store ${clean}`;

  res = await query(
    'INSERT INTO vendors (whatsapp_number, business_name) VALUES ($1, $2) RETURNING *',
    [clean, name]
  );
  return res.rows[0] || null;
}

async function getVendorByStoreCode(code) {
  if (!code || !String(code).trim()) return null;
  const clean = String(code).toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;
  const res = await query(
    'SELECT * FROM vendors WHERE UPPER(TRIM(store_code)) = $1 LIMIT 1',
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

module.exports = { getVendorByBotNumber, getVendorByStoreCode, incrementNoCount };
