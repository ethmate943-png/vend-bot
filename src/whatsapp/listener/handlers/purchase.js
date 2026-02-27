/** Payment link generation and purchase flow */

const { sendMessage, sendWithDelay } = require('../../sender');
const { logReply } = require('../logger');
const { alreadyHaveLink, dailyCap, paymentFailed, paymentIntro, vendorUnavailable } = require('../../../ai/human-phrases');
const { generatePaymentLink, checkVendorCap, checkDuplicatePayment } = require('../../../payments/paystack');
const { getVendorBadgeLineForPayment } = require('../../../verified-vendor');
const { checkVelocity } = require('../../../safety/velocity');
const { upsertSession, upsertSessionFields } = require('../../../sessions/manager');
const { query } = require('../../../db');
const { isVendorTrustedBuyer, getTrustedBuyerDisplayName, createPendingTrustOrder } = require('../../../trust/manager');

async function handlePurchase(sock, buyerJid, vendor, session, item, negotiatedPrice) {
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
  const finalPrice = Math.round(effectivePrice);
  const amountKobo = Math.floor(finalPrice * 100);

  if (await isVendorTrustedBuyer(vendor.id, buyerJid)) {
    const displayName = await getTrustedBuyerDisplayName(vendor.id, buyerJid);
    const name = displayName || buyerJid.replace(/@s.whatsapp.net/, '');
    const pending = await createPendingTrustOrder(
      vendor.id,
      buyerJid,
      (buyerJid || '').replace(/\D/g, '').slice(-11),
      item.name,
      item.sku,
      amountKobo
    );
    if (!pending) {
      await sendWithDelay(sock, buyerJid, 'Something went wrong. Please try again.');
      return;
    }
    const vendorJid = `${(vendor.whatsapp_number || '').replace(/\D/g, '')}@s.whatsapp.net`;
    await sendWithDelay(sock, vendorJid,
      `🛒 New order from *${name}* (trusted buyer)\n\n` +
      `Item: *${item.name}* — ₦${finalPrice.toLocaleString()}\n\n` +
      `How do you want to handle payment?\n` +
      `*1* — Standard (buyer pays now via link)\n` +
      `*2* — Pay on delivery (you confirm receipt of cash)\n` +
      `*3* — Credit (release now, collect later)`
    );
    await sendWithDelay(sock, buyerJid, `${vendor.business_name} will sort payment with you — no link yet. They can send a link or do pay-on-delivery.`);
    logReply(' [Trusted buyer – vendor choosing payment]');
    return;
  }

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

    const deliveryPrompt =
      `Before you pay (if you haven't already), tell me how you want to get it:\n` +
      `• Reply *Pickup:* plus where you'll collect it (e.g. "Pickup: Ikeja shop")\n` +
      `• Or *Delivery:* plus your full address and landmark (e.g. "Delivery: 22 Allen Avenue, Ikeja, close to XYZ")\n\n`;

    const badgeLine = getVendorBadgeLineForPayment(vendor);
    const payMsg = `${paymentIntro()}\n\n` +
      `🛒 *${item.name}*\n` +
      discountLine +
      deliveryPrompt +
      `🔗 Pay here: ${link}\n\n` +
      `_Card, bank transfer, or USSD. Link expires in 30 mins._` +
      (badgeLine || '\n\n_Your payment is held safely until you confirm your item arrived._');

    await sendWithDelay(sock, buyerJid, payMsg);
    logReply(payMsg);

    // State write AFTER send — never parallel, never fire-and-forget
    await upsertSessionFields(buyerJid, vendor.id, {
      intent_state: 'awaiting_payment',
      pending_payment_ref: reference,
      payment_link_sent_at: new Date().toISOString(),
      last_item_sku: item.sku,
      last_item_name: item.name,
      last_item_price: finalPrice,
      last_item_price_quoted_at: new Date().toISOString()
    });

    // One-time gentle reminder if payment stays pending.
    const reminderMinutes = Number(process.env.PAYMENT_REMINDER_MINUTES || 20);
    const delayMs = Math.max(5, reminderMinutes) * 60 * 1000;
    setTimeout(async () => {
      try {
        const res = await query(
          'SELECT status, mono_link, item_name FROM transactions WHERE mono_ref = $1 LIMIT 1',
          [reference]
        );
        const row = res.rows && res.rows[0];
        if (!row || row.status !== 'pending' || !row.mono_link) return;
        const reminder =
          `Just a quick reminder for *${row.item_name}* — your payment link is still active:\n\n` +
          `${row.mono_link}\n\n` +
          `_If you've already paid, you can ignore this._`;
        await sendWithDelay(sock, buyerJid, reminder, 800);
        logReply(' [Payment reminder sent]');
      } catch (remErr) {
        console.error('[PAYMENT REMINDER ERROR]', remErr.message || remErr);
      }
    }, delayMs);
  } catch (err) {
    console.error('[PAYMENT ERROR]', err.response?.data || err.message);
    await sendWithDelay(sock, buyerJid,
      `Sorry, something went wrong generating your payment link. ` +
      `Please try again — just say "I want to buy" or "send link" again.`
    );
  }
}

module.exports = { handlePurchase };
