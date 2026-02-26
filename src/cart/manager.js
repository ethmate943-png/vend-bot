/**
 * Cart per buyer per vendor. Stored in cart_items (see migrations/cart-items.sql).
 * Item shape: { sku, name, price, quantity } (price in Naira for callers).
 */
const { query } = require('../db');

async function getCart(buyerJid, vendorId) {
  const res = await query(
    `SELECT sku, name, price_kobo, quantity FROM cart_items
     WHERE buyer_jid = $1 AND vendor_id = $2 AND quantity > 0
     ORDER BY added_at`,
    [buyerJid, vendorId]
  );
  return (res.rows || []).map((r) => ({
    sku: r.sku,
    name: r.name,
    price: r.price_kobo / 100,
    quantity: Number(r.quantity)
  }));
}

/** Add or bump quantity. item: { sku, name, price }, qty default 1. */
async function addToCart(buyerJid, vendorId, item, qty = 1) {
  const sku = (item.sku || item.name || '').trim();
  const name = (item.name || '').trim();
  const priceKobo = Math.max(0, Math.floor(Number(item.price) || 0) * 100);
  const quantity = Math.max(1, Math.floor(Number(qty) || 1));
  if (!sku || !name) return;
  await query(
    `INSERT INTO cart_items (buyer_jid, vendor_id, sku, name, price_kobo, quantity)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (buyer_jid, vendor_id, sku) DO UPDATE SET
       quantity = cart_items.quantity + EXCLUDED.quantity,
       name = EXCLUDED.name,
       price_kobo = EXCLUDED.price_kobo`,
    [buyerJid, vendorId, sku, name, priceKobo, quantity]
  );
}

/** Set quantity for one SKU. 0 = remove. */
async function updateCartItem(buyerJid, vendorId, sku, quantity) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty === 0) {
    await query('DELETE FROM cart_items WHERE buyer_jid = $1 AND vendor_id = $2 AND sku = $3', [buyerJid, vendorId, sku]);
    return;
  }
  await query(
    'UPDATE cart_items SET quantity = $4 WHERE buyer_jid = $1 AND vendor_id = $2 AND sku = $3',
    [buyerJid, vendorId, sku, qty]
  );
}

async function removeFromCart(buyerJid, vendorId, sku) {
  await updateCartItem(buyerJid, vendorId, sku, 0);
}

async function clearCart(buyerJid, vendorId) {
  await query('DELETE FROM cart_items WHERE buyer_jid = $1 AND vendor_id = $2', [buyerJid, vendorId]);
}

/** Total amount in kobo for checkout. */
async function getCartTotalKobo(buyerJid, vendorId) {
  const res = await query(
    'SELECT COALESCE(SUM(price_kobo * quantity), 0) AS total FROM cart_items WHERE buyer_jid = $1 AND vendor_id = $2',
    [buyerJid, vendorId]
  );
  return Number(res.rows[0]?.total || 0);
}

module.exports = {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  getCartTotalKobo
};
