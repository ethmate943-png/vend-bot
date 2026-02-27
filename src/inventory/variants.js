/**
 * Conversational variant selection: buyer picks options (size, storage, color, etc.)
 * before we have a single variant SKU for payment.
 */
const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');
const { upsertSessionFields } = require('../sessions/manager');

const TYPE_LABELS = {
  storage: 'storage size',
  color: 'colour',
  size: 'size',
  ram: 'RAM',
  model: 'model'
};

/** Get parent product by vendor + sku. Returns null if not found or not variant product. */
async function getProduct(vendorId, sku) {
  const res = await query(
    `SELECT id, vendor_id, sku, name, description, category, has_variants, variant_types
     FROM inventory_products
     WHERE vendor_id = $1 AND (sku = $2 OR name ILIKE $2)
     LIMIT 1`,
    [vendorId, sku]
  );
  const row = res.rows && res.rows[0];
  if (!row || !row.has_variants) return null;
  const types = row.variant_types;
  row.variant_types = Array.isArray(types) ? types : (typeof types === 'string' ? JSON.parse(types || '[]') : []);
  return row;
}

/** Get product by sku only (vendor_id required). */
async function getProductBySku(vendorId, parentSku) {
  const res = await query(
    `SELECT id, vendor_id, sku, name, description, category, has_variants, variant_types
     FROM inventory_products
     WHERE vendor_id = $1 AND sku = $2
     LIMIT 1`,
    [vendorId, parentSku]
  );
  const row = res.rows && res.rows[0];
  if (!row || !row.has_variants) return null;
  const types = row.variant_types;
  row.variant_types = Array.isArray(types) ? types : (typeof types === 'string' ? JSON.parse(types || '[]') : []);
  return row;
}

/**
 * Get available options for the next variant type.
 * existing = { storage: "128GB" } etc.
 * Returns [{ value, label, price, price_diff }] for the given type.
 */
async function getVariantOptions(vendorId, parentSku, type, existing = {}) {
  let sql = `
    SELECT variant_sku, name, variant_label, price, attributes
    FROM inventory_variants
    WHERE vendor_id = $1 AND parent_sku = $2 AND quantity > 0
  `;
  const params = [vendorId, parentSku];
  let idx = 3;
  const attrs = existing && typeof existing === 'object' ? existing : {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === type || v == null || v === '') continue;
    const safeKey = String(k).replace(/[^a-z0-9_]/gi, '') || 'attr';
    sql += ` AND attributes->>'${safeKey}' = $${idx}`;
    params.push(String(v));
    idx += 1;
  }
  const res = await query(sql, params);
  const rows = res.rows || [];

  const seen = new Set();
  const options = [];
  const pricesByValue = {};
  for (const r of rows) {
    const att = r.attributes && typeof r.attributes === 'object' ? r.attributes : (typeof r.attributes === 'string' ? JSON.parse(r.attributes || '{}') : {});
    const val = att[type] || (r.variant_label && type === 'size' ? r.variant_label : null);
    if (val == null) continue;
    const key = String(val).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const price = Number(r.price) || 0;
    pricesByValue[key] = price;
    options.push({
      value: String(val).trim(),
      label: String(val).trim(),
      price,
      price_diff: null
    });
  }
  const prices = options.map(o => o.price).filter(Boolean);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  options.forEach(o => {
    if (o.price > minPrice) o.price_diff = Math.round((o.price - minPrice) / 100);
  });
  return options.sort((a, b) => String(a.label).localeCompare(b.label));
}

/**
 * Find the single variant row matching the full selection.
 * selections = { storage: "256GB", color: "White" }
 */
async function findVariantBySku(vendorId, parentSku, selections) {
  if (!selections || typeof selections !== 'object') return null;
  const conditions = [];
  const params = [vendorId, parentSku];
  let i = 3;
  for (const [k, v] of Object.entries(selections)) {
    if (v == null || v === '') continue;
    const safeKey = String(k).replace(/[^a-z0-9_]/gi, '') || 'attr';
    conditions.push(`attributes->>'${safeKey}' = $${i}`);
    params.push(String(v));
    i += 1;
  }
  if (conditions.length === 0) return null;
  const res = await query(
    `SELECT variant_sku, name, variant_label, price, quantity
     FROM inventory_variants
     WHERE vendor_id = $1 AND parent_sku = $2 AND quantity > 0
     AND ${conditions.join(' AND ')}
     LIMIT 1`,
    params
  );
  return res.rows && res.rows[0] ? res.rows[0] : null;
}

/** Show all in-stock variant combinations for a product. */
async function showAvailableVariants(sock, buyerJid, vendor, product) {
  const res = await query(
    `SELECT variant_label, price, quantity
     FROM inventory_variants
     WHERE vendor_id = $1 AND parent_sku = $2 AND quantity > 0
     ORDER BY price, variant_label
     LIMIT 15`,
    [vendor.id, product.sku]
  );
  const rows = res.rows || [];
  if (rows.length === 0) {
    await sendWithDelay(sock, buyerJid, `No stock left for *${product.name}* right now. Want to see something else?`);
    return;
  }
  const lines = rows.map(r =>
    `• ${r.variant_label} — ₦${(Number(r.price) / 100).toLocaleString()} (${r.quantity} left)`
  ).join('\n');
  await sendWithDelay(sock, buyerJid,
    `*${product.name}* — available:\n\n${lines}\n\n` +
    `Reply with the option you want (e.g. "256GB White") or say *cancel* to pick something else.`
  );
}

