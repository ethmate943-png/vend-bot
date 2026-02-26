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

async function setSessionRole(buyerJid, vendorId, role) {
  const safeRole = role === 'vendor' ? 'vendor' : 'buyer';
  await upsertSession(buyerJid, vendorId, { role: safeRole });
}

async function clearSession(buyerJid, vendorId) {
  await query(
    `UPDATE sessions SET intent_state = 'idle', pending_payment_ref = NULL, last_item_sku = NULL, last_item_name = NULL, list_skus = NULL, list_offset = 0, conversation_history = '[]' WHERE buyer_jid = $1 AND vendor_id = $2`,
    [buyerJid, vendorId]
  );
}

const MAX_CONVERSATION_HISTORY = 10;

function getConversationHistory(session) {
  if (!session) return [];
  const raw = session.conversation_history;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

async function appendConversationExchange(buyerJid, vendorId, userContent, assistantContent) {
  if (process.env.PRIVACY_NO_CHAT_STORAGE === 'true' || process.env.PRIVACY_NO_CHAT_STORAGE === '1') return;
  const session = await getSession(buyerJid, vendorId);
  if (!session) return;
  const history = getConversationHistory(session);
  history.push({ role: 'user', content: (userContent || '').slice(0, 500) });
  history.push({ role: 'assistant', content: (assistantContent || '').slice(0, 500) });
  const trimmed = history.slice(-MAX_CONVERSATION_HISTORY);
  await query(
    'UPDATE sessions SET conversation_history = $1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(trimmed), buyerJid, vendorId]
  );
}

const MAX_HISTORY = 10;

/** When PRIVACY_NO_CHAT_STORAGE is set, we never store or return chat content. */
const noChatStorage = process.env.PRIVACY_NO_CHAT_STORAGE === 'true' || process.env.PRIVACY_NO_CHAT_STORAGE === '1';

function getChatHistory(session) {
  if (noChatStorage) return [];
  try {
    return JSON.parse(session.chat_history || '[]');
  } catch {
    return [];
  }
}

async function appendMessage(buyerJid, vendorId, role, text) {
  if (noChatStorage) return;
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

/**
 * Append a single entry to the high-level conversation_history and bump message_count.
 * This is used by the conversation engine (gatekeeper/patterns) to understand behaviour,
 * separate from the lightweight chat_history used for quick intent heuristics.
 */
async function appendHistory(buyerJid, vendorId, role, content) {
  if (process.env.PRIVACY_NO_CHAT_STORAGE === 'true' || process.env.PRIVACY_NO_CHAT_STORAGE === '1') return;
  const session = await getSession(buyerJid, vendorId);
  if (!session) return;
  const history = getConversationHistory(session);
  history.push({
    role,
    content: (content || '').slice(0, 500),
    ts: new Date().toISOString()
  });
  const trimmed = history.slice(-12);
  await query(
    'UPDATE sessions SET conversation_history = $1, message_count = COALESCE(message_count, 0) + 1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(trimmed), buyerJid, vendorId]
  );
}

module.exports = {
  getSession,
  upsertSession,
  clearSession,
  getChatHistory,
  appendMessage,
  getConversationHistory,
  appendConversationExchange,
  setSessionRole,
  appendHistory
};
