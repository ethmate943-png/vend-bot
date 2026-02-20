const { query } = require('../db');

/**
 * Get receipt data for a paid transaction (for HTML/PDF receipt page).
 * Returns null if not found or not paid.
 */
async function getReceiptData(reference) {
  const ref = (reference || '').replace(/\.pdf$/i, '').trim();
  if (!ref) return null;

  const res = await query(
    `SELECT t.mono_ref, t.item_name, t.amount, t.buyer_phone, t.created_at,
            v.business_name
     FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.mono_ref = $1 AND t.status = 'paid' LIMIT 1`,
    [ref]
  );
  const rows = res.rows || (Array.isArray(res) ? res : []);
  const row = rows[0];
  if (!row) return null;

  const date = new Date(row.created_at).toLocaleDateString('en-NG', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  return {
    reference: row.mono_ref,
    businessName: row.business_name,
    itemName: row.item_name,
    amount: row.amount,
    amountFormatted: `₦${(Number(row.amount) / 100).toLocaleString()}`,
    buyerPhone: row.buyer_phone,
    date
  };
}

module.exports = { getReceiptData };
