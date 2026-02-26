/**
 * Reputation & trust: vendor trusted buyers, buyer trusted vendors,
 * relationship scores, mutual trust, hold reduction.
 */

const { query } = require('../db');

const RELATIONSHIP_HOLD_REDUCTION = {
  new: 1.0,
  familiar: 0.75,
  trusted: 0.5,
  vip: 0.25
};

async function isVendorTrustedBuyer(vendorId, buyerJid) {
  const res = await query(
    'SELECT id FROM vendor_trusted_buyers WHERE vendor_id = $1 AND buyer_jid = $2 LIMIT 1',
    [vendorId, buyerJid]
  );
  return (res.rows && res.rows.length > 0);
}

async function isBuyerTrustedVendor(buyerJid, vendorId) {
  const res = await query(
    'SELECT id FROM buyer_trusted_vendors WHERE buyer_jid = $1 AND vendor_id = $2 LIMIT 1',
    [buyerJid, vendorId]
  );
  return (res.rows && res.rows.length > 0);
}

async function isMutuallyTrusted(buyerJid, vendorId) {
  const [vRes, bRes] = await Promise.all([
    query('SELECT id FROM vendor_trusted_buyers WHERE vendor_id = $1 AND buyer_jid = $2 LIMIT 1', [vendorId, buyerJid]),
    query('SELECT id FROM buyer_trusted_vendors WHERE buyer_jid = $1 AND vendor_id = $2 LIMIT 1', [buyerJid, vendorId])
  ]);
  return (vRes.rows && vRes.rows.length > 0) && (bRes.rows && bRes.rows.length > 0);
}

async function addVendorTrustedBuyer(vendorId, buyerJid, buyerName = null, note = null) {
  await query(
    `INSERT INTO vendor_trusted_buyers (vendor_id, buyer_jid, buyer_name, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vendor_id, buyer_jid) DO UPDATE SET buyer_name = COALESCE(EXCLUDED.buyer_name, vendor_trusted_buyers.buyer_name), note = COALESCE(EXCLUDED.note, vendor_trusted_buyers.note)`,
    [vendorId, buyerJid, buyerName || null, note || null]
  );
}

async function addBuyerTrustedVendor(buyerJid, vendorId) {
  await query(
    `INSERT INTO buyer_trusted_vendors (buyer_jid, vendor_id) VALUES ($1, $2) ON CONFLICT (buyer_jid, vendor_id) DO NOTHING`,
    [buyerJid, vendorId]
  );
}

async function getTrustedBuyerDisplayName(vendorId, buyerJid) {
  const res = await query(
    'SELECT buyer_name FROM vendor_trusted_buyers WHERE vendor_id = $1 AND buyer_jid = $2 LIMIT 1',
    [vendorId, buyerJid]
  );
  return (res.rows && res.rows[0] && res.rows[0].buyer_name) || null;
}

async function getRelationshipTrustLevel(vendorId, buyerJid) {
  const res = await query(
    'SELECT trust_level FROM relationship_scores WHERE vendor_id = $1 AND buyer_jid = $2 LIMIT 1',
    [vendorId, buyerJid]
  );
  const level = (res.rows && res.rows[0] && res.rows[0].trust_level) || 'new';
  return RELATIONSHIP_HOLD_REDUCTION[level] !== undefined ? level : 'new';
}

async function updateRelationshipScore(vendorId, buyerJid, confirmed) {
  const completed = confirmed ? 1 : 0;
  const disputed = confirmed ? 0 : 1;
  const res = await query(
    `INSERT INTO relationship_scores (vendor_id, buyer_jid, completed_orders, disputed_orders)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vendor_id, buyer_jid) DO UPDATE SET
       completed_orders = relationship_scores.completed_orders + $3,
       disputed_orders = relationship_scores.disputed_orders + $4,
       updated_at = NOW()
     RETURNING completed_orders, disputed_orders`,
    [vendorId, buyerJid, completed, disputed]
  );
  const row = res.rows && res.rows[0];
  if (!row) return 'new';
  const total = row.completed_orders + row.disputed_orders;
  const successRate = total === 0 ? 0 : row.completed_orders / total;
  let trustLevel = 'new';
  if (total >= 10 && successRate >= 0.95) trustLevel = 'vip';
  else if (total >= 5 && successRate >= 0.9) trustLevel = 'trusted';
  else if (total >= 2 && successRate >= 0.8) trustLevel = 'familiar';
  await query(
    'UPDATE relationship_scores SET trust_level = $1 WHERE vendor_id = $2 AND buyer_jid = $3',
    [trustLevel, vendorId, buyerJid]
  );
  return trustLevel;
}

