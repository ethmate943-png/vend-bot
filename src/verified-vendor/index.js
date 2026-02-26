/**
 * Verified Vendor: platform-verified tiers (rising → verified → trusted → elite).
 * Hold reduction, daily cap multiplier, badge text, graduation and demotion.
 */

const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');

const VERIFIED_TIERS = [
  {
    tier: 'rising',
    conditions: {
      min_transactions: 5,
      min_confirmation_rate: 0.8,
      max_disputes: 1,
      min_days_active: 7
    },
    perks: {
      hold_reduction: 0.75,
      daily_cap_multiplier: 2,
      badge_text: 'Rising Vendor'
    }
  },
  {
    tier: 'verified',
    conditions: {
      min_transactions: 20,
      min_confirmation_rate: 0.9,
      max_disputes: 1,
      min_days_active: 30
    },
    perks: {
      hold_reduction: 0.5,
      daily_cap_multiplier: 5,
      badge_text: 'VendBot Verified'
    }
  },
  {
    tier: 'trusted',
    conditions: {
      min_transactions: 50,
      min_confirmation_rate: 0.95,
      max_disputes: 0,
      min_days_active: 60
    },
    perks: {
      hold_reduction: 0.25,
      daily_cap_multiplier: 10,
      badge_text: 'Trusted Vendor'
    }
  },
  {
    tier: 'elite',
    conditions: {
      min_transactions: 100,
      min_confirmation_rate: 0.98,
      max_disputes: 0,
      min_days_active: 90
    },
    perks: {
      hold_reduction: 0, // no hold at all
      daily_cap_multiplier: 20,
      badge_text: 'VendBot Elite'
    }
  }
];

const TIER_ORDER = ['rising', 'verified', 'trusted', 'elite'];

function getTierByKey(tierKey) {
  return VERIFIED_TIERS.find(t => t.tier === tierKey) || null;
}

function getTierHoldMultiplier(tierKey) {
  const tier = getTierByKey(tierKey);
  if (!tier) return 1;
  if (tier.perks.hold_reduction === 0 && tier.tier === 'elite') return 0;
  return 1 - (tier.perks.hold_reduction || 0);
}

function getTierCapMultiplier(tierKey) {
  const tier = getTierByKey(tierKey);
  return (tier && tier.perks.daily_cap_multiplier) || 1;
}

function getVendorBadgeText(vendor) {
  const badges = {
    elite: '👑 VendBot Elite Vendor\n     Top 1% of all vendors on the platform.',
    trusted: '🏆 VendBot Trusted Vendor\n     Consistently excellent track record.',
    verified: '✅ VendBot Verified Vendor\n     Clean history, reliable delivery.',
    rising: '⭐ Rising Vendor\n     New but delivering consistently.'
  };
  const tier = (vendor && vendor.verified_vendor_tier) || null;
  return tier ? (badges[tier] || null) : null;
}

function getVendorBadgeLine(vendor) {
  if (!vendor || !vendor.verified_vendor_tier) return null;
  const badge = getVendorBadgeText(vendor);
  if (!badge) return null;
  const completed = Number(vendor.total_transactions || 0);
  const disputes = Number(vendor.vendor_dispute_count != null ? vendor.vendor_dispute_count : 0);
  const memberSince = vendor.vendor_created_at
    ? new Date(vendor.vendor_created_at).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })
    : '';
  const stats = `${completed} completed orders • ${disputes} disputes${memberSince ? ` • Member since ${memberSince}` : ''}`;
  return `\n\n     ${badge}\n     ${stats}\n\n     Your payment is protected. 🛡`;
}

/** Shorter badge line for payment link message (before pay); no dispute count required. */
function getVendorBadgeLineForPayment(vendor) {
  if (!vendor || !vendor.verified_vendor_tier) return null;
  const badge = getVendorBadgeText(vendor);
  if (!badge) return null;
  const completed = Number(vendor.total_transactions || 0);
  const memberSince = (vendor.created_at || vendor.vendor_created_at)
    ? new Date(vendor.created_at || vendor.vendor_created_at).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })
    : '';
  const stats = `${completed} completed orders${memberSince ? ` • Member since ${memberSince}` : ''}`;
  return `\n\n✅ *${(vendor.business_name || '').trim() || 'This store'} is a VendBot ${getTierByKey(vendor.verified_vendor_tier)?.perks?.badge_text || 'Verified Vendor'}*\n${stats}\n\nYour payment is protected. 🛡`;
}

async function runVendorTierGraduation() {
  const { rows: vendors } = await query(`
    SELECT
      v.id,
      v.whatsapp_number,
      v.business_name,
      v.verified_vendor_tier,
      v.created_at,
      COUNT(t.id)::int AS total_txns,
      COUNT(CASE WHEN t.delivery_confirmed = true THEN 1 END)::int AS confirmed,
      COALESCE(dispute_counts.cnt, 0)::int AS disputes,
      FLOOR(EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 86400)::int AS days_active
    FROM vendors v
    LEFT JOIN transactions t ON t.vendor_id = v.id AND t.status = 'paid'
    LEFT JOIN (
      SELECT vendor_id, COUNT(*) AS cnt FROM disputes GROUP BY vendor_id
    ) dispute_counts ON dispute_counts.vendor_id = v.id
    WHERE (v.onboarding_complete = true OR v.store_code IS NOT NULL)
    GROUP BY v.id, v.whatsapp_number, v.business_name, v.verified_vendor_tier, v.created_at, dispute_counts.cnt
  `);

  for (const vendor of vendors) {
    const confirmationRate = vendor.total_txns > 0 ? vendor.confirmed / vendor.total_txns : 0;
    let newTier = null;
    for (let i = VERIFIED_TIERS.length - 1; i >= 0; i--) {
      const tier = VERIFIED_TIERS[i];
      const c = tier.conditions;
      if (
        vendor.total_txns >= c.min_transactions &&
        confirmationRate >= c.min_confirmation_rate &&
        vendor.disputes <= c.max_disputes &&
        vendor.days_active >= c.min_days_active
      ) {
        newTier = tier;
        break;
      }
    }
    if (!newTier) continue;
    if (vendor.verified_vendor_tier === newTier.tier) continue;

    await query(
      `UPDATE vendors SET
        verified_vendor = true,
        verified_vendor_tier = $1,
        verified_vendor_at = COALESCE(verified_vendor_at, NOW())
       WHERE id = $2`,
      [newTier.tier, vendor.id]
    );

    await notifyVendorTierUpgrade(vendor, newTier);
  }
}

