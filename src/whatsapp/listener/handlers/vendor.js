/** Vendor messages: voice stock, onboarding, inventory commands, broadcast, orders, details, delivery status, TRUST, COLLECTED */

const { query } = require('../../../db');
const path = require('path');
const fs = require('fs');
const { sendMessage, sendWithDelay, sendListMessage } = require('../../sender');
const { logReply } = require('../logger');
const { getInventory, addItems, setItemImage } = require('../../../inventory/manager');
const { handleOnboarding } = require('../../../vendors/onboarding');
const { handleInventoryCommand } = require('../../../inventory/commands');
const { broadcastToAllBuyers } = require('../../../crm/broadcast');
const { getBuyerProfile, formatBuyerProfileMessage } = require('../../../crm/manager');
const {
  getPendingTrustOrder,
  deletePendingTrustOrder,
  createTrustOrderTransaction,
  markTrustOrderCollected,
  addVendorTrustedBuyer,
  isVendorTrustedBuyer
} = require('../../../trust/manager');
const { generatePaymentLink } = require('../../../payments/paystack');
const { checkVendorCap } = require('../../../payments/paystack');
const { decrementQty } = require('../../../inventory/manager');
const VENDBOT_NUMBER = process.env.VENDBOT_NUMBER || '';

// Cooldown so we don't spam the same fallback every time (ms).
const VENDOR_FALLBACK_COOLDOWN_MS = 3 * 60 * 1000;
const vendorFallbackLastSent = new Map();

const VENDOR_FALLBACK_LINES = [
  'Type *help* to see commands, or *add: name, price, qty* to add stock.',
  'Need a reminder? *help* for commands.',
  'Say *stock help* for inventory commands.'
];

const PENDING_IMAGE_TTL_MS = 5 * 60 * 1000;
const pendingImageFor = new Map();

