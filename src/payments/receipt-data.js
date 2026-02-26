const { query } = require('../db');

// When WhatsApp is disconnected at payment time, queue receipt and send when sock is back
const pendingReceipts = [];
let pendingReceiptsInterval = null;

function getSock() {
  return require('../whatsapp/client').getSock();
}

function startPendingReceiptsPolling() {
  if (pendingReceiptsInterval) return;
  pendingReceiptsInterval = setInterval(tryPendingReceipts, 15000);
}

async function tryPendingReceipts() {
  const sock = getSock();
  if (!sock || pendingReceipts.length === 0) return;
  const toSend = pendingReceipts.splice(0, pendingReceipts.length);
  for (const ref of toSend) {
    console.log('[PAYMENT] Retrying queued receipt for ref (WhatsApp now connected):', ref.reference);
    try {
      await sendReceiptForReference(sock, ref.reference, ref.receiptNumber);
    } catch (err) {
      console.error('[PAYMENT] Pending receipt send failed, will re-queue:', err.message);
      pendingReceipts.push(ref);
    }
  }
}

function queuePendingReceipt(reference, receiptNumber) {
  if (!reference) return;
  pendingReceipts.push({ reference, receiptNumber: receiptNumber || null });
  startPendingReceiptsPolling();
}

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

async function sendReceiptForReference(sock, reference, receiptNumber) {
  const txnRes = await query(
    `SELECT t.*, v.whatsapp_number, v.business_name, v.total_transactions
     FROM transactions t JOIN vendors v ON v.id = t.vendor_id
     WHERE t.mono_ref = $1 LIMIT 1`,
    [reference]
  );
  const rows = txnRes.rows || (Array.isArray(txnRes) ? txnRes : []);
  const txn = rows[0];
  if (!txn) return;

  const isEstablished = txn.total_transactions >= Number(process.env.ESTABLISHED_VENDOR_MIN_TRANSACTIONS);
  const holdHours = isEstablished
    ? Number(process.env.ESCROW_HOLD_ESTABLISHED_HOURS)
    : Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);
  const amountFormatted = `₦${(txn.amount / 100).toLocaleString()}`;
  const date = new Date().toLocaleDateString('en-NG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  let baseUrl = (process.env.CALLBACK_BASE_URL || process.env.APP_URL || '').trim();
  try { baseUrl = new URL(baseUrl).origin; } catch (_) { baseUrl = ''; }
  const visualReceiptUrl = baseUrl ? `${baseUrl}/receipt/${encodeURIComponent(reference)}` : '';
  const receiptLink = receiptNumber
    ? `\n🔗 Paystack receipt: https://paystack.com/receipt/${receiptNumber}\n`
    : '';
  const visualReceiptLine = visualReceiptUrl ? `\n📄 View & download your receipt: ${visualReceiptUrl}\n` : '';
  const receiptText =
    `✅ *PAYMENT RECEIPT*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🏪 *${txn.business_name}*\n\n` +
    `📦 Item: *${txn.item_name}*\n` +
    `💰 Amount: *${amountFormatted}*\n` +
    `🧾 Ref: \`${reference}\`\n` +
    `📅 Date: ${date}\n` +
    receiptLink +
    visualReceiptLine +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `Your payment has been received and your order is confirmed.\n\n` +
    `*${txn.business_name}* will contact you to arrange delivery.\n\n` +
    `_Your funds are held in escrow for ${holdHours} hours for your protection. ` +
    `If anything goes wrong, contact wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER}_`;

  try {
    await require('../whatsapp/sender').sendWithDelay(sock, txn.buyer_jid, receiptText);
    console.log('[PAYMENT] Receipt sent to buyer (on-demand/queued)', txn.buyer_jid);
  } catch (err) {
    const fallbackJid = `${String(txn.buyer_phone).replace(/\D/g, '')}@s.whatsapp.net`;
    await require('../whatsapp/sender').sendWithDelay(sock, fallbackJid, receiptText);
    console.log('[PAYMENT] Receipt sent to buyer (on-demand/queued fallback)', fallbackJid);
  }
  await require('../whatsapp/sender').sendWithDelay(
    sock,
    `${txn.whatsapp_number}@s.whatsapp.net`,
    `🛍️ *NEW SALE!*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 Item: *${txn.item_name}*\n` +
    `💰 Amount: *${amountFormatted}*\n` +
    `👤 Buyer: ${txn.buyer_phone}\n` +
    `🧾 Ref: \`${reference}\`\n` +
    `📅 Date: ${date}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Please arrange delivery for the buyer.\n\n` +
    `💸 Payout: *${holdHours} hours* after delivery is confirmed.\n` +
    `_Inventory has been auto-updated on your sheet._`
  );
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

module.exports = {
  getReceiptData,
  amountInWordsNaira,
  queuePendingReceipt,
  startPendingReceiptsPolling,
  sendReceiptForReference
};
