const { query } = require('../db');

/** Convert naira amount (kobo) to words for receipt, e.g. 2500000 -> "Twenty-five thousand naira only" */
function amountInWordsNaira(kobo) {
  const n = Math.floor(Number(kobo) / 100);
  if (n === 0) return 'Zero naira only';
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function toWords(num) {
    if (num === 0) return '';
    if (num < 10) return ones[num];
    if (num < 20) return teens[num - 10];
    if (num < 100) return (tens[Math.floor(num / 10)] + (num % 10 ? '-' + ones[num % 10] : '')).trim();
    if (num < 1000) return (ones[Math.floor(num / 100)] + ' hundred ' + toWords(num % 100)).trim();
    if (num < 1e6) return (toWords(Math.floor(num / 1000)) + ' thousand ' + toWords(num % 1000)).trim();
    if (num < 1e9) return (toWords(Math.floor(num / 1e6)) + ' million ' + toWords(num % 1e6)).trim();
    return (toWords(Math.floor(num / 1e9)) + ' billion ' + toWords(num % 1e9)).trim();
  }

  const words = toWords(n).replace(/\s+/g, ' ').trim();
  const capped = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Zero';
  return capped + ' naira only';
}

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

  const amountKobo = Number(row.amount);
  const amountNaira = amountKobo / 100;
  const date = new Date(row.created_at).toLocaleDateString('en-NG', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const dateShort = new Date(row.created_at).toLocaleDateString('en-NG', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  return {
    reference: row.mono_ref,
    businessName: row.business_name,
    itemName: row.item_name,
    amount: amountKobo,
    amountFormatted: `₦${amountNaira.toLocaleString()}`,
    amountInWords: amountInWordsNaira(amountKobo),
    buyerPhone: row.buyer_phone,
    date,
    dateShort
  };
}

module.exports = { getReceiptData, amountInWordsNaira };
