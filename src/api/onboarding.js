const crypto = require('crypto');
const { query } = require('../db');
const { getVendorByPhone } = require('../vendors/resolver');

function normalizePhone(raw) {
  if (!raw) return '';
  let cleaned = String(raw).replace(/\D/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('0')) cleaned = '234' + cleaned.slice(1);
  if (!cleaned.startsWith('234') && cleaned.length <= 11) cleaned = '234' + cleaned;
  return cleaned;
}

function makeTokenPrefix(type) {
  if (type === 'COMPLETE') return 'C';
  if (type === 'RESUME') return 'R';
  return 'N';
}

function generateToken(type) {
  const prefix = makeTokenPrefix(type);
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}${random}`;
}

async function initOnboarding(req, res) {
  try {
    const { phone, category, name } = req.body || {};
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Phone required' });
    }

    const existing = await getVendorByPhone(normalizedPhone);
    let type = 'NEW';
    if (existing && (existing.onboarding_complete || existing.onboarding_step === 'complete')) {
      type = 'COMPLETE';
    } else if (existing) {
      type = 'RESUME';
    }

    const token = generateToken(type);
    const source = 'landing_page';

    await query(
      `INSERT INTO onboarding_tokens (
         token, phone, category, name, source, status, vendor_id, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         token      = EXCLUDED.token,
         category   = EXCLUDED.category,
         name       = EXCLUDED.name,
         source     = EXCLUDED.source,
         vendor_id  = COALESCE(EXCLUDED.vendor_id, onboarding_tokens.vendor_id),
         status     = 'pending',
         created_at = NOW()`,
      [
        token,
        normalizedPhone,
        category || null,
        name || null,
        source,
        existing ? existing.id : null,
      ]
    );

    const bot = (process.env.BOT_NUMBER || process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');
    const waBase = bot || normalizedPhone;
    const msg = `MOOV-${token}`;
    const whatsappLink = `https://wa.me/${waBase}?text=${encodeURIComponent(msg)}`;

    res.json({
      token,
      status: type.toLowerCase(), // 'new' | 'resume' | 'complete'
      whatsapp_link: whatsappLink,
      vendor: existing
        ? {
            id: existing.id,
            business_name: existing.business_name || null,
            store_code: existing.store_code || null,
            onboarding_step: existing.onboarding_step || null,
            onboarding_complete: !!existing.onboarding_complete,
          }
        : null,
    });
  } catch (err) {
    console.error('[API] /api/onboarding/init error:', err.message);
    res.status(500).json({ error: 'Onboarding init failed. Try again.' });
  }
}

module.exports = { initOnboarding };

