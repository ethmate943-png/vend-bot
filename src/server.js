const express = require('express');
const crypto = require('crypto');
const qrcode = require('qrcode');
const PDFDocument = require('pdfkit');
const { handlePaymentSuccess } = require('./payments/webhook');
const { verifyTransaction } = require('./payments/mono');
const { getReceiptData } = require('./payments/receipt-data');
const { getState } = require('./whatsapp/qr-store');
const { query } = require('./db');
const { runSystemChecks } = require('./health/system-checks');
const { initOnboarding } = require('./api/onboarding');

const path = require('path');
const fs = require('fs');
const app = express();

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const publicDir = path.join(process.cwd(), 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.use('/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'vendbot',
  timestamp: new Date().toISOString()
}));

app.get('/health/systems', async (_, res) => {
  try {
    const checks = await runSystemChecks();
    const allGreen = checks.db && checks.groq && (checks.paystack !== false) && (checks.inventory === null || checks.inventory >= 0);
    res.json({
      status: allGreen ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }
});

// Landing-page → WhatsApp vendor onboarding token.
app.post('/api/onboarding/init', initOnboarding);

// QR page so phone users can scan WhatsApp without using the terminal
app.get('/qr', async (req, res) => {
  const secret = process.env.QR_SECRET;
  if (secret && req.query.key !== secret) {
    return res.status(401).send('<html><body><p>Invalid or missing key. Use ?key=YOUR_QR_SECRET</p></body></html>');
  }

  const { qr, connected } = getState();

  if (connected) {
    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
      .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:380px}
      h2{margin-top:0}</style></head>
      <body><div class="card"><h2>✅ WhatsApp connected</h2><p>You can close this page. The bot is running.</p></div></body></html>
    `);
  }

  if (qr) {
    try {
      const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:system-ui;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
        .card{background:#128C7E;padding:1.5rem;border-radius:1rem;max-width:320px}
        h2{margin-top:0;font-size:1.25rem}p{font-size:0.95rem}
        img{display:block;margin:1rem auto;border-radius:8px}</style></head>
        <body><div class="card">
        <h2>Link your WhatsApp</h2>
        <p>Open WhatsApp → Settings → Linked devices → Link a device</p>
        <p>Then scan this QR code:</p>
        <img src="${dataUrl}" alt="QR code" width="280" height="280"/>
        <p><small>Page refreshes when a new QR is generated.</small></p>
        </div></body></html>
      `);
    } catch (err) {
      console.error('[QR] toDataURL error:', err.message);
      return res.status(500).send('<html><body><p>Error generating QR. Try again.</p></body></html>');
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="3">
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
    .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:380px}</style></head>
    <body><div class="card"><h2>⏳ Connecting…</h2><p>Refresh in a moment to see the QR code.</p></div></body></html>
  `);
});

// Normalize a raw code string into a store_code (A–Z, 0–9, hyphen, max 12 chars).
function normalizeStoreCode(raw) {
  if (!raw) return 'STORE';
  const cleaned = String(raw)
    .trim()
    .replace(/[^A-Za-z0-9-]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return cleaned || 'STORE';
}

// Build candidate store codes from the business name:
// - 1st word
// - 1st + 2nd word joined with hyphen
// - 1st + 2nd + 3rd word joined with hyphen
function buildStoreCodeCandidates(businessName) {
  if (!businessName || !String(businessName).trim()) return ['STORE'];
  const words = String(businessName)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [];
  if (words[0]) candidates.push(normalizeStoreCode(words[0]));
  if (words.length >= 2) candidates.push(normalizeStoreCode(`${words[0]}-${words[1]}`));
  if (words.length >= 3) candidates.push(
    normalizeStoreCode(`${words[0]}-${words[1]}-${words[2]}`)
  );
  const uniq = [];
  for (const c of candidates) {
    if (!uniq.includes(c)) uniq.push(c);
  }
  return uniq.length ? uniq : ['STORE'];
}

async function findAvailableStoreCode(candidates, excludeVendorId) {
  let list = candidates && candidates.length ? candidates : ['STORE'];
  // Try each candidate as-is
  for (const cand of list) {
    const args = [cand];
    let sql =
      'SELECT id FROM vendors WHERE UPPER(TRIM(store_code)) = $1';
    if (excludeVendorId) {
      sql += ' AND id != $2';
      args.push(excludeVendorId);
    }
    sql += ' LIMIT 1';
    const clash = await query(sql, args);
    if (!(clash.rows && clash.rows.length)) {
      return cand;
    }
  }
  // If all taken, append numeric suffix to the last candidate until we find a free one
  const base = list[list.length - 1] || 'STORE';
  let suffix = 1;
  // Hard cap to avoid pathological loops
  while (suffix < 1000) {
    const cand = normalizeStoreCode(`${base}-${suffix}`);
    const args = [cand];
    let sql =
      'SELECT id FROM vendors WHERE UPPER(TRIM(store_code)) = $1';
    if (excludeVendorId) {
      sql += ' AND id != $2';
      args.push(excludeVendorId);
    }
    sql += ' LIMIT 1';
    const clash = await query(sql, args);
    if (!(clash.rows && clash.rows.length)) {
      return cand;
    }
    suffix += 1;
  }
  return normalizeStoreCode(base);
}

// Check if a number is already registered; return vendor state and links so they can continue setup.
function onboardingStepLabel(step) {
  if (!step || step === 'complete') return null;
  const labels = {
    start: 'Business name & store code',
    business_name: 'Business name',
    store_code: 'Store code',
    category: 'Category (what you sell)',
    category_other: 'Category description',
    location: 'Location',
    delivery_coverage: 'Delivery options',
    turnaround: 'Turnaround time',
    tone: 'Tone (professional / friendly / pidgin)',
    custom_note: 'Short note for buyers'
  };
  return labels[step] || step;
}

app.post('/api/landing/check', async (req, res) => {
  try {
    const { whatsapp_number } = req.body || {};
    const raw = String(whatsapp_number || '').replace(/\D/g, '');
    const phone = raw.startsWith('234') ? raw : raw ? `234${raw}` : '';
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Valid WhatsApp number required' });
    }
    const existing = await query(
      'SELECT business_name, store_code, onboarding_step FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
      [phone]
    );
    const row = existing.rows && existing.rows[0];
    if (!row) {
      return res.json({ registered: false });
    }
    const bot = (process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
    const waBase = bot || phone;
    const code = (row.store_code || '').trim();
    const setupLink = waBase && code
      ? `https://wa.me/${waBase}?text=${encodeURIComponent('VENDOR-SETUP ' + code)}`
      : null;
    const whatsappLink = waBase && code
      ? `https://wa.me/${waBase}?text=${encodeURIComponent(code)}`
      : null;
    const missingLabel = onboardingStepLabel(row.onboarding_step);
    const setupComplete = !row.onboarding_step || row.onboarding_step === 'complete';
    return res.json({
      registered: true,
      setup_complete: setupComplete,
      business_name: row.business_name || null,
      store_code: code || null,
      onboarding_step: row.onboarding_step || null,
      missing: missingLabel ? [missingLabel] : [],
      setup_link: setupLink,
      whatsapp_link: whatsappLink
    });
  } catch (err) {
    console.error('[SERVER] /api/landing/check error:', err.message);
    res.status(500).json({ error: 'Check failed. Try again.' });
  }
});