async function notifyVendorTierUpgrade(vendor, newTier) {
  const sock = require('../whatsapp/client').getSock();
  if (!sock || !vendor.whatsapp_number) return;

  const jid = `${String(vendor.whatsapp_number).replace(/\D/g, '')}@s.whatsapp.net`;
  const tierLabel = newTier.perks.badge_text;
  const messages = {
    rising: '💰 Slightly faster payouts\n     📈 Daily limit increased\n     ⭐ Your *Rising Vendor* badge shows to buyers.',
    verified: '💰 Payouts in 24 hours (when established)\n     📈 Daily limit increased\n     ✅ Your verified badge shows on every sale — buyers trust you before they pay.',
    trusted: '💰 Payouts in 12 hours instead of 48\n     📈 Daily limit increased to ₦500,000\n     ✅ Your verified badge shows on every sale — buyers trust you before they pay.',
    elite: '💰 No hold — payouts as soon as delivery is confirmed\n     📈 Highest daily limit\n     👑 Elite badge on every sale.'
  };
  const perksText = messages[newTier.tier] || 'You get faster payouts and higher limits.';

  const body =
    `🏆 *You've been promoted!*\n\n` +
    `${vendor.business_name} is now a *${tierLabel}*\n\n` +
    `What this means for you:\n\n` +
    `${perksText}\n\n` +
    `You earned this by delivering consistently and keeping your buyers happy.\n\n` +
    `Keep it up. 👊`;

  try {
    await sendWithDelay(sock, jid, body);
  } catch (err) {
    console.error('[VERIFIED_VENDOR] Notify upgrade error:', err.message);
  }
}

async function checkForDemotion(vendorId) {
  const res = await query(
    `SELECT COUNT(*)::int AS recent_disputes
     FROM disputes
     WHERE vendor_id = $1
       AND created_at >= NOW() - INTERVAL '30 days'
       AND status IN ('open', 'resolved_against_vendor')`,
    [vendorId]
  );
  const recentDisputes = (res.rows && res.rows[0] && res.rows[0].recent_disputes) || 0;
  if (recentDisputes < 2) return;

  const vRes = await query('SELECT id, whatsapp_number, business_name, verified_vendor_tier FROM vendors WHERE id = $1', [vendorId]);
  const vendor = vRes.rows && vRes.rows[0];
  if (!vendor) return;

  const currentTier = vendor.verified_vendor_tier;
  const sock = require('../whatsapp/client').getSock();
  const jid = vendor.whatsapp_number ? `${String(vendor.whatsapp_number).replace(/\D/g, '')}@s.whatsapp.net` : null;

  if (!currentTier || currentTier === 'rising') {
    await query(
      `UPDATE vendors SET verified_vendor = false, verified_vendor_tier = NULL WHERE id = $1`,
      [vendorId]
    );
    if (sock && jid) {
      try {
        await sendWithDelay(sock, jid,
          `⚠️ Your vendor badge has been reviewed.\n\n` +
          `Due to recent disputes, your verified status has been removed.\n\n` +
          `Resolve open disputes and maintain clean deliveries to earn it back.`
        );
      } catch (e) {
        console.error('[VERIFIED_VENDOR] Demotion notify error:', e.message);
      }
    }
    return;
  }

  const currentIndex = TIER_ORDER.indexOf(currentTier);
  const newTier = TIER_ORDER[Math.max(0, currentIndex - 1)];

  await query(
    'UPDATE vendors SET verified_vendor_tier = $1 WHERE id = $2',
    [newTier, vendorId]
  );

  if (sock && jid) {
    try {
      await sendWithDelay(sock, jid,
        `⚠️ Your vendor tier has been reviewed.\n\n` +
        `Due to recent disputes, your status has moved from *${currentTier}* to *${newTier}*.\n\n` +
        `Resolve open disputes and maintain clean deliveries to earn it back.`
      );
    } catch (e) {
      console.error('[VERIFIED_VENDOR] Demotion notify error:', e.message);
    }
  }
}

async function runDemotionChecks() {
  const { rows } = await query(
    `SELECT id FROM vendors WHERE verified_vendor = true OR verified_vendor_tier IS NOT NULL`
  );
  for (const r of rows || []) {
    try {
      await checkForDemotion(r.id);
    } catch (err) {
      console.error('[VERIFIED_VENDOR] Demotion check error for vendor', r.id, err.message);
    }
  }
}

module.exports = {
  VERIFIED_TIERS,
  getTierByKey,
  getTierHoldMultiplier,
  getTierCapMultiplier,
  getVendorBadgeText,
  getVendorBadgeLine,
  getVendorBadgeLineForPayment,
  runVendorTierGraduation,
  checkForDemotion,
  runDemotionChecks,
  notifyVendorTierUpgrade
};
