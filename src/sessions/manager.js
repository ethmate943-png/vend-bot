const { query } = require('../db');

/**
 * Same person can message from phone (234xxx@s.whatsapp.net) or linked device (xxx@lid).
 * Use one canonical jid for session so list selection and state work from either.
 */
function canonicalBuyerJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;
  const phone = jid.replace(/@s\.whatsapp\.net$/i, '').replace(/@lid.*$/i, '').replace(/\D/g, '');
  return phone ? `${phone}@s.whatsapp.net` : jid;
}

/** Session columns that are safe to upsert in upsertSessionFields. */
const SESSION_UPDATEABLE = new Set([
  'intent_state', 'pending_payment_ref', 'last_item_sku', 'last_item_name', 'last_item_price',
  'last_item_price_quoted_at', 'list_skus', 'list_offset', 'role', 'buyer_name', 'buyer_name_source',
  'message_count', 'bot_paused', 'payment_link_sent_at', 'conversation_history',
  'variant_selections', 'pending_variant_product_sku', 'pending_variant_type'
]);

async function getSession(buyerJid, vendorId) {
  const c = canonicalBuyerJid(buyerJid);
  let res = await query(
    `SELECT *, COALESCE(conversation_history, '[]'::jsonb) AS conversation_history
     FROM sessions WHERE buyer_jid = $1 AND vendor_id = $2 LIMIT 1`,
    [c, vendorId]
  );
  let row = res.rows[0] || null;
  // Same person may have been stored as @lid (linked device); find and migrate to canonical
  if (!row && buyerJid && buyerJid !== c) {
    res = await query(
      `SELECT *, COALESCE(conversation_history, '[]'::jsonb) AS conversation_history
       FROM sessions WHERE buyer_jid = $1 AND vendor_id = $2 LIMIT 1`,
      [buyerJid, vendorId]
    );
    row = res.rows[0] || null;
    if (row) {
      await query(
        'UPDATE sessions SET buyer_jid = $1, updated_at = NOW() WHERE buyer_jid = $2 AND vendor_id = $3',
        [c, buyerJid, vendorId]
      );
      row.buyer_jid = c;
    }
  }
  if (row && typeof row.conversation_history === 'string') {
    try {
      row.conversation_history = JSON.parse(row.conversation_history);
    } catch {
      row.conversation_history = [];
    }
  }
  return row;
}

/**
 * Upsert session fields. Uses INSERT ... ON CONFLICT so the row is created if missing.
 * Never assume the session row exists. Logs state transitions for debugging.
 */
async function upsertSessionFields(buyerJid, vendorId, fields) {
  if (!fields || Object.keys(fields).length === 0) return;
  const keys = Object.keys(fields).filter(k => SESSION_UPDATEABLE.has(k) || k === 'conversation_history');
  if (keys.length === 0) return;

  const values = keys.map(k => {
    const v = fields[k];
    if (k === 'conversation_history' && Array.isArray(v)) return JSON.stringify(v);
    return v;
  });

  if (fields.intent_state) {
    console.log(`[SESSION] ${buyerJid} → ${vendorId} state: ${fields.intent_state}`);
  }

  const c = canonicalBuyerJid(buyerJid);
  const conflictCols = 'buyer_jid, vendor_id';
  const setClauses = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const insertCols = ['buyer_jid', 'vendor_id', ...keys].join(', ');
  const insertPlaces = ['$1', '$2', ...keys.map((_, i) => `$${i + 3}`)].join(', ');

  const res = await query(
    `INSERT INTO sessions (${insertCols}, created_at, updated_at)
     VALUES (${insertPlaces}, NOW(), NOW())
     ON CONFLICT (buyer_jid, vendor_id) DO UPDATE SET ${setClauses}, updated_at = NOW()`,
    [c, vendorId, ...values]
  );

  if (res.rowCount === 0) {
    console.warn(`[SESSION] upsertSessionFields: no row affected for ${buyerJid} ${vendorId}`);
  }
}

async function upsertSession(buyerJid, vendorId, updates) {
  const c = canonicalBuyerJid(buyerJid);
  const existing = await getSession(buyerJid, vendorId);

  if (existing) {
    const fields = Object.keys(updates);
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const values = fields.map(f => updates[f]);
    await query(
      `UPDATE sessions SET ${sets}, updated_at = NOW() WHERE buyer_jid = $1 AND vendor_id = $2`,
      [c, vendorId, ...values]
    );
  } else {
    const allFields = { buyer_jid: c, vendor_id: vendorId, ...updates };
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
  const c = canonicalBuyerJid(buyerJid);
  await query(
    `UPDATE sessions SET intent_state = 'idle', pending_payment_ref = NULL, last_item_sku = NULL, last_item_name = NULL, list_skus = NULL, list_offset = 0, conversation_history = '[]' WHERE buyer_jid = $1 AND vendor_id = $2`,
    [c, vendorId]
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
  const c = canonicalBuyerJid(buyerJid);
  await query(
    'UPDATE sessions SET conversation_history = $1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(trimmed), c, vendorId]
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
  const c = canonicalBuyerJid(buyerJid);
  await query(
    'UPDATE sessions SET chat_history = $1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(history), c, vendorId]
  );
}

/**
 * Append a single entry to the high-level conversation_history and bump message_count.
 * This is used by the conversation engine (gatekeeper/patterns) to understand behaviour,
 * separate from the lightweight chat_history used for quick intent heuristics.
 */
/** Find an active buyer session for this JID (any vendor). Used when vendor messages without store code to continue a purchase. */
async function getAnyActiveBuyerSession(buyerJid) {
  const c = canonicalBuyerJid(buyerJid);
  let res = await query(
    `SELECT s.*, s.vendor_id
     FROM sessions s
     WHERE s.buyer_jid = $1
       AND s.intent_state IN ('selecting_item', 'querying', 'negotiating', 'awaiting_payment', 'awaiting_delivery_confirm')
       AND s.updated_at > NOW() - INTERVAL '2 hours'
     ORDER BY s.updated_at DESC NULLS LAST
     LIMIT 1`,
    [c]
  );
  let row = res.rows[0] || null;
  if (!row && buyerJid && buyerJid !== c) {
    res = await query(
      `SELECT s.*, s.vendor_id
       FROM sessions s
       WHERE s.buyer_jid = $1
         AND s.intent_state IN ('selecting_item', 'querying', 'negotiating', 'awaiting_payment', 'awaiting_delivery_confirm')
         AND s.updated_at > NOW() - INTERVAL '2 hours'
       ORDER BY s.updated_at DESC NULLS LAST
       LIMIT 1`,
      [buyerJid]
    );
    row = res.rows[0] || null;
    if (row) {
      await query('UPDATE sessions SET buyer_jid = $1, updated_at = NOW() WHERE buyer_jid = $2 AND vendor_id = $3', [c, buyerJid, row.vendor_id]);
    }
  }
  return row;
}

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
  const c = canonicalBuyerJid(buyerJid);
  await query(
    'UPDATE sessions SET conversation_history = $1, message_count = COALESCE(message_count, 0) + 1 WHERE buyer_jid = $2 AND vendor_id = $3',
    [JSON.stringify(trimmed), c, vendorId]
  );
}

module.exports = {
  getSession,
  upsertSession,
  upsertSessionFields,
  clearSession,
  getChatHistory,
  appendMessage,
  getConversationHistory,
  appendConversationExchange,
  setSessionRole,
  appendHistory,
  getAnyActiveBuyerSession
};
