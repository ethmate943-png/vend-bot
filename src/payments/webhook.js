const { query } = require('../db');
const { decrementQty } = require('../inventory/manager');
const { sendWithDelay } = require('../whatsapp/sender');
const { queuePendingReceipt } = require('./receipt-data');
const { upsertBuyerAndRelationship, checkAndFlagVip } = require('../crm/manager');
const {
  isBuyerTrustedVendor,
  addBuyerTrustedVendor,
  updateRelationshipScore,
  countCompletedOrdersWithVendor,
  isMutuallyTrusted,
  getRelationshipTrustLevel,
  getHoldReductionMultiplier
} = require('../trust/manager');
const {
  getTierHoldMultiplier,
  getVendorBadgeLine
} = require('../verified-vendor');

function getSock() {
  return require('../whatsapp/client').getSock();
}

// When WhatsApp is disconnected at payment time, queue receipt and send when sock is back
const pendingReceipts = [];
let pendingReceiptsInterval = null;

function startPendingReceiptsPolling() {
  if (pendingReceiptsInterval) return;
  pendingReceiptsInterval = setInterval(tryPendingReceipts, 15000);
}

async function tryPendingReceipts() {
  const sock = getSock();
  if (!sock || pendingReceipts.length === 0) return;
  const toSend = pendingReceipts.splice(0, pendingReceipts.length);
  for (const ref of toSend) {
    console.log('[PAYMENT] Retrying receipt for ref (WhatsApp now connected):', ref.reference);
    try {
      await sendReceiptForReference(sock, ref.reference, ref.receiptNumber);
    } catch (err) {
      console.error('[PAYMENT] Pending receipt send failed:', err.message);
      pendingReceipts.push(ref);
    }
  }
}