/** Returns multiplier for hold hours (1 = full hold, 0.25 = 75% reduction). */
function getHoldReductionMultiplier(trustLevel) {
  return RELATIONSHIP_HOLD_REDUCTION[trustLevel] ?? 1.0;
}

/** Count completed (delivery-confirmed or collected) orders between buyer and vendor. */
async function countCompletedOrdersWithVendor(buyerJid, vendorId) {
  const res = await query(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE buyer_jid = $1 AND vendor_id = $2
       AND ( (status = 'paid' AND delivery_confirmed = true) OR status = 'completed' OR payment_collected_at IS NOT NULL )`,
    [buyerJid, vendorId]
  );
  return parseInt((res.rows && res.rows[0] && res.rows[0].n) || '0', 10);
}

// ---------- Pending trust orders (vendor chooses payment method for trusted buyer) ----------

async function createPendingTrustOrder(vendorId, buyerJid, buyerPhone, itemName, itemSku, amountKobo) {
  const res = await query(
    `INSERT INTO pending_trust_orders (vendor_id, buyer_jid, buyer_phone, item_name, item_sku, amount_kobo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [vendorId, buyerJid, buyerPhone || null, itemName, itemSku, amountKobo]
  );
  return res.rows && res.rows[0];
}

async function getPendingTrustOrder(vendorId) {
  const res = await query(
    'SELECT * FROM pending_trust_orders WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 1',
    [vendorId]
  );
  return (res.rows && res.rows[0]) || null;
}

async function deletePendingTrustOrder(id) {
  await query('DELETE FROM pending_trust_orders WHERE id = $1', [id]);
}

/** Create a transaction for pay-on-delivery or credit (no payment link). */
async function createTrustOrderTransaction(vendorId, buyerJid, buyerPhone, itemName, itemSku, amountKobo, paymentMethod) {
  const res = await query(
    `INSERT INTO transactions (vendor_id, buyer_jid, buyer_phone, item_name, item_sku, amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [vendorId, buyerJid, buyerPhone || null, itemName, itemSku, amountKobo, paymentMethod]
  );
  return res.rows && res.rows[0];
}

/** Mark trust order as collected (vendor received cash). */
async function markTrustOrderCollected(vendorId, buyerPhoneOrJid, amountKobo) {
  const phone = String(buyerPhoneOrJid).replace(/\D/g, '');
  const findRes = await query(
    `SELECT id, buyer_jid, item_name, amount FROM transactions
     WHERE vendor_id = $1 AND status IN ('pay_on_delivery', 'credit')
       AND amount = $2
       AND (buyer_phone = $3 OR buyer_jid = $4 OR REPLACE(REPLACE(buyer_jid, '@s.whatsapp.net', ''), '@lid', '') = $3)
     ORDER BY created_at DESC LIMIT 1`,
    [vendorId, amountKobo, phone, buyerPhoneOrJid]
  );
  const row = findRes.rows && findRes.rows[0];
  if (!row) return null;
  await query(
    'UPDATE transactions SET status = $1, payment_collected_at = NOW() WHERE id = $2',
    ['completed', row.id]
  );
  return row;
}

module.exports = {
  isVendorTrustedBuyer,
  isBuyerTrustedVendor,
  isMutuallyTrusted,
  addVendorTrustedBuyer,
  addBuyerTrustedVendor,
  getTrustedBuyerDisplayName,
  getRelationshipTrustLevel,
  updateRelationshipScore,
  getHoldReductionMultiplier,
  countCompletedOrdersWithVendor,
  createPendingTrustOrder,
  getPendingTrustOrder,
  deletePendingTrustOrder,
  createTrustOrderTransaction,
  markTrustOrderCollected,
  RELATIONSHIP_HOLD_REDUCTION
};