async function handleVendorMessage(sock, msg, vendor, text, vendorJid) {
  if (msg.message.imageMessage) {
    const pending = pendingImageFor.get(vendorJid);
    if (pending && Date.now() - pending.at < PENDING_IMAGE_TTL_MS) {
      const baseUrl = (process.env.PUBLIC_IMAGE_BASE_URL || '').trim().replace(/\/$/, '');
      if (!baseUrl) {
        pendingImageFor.delete(vendorJid);
        await sendWithDelay(sock, vendorJid, 'Photo upload not configured. Use *image: item, https://...* with a direct image link (e.g. from imgur).');
        logReply('[pending image: no base URL]');
        return;
      }
      try {
        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image', {});
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const uploadsDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const safeSku = String(pending.sku).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const filename = `${vendor.id}_${safeSku}.jpg`;
        const filepath = path.join(uploadsDir, filename);
        fs.writeFileSync(filepath, buffer);
        const imageUrl = `${baseUrl}/uploads/${filename}`;
        await setItemImage(vendor, pending.sku, imageUrl);
        pendingImageFor.delete(vendorJid);
        await sendWithDelay(sock, vendorJid, `Image set ✅ for ${pending.itemName}. Buyers will see the photo.`);
        logReply('[Vendor image uploaded]');
      } catch (err) {
        console.error('[LISTENER] Vendor image upload error:', err.message);
        pendingImageFor.delete(vendorJid);
        await sendWithDelay(sock, vendorJid, 'Could not save the photo. Try *image: item, https://...* with a direct image link instead.');
      }
      return;
    }
  }

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
        const reply = `Added from voice ✅ ${items.length} item(s)\n\n${summary}`;
        await sendWithDelay(sock, vendorJid, reply);
        logReply(reply);
      } else {
        const reply = 'Could not get items from the voice note. Try saying clearly: "add: item name, price, quantity" or "restock: item name, number".';
        await sendWithDelay(sock, vendorJid, reply);
        logReply(reply);
      }
    } catch (err) {
      console.error('[LISTENER] Vendor voice stock error:', err.message);
      const reply = 'Something went wrong with the voice note. Try typing *add:* or *restock:* instead.';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
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
    // Refetch current store_code from DB by id (same row CODE: updates) so help always shows the latest link
    const helpRes = await query('SELECT store_code, business_name FROM vendors WHERE id = $1 LIMIT 1', [vendor.id]);
    const row = helpRes.rows && helpRes.rows[0] ? helpRes.rows[0] : null;
    const vendorForHelp = {
      ...vendor,
      store_code: row ? (row.store_code != null ? row.store_code : '') : (vendor.store_code || ''),
      business_name: row ? (row.business_name != null ? row.business_name : '') : (vendor.business_name || '')
    };
    const reply = getVendorCommandsMessage(vendorForHelp);
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  const trimmed = (text || '').trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();

  // Vendor profile / settings overview (always read latest from DB by whatsapp_number so NAME: changes show immediately)
  if (upper === 'PROFILE' || upper === 'SETTINGS') {
    const vendorKey = (vendor.whatsapp_number || '').replace(/\D/g, '');
    const vRes = vendorKey
      ? await query(
          'SELECT business_name, category, location, delivery_coverage, turnaround, tone, custom_note, store_code FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
          [vendorKey]
        )
      : { rows: [] };
    const v = (vRes.rows && vRes.rows[0]) ? vRes.rows[0] : vendor;
    const lines = [
      `📋 *Your VendBot profile*`,
      '',
      `Business: *${v.business_name || vendor.business_name || ''}*`,
      `Store code: *${(v.store_code || vendor.store_code || '').toUpperCase()}*`,
      '',
      `Market type: ${v.category || 'Not set'}`,
      `Location: ${v.location || 'Not set'}`,
      `Delivery: ${v.delivery_coverage || 'Not set'}`,
      `Turnaround: ${v.turnaround || 'Not set'}`,
      `Tone: ${v.tone || 'Not set'}`,
      `Note: ${v.custom_note || 'None'}`,
      '',
      `To update:`,
      `• NAME: New Name — change store name once after setup; then admin only`,
      `• CODE: NEWCODE — change your store code (must be unique)`,
      `• TYPE: 1–6 or short description`,
      `• LOCATION: new area`,
      `• DELIVERY: how you deliver`,
      `• TURNAROUND: how long orders take`,
      `• TONE: professional / friendly / playful / pidgin`,
      `• NOTE: one short sentence buyers should see`
    ];
    const reply = lines.join('\n');
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // Change store code via CODE: NEWCODE
  if (upper.startsWith('CODE:')) {
    const rawCode = trimmed.slice('CODE:'.length).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!rawCode) {
      const reply = `Reply like: CODE: AMAKA or CODE: SNEAKERHUB`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    const code = rawCode.slice(0, 32);
    const existing = await query('SELECT id FROM vendors WHERE store_code = $1 AND id != $2 LIMIT 1', [code, vendor.id]);
    if (existing.rows && existing.rows.length > 0) {
      const reply = `"${code}" is already taken by another store. Try a different code.`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    await query('UPDATE vendors SET store_code = $1 WHERE id = $2', [code, vendor.id]);
    const botNum = (VENDBOT_NUMBER || '').replace(/\D/g, '');
    const textParam = encodeURIComponent(`${code} hi`);
    const link = botNum ? `wa.me/${botNum}?text=${textParam}` : null;
    const reply =
      `Store code updated to *${code}* ✅` +
      (link ? `\n\nNew store link:\n${link}` : '');
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // Change business name: one self-serve change after onboarding; then admin only
  // Aliases: NAME:, STORE NAME:, STORE:
  if (upper.startsWith('NAME:') || upper.startsWith('STORE NAME:') || upper.startsWith('STORE:')) {
    const prefixMatch = upper.match(/^(NAME:|STORE NAME:|STORE:)/);
    const prefixLen = prefixMatch ? prefixMatch[0].length : 'NAME:'.length;
    const newName = trimmed.slice(prefixLen).trim().slice(0, 255);
    if (!newName) {
      const reply = 'Reply with *NAME:* then your new store name (e.g. NAME: Amaka Fashion). You can change it once after setup; after that, only admin can change it.';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    // Use whatsapp_number (same key we use to resolve vendor from bot) so we always update this bot's row
    const vendorKey = (vendor.whatsapp_number || '').replace(/\D/g, '');
    if (!vendorKey) {
      await sendWithDelay(sock, vendorJid, 'Could not identify this store. Contact admin.');
      return;
    }
    const vRes = await query(
      'SELECT business_name_edits_used FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
      [vendorKey]
    );
    const used = vRes.rows && vRes.rows[0] && vRes.rows[0].business_name_edits_used === true;
    if (used) {
      const reply = 'You’ve already used your one store-name change. For further changes, contact admin.';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    const updateRes = await query(
      'UPDATE vendors SET business_name = $1, business_name_edits_used = true WHERE whatsapp_number = $2 RETURNING id, business_name',
      [newName, vendorKey]
    );
    const updatedName = updateRes.rows && updateRes.rows[0] ? updateRes.rows[0].business_name : newName;
    const reply = `Store name updated to *${updatedName}* ✅. Further changes require admin.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // If they say they picked the wrong type/category, gently point to TYPE command
  if (/(wrong (type|category)|change (my )?(type|category|market)|picked the wrong (type|category)|chose the wrong (type|category))/i.test(lower)) {
    const msgText =
      `No wahala — we can change your market type. 👍\n\n` +
      `Reply with *TYPE:* and a number:\n\n` +
      `1 — Fashion & clothing\n` +
      `2 — Food & drinks\n` +
      `3 — Electronics & gadgets\n` +
      `4 — Beauty & skincare\n` +
      `5 — Home & furniture\n` +
      `6 — Other (TYPE: other: one-sentence description)`;
    await sendWithDelay(sock, vendorJid, msgText);
    logReply(msgText);
    return;
  }

  // Explicit market type change
  if (upper.startsWith('TYPE')) {
    const raw = trimmed.replace(/^TYPE[:\s]*/i, '').trim();
    if (!raw) {
      const msgText =
        `To change your market type, reply with *TYPE:* and a number:\n\n` +
        `1 — Fashion & clothing\n` +
        `2 — Food & drinks\n` +
        `3 — Electronics & gadgets\n` +
        `4 — Beauty & skincare\n` +
        `5 — Home & furniture\n` +
        `6 — Other (TYPE: other: one-sentence description)`;
      await sendWithDelay(sock, vendorJid, msgText);
      logReply(msgText);
      return;
    }
    const num = raw === '6' || /^6\s*[.)]?\s*$/i.test(raw) ? 6 : parseInt(raw, 10);
    const categoryMap = {
      1: 'Fashion & clothing',
      2: 'Food & drinks',
      3: 'Electronics & gadgets',
      4: 'Beauty & skincare',
      5: 'Home & furniture'
    };
    let newCategory = null;
    if (num >= 1 && num <= 5 && categoryMap[num]) {
      newCategory = categoryMap[num];
    } else if (num === 6 || /^other\b/i.test(raw)) {
      const desc = raw.replace(/^other[:\s-]*/i, '').trim();
      if (!desc) {
        await sendWithDelay(sock, vendorJid, `Describe what you sell in one short sentence — e.g. "Handmade jewellery and accessories" or "Phone repairs and accessories".`);
        return;
      }
      newCategory = desc.slice(0, 200);
    } else if (!Number.isNaN(num) && categoryMap[num]) {
      newCategory = categoryMap[num];
    } else {
      // Treat free text as custom description
      newCategory = raw.slice(0, 200);
    }
    await query('UPDATE vendors SET category = $1 WHERE id = $2', [newCategory, vendor.id]);
    const reply = `Market type updated to *${newCategory}* ✅`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // LOCATION: Ajah, Lagos
  if (upper.startsWith('LOCATION:')) {
    const loc = trimmed.slice('LOCATION:'.length).trim().slice(0, 200);
    if (!loc) {
      const reply = `Reply like: LOCATION: Ajah, Lagos`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    await query('UPDATE vendors SET location = $1 WHERE id = $2', [loc, vendor.id]);
    const reply = `Location updated to *${loc}* ✅`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // DELIVERY: Lagos only, rider
  if (upper.startsWith('DELIVERY:')) {
    const d = trimmed.slice('DELIVERY:'.length).trim().slice(0, 200);
    if (!d) {
      const reply = `Reply like: DELIVERY: Lagos only, rider / Pickup only / Nationwide via dispatch`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    await query('UPDATE vendors SET delivery_coverage = $1 WHERE id = $2', [d, vendor.id]);
    const reply = `Delivery info updated ✅\nNow: *${d}*`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // TURNAROUND: 3–5 days
  if (upper.startsWith('TURNAROUND:')) {
    const t = trimmed.slice('TURNAROUND:'.length).trim().slice(0, 100);
    if (!t) {
      const reply = `Reply like: TURNAROUND: 3–5 days / Same day / 1 week`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    await query('UPDATE vendors SET turnaround = $1 WHERE id = $2', [t, vendor.id]);
    const reply = `Turnaround updated to *${t}* ✅`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // TONE: friendly / playful / professional / pidgin
  if (upper.startsWith('TONE:')) {
    const val = trimmed.slice('TONE:'.length).trim().toLowerCase();
    const mapTone = {
      professional: 'professional',
      formal: 'professional',
      friendly: 'friendly',
      conversational: 'friendly',
      playful: 'playful',
      fun: 'playful',
      pidgin: 'pidgin',
      'english & pidgin': 'pidgin',
      'mix': 'pidgin'
    };
    const key = Object.keys(mapTone).find(k => val.includes(k)) || val;
    const toneVal = mapTone[key] || (val || '').slice(0, 32);
    await query('UPDATE vendors SET tone = $1 WHERE id = $2', [toneVal, vendor.id]);
    const reply = `Tone updated to *${toneVal}* ✅`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // NOTE: free short sentence buyers should see
  if (upper.startsWith('NOTE:')) {
    const note = trimmed.slice('NOTE:'.length).trim().slice(0, 300);
    await query('UPDATE vendors SET custom_note = $1 WHERE id = $2', [note || null, vendor.id]);
    const reply = note ? `Buyer note updated ✅\nNow: *${note}*` : 'Buyer note cleared ✅';
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // Pending trust order: vendor replying 1 (standard), 2 (pay on delivery), or 3 (credit)
  const pendingTrust = await getPendingTrustOrder(vendor.id);
  if (pendingTrust && /^[123]\s*[.)]?\s*$/.test(trimmed)) {
    const choice = trimmed.replace(/\D/g, '') || '1';
    const buyerJid = pendingTrust.buyer_jid;
    const buyerPhone = pendingTrust.buyer_phone || buyerJid.replace(/\D/g, '');
    const amountNaira = pendingTrust.amount_kobo / 100;
    // Use current store name from DB for payment-link messages
    const vendorKey = (vendor.whatsapp_number || '').replace(/\D/g, '');
    const nameRes = vendorKey ? await query('SELECT business_name FROM vendors WHERE whatsapp_number = $1 LIMIT 1', [vendorKey]) : { rows: [] };
    const currentName = (nameRes.rows && nameRes.rows[0] && nameRes.rows[0].business_name) || vendor.business_name || 'Store';
    if (choice === '1') {
      try {
        const capCheck = await checkVendorCap(vendor, pendingTrust.amount_kobo);
        if (!capCheck.allowed) {
          const reply = `Daily cap reached. Can't send payment link right now.`;
          await sendWithDelay(sock, vendorJid, reply);
          logReply(reply);
          return;
        }
        const { link, reference, business_name: linkName } = await generatePaymentLink({
          amount: amountNaira,
          itemName: pendingTrust.item_name,
          itemSku: pendingTrust.item_sku,
          buyerJid: pendingTrust.buyer_jid,
          vendorId: vendor.id,
          vendorPhone: vendor.whatsapp_number
        });
        const nameInMsg = linkName || currentName;
        await sendWithDelay(sock, buyerJid, `${nameInMsg}: Pay here — *${pendingTrust.item_name}* (₦${amountNaira.toLocaleString()})\n\n${link}\n\n_Link expires in 30 mins._`);
        const reply = `Payment link sent to buyer ✅`;
        await sendWithDelay(sock, vendorJid, reply);
        logReply(reply);
      } catch (err) {
        console.error('[TRUST] Payment link error:', err.message);
        const reply = 'Could not create payment link. Try again or use *orders* to see pending.';
        await sendWithDelay(sock, vendorJid, reply);
        logReply(reply);
      }
    } else {
      const status = choice === '2' ? 'pay_on_delivery' : 'credit';
      await createTrustOrderTransaction(
        vendor.id,
        pendingTrust.buyer_jid,
        pendingTrust.buyer_phone,
        pendingTrust.item_name,
        pendingTrust.item_sku,
        pendingTrust.amount_kobo,
        status
      );
      const replyBuyer = `${currentName}: No payment link — you'll pay when you receive. Vendor will confirm when payment is collected.`;
      await sendWithDelay(sock, buyerJid, replyBuyer);
      logReply(replyBuyer);
      const replyVendor = `Noted. Deliver and when you've collected payment, reply: *COLLECTED: ${buyerPhone} ${amountNaira}*`;
      await sendWithDelay(sock, vendorJid, replyVendor);
      logReply(replyVendor);
      try {
        const vendorRef = { id: vendor.id, sheet_id: vendor.sheet_id, sheet_tab: vendor.sheet_tab };
        await decrementQty(vendorRef, pendingTrust.item_sku);
      } catch (_) {}
    }
    await deletePendingTrustOrder(pendingTrust.id);
    return;
  }

  if (upper.startsWith('TRUST:')) {
    const rest = trimmed.slice(6).trim();
    const match = rest.match(/^(\d[\d\s-]{9,})\s*[—\-:]\s*(.+)$/) || rest.match(/^(\d[\d\s-]{9,})\s+(.+)$/);
    const phone = (match ? match[1] : rest).replace(/\D/g, '');
    const nameNote = match ? match[2].trim() : '';
    if (phone.length < 10) {
      const reply = 'Use: *TRUST: 08012345678 — Mama Ngozi, regular customer*';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    const buyerJid = `${phone}@s.whatsapp.net`;
    const [buyerName, ...noteParts] = nameNote.split(',').map(s => s.trim());
    const note = noteParts.length ? noteParts.join(', ') : null;
    await addVendorTrustedBuyer(vendor.id, buyerJid, buyerName || null, note);
    const display = buyerName || phone;
    const reply = `${display} added to your trusted buyers ✅\n\nWhen they order from your store, you choose how payment works — standard link, pay on delivery, or credit.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  if (upper.startsWith('COLLECTED:')) {
    const rest = trimmed.slice(10).trim();
    const parts = rest.split(/\s+/);
    const phone = (parts[0] || '').replace(/\D/g, '');
    const amountStr = (parts[1] || parts[0]).replace(/[^\d.]/g, '');
    const amountNaira = parseFloat(amountStr) || 0;
    const amountKobo = Math.round(amountNaira * 100);
    if (!phone || amountKobo <= 0) {
      const reply = 'Use: *COLLECTED: 08012345678 8500* (phone and amount in naira)';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    const row = await markTrustOrderCollected(vendor.id, phone, amountKobo);
    if (!row) {
      const reply = `No matching pay-on-delivery or credit order for that buyer/amount. Check the amount (e.g. 8500 for ₦8,500).`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
      return;
    }
    const name = row.buyer_jid || phone;
    const reply = `₦${(row.amount / 100).toLocaleString()} recorded for ${name} ✅\nTransaction logged.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    try {
      const notify = `${vendor.business_name}: Payment of ₦${(row.amount / 100).toLocaleString()} for *${row.item_name}* has been confirmed ✅`;
      await sendWithDelay(sock, row.buyer_jid, notify);
      logReply(notify);
    } catch (_) {}
    return;
  }

  const invReply = await handleInventoryCommand(text, vendor);
  if (invReply !== null) {
    if (typeof invReply === 'object' && invReply.pendingImage === true) {
      pendingImageFor.set(vendorJid, {
        sku: invReply.sku,
        itemName: invReply.itemName,
        vendorId: vendor.id,
        at: Date.now()
      });
      await sendWithDelay(sock, vendorJid, `Send the product photo now (one image). I'll use it for *${invReply.itemName}*.`);
      logReply('[Pending image]');
      return;
    }
    if (typeof invReply === 'object' && invReply.list === true && invReply.items && invReply.items.length > 0) {
      await sendListMessage(sock, vendorJid, invReply.intro, invReply.buttonTitle || 'View items', invReply.items);
      logReply('[Vendor list]');
      return;
    }
    if (typeof invReply === 'object' && invReply.waitlistBuyers && invReply.waitlistBuyers.length > 0) {
      await sendWithDelay(sock, vendorJid, invReply.reply);
      logReply(invReply.reply);
      for (const w of invReply.waitlistBuyers) {
        const jid = w.buyer_jid;
        if (jid) {
          await sendWithDelay(sock, jid, `${vendor.business_name}: *${invReply.restockedItem.name}* is back in stock! Reply to order.`);
          await query('UPDATE waitlist SET notified = true WHERE buyer_jid = $1 AND vendor_id = $2 AND item_sku = $3', [jid, vendor.id, invReply.restockedItem.sku]);
        }
      }
    } else {
      const reply = typeof invReply === 'object' ? invReply.reply : invReply;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
    }
    return;
  }

  if ((text || '').toLowerCase().startsWith('broadcast:')) {
    const message = text.replace(/^broadcast:?\s*/i, '').trim();
    if (message) {
      const { sent } = await broadcastToAllBuyers(vendor.id, message, vendor);
      const reply = `Broadcast sent to ${sent} buyer(s).`;
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
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
      const reply = 'No pending orders. All caught up! ✅';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
    } else {
      const lines = orders.map((o, i) => {
        const phone = (o.buyer_phone || o.buyer_jid || '').replace(/\D/g, '');
        return `${i + 1}. *${o.item_name}* — ₦${(o.amount / 100).toLocaleString()}\n   Buyer: wa.me/${phone}\n   Reply *DETAILS* for the latest order's buyer history.`;
      });
      const reply = `📋 *Pending orders (${orders.length})*\n\n` + lines.join('\n\n');
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
    }
    return;
  }

  if ((text || '').toUpperCase().trim() === 'SUMMARY') {
    const sumRes = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid' AND created_at::date = CURRENT_DATE) AS paid_today,
         COALESCE(SUM(CASE WHEN status = 'paid' AND created_at::date = CURRENT_DATE THEN amount ELSE 0 END), 0) AS volume_today,
         COUNT(*) FILTER (WHERE status = 'pending' AND created_at::date = CURRENT_DATE) AS pending_today
       FROM transactions
       WHERE vendor_id = $1`,
      [vendor.id]
    );
    const row = sumRes.rows[0] || { paid_today: 0, volume_today: 0, pending_today: 0 };
    const paidToday = Number(row.paid_today || 0);
    const volToday = Number(row.volume_today || 0);
    const pendingToday = Number(row.pending_today || 0);
    const biz = vendor.business_name || 'your store';
    const reply =
      `📊 *Today on VendBot for ${biz}*\n\n` +
      `Paid orders: *${paidToday}* (₦${(volToday / 100).toLocaleString()})\n` +
      `Pending payments: *${pendingToday}*\n\n` +
      `Reply *orders* to see pending orders, or *PROFILE* to review your settings.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
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
      const reply = formatBuyerProfileMessage(profile);
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
    } else {
      const reply = 'No pending order to show details for.';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
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
      const reply = 'Updated. Thanks!';
      await sendWithDelay(sock, vendorJid, reply);
      logReply(reply);
    }
    return;
  }

  // Soft vendor “assistant” replies for common free-form questions,
  // instead of always pushing the same help text.
  const lowerFree = (text || '').toLowerCase();

  // Vendor asking about their business/store name
  if (/store name|business name|what('?s| is) my (store|business)/i.test(text || '')) {
    const name = vendor.business_name || '(not set yet)';
    const reply = `Your current business name is *${name}*.\n\nStore name can only be set once during setup. To change it, contact admin.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // Vendor asking about store code
  if (/store code|my code|what('?s| is) my code/i.test(text || '')) {
    const code = (vendor.store_code || '').toUpperCase() || '(not set yet)';
    const reply = `Your current store code is *${code}*.\nBuyers can DM your bot with this code to open your store.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // Vendor asking for store link (use current business name from DB)
  if (/store link|shop link|whatsapp link|store url/i.test(text || '')) {
    const vendorKey = (vendor.whatsapp_number || '').replace(/\D/g, '');
    const nameRes = vendorKey ? await query('SELECT business_name FROM vendors WHERE whatsapp_number = $1 LIMIT 1', [vendorKey]) : { rows: [] };
    const currentName = (nameRes.rows && nameRes.rows[0] && nameRes.rows[0].business_name) || vendor.business_name || 'Your store';
    const botNum = (VENDBOT_NUMBER || '').replace(/\D/g, '');
    const code = (vendor.store_code || '').toUpperCase();
    const link = botNum && code ? `wa.me/${botNum}?text=${encodeURIComponent(code)}` : null;
    const reply = link
      ? `Here is your store link for *${currentName}*:\n\n${link}\n\nShare it so buyers can chat with your bot directly.`
      : `Once your store code and VendBot number are set, I'll generate a shareable store link for you.`;
    await sendWithDelay(sock, vendorJid, reply);
    logReply(reply);
    return;
  }

  // If they explicitly say they don't need help, don't spam help again.
  if (/don'?t need help|no help|stop (help|this)|i (am|m) fine/i.test(lowerFree)) {
    return;
  }

  const now = Date.now();
  const last = vendorFallbackLastSent.get(vendorJid) || 0;
  if (now - last < VENDOR_FALLBACK_COOLDOWN_MS) {
    return; // Already sent a fallback recently; stay quiet.
  }
  vendorFallbackLastSent.set(vendorJid, now);
  const reply = VENDOR_FALLBACK_LINES[Math.floor(Math.random() * VENDOR_FALLBACK_LINES.length)];
  await sendWithDelay(sock, vendorJid, reply);
  logReply(reply);
}

module.exports = { handleVendorMessage };