// Landing registration: create/update vendor by number + business name, return store code and links.
app.post('/api/landing/register', async (req, res) => {
  try {
    const { whatsapp_number, business_name } = req.body || {};
    const raw = String(whatsapp_number || '').replace(/\D/g, '');
    const phone = raw.startsWith('234') ? raw : raw ? `234${raw}` : '';
    const name = String(business_name || '').trim().slice(0, 200);
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Valid WhatsApp number required' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Business / store name required' });
    }
    const candidates = buildStoreCodeCandidates(name);
    // Prefer the most specific candidate (e.g. FIRST-SECOND-THIRD)
    const desiredCode = candidates[candidates.length - 1] || candidates[0] || 'STORE';
    let storeCode = desiredCode;
    const bot = (process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
    const waBase = bot || phone;
    // Check for store_code collision with a different vendor
    const clashRes = await query(
      'SELECT id FROM vendors WHERE UPPER(TRIM(store_code)) = $1 LIMIT 1',
      [storeCode]
    );

    const existing = await query(
      'SELECT id, store_code FROM vendors WHERE whatsapp_number = $1 LIMIT 1',
      [phone]
    );
    const row = existing.rows && existing.rows[0];

    if (clashRes.rows && clashRes.rows.length) {
      const clashId = clashRes.rows[0].id;
      const sameVendor = row && row.id === clashId;
      if (!sameVendor) {
        return res.status(409).json({
          error: 'That store code is already taken. Try a slightly different business name.'
        });
      }
    }

    // Set onboarding_step = 'category' so the bot skips business_name and store_code (already set here)
    if (row) {
      await query(
        'UPDATE vendors SET business_name = $1, store_code = $2, onboarding_step = $3 WHERE id = $4',
        [name, storeCode, 'category', row.id]
      );
    } else {
      await query(
        `INSERT INTO vendors (whatsapp_number, business_name, store_code, status, onboarding_step) VALUES ($1, $2, $3, 'probation', 'category')`,
        [phone, name, storeCode]
      );
    }
    const text = encodeURIComponent(storeCode);
    res.json({
      business_name: name,
      store_code: storeCode,
      whatsapp_link: `https://wa.me/${waBase}?text=${text}`,
      setup_link: `https://wa.me/${waBase}?text=${encodeURIComponent('VENDOR-SETUP ' + storeCode)}`
    });
  } catch (err) {
    console.error('[SERVER] /api/landing/register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
});

