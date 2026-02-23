/** Payment link generation and purchase flow */

const { sendMessage, sendWithDelay } = require('../../sender');
const { logReply } = require('../logger');
const { alreadyHaveLink, dailyCap, paymentFailed, paymentIntro, vendorUnavailable } = require('../../../ai/human-phrases');
const { generatePaymentLink, checkVendorCap, checkDuplicatePayment } = require('../../../payments/paystack');
const { checkVelocity } = require('../../../safety/velocity');
const { upsertSession } = require('../../../sessions/manager');

async function handlePurchase(sock, buyerJid, vendor, session, item, negotiatedPrice) {
  if (session.intent_state === 'awaiting_payment' && session.pending_payment_ref) {
    const pendingItem = session.last_item_name || 'your item';
    await sendWithDelay(sock, buyerJid, alreadyHaveLink(pendingItem));
    logReply(' [Already have link – asked before resending]');
    return;
  }

  const velocity = await checkVelocity(vendor.id);
  if (velocity.blocked) {
    await sendWithDelay(sock, buyerJid, vendorUnavailable());
    return;
  }

  if (vendor.trust_stage === 'notification_only') {
    await sendWithDelay(sock, buyerJid,
      `${vendor.business_name} will send you payment details directly. Let me connect you now!`
    );
    await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
      `💬 *Buyer ready to pay!*\n\nItem: ${item.name} — ₦${item.price.toLocaleString()}\nBuyer: wa.me/${buyerJid.replace('@s.whatsapp.net', '')}\n\nReach out directly to collect payment.`
    );
    return;
  }

  const quotedAt = session.last_item_price_quoted_at
    ? new Date(session.last_item_price_quoted_at).getTime()
    : 0;
  const priceLockMinutes = 30;
  const priceExpired = !quotedAt || (Date.now() - quotedAt) > priceLockMinutes * 60 * 1000;

  let effectivePrice = item.price;
  if (negotiatedPrice != null) {
    effectivePrice = negotiatedPrice;
  } else if (!priceExpired && session.last_item_price != null) {
    effectivePrice = session.last_item_price;
  }

  const finalPrice = effectivePrice;
  const isDiscounted = negotiatedPrice != null && negotiatedPrice < item.price;

  const capCheck = await checkVendorCap(vendor, Math.floor(finalPrice * 100));
  if (!capCheck.allowed) {
    await sendWithDelay(sock, buyerJid, dailyCap());
    await sendMessage(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
      `⚠️ Daily cap reached (₦${((capCheck.cap || 0) / 100).toLocaleString()}).\nBuyers cannot pay until tomorrow.\nContact VendBot to increase your limit.`
    );
    return;
  }

  const duplicate = await checkDuplicatePayment(buyerJid, vendor.id, item.sku);
  if (duplicate) {
    await sendWithDelay(sock, buyerJid,
      `You already paid for this item ✅\nRef: ${duplicate.mono_ref}\nYour order is confirmed — the vendor has been notified.`
    );
    return;
  }

  try {
    const { link, reference } = await generatePaymentLink({
      amount: finalPrice,
      itemName: item.name,
      itemSku: item.sku,
      buyerJid,
      vendorId: vendor.id,
      vendorPhone: vendor.whatsapp_number
    });

    const discountLine = isDiscounted
      ? `~₦${item.price.toLocaleString()}~ → *₦${finalPrice.toLocaleString()}* 🎉\n`
      : `Price: *₦${finalPrice.toLocaleString()}*\n`;

    const payMsg = `${paymentIntro()}\n\n` +
      `🛒 *${item.name}*\n` +
      discountLine +
      `🔗 Pay here: ${link}\n\n` +
      `_Card, bank transfer, or USSD. Link expires in 30 mins._`;

    await sendWithDelay(sock, buyerJid, payMsg);
    logReply(payMsg);

    await upsertSession(buyerJid, vendor.id, {
      intent_state: 'awaiting_payment',
      pending_payment_ref: reference,
      last_item_sku: item.sku,
      last_item_name: item.name
    });
  } catch (err) {
    console.error('[PAYMENT ERROR]', err.response?.data || err.message);
    await sendWithDelay(sock, buyerJid, paymentFailed());
  }
}

module.exports = { handlePurchase };
