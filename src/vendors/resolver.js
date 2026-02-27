const { query } = require('../db');

/**
 * Resolve the vendor (store) for this bot.
 * Mapping: one WhatsApp bot number = one vendor row.
 * - vendors.id = UUID primary key (used in sessions, transactions, etc.)
 * - vendors.whatsapp_number = bot's phone number (digits only); this is how we know "this number is this vendor"
 */
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

/** Sender is a registered vendor if their phone matches a vendor's whatsapp_number. */
async function getVendorByPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return null;
  const res = await query(
    'SELECT * FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
    [clean]
  );
  return res.rows[0] || null;
}

async function getVendorById(vendorId) {
  if (!vendorId) return null;
  const res = await query('SELECT * FROM vendors WHERE id = $1 LIMIT 1', [vendorId]);
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

module.exports = { getVendorByBotNumber, getVendorByStoreCode, getVendorByPhone, getVendorById, incrementNoCount };