// MoovMart landing page (root and /landing).
app.get(['/', '/landing'], (req, res) => {
  const landingPath = path.join(process.cwd(), 'public', 'landing.html');
  if (fs.existsSync(landingPath)) return res.sendFile(landingPath);
  res.redirect(302, '/health');
});

// Privacy policy page.
app.get('/privacy', (req, res) => {
  const privacyPath = path.join(process.cwd(), 'public', 'privacy.html');
  if (fs.existsSync(privacyPath)) return res.sendFile(privacyPath);
  res.status(404).send('Privacy policy not found');
});

// Simple front-facing page listing all seeded vendors + their WhatsApp links.
app.get('/vendors/links', async (req, res) => {
  try {
    const bot = (process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
    const { rows } = await query(
      `SELECT business_name, store_code, whatsapp_number
       FROM vendors
       WHERE store_code IS NOT NULL AND store_code != ''
       ORDER BY business_name NULLS LAST`
    );
    const links = rows.map(v => {
      const base = bot || (v.whatsapp_number || '').replace(/\D/g, '');
      const code = encodeURIComponent(v.store_code || '');
      return {
        name: v.business_name || v.store_code,
        store_code: v.store_code,
        url: `https://wa.me/${base}?text=${code}`
      };
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>VendBot Demo Stores</title>
        <style>
          body{font-family:system-ui;background:#111827;color:#e5e7eb;margin:0;padding:2rem;}
          h1{font-size:1.5rem;margin-bottom:1rem;}
          .vendor{background:#1f2937;margin-bottom:.75rem;padding:.75rem 1rem;border-radius:.5rem;display:flex;justify-content:space-between;align-items:center;}
          .name{font-weight:600;}
          a{color:#10b981;text-decoration:none;font-size:.9rem;}
          a:hover{text-decoration:underline;}
          code{background:#111827;color:#9ca3af;padding:2px 4px;border-radius:4px;}
        </style>
      </head>
      <body>
        <h1>VendBot demo vendors</h1>
        ${links.length === 0 ? '<p>No vendors with store codes found.</p>' : links.map(v => `
          <div class="vendor">
            <div>
              <div class="name">${v.name}</div>
              <div>Store code: <code>${v.store_code}</code></div>
            </div>
            <div><a href="${v.url}" target="_blank" rel="noopener noreferrer">Open WhatsApp link</a></div>
          </div>
        `).join('')}
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[SERVER] /vendors/links error:', err.message);
    res.status(500).send('Error loading vendor links.');
  }
});

// Vendor overview: all generated store links + onboarding status.
app.get('/vendors/overview', async (req, res) => {
  try {
    const bot = (process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
    const { rows } = await query(
      `SELECT v.id,
              v.business_name,
              v.store_code,
              v.whatsapp_number,
              v.category,
              v.location,
              v.delivery_coverage,
              v.turnaround,
              v.onboarding_step,
              v.onboarding_complete,
              v.status,
              v.total_transactions,
              v.created_at,
              inv.product_count,
              inv.total_stock,
              inv.min_price,
              inv.max_price
       FROM vendors v
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS product_count,
                COALESCE(SUM(quantity), 0) AS total_stock,
                MIN(price)            AS min_price,
                MAX(price)            AS max_price
         FROM inventory_items i
         WHERE i.vendor_id = v.id
       ) inv ON true
       WHERE v.store_code IS NOT NULL AND v.store_code != ''
       ORDER BY v.created_at DESC NULLS LAST`
    );

    const vendors = rows.map(v => {
      const base = bot || (v.whatsapp_number || '').replace(/\D/g, '');
      const code = encodeURIComponent(v.store_code || '');
      const buyerUrl = `https://wa.me/${base}?text=${code}`;
      const setupUrl = `https://wa.me/${base}?text=${encodeURIComponent('VENDOR-SETUP ' + (v.store_code || ''))}`;
      let onboardingLabel = 'Not started';
      if (v.onboarding_complete) {
        onboardingLabel = 'Complete';
      } else if (v.onboarding_step) {
        onboardingLabel = `In progress (${v.onboarding_step})`;
      }
      return {
        name: v.business_name || v.store_code,
        store_code: v.store_code,
        status: v.status || 'probation',
        category: v.category || 'unspecified',
        location: v.location || 'unspecified',
        coverage: v.delivery_coverage || 'unspecified',
        turnaround: v.turnaround || null,
        total_transactions: v.total_transactions || 0,
        product_count: v.product_count || 0,
        total_stock: v.total_stock || 0,
        min_price: v.min_price || 0,
        max_price: v.max_price || 0,
        onboarding: onboardingLabel,
        created_at: v.created_at,
        buyerUrl,
        setupUrl
      };
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>MoovMart Vendor Overview</title>
        <style>
          body{font-family:system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;background:#020617;color:#e5e7eb;margin:0;padding:2rem;}
          h1{font-size:1.6rem;margin:0 0 0.5rem;font-weight:600;}
          p.subtitle{margin:0 0 1.5rem;font-size:0.9rem;color:#9ca3af;}
          .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.25rem;}
          .card{background:radial-gradient(circle at top left,rgba(37,211,102,0.16),transparent 55%),linear-gradient(135deg,rgba(15,23,42,1),rgba(15,23,42,0.96));border:1px solid rgba(148,163,184,0.35);border-radius:0.9rem;padding:1.1rem 1.2rem;display:flex;flex-direction:column;gap:0.35rem;position:relative;overflow:hidden;}
          .card::before{content:'';position:absolute;inset:-40%;background-image:radial-gradient(circle at 1px 1px,rgba(148,163,184,0.16) 1px,transparent 0);background-size:18px 18px;opacity:0.25;mix-blend-mode:soft-light;pointer-events:none;}
          .card-inner{position:relative;z-index:1;display:flex;flex-direction:column;gap:0.4rem;}
          .name{font-weight:600;font-size:0.95rem;color:#f9fafb;}
          .code{font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;font-size:0.8rem;color:#a5b4fc;}
          .meta-row{display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.25rem;font-size:0.72rem;color:#9ca3af;}
          .meta-pill{padding:0.15rem 0.55rem;border-radius:999px;background:rgba(15,23,42,0.9);border:1px solid rgba(148,163,184,0.35);}
          .badge-row{display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.35rem;}
          .badge{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.12em;border-radius:999px;padding:0.18rem 0.6rem;border:1px solid rgba(148,163,184,0.4);color:#9ca3af;background:rgba(15,23,42,0.9);}
          .badge.status-active{border-color:rgba(34,197,94,0.5);color:#bbf7d0;}
          .badge.status-banned{border-color:rgba(239,68,68,0.6);color:#fecaca;}
          .badge.onboarding-complete{border-color:rgba(59,130,246,0.6);color:#bfdbfe;}
          .links{display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.55rem;}
          .links a{font-size:0.78rem;text-decoration:none;border-radius:999px;padding:0.25rem 0.7rem;border:1px solid rgba(148,163,184,0.4);color:#e5e7eb;background:rgba(15,23,42,0.9);}
          .links a:hover{border-color:rgba(37,211,102,0.7);color:#bbf7d0;}
          .footer-meta{margin-top:0.35rem;font-size:0.7rem;color:#64748b;display:flex;justify-content:space-between;gap:0.5rem;align-items:flex-end;}
          .footer-meta span{white-space:nowrap;}
          @media (max-width:600px){body{padding:1.25rem;}}
        </style>
      </head>
      <body>
        <h1>MoovMart vendor overview</h1>
        <p class="subtitle">
          All vendors with generated store codes. Use this to check onboarding status and avoid redundant links.
        </p>
        ${vendors.length === 0 ? '<p>No vendors with store codes found yet.</p>' : `
          <div class="grid">
            ${vendors.map(v => `
              <div class="card">
                <div class="card-inner">
                  <div class="name">${v.name}</div>
                  <div class="code">${v.store_code}</div>
                  <div class="meta-row">
                    <span class="meta-pill">Category: ${v.category}</span>
                    <span class="meta-pill">Location: ${v.location}</span>
                    <span class="meta-pill">Coverage: ${v.coverage}</span>
                    ${v.turnaround ? `<span class="meta-pill">Turnaround: ${v.turnaround}</span>` : ''}
                  </div>
                  <div class="badge-row">
                    <span class="badge ${v.status === 'active' ? 'status-active' : (v.status === 'banned' ? 'status-banned' : '')}">Status: ${v.status}</span>
                    <span class="badge ${v.onboarding === 'Complete' ? 'onboarding-complete' : ''}">Onboarding: ${v.onboarding}</span>
                  </div>
                  <div class="badge-row">
                    <span class="badge">Products: ${v.product_count}</span>
                    <span class="badge">Total stock: ${v.total_stock}</span>
                    <span class="badge">Txns: ${v.total_transactions}</span>
                    ${v.min_price && v.max_price ? `<span class="badge">Price range: ₦${(v.min_price).toLocaleString()} – ₦${(v.max_price).toLocaleString()}</span>` : ''}
                  </div>
                  <div class="links">
                    <a href="${v.buyerUrl}" target="_blank" rel="noopener noreferrer">Buyer link</a>
                    <a href="${v.setupUrl}" target="_blank" rel="noopener noreferrer">Vendor setup link</a>
                  </div>
                  <div class="footer-meta">
                    <span>Created: ${v.created_at ? new Date(v.created_at).toLocaleString() : 'n/a'}</span>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[SERVER] /vendors/overview error:', err.message);
    res.status(500).send('Error loading vendor overview.');
  }
});

// Proxy payment link: /pay/:token binds the link to one transaction (buyer/vendor/order).
// The real Paystack URL is never sent to the buyer, reducing interception/forwarding risk.
const PAY_LINK_EXPIRY_MINUTES = 30;
app.get('/pay/:token', async (req, res) => {
  const token = (req.params.token || '').trim();
  if (!token) return res.status(404).send(PAY_HTML('Invalid payment link.', 404));

  const txnRes = await query(
    `SELECT id, mono_link, status, created_at, item_name, amount FROM transactions WHERE pay_token = $1 LIMIT 1`,
    [token]
  );
  const txn = txnRes.rows && txnRes.rows[0];
  if (!txn) {
    return res.status(404).send(PAY_HTML('Invalid or expired payment link. Please request a new link from the seller.', 404));
  }
  if (txn.status === 'paid') {
    return res.send(PAY_HTML('Payment already completed. Your receipt was sent to your WhatsApp.', 200));
  }
  if (txn.status === 'expired') {
    return res.status(410).send(PAY_HTML('This payment link has expired. Please request a new link from the seller.', 410));
  }
  const createdAt = new Date(txn.created_at).getTime();
  if (Date.now() - createdAt > PAY_LINK_EXPIRY_MINUTES * 60 * 1000) {
    return res.status(410).send(PAY_HTML('This payment link has expired. Please request a new link from the seller.', 410));
  }
  if (!txn.mono_link) {
    return res.status(500).send(PAY_HTML('Payment link is not available. Please try again later.', 500));
  }
  res.redirect(302, txn.mono_link);
});

function PAY_HTML(message, status) {
  const isError = status >= 400;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isError ? 'Payment link' : 'Payment'}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
.card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:360px}
h2{margin-top:0;font-size:1.1rem}</style></head>
<body><div class="card"><h2>${isError ? '⚠️' : '✅'} ${message}</h2></div></body></html>`;
}

// Payment callback: Paystack redirects the buyer's browser here after they pay.
// Handle both /payment/callback and /payment/callback/ (trailing slash) so redirect always works.
async function paymentCallback(req, res) {
  const ref = req.query.reference || req.query.trxref;
  const { vendor } = req.query;
  console.log('[CALLBACK] GET /payment/callback', { reference: ref || 'none', vendor: vendor ? 'yes' : 'no', queryKeys: Object.keys(req.query) });

  try {
    if (ref) {
      const txn = await verifyTransaction(ref);
      if (txn.status === 'success') {
        console.log(`[CALLBACK] Payment verified for ref ${ref}, sending receipt...`);
        const receiptNumber = txn.receipt_number || txn.receipt || null;
        await handlePaymentSuccess({ reference: ref, receiptNumber });
        console.log('[CALLBACK] Receipt sent.');
      } else {
        console.warn('[CALLBACK] Verify status not success:', txn.status);
      }
    } else {
      console.warn('[CALLBACK] No reference or trxref in query');
    }
  } catch (err) {
    console.error('[CALLBACK] Error:', err.message);
  }

  if (vendor) {
    const waUrl = `https://wa.me/${String(vendor).replace(/\D/g, '')}`;
    console.log('[CALLBACK] Redirecting to WhatsApp:', waUrl);
    return res.redirect(302, waUrl);
  }

  res.send(`
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#075E54;color:#fff;text-align:center}
    .card{background:#128C7E;padding:2rem;border-radius:1rem;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.3)}
    h2{margin-top:0}a{color:#25D366;font-weight:bold;font-size:1.1rem}</style></head>
    <body><div class="card">
    <h2>✅ Payment Received!</h2>
    <p>Your receipt has been sent to your WhatsApp chat.</p>
    <p>Go back to WhatsApp to see your confirmation.</p>
    </div></body></html>
  `);
}

app.get('/payment/callback', paymentCallback);
// With trailing slash: redirect to canonical URL so route always matches
app.get('/payment/callback/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
});

// Wrong callback URL (if APP_URL was set with /webhook/paystack): redirect to correct path
app.get('/webhook/paystack/payment/callback', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
});
app.get('/webhook/paystack/payment/callback/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/payment/callback' + qs);
});

// Webhook: Paystack calls this when a payment succeeds (server-to-server).
// This is what sends the receipt and notifies the vendor. The callback URL only redirects the buyer.
app.post('/webhook/paystack', async (req, res) => {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🔔 PAYSTACK WEBHOOK HIT!', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('[WEBHOOK] ❌ Invalid Paystack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);
  console.log('[WEBHOOK] ✅ Signature verified');
  console.log('[WEBHOOK] 📦 Paystack event:', event.event);
  if (event.data?.reference) {
    console.log('[WEBHOOK] 🔗 Reference:', event.data.reference);
  }

  if (event.event === 'charge.success') {
    console.log('[WEBHOOK] 💰 Processing successful payment...');
    try {
      const txnData = await verifyTransaction(event.data.reference);
      if (txnData.status === 'success') {
        console.log('\n📋 ─── RECEIPT DETAILS ───');
        console.log(`🧾 Receipt Number: ${txnData.receipt_number || 'N/A'}`);
        console.log(`🔗 Reference: ${txnData.reference}`);
        console.log(`💰 Amount: ₦${(txnData.amount / 100).toLocaleString()}`);
        console.log(`📧 Customer: ${txnData.customer?.email || 'N/A'}`);
        console.log(`📅 Paid At: ${txnData.paid_at || 'N/A'}`);
        console.log(`💳 Channel: ${txnData.channel || 'N/A'}`);
        console.log(`🏦 Bank: ${txnData.authorization?.bank || txnData.authorization?.card_type || 'N/A'}`);
        console.log('─────────────────────────────\n');
        
        console.log('[WEBHOOK] ✅ Payment verified, sending notifications...');
        await handlePaymentSuccess({
          reference: event.data.reference,
          receiptNumber: txnData.receipt_number
        });
        console.log('[WEBHOOK] ✅ Payment processing complete!\n');
      } else {
        console.warn('[WEBHOOK] ⚠️ Paystack verify status:', txnData.status);
      }
    } catch (err) {
      console.error('[WEBHOOK] ❌ Verify failed, processing anyway:', err.message);
      await handlePaymentSuccess({ reference: event.data.reference });
    }
  } else {
    console.log(`[WEBHOOK] ℹ️ Event type: ${event.event} (not processing)\n`);
  }

  res.status(200).json({ received: true });
});

// Visual receipt: view in browser and download as PDF
function receiptBaseUrl() {
  const u = process.env.CALLBACK_BASE_URL || process.env.APP_URL || '';
  try { return new URL(u).origin; } catch (_) { return u || ''; }
}

app.get('/receipt/:reference', async (req, res) => {
  const reference = req.params.reference.replace(/\.pdf$/i, '');
  const data = await getReceiptData(reference);
  if (!data) {
    return res.status(404).send('<html><body><p>Receipt not found or payment not completed.</p></body></html>');
  }

  const base = receiptBaseUrl();
  const receiptUrl = `${base}/receipt/${encodeURIComponent(data.reference)}`;
  const pdfUrl = `${receiptUrl}/pdf`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Order Confirmed - ${escapeHtml(data.reference)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #111827;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 2rem 1.25rem;
    }
    .page {
      width: 100%;
      max-width: 900px;
      background: #ffffff;
      display: flex;
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 22px 60px rgba(15,23,42,0.35);
    }
    .hero {
      flex: 0 0 34%;
      background: radial-gradient(circle at top left, #111827 0, #020617 60%, #000000 100%);
      position: relative;
      color: #f9fafb;
      padding: 1.75rem 1.5rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .hero-top-label {
      font-size: 0.7rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.8;
    }
    .hero-product {
      margin-top: 4rem;
      font-size: 1.35rem;
      font-weight: 600;
    }
    .hero-store {
      margin-top: 0.35rem;
      font-size: 0.8rem;
      opacity: 0.85;
    }
    .hero-ref {
      margin-top: 3rem;
      font-size: 0.72rem;
      opacity: 0.7;
    }
    .hero-ref span {
      display: block;
      margin-top: 0.15rem;
      font-weight: 500;
      letter-spacing: 0.04em;
    }
    .content {
      flex: 1;
      padding: 1.75rem 2rem 1.75rem;
    }
    .content-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1.6rem;
      font-size: 0.8rem;
      color: #6b7280;
    }
    .content-header-right {
      text-align: right;
    }
    .order-title {
      font-size: 1.8rem;
      font-weight: 700;
      margin: 0 0 0.4rem;
      color: #111827;
    }
    .order-subtitle {
      font-size: 0.9rem;
      color: #4b5563;
      margin: 0;
    }
    .section {
      margin-top: 1.6rem;
      font-size: 0.86rem;
      color: #111827;
    }
    .section h3 {
      margin: 0 0 0.6rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #9ca3af;
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding: 0.6rem 0 0.2rem;
      border-bottom: 1px solid #e5e7eb;
    }
    .item-main {
      font-weight: 600;
    }
    .item-sub {
      font-size: 0.8rem;
      color: #6b7280;
    }
    .amounts {
      display: grid;
      grid-template-columns: 1fr auto;
      row-gap: 0.35rem;
      column-gap: 1.5rem;
      margin-top: 0.6rem;
      font-size: 0.8rem;
      color: #4b5563;
    }
    .amounts div:last-child {
      font-weight: 600;
      color: #111827;
    }
    .amounts .total-label {
      margin-top: 0.25rem;
      font-weight: 600;
      color: #111827;
    }
    .amounts .total-value {
      margin-top: 0.25rem;
      font-weight: 700;
      color: #111827;
    }
    .amount-words {
      margin-top: 0.5rem;
      font-size: 0.78rem;
      color: #6b7280;
      font-style: italic;
    }
    .footer {
      margin-top: 1.8rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      row-gap: 0.75rem;
      font-size: 0.78rem;
      color: #6b7280;
    }
    .actions {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 0.55rem 1.2rem;
      border-radius: 999px;
      border: none;
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.18s ease, transform 0.1s ease, color 0.18s ease;
    }
    .btn-primary {
      background: #111827;
      color: #f9fafb;
    }
    .btn-primary:hover {
      background: #020617;
      transform: translateY(-1px);
    }
    .btn-ghost {
      background: transparent;
      color: #111827;
    }
    .btn-ghost:hover {
      background: #f3f4f6;
    }
    @media (max-width: 768px) {
      body { padding: 1.5rem 0.75rem; }
      .page { flex-direction: column; max-width: 100%; }
      .hero { flex-basis: auto; min-height: 160px; }
      .hero-product { margin-top: 2.5rem; }
    }
    @media print {
      body { background: #ffffff; padding: 0; align-items: flex-start; }
      .page { box-shadow: none; border-radius: 0; max-width: 100%; }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div>
        <div class="hero-top-label">HEY!</div>
        <div class="hero-product">${escapeHtml(data.itemName)}</div>
        <div class="hero-store">${escapeHtml(data.businessName)}</div>
      </div>
      <div class="hero-ref">
        Order reference
        <span>${escapeHtml(data.reference)}</span>
      </div>
    </div>
    <div class="content">
      <div class="content-header">
        <div></div>
        <div class="content-header-right">
          <div>${escapeHtml(data.date)}</div>
          <div>Order #${escapeHtml(data.reference)}</div>
        </div>
      </div>
      <h1 class="order-title">Order confirmed!</h1>
      <p class="order-subtitle">
        Your payment has been received. <strong>${escapeHtml(data.businessName)}</strong> will contact you to arrange delivery.
      </p>

      <div class="section">
        <h3>Item</h3>
        <div class="item-row">
          <div>
            <div class="item-main">${escapeHtml(data.itemName)}</div>
          </div>
          <div>₦${Number(data.amount / 100).toLocaleString('en-NG')}</div>
        </div>

        <div class="amounts">
          <div>Subtotal</div><div>${escapeHtml(data.amountFormatted)}</div>
          <div class="total-label">Total</div><div class="total-value">${escapeHtml(data.amountFormatted)}</div>
        </div>
        <div class="amount-words">${escapeHtml(data.amountInWords)}</div>
      </div>

      <div class="section">
        <h3>Payment</h3>
        <div>Paid to: <strong>${escapeHtml(data.businessName)}</strong></div>
        <div style="margin-top:0.25rem;">Payment method: Online payment (Paystack)</div>
      </div>

      <div class="footer">
        <div>
          This receipt is for your records. Keep your order reference safe.
        </div>
        <div class="actions">
          <a href="${pdfUrl}" class="btn btn-primary" download>Download PDF receipt</a>
          <a href="javascript:window.print()" class="btn btn-ghost">Print</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

app.get('/receipt/:reference/pdf', async (req, res) => {
  const reference = req.params.reference;
  const data = await getReceiptData(reference);
  if (!data) {
    return res.status(404).send('Receipt not found');
  }

  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${data.reference}.pdf"`);
  doc.pipe(res);

  // Header block
  doc.roundedRect(36, 40, doc.page.width - 72, 80, 16)
    .fillAndStroke('#111827', '#111827');
  doc.fillColor('#22c55e').fontSize(22).text('✓', 0, 58, { align: 'center' });
  doc.fillColor('#e5e7eb').fontSize(12).text('Payment Success', 0, 84, { align: 'center' });
  doc.fontSize(9).fillColor('#9ca3af').text(data.businessName, 0, 100, { align: 'center' });

  doc.moveTo(36, 132).lineTo(doc.page.width - 36, 132).dash(3, { space: 3 }).strokeColor('#e5e7eb').stroke().undash();

  doc.moveDown(2);

  // Body
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
  doc.text('Reference number', 36, 140);
  doc.font('Helvetica-Bold').fillColor('#111827').text(data.reference, 0, 140, { align: 'right', width: doc.page.width - 72 });

  doc.font('Helvetica').fillColor('#6b7280').text('Date & time', 36, 158);
  doc.font('Helvetica-Bold').fillColor('#111827').text(data.date, 0, 158, { align: 'right', width: doc.page.width - 72 });

  doc.font('Helvetica').fillColor('#6b7280').text('Item', 36, 176);
  doc.font('Helvetica-Bold').fillColor('#111827').text(data.itemName, 0, 176, { align: 'right', width: doc.page.width - 72 });

  doc.moveTo(36, 200).lineTo(doc.page.width - 36, 200).strokeColor('#e5e7eb').stroke();

  doc.font('Helvetica').fillColor('#6b7280').text('Total', 36, 210);
  doc.font('Helvetica-Bold').fillColor('#16a34a').fontSize(12).text(data.amountFormatted, 0, 208, { align: 'right', width: doc.page.width - 72 });

  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#4b5563').text(data.amountInWords, 36, 230, { width: doc.page.width - 72 });

  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text('Paid to: ' + data.businessName, 36, 248);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text('Payment method: Online payment (Paystack)', 36, 260);

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#4b5563').text(
    'This confirms your payment. ' + data.businessName + ' will contact you to arrange delivery.',
    36,
    268,
    { width: doc.page.width - 72, align: 'center' }
  );

  doc.end();
});

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Dev-only: simulate an incoming message so you can test without another person.
// Set ENABLE_DEV_SIMULATE=1 and POST { "from": "2348012345678", "text": "AMAKA" }.
// The bot will process it and send the real reply to that WhatsApp number.
if (process.env.ENABLE_DEV_SIMULATE === '1' || process.env.ENABLE_DEV_SIMULATE === 'true') {
  // Trigger abandonment agent once (same as cron). For testing: ensure you have a pending txn 35min–6h old, session awaiting_payment, buyer inactive 45+ min.
  app.post('/dev/run-abandonment', async (req, res) => {
    try {
      const { runAbandonmentAgent } = require('./agents/abandonment');
      await runAbandonmentAgent();
      res.json({ ok: true, message: 'Abandonment agent ran. Check logs and WhatsApp.' });
    } catch (err) {
      console.error('[DEV] run-abandonment', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger content agent once (Status + Instagram copy for all active/probation vendors).
  app.post('/dev/run-content', async (req, res) => {
    try {
      const { runContentAgent } = require('./agents/content');
      await runContentAgent();
      res.json({ ok: true, message: 'Content agent ran. Check logs and WhatsApp.' });
    } catch (err) {
      console.error('[DEV] run-content', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger pricing agent once (weekly report for all active/probation vendors).
  app.post('/dev/run-pricing', async (req, res) => {
    try {
      const { runPricingAgent } = require('./agents/pricing');
      await runPricingAgent();
      res.json({ ok: true, message: 'Pricing agent ran. Check logs and WhatsApp.' });
    } catch (err) {
      console.error('[DEV] run-pricing', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/dev/simulate', express.json(), async (req, res) => {
    const { from: fromPhone, text } = req.body || {};
    const phone = String(fromPhone || '').replace(/\D/g, '');
    const messageText = String(text || '').trim();
    if (!phone || !messageText) {
      return res.status(400).json({ error: 'Missing "from" or "text". Example: {"from":"2348012345678","text":"AMAKA"}' });
    }
    try {
      const { getSock } = require('./whatsapp/client');
      const { handleMessage } = require('./whatsapp/listener');
      const sock = getSock();
      if (!sock) {
        return res.status(503).json({ error: 'WhatsApp not connected yet. Wait for the bot to connect, then try again.' });
      }
      const jid = phone + '@s.whatsapp.net';
      const msg = {
        key: { remoteJid: jid, fromMe: false, id: 'dev-' + Date.now() },
        message: { conversation: messageText },
        messageTimestamp: Math.floor(Date.now() / 1000)
      };
      await handleMessage(sock, msg);
      res.json({ ok: true, message: 'Message processed. Check WhatsApp for the reply.' });
    } catch (err) {
      console.error('[DEV_SIMULATE]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

// WhatsApp Cloud API webhook (for when WHATSAPP_PROVIDER=cloud-api)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

app.post('/webhook/whatsapp', express.json(), async (req, res) => {
  res.status(200).send(); // Always 200 so Meta doesn't retry
  const body = req.body;
  if (!body || body.object !== 'whatsapp_business_account') return;
  try {
    const { receiveWebhookPayload } = require('./whatsapp/cloud-api');
    await receiveWebhookPayload(body);
  } catch (err) {
    console.error('[WEBHOOK] WhatsApp Cloud:', err?.message || err);
  }
});

// Catch-all: so wrong paths don't show "Cannot GET /route" (e.g. bad callback URL)
app.use((req, res) => {
  console.warn('[SERVER] No route for', req.method, req.path);
  res.status(404).send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:system-ui;text-align:center;padding:2rem;">
    <h2>Page not found</h2>
    <p>This URL is not used by VendBot. Valid paths: <code>/health</code>, <code>/qr</code>, <code>/payment/callback</code>, <code>/receipt/:reference</code>.</p>
    </body></html>
  `);
});

module.exports = app;