/**
 * Main variant selection flow. Asks for next option or proceeds to payment when complete.
 */
async function handleVariantSelection(sock, buyerJid, vendor, product, session) {
  const variantTypes = product.variant_types || [];
  const currentSelections = (session.variant_selections && typeof session.variant_selections === 'object')
    ? session.variant_selections
    : (typeof session.variant_selections === 'string' ? JSON.parse(session.variant_selections || '{}') : {});

  const nextType = variantTypes.find(t => !currentSelections[t]);

  if (!nextType) {
    const variant = await findVariantBySku(vendor.id, product.sku, currentSelections);

    if (!variant || (variant.quantity != null && variant.quantity <= 0)) {
      await sendWithDelay(sock, buyerJid,
        `That combination isn't available right now.\n\nHere's what we have:`
      );
      await showAvailableVariants(sock, buyerJid, vendor, product);
      await upsertSessionFields(buyerJid, vendor.id, {
        variant_selections: null,
        pending_variant_product_sku: null,
        pending_variant_type: null,
        intent_state: 'querying'
      });
      return;
    }

    await upsertSessionFields(buyerJid, vendor.id, {
      last_item_sku: variant.variant_sku,
      last_item_name: `${product.name} (${variant.variant_label})`,
      last_item_price: Math.round(Number(variant.price) / 100),
      last_item_price_quoted_at: new Date().toISOString(),
      intent_state: 'variant_ready',
      variant_selections: currentSelections,
      pending_variant_product_sku: product.sku
    });

    await sendWithDelay(sock, buyerJid,
      `*${product.name}* — ${variant.variant_label}\n` +
      `₦${(Number(variant.price) / 100).toLocaleString()}\n\n` +
      `Want to change anything, or continue with this? You can also *add to cart* to add more items before paying.`
    );
    return;
  }

  const options = await getVariantOptions(vendor.id, product.sku, nextType, currentSelections);

  if (!options.length) {
    await sendWithDelay(sock, buyerJid, `Sorry, no stock available for that combination.`);
    return;
  }

  const optionList = options.map((opt, i) =>
    `${i + 1}. ${opt.label}${opt.price_diff != null && opt.price_diff > 0 ? ` (+₦${opt.price_diff.toLocaleString()})` : opt.price ? ` — ₦${(opt.price / 100).toLocaleString()}` : ''}`
  ).join('\n');

  const typeLabel = TYPE_LABELS[nextType] || nextType;

  await sendWithDelay(sock, buyerJid,
    `Which ${typeLabel} do you want?\n\n${optionList}\n\n` +
    `Reply the number or type your choice.`
  );

  await upsertSessionFields(buyerJid, vendor.id, {
    intent_state: 'selecting_variant',
    pending_variant_product_sku: product.sku,
    pending_variant_type: nextType,
    variant_selections: currentSelections
  });
}

/**
 * Handle buyer's reply when in selecting_variant (number or text choice).
 */
async function handleVariantReply(sock, buyerJid, text, vendor, session) {
  const productSku = session.pending_variant_product_sku;
  if (!productSku) {
    await upsertSessionFields(buyerJid, vendor.id, { intent_state: 'querying', pending_variant_type: null });
    return;
  }

  const product = await getProductBySku(vendor.id, productSku);
  if (!product) {
    await sendWithDelay(sock, buyerJid, `Something went wrong — that product isn't available. Try asking again.`);
    await upsertSessionFields(buyerJid, vendor.id, { intent_state: 'querying', pending_variant_product_sku: null, pending_variant_type: null });
    return;
  }

  const options = await getVariantOptions(
    vendor.id,
    product.sku,
    session.pending_variant_type,
    session.variant_selections || {}
  );

  const trimmed = (text || '').trim();
  const num = parseInt(trimmed, 10);
  let selected = null;

  if (!isNaN(num) && num >= 1 && num <= options.length) {
    selected = options[num - 1];
  } else {
    const normText = trimmed.toLowerCase();
    selected = options.find(opt =>
      (opt.label && opt.label.toLowerCase().includes(normText)) ||
      (normText && normText.includes((opt.label || '').toLowerCase()))
    );
  }

  if (!selected) {
    const optionList = options.map((opt, i) => `${i + 1}. ${opt.label}`).join('\n');
    await sendWithDelay(sock, buyerJid, `I didn't catch that. Which one?\n\n${optionList}`);
    return;
  }

  const newSelections = {
    ...(session.variant_selections && typeof session.variant_selections === 'object' ? session.variant_selections : {}),
    [session.pending_variant_type]: selected.value
  };

  await upsertSessionFields(buyerJid, vendor.id, {
    variant_selections: newSelections,
    pending_variant_type: null
  });

  await handleVariantSelection(sock, buyerJid, vendor, product, {
    ...session,
    variant_selections: newSelections
  });
}

module.exports = {
  getProduct,
  getProductBySku,
  getVariantOptions,
  findVariantBySku,
  showAvailableVariants,
  handleVariantSelection,
  handleVariantReply
};
