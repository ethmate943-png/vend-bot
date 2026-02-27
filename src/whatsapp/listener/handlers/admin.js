/** Admin-only commands (TIER, CAP, STATUS, BAN, REFUND, RESERVE, LABEL) */

const axios = require('axios');
const { query } = require('../../../db');
const { sendMessage, sendWithDelay } = require('../../sender');

async function handleAdminCommand(sock, text, adminJid) {
  const upper = (text || '').toUpperCase();

  if (upper.startsWith('DEBUG:')) {
    const phone = (text || '').replace(/^debug:\s*/i, '').trim().replace(/\D/g, '');
    if (!phone) {
      await sendWithDelay(sock, adminJid, 'Use: DEBUG: 08012345678');
      return;
    }
    const jid = `${phone}@s.whatsapp.net`;
    const { rows } = await query(
      `SELECT s.intent_state, s.last_item_name, s.last_item_sku, s.message_count, s.updated_at,
              v.business_name, v.store_code
       FROM sessions s
       JOIN vendors v ON v.id = s.vendor_id
       WHERE s.buyer_jid = $1
       ORDER BY s.updated_at DESC
       LIMIT 5`,
      [jid]
    );
    if (!rows.length) {
      await sendWithDelay(sock, adminJid, `No sessions found for ${phone}`);
      return;
    }
    const summary = rows.map(s =>
      `Store: ${s.store_code}\nState: ${s.intent_state}\nLast item: ${s.last_item_name || 'none'}\nMessages: ${s.message_count || 0}\nUpdated: ${s.updated_at}`
    ).join('\n---\n');
    await sendWithDelay(sock, adminJid, summary);
    return;
  }

  if (upper.startsWith('TIER:')) {
    const parts = text.replace(/^tier:\s*/i, '').trim().split(/\s+/);
    const code = (parts[0] || '').toUpperCase();
    const tier = (parts[1] || 'standard').toLowerCase();
    const capKobo = parts[2] ? parseInt(parts[2], 10) * 100 : null;
    await query(
      `UPDATE vendors SET
        vendor_tier = $1, status = 'active',
        custom_daily_cap_kobo = $2, tier_set_by = 'admin',
        onboarding_complete = true
       WHERE store_code = $3`,
      [tier, capKobo, code]
    );
    await sendMessage(sock, adminJid,
      `✅ ${code} → ${tier.toUpperCase()} | Cap: ₦${(parseInt(parts[2], 10) || 0).toLocaleString()}`
    );
    return;
  }

  if (upper.startsWith('CAP:')) {
    const parts = text.replace(/^cap:\s*/i, '').trim().split(/\s+/);
    const code = (parts[0] || '').toUpperCase();
    const cap = parseInt(parts[1], 10) * 100;
    await query('UPDATE vendors SET custom_daily_cap_kobo = $1 WHERE store_code = $2', [cap, code]);
    await sendMessage(sock, adminJid, `✅ ${code} cap → ₦${parseInt(parts[1], 10).toLocaleString()}`);
    return;
  }

  if (upper.startsWith('STATUS:')) {
    const code = text.replace(/^status:\s*/i, '').trim().toUpperCase();
    const res = await query('SELECT * FROM vendors WHERE store_code = $1', [code]);
    const v = res.rows[0];
    if (!v) {
      await sendMessage(sock, adminJid, `${code} not found`);
      return;
    }
    const cap = v.custom_daily_cap_kobo ?? v.daily_cap_kobo ?? 0;
    await sendMessage(sock, adminJid,
      `📊 *${v.business_name}*\n` +
      `Tier: ${v.vendor_tier || 'standard'} | Status: ${v.status}\n` +
      `Transactions: ${v.total_transactions || 0}\n` +
      `Daily cap: ₦${(cap / 100).toLocaleString()}\n` +
      `No count: ${v.no_count || 0}\n` +
      `Subaccount: ${v.paystack_subaccount_code || 'not set'}`
    );
    return;
  }

  if (upper.startsWith('NAME:')) {
    const parts = text.replace(/^name:\s*/i, '').trim().split(/\s+/);
    const code = (parts[0] || '').toUpperCase();
    const newName = parts.slice(1).join(' ').trim();
    if (!newName) {
      await sendMessage(sock, adminJid, 'Use: NAME: STORECODE New Store Name');
      return;
    }
    const res = await query(
      'UPDATE vendors SET business_name = $1 WHERE store_code = $2 RETURNING id',
      [newName.slice(0, 255), code]
    );
    if (!res.rows || res.rows.length === 0) {
      await sendMessage(sock, adminJid, `Store code "${code}" not found`);
      return;
    }
    await sendMessage(sock, adminJid, `✅ ${code} → business name set to "${newName.slice(0, 255)}"`);
    return;
  }

  if (upper.startsWith('BAN:')) {
    const parts = text.replace(/^ban:\s*/i, '').trim().split(/\s+/);
    const code = (parts[0] || '').toUpperCase();
    await query('UPDATE vendors SET status = $1 WHERE store_code = $2', ['banned', code]);
    await sendMessage(sock, adminJid, `✅ ${code} banned`);
    return;
  }

  if (upper.startsWith('REFUND:')) {
    const parts = text.replace(/^refund:\s*/i, '').trim().split(/\s+/);
    const reference = (parts[0] || '').toUpperCase();
    const amountArg = parts[1];
    const res = await query(
      'SELECT * FROM transactions WHERE mono_ref = $1 LIMIT 1',
      [reference]
    );
    const txn = res.rows[0];
    if (!txn) {
      await sendMessage(sock, adminJid, 'Transaction not found');
      return;
    }
    const refundAmount = amountArg === 'FULL'
      ? txn.amount
      : Math.floor(txn.amount * parseInt(amountArg, 10) / 100);
    await axios.post(
      'https://api.paystack.co/refund',
      { transaction: reference, amount: refundAmount },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    await sendWithDelay(sock, txn.buyer_jid,
      `✅ Refund of ₦${(refundAmount / 100).toLocaleString()} processed. Allow 3-5 business days.`
    );
    await sendMessage(sock, adminJid, `✅ Refund done — ₦${(refundAmount / 100).toLocaleString()}`);
    return;
  }

  if (upper === 'RESERVE') {
    try {
      const res = await query(
        'SELECT COALESCE(SUM(amount_kobo), 0) AS total FROM platform_reserve WHERE used_for_dispute_id IS NULL'
      );
      const total = res.rows[0]?.total || 0;
      await sendMessage(sock, adminJid, `💰 Platform Reserve: ₦${(total / 100).toLocaleString()}`);
    } catch (e) {
      await sendMessage(sock, adminJid, `Reserve table not set up: ${e.message}`);
    }
    return;
  }

  if (upper.startsWith('LABEL:')) {
    const parts = text.replace(/^label:\s*/i, '').trim().split(/\s+/);
    const code = (parts[0] || '').toUpperCase();
    const isFraud = (parts[1] || '').toUpperCase() === 'FRAUD';
    const vRes = await query('SELECT id FROM vendors WHERE store_code = $1', [code]);
    if (vRes.rows[0]) {
      try {
        await query(
          'UPDATE vendor_features SET is_fraud = $1, reviewed_by = $2 WHERE vendor_id = $3',
          [isFraud, 'admin', vRes.rows[0].id]
        );
      } catch (e) {
        await sendMessage(sock, adminJid, `Label failed (table?): ${e.message}`);
        return;
      }
    }
    await sendMessage(sock, adminJid, `✅ ${code} labelled as ${isFraud ? 'FRAUD' : 'LEGITIMATE'}`);
    return;
  }
}

module.exports = { handleAdminCommand };