function getTryPendingReceipts() {
  return tryPendingReceipts;
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
    await sendWithDelay(sock, txn.buyer_jid, receiptText);
    console.log('[PAYMENT] Receipt sent to buyer (retry)', txn.buyer_jid);
  } catch (err) {
    const fallbackJid = `${String(txn.buyer_phone).replace(/\D/g, '')}@s.whatsapp.net`;
    await sendWithDelay(sock, fallbackJid, receiptText);
    console.log('[PAYMENT] Receipt sent to buyer (retry fallback)', fallbackJid);
  }
  await sendWithDelay(sock, `${txn.whatsapp_number}@s.whatsapp.net`,
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

async function handlePaymentSuccess(data) {
  const { reference, receiptNumber } = data;
  const sock = getSock();

  const txnRes = await query(
    `SELECT t.*, v.whatsapp_number, v.business_name, v.total_transactions,
            v.sheet_id, v.sheet_tab, v.id as vid, v.store_code,
            v.verified_vendor_tier, v.created_at AS vendor_created_at,
            (SELECT COUNT(*)::int FROM disputes d WHERE d.vendor_id = t.vendor_id) AS vendor_dispute_count
     FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.mono_ref = $1 LIMIT 1`,
    [reference]
  );

  const rows = txnRes.rows || (Array.isArray(txnRes) ? txnRes : []);
  const txn = rows[0];
  if (!txn) {
    console.error('[PAYMENT] Transaction not found for reference:', reference, '(check mono_ref in DB)');
    return;
  }
  console.log('[PAYMENT] Found txn:', txn.id, 'buyer_jid:', txn.buyer_jid, 'buyer_phone:', txn.buyer_phone);
  if (txn.status === 'paid') {
    console.log('[PAYMENT] Already processed:', reference);
    return;
  }

  if (!sock) {
    console.error('[PAYMENT] Cannot send receipt now: WhatsApp not connected (sock is null). Queueing for retry for ref:', reference);
    queuePendingReceipt(reference, receiptNumber);
  }

  const isEstablished = txn.total_transactions >= Number(process.env.ESTABLISHED_VENDOR_MIN_TRANSACTIONS);
  let baseHoldHours = isEstablished
    ? Number(process.env.ESCROW_HOLD_ESTABLISHED_HOURS)
    : Number(process.env.ESCROW_HOLD_NEW_VENDOR_HOURS);
  const mutualTrust = await isMutuallyTrusted(txn.buyer_jid, txn.vendor_id);
  if (mutualTrust) {
    baseHoldHours = 2;
  } else {
    const trustLevel = await getRelationshipTrustLevel(txn.vendor_id, txn.buyer_jid);
    const mult = getHoldReductionMultiplier(trustLevel);
    baseHoldHours = Math.ceil(baseHoldHours * mult);
  }
  const tierMult = getTierHoldMultiplier(txn.verified_vendor_tier);
  baseHoldHours = tierMult === 0 ? 0 : Math.ceil(baseHoldHours * tierMult);
  const holdHours = Math.max(0, baseHoldHours);
  const releaseAt = holdHours === 0
    ? new Date().toISOString()
    : new Date(Date.now() + holdHours * 3_600_000).toISOString();

  await query(
    `UPDATE transactions SET status = 'paid', escrow_release_at = $1 WHERE id = $2`,
    [releaseAt, txn.id]
  );

  await query(
    `UPDATE vendors SET total_transactions = total_transactions + 1 WHERE id = $1`,
    [txn.vid]
  );

  const buyer = await upsertBuyerAndRelationship(txn.buyer_jid, txn.buyer_phone, txn.vendor_id, txn.amount);
  if (buyer) {
    await query('UPDATE transactions SET buyer_id = $1 WHERE id = $2', [buyer.id, txn.id]);
  }

  try {
    const vendorRef = { id: txn.vendor_id, sheet_id: txn.sheet_id, sheet_tab: txn.sheet_tab };
    const cartItems = txn.cart_items_json ? (() => { try { return JSON.parse(txn.cart_items_json); } catch { return null; } })() : null;
    if (cartItems && Array.isArray(cartItems)) {
      for (const line of cartItems) {
        const sku = line.sku;
        const qty = Math.max(0, Math.floor(Number(line.quantity) || 1));
        for (let i = 0; i < qty; i++) {
          await decrementQty(vendorRef, sku);
        }
      }
    } else {
      await decrementQty(vendorRef, txn.item_sku);
    }
    await query('UPDATE transactions SET sheet_row_updated = true WHERE id = $1', [txn.id]);
  } catch (e) {
    console.error('[INVENTORY UPDATE ERROR]', e.message);
  }

  const amountFormatted = `₦${(txn.amount / 100).toLocaleString()}`;
  const date = new Date().toLocaleDateString('en-NG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  if (sock) {
    console.log('[PAYMENT] Sending receipt to buyer', txn.buyer_jid, 'and vendor', txn.whatsapp_number);
    let baseUrl = (process.env.CALLBACK_BASE_URL || process.env.APP_URL || '').trim();
    try { baseUrl = new URL(baseUrl).origin; } catch (_) { baseUrl = ''; }
    const visualReceiptUrl = baseUrl ? `${baseUrl}/receipt/${encodeURIComponent(reference)}` : '';

    const receiptLink = receiptNumber
      ? `\n🔗 Paystack receipt: https://paystack.com/receipt/${receiptNumber}\n`
      : '';
    const visualReceiptLine = visualReceiptUrl
      ? `\n📄 View & download your receipt: ${visualReceiptUrl}\n`
      : '';

    const storeLine = txn.store_code
      ? `\n_Shop more: wa.me/${(process.env.VENDBOT_NUMBER || '').replace(/\D/g, '')}?text=${encodeURIComponent(`${txn.store_code} hi`)}_\n`
      : '';
    const badgeLine = getVendorBadgeLine({
      verified_vendor_tier: txn.verified_vendor_tier,
      total_transactions: (txn.total_transactions || 0) + 1,
      vendor_dispute_count: txn.vendor_dispute_count,
      vendor_created_at: txn.vendor_created_at
    });
    const protectionLine = badgeLine
      ? badgeLine
      : `\n\n_Your funds are held in escrow for ${holdHours} hours. ` +
        `Issue? Contact wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER || ''}_`;
    const receiptText =
      `✅ *Payment confirmed!*\n\n` +
      `You just copped from *${txn.business_name}*\n\n` +
      `🛍️ ${txn.item_name}\n` +
      `💰 ₦${(txn.amount / 100).toLocaleString()}\n\n` +
      `_Ref: ${reference}_\n` +
      receiptLink +
      visualReceiptLine +
      storeLine +
      protectionLine;

    try {
      await sendWithDelay(sock, txn.buyer_jid, receiptText);
      console.log('[PAYMENT] Receipt sent to buyer', txn.buyer_jid);
    } catch (err) {
      console.error('[PAYMENT] Failed to send receipt to buyer_jid:', err.message);
      const fallbackJid = `${String(txn.buyer_phone).replace(/\D/g, '')}@s.whatsapp.net`;
      if (fallbackJid !== txn.buyer_jid) {
        try {
          await sendWithDelay(sock, fallbackJid, receiptText);
          console.log('[PAYMENT] Receipt sent to buyer (fallback)', fallbackJid);
        } catch (err2) {
          console.error('[PAYMENT] Fallback send also failed:', err2.message);
        }
      }
    }

    try {
      await sendWithDelay(sock, `${txn.whatsapp_number}@s.whatsapp.net`,
        `🛍️ *New Sale!*\n\n` +
        `*Item:* ${txn.item_name}\n` +
        `*Amount:* ${amountFormatted}\n` +
        `*Buyer:* ${txn.buyer_phone}\n` +
        `*Ref:* ${reference}\n\n` +
        `👇 Open buyer chat:\nwa.me/${(txn.buyer_phone || '').replace(/\D/g, '')}\n\n` +
        `Reply:\n*DELIVERED* — mark delivered\n*TOMORROW* — delivering tomorrow\n*ISSUE* — flag problem\n*DETAILS* — buyer history`
      );
    } catch (err) {
      console.error('[PAYMENT] Failed to send vendor notification:', err.message);
    }

    try {
      await checkAndFlagVip(txn.buyer_jid, txn.vendor_id, sock);
    } catch (err) {
      console.error('[PAYMENT] VIP check error:', err.message);
    }

    // Delivery check after 3 hours — skip if elite vendor or buyer has marked this vendor as trusted
    const skipPing = (txn.verified_vendor_tier === 'elite') || (await isBuyerTrustedVendor(txn.buyer_jid, txn.vendor_id));
    if (!skipPing) {
      setTimeout(async () => {
        try {
          await sendWithDelay(sock, txn.buyer_jid,
            `Hi! Did you receive your *${txn.item_name}* from *${txn.business_name}*?\n\nReply *YES* ✅ or *NO* ❌`
          );
        } catch (err) {
          console.error('[DELIVERY PING ERROR]', err.message);
        }
      }, 3 * 60 * 60 * 1000);
    }
  } else {
    console.error('[PAYMENT] WhatsApp not connected — queuing receipt for ref:', reference);
    pendingReceipts.push({ reference, receiptNumber });
    startPendingReceiptsPolling();
  }
}

async function handleDeliveryReply(buyerJid, vendorId, reply) {
  const r = (reply || '').toLowerCase().trim();
  const isTrust = r === 'trust';
  const isSkip = r === 'skip';

  if (isTrust || isSkip) {
    const txnRes = await query(
      `SELECT t.id, t.updated_at, v.business_name FROM transactions t
       JOIN vendors v ON v.id = t.vendor_id
       WHERE t.buyer_jid = $1 AND t.vendor_id = $2 AND t.status = 'paid' AND t.delivery_confirmed = true
       ORDER BY t.updated_at DESC NULLS LAST LIMIT 1`,
      [buyerJid, vendorId]
    );
    const txn = txnRes.rows && txnRes.rows[0];
    const recentlyConfirmed = txn && (Date.now() - new Date(txn.updated_at || txn.created_at || 0).getTime() < 10 * 60 * 1000);
    if (!txn || !recentlyConfirmed) {
      const sock = getSock();
      if (sock && isTrust) await sendWithDelay(sock, buyerJid, 'No recent delivery to mark as trusted. Complete a delivery and confirm with YES first.');
      return;
    }
    if (isTrust) {
      const already = await isBuyerTrustedVendor(buyerJid, vendorId);
      if (!already) {
        await addBuyerTrustedVendor(buyerJid, vendorId);
        const sock = getSock();
        if (sock) await sendWithDelay(sock, buyerJid, `${txn.business_name} marked as trusted ✅\nYour next orders with them will be seamless.`);
      }
    }
    return;
  }

  const confirmed = r.includes('yes');

  const txnRes = await query(
    `SELECT * FROM transactions
     WHERE buyer_jid = $1 AND vendor_id = $2 AND status = 'paid' AND delivery_confirmed IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [buyerJid, vendorId]
  );

  const txn = txnRes.rows[0];
  if (!txn) return;

  await query(
    'UPDATE transactions SET delivery_confirmed = $1, updated_at = NOW() WHERE id = $2',
    [confirmed, txn.id]
  );

  if (!confirmed) {
    await updateRelationshipScore(vendorId, buyerJid, false);
    const { incrementNoCount } = require('../vendors/resolver');
    await incrementNoCount(vendorId);
    const sock = getSock();
    if (sock) {
      await sendWithDelay(sock, buyerJid,
        `Sorry to hear that. We've flagged this for review. Please contact us at wa.me/${process.env.DISPUTE_WHATSAPP_NUMBER} to raise a dispute and we will resolve it within 48 hours.`
      );
    }
    return;
  }

  await updateRelationshipScore(vendorId, buyerJid, true);
  const sock = getSock();
  const completed = await countCompletedOrdersWithVendor(buyerJid, vendorId);
  const alreadyTrusted = await isBuyerTrustedVendor(buyerJid, vendorId);
  if (sock && completed >= 3 && !alreadyTrusted) {
    const vRes = await query('SELECT business_name FROM vendors WHERE id = $1', [vendorId]);
    const vendorName = (vRes.rows && vRes.rows[0] && vRes.rows[0].business_name) || 'this vendor';
    await sendWithDelay(sock, buyerJid,
      `Great! Payout released to the vendor ✅\n\n` +
      `You've now completed ${completed} order(s) with them with zero issues.\n\n` +
      `Would you like to mark them as a *trusted vendor*? Future orders will skip the delivery confirmation ping — we'll release payment automatically after the delivery window.\n\n` +
      `Reply *TRUST* to confirm or *SKIP* to keep things as they are.`
    );
  }
}

module.exports = { handlePaymentSuccess, handleDeliveryReply, getTryPendingReceipts };
