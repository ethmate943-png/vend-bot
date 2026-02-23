/** Vendor messages: voice stock, onboarding, inventory commands, broadcast, orders, details, delivery status */

const { query } = require('../../../db');
const { sendWithDelay } = require('../../sender');
const { getInventory, addItems } = require('../../../inventory/manager');
const { handleOnboarding } = require('../../../vendors/onboarding');
const { handleInventoryCommand } = require('../../../inventory/commands');
const { broadcastToAllBuyers } = require('../../../crm/broadcast');
const { getBuyerProfile, formatBuyerProfileMessage } = require('../../../crm/manager');

async function handleVendorMessage(sock, msg, vendor, text, vendorJid) {
  if (msg.message.audioMessage || msg.message.pttMessage) {
    try {
      const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
      const media = msg.message.audioMessage || msg.message.pttMessage;
      const stream = await downloadContentFromMessage(media, 'audio', {});
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const { extractInventoryFromVoice } = require('../../../ai/extractor');
      const items = await extractInventoryFromVoice(buffer, media.mimetype || 'audio/ogg');
      if (items.length) {
        await addItems(vendor, items);
        const summary = items.map(i => `• ${i.name} — ₦${Number(i.price).toLocaleString()} (${i.quantity} in stock)`).join('\n');
        await sendWithDelay(sock, vendorJid, `Added from voice ✅ ${items.length} item(s)\n\n${summary}`);
      } else {
        await sendWithDelay(sock, vendorJid, 'Could not get items from the voice note. Try saying clearly: "add: item name, price, quantity" or "restock: item name, number".');
      }
    } catch (err) {
      console.error('[LISTENER] Vendor voice stock error:', err.message);
      await sendWithDelay(sock, vendorJid, 'Something went wrong with the voice note. Try typing *add:* or *restock:* instead.');
    }
    return;
  }

  if (vendor.onboarding_step && vendor.onboarding_step !== 'complete') {
    const handled = await handleOnboarding(sock, vendorJid, text, vendor);
    if (handled) return;
  }
  if ((text || '').toUpperCase().trim() === 'VENDOR-SETUP' || (text || '').toUpperCase().trim() === 'ADMIN') {
    await handleOnboarding(sock, vendorJid, 'start', { ...vendor, onboarding_step: 'start' });
    return;
  }
  if (['help', 'commands', 'menu', '?'].includes((text || '').toLowerCase().trim())) {
    const { getVendorCommandsMessage } = require('../../../vendors/onboarding');
    await sendWithDelay(sock, vendorJid, getVendorCommandsMessage(vendor));
    return;
  }

  const invReply = await handleInventoryCommand(text, vendor);
  if (invReply !== null) {
    if (typeof invReply === 'object' && invReply.waitlistBuyers && invReply.waitlistBuyers.length > 0) {
      await sendWithDelay(sock, vendorJid, invReply.reply);
      for (const w of invReply.waitlistBuyers) {
        const jid = w.buyer_jid;
        if (jid) {
          await sendWithDelay(sock, jid, `${vendor.business_name}: *${invReply.restockedItem.name}* is back in stock! Reply to order.`);
          await query('UPDATE waitlist SET notified = true WHERE buyer_jid = $1 AND vendor_id = $2 AND item_sku = $3', [jid, vendor.id, invReply.restockedItem.sku]);
        }
      }
    } else {
      await sendWithDelay(sock, vendorJid, typeof invReply === 'object' ? invReply.reply : invReply);
    }
    return;
  }

  if ((text || '').toLowerCase().startsWith('broadcast:')) {
    const message = text.replace(/^broadcast:?\s*/i, '').trim();
    if (message) {
      const { sent } = await broadcastToAllBuyers(vendor.id, message, vendor);
      await sendWithDelay(sock, vendorJid, `Broadcast sent to ${sent} buyer(s).`);
    }
    return;
  }

  if ((text || '').toLowerCase().trim() === 'orders') {
    const ordersRes = await query(
      `SELECT t.id, t.item_name, t.amount, t.buyer_jid, t.buyer_phone, t.created_at
       FROM transactions t
       WHERE t.vendor_id = $1 AND t.status = $2 AND t.delivery_confirmed IS NULL
       ORDER BY t.created_at DESC LIMIT 20`,
      [vendor.id, 'paid']
    );
    const orders = ordersRes.rows || [];
    if (!orders.length) {
      await sendWithDelay(sock, vendorJid, 'No pending orders. All caught up! ✅');
    } else {
      const lines = orders.map((o, i) => {
        const phone = (o.buyer_phone || o.buyer_jid || '').replace(/\D/g, '');
        return `${i + 1}. *${o.item_name}* — ₦${(o.amount / 100).toLocaleString()}\n   Buyer: wa.me/${phone}\n   Reply *DETAILS* for the latest order's buyer history.`;
      });
      await sendWithDelay(sock, vendorJid, `📋 *Pending orders (${orders.length})*\n\n` + lines.join('\n\n'));
    }
    return;
  }

  if ((text || '').toUpperCase() === 'DETAILS') {
    const txnRes = await query(
      'SELECT buyer_jid FROM transactions WHERE vendor_id = $1 AND status = $2 AND delivery_confirmed IS NULL ORDER BY created_at DESC LIMIT 1',
      [vendor.id, 'paid']
    );
    const txn = txnRes.rows && txnRes.rows[0];
    if (txn) {
      const profile = await getBuyerProfile(txn.buyer_jid, vendor.id);
      await sendWithDelay(sock, vendorJid, formatBuyerProfileMessage(profile));
    } else {
      await sendWithDelay(sock, vendorJid, 'No pending order to show details for.');
    }
    return;
  }

  if (['DELIVERED', 'TOMORROW', 'ISSUE'].includes((text || '').toUpperCase().trim())) {
    const txnRes = await query(
      'SELECT id FROM transactions WHERE vendor_id = $1 AND status = $2 AND delivery_confirmed IS NULL ORDER BY created_at DESC LIMIT 1',
      [vendor.id, 'paid']
    );
    const txn = txnRes.rows && txnRes.rows[0];
    if (txn) {
      await query('UPDATE transactions SET delivery_status = $1 WHERE id = $2', [text.toUpperCase().trim(), txn.id]);
      await sendWithDelay(sock, vendorJid, 'Updated. Thanks!');
    }
    return;
  }

  await sendWithDelay(sock, vendorJid, 'Reply *help* for commands. Or *add: item name, price, qty* to add stock.');
}

module.exports = { handleVendorMessage };
