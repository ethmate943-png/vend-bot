const { query } = require('../db');

async function getSession(buyerJid, vendorId) {
  const res = await query(
    'SELECT * FROM sessions WHERE buyer_jid = $1 AND vendor_id = $2 LIMIT 1',
    [buyerJid, vendorId]
  );
  return res.rows[0] || null;
}

async function upsertSession(buyerJid, vendorId, updates) {
  const existing = await getSession(buyerJid, vendorId);

  if (existing) {
    const fields = Object.keys(updates);
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const values = fields.map(f => updates[f]);
    await query(
      `UPDATE sessions SET ${sets}, updated_at = NOW() WHERE buyer_jid = $1 AND vendor_id = $2`,
      [buyerJid, vendorId, ...values]
    );
  } else {
    const allFields = { buyer_jid: buyerJid, vendor_id: vendorId, ...updates };
    const keys = Object.keys(allFields);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => allFields[k]);
    await query(
      `INSERT INTO sessions (${keys.join(', ')}) VALUES (${placeholders})`,
      values
    );
  }
}

async function clearSession(buyerJid, vendorId) {
  await query(
    `UPDATE sessions SET intent_state = 'idle', pending_payment_ref = NULL, last_item_sku = NULL, last_item_name = NULL WHERE buyer_jid = $1 AND vendor_id = $2`,
    [buyerJid, vendorId]
  );
}

const MAX_HISTORY = 10;

function getChatHistory(session) {
  try {
    return JSON.parse(session.chat_history || '[]');
  } catch {
    return [];
  }
}

async function appendMessage(buyerJid, vendorId, role, text) {
  const session = await getSession(buyerJid, vendorId);
  if (!session) return;
  const history = getChatHistory(session);
  history.push({ role, text: text.slice(0, 200) });
  while (history.length > MAX_HISTORY) history.shift();
  await query(
    'UPDATE sessions SET chat_history = $1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(history), buyerJid, vendorId]
  );
}

module.exports = { getSession, upsertSession, clearSession, getChatHistory, appendMessage };
