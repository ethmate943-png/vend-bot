/**
 * Vendor finance: BALANCE, PENDING, HISTORY.
 * Escrow breakdown, pending deliveries, awaiting confirmation, payout history.
 */

const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');
const { logReply } = require('../whatsapp/listener/logger');

const fmt = (n) => Number(n).toLocaleString('en-NG');

/**
 * Detect vendor finance intent from natural language (e.g. "how many orders are pending", "how much have I made").
 * Returns 'balance' | 'pending' | 'history' | null. Only runs on short messages; exact commands (BALANCE, PENDING, HISTORY) are handled by the listener.
 */
function detectVendorFinanceIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (t.length > 120) return null; // avoid matching long pastes

  // Pending / how many orders
  if (/\b(how many|number of|count of|what('s| is) pending|pending (orders?|count)|orders? (pending|awaiting)|any pending|my pending)\b/.test(t)) return 'pending';
  if (/\b(pending|undelivered|awaiting delivery)\b/.test(t) && /\b(orders?|list|see|show|what)\b/.test(t)) return 'pending';

  // Balance / how much I get / money available / withdraw
  if (/\b(how much (do )?i get|my balance|what('s| is) my balance|balance|how much (can i )?withdraw|money (i have|available)|available (balance|money))\b/.test(t)) return 'balance';
  if (/\b(how much (have i |did i )?(made|earned|sold|get)|(total |my )?(sales|earnings|revenue)|sales i made|how much sales|revenue|earnings (this (week|month)|so far)?)\b/.test(t)) return 'balance';

  // Payout history
  if (/\b(payout history|past payouts?|payment history|when (did you pay|was i paid)|history of payouts?)\b/.test(t)) return 'history';

  return null;
}

function getOrderAgeHours(createdAt) {
  if (!createdAt) return 0;
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
}

function timeAgo(date) {
  if (!date) return '—';
  const hours = getOrderAgeHours(date);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${Math.floor(hours)} hours ago`;
  if (hours < 48) return 'Yesterday';
  return `${Math.floor(hours / 24)} days ago`;
}

function formatReleaseTime(escrowReleaseAt) {
  if (!escrowReleaseAt) return '—';
  const release = new Date(escrowReleaseAt);
  const now = new Date();
  const hoursLeft = (release - now) / (1000 * 60 * 60);
  if (hoursLeft <= 0) return 'Releasing soon';
  if (hoursLeft < 1) return 'Less than 1 hour';
  const opts = { hour: '2-digit', minute: '2-digit', hour12: true };
  if (hoursLeft < 24) return `Tonight ${release.toLocaleTimeString('en-NG', opts)}`;
  return `Tomorrow ${release.toLocaleTimeString('en-NG', opts)}`;
}

// --- DB queries ---

async function getEscrowBreakdown(vendorId) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' AND delivery_confirmed IS NULL AND (delivery_status IS NULL OR delivery_status = '') THEN amount ELSE 0 END), 0)::bigint AS awaiting_delivery,
       COUNT(CASE WHEN status = 'paid' AND delivery_confirmed IS NULL AND (delivery_status IS NULL OR delivery_status = '') THEN 1 END)::int AS delivery_count,
       COALESCE(SUM(CASE WHEN status = 'paid' AND delivery_confirmed IS NULL AND delivery_status IS NOT NULL AND delivery_status != '' THEN amount ELSE 0 END), 0)::bigint AS awaiting_confirm,
       COUNT(CASE WHEN status = 'paid' AND delivery_confirmed IS NULL AND delivery_status IS NOT NULL AND delivery_status != '' THEN 1 END)::int AS confirm_count
     FROM transactions
     WHERE vendor_id = $1`,
    [vendorId]
  );
  const row = rows[0] || {};
  const awaitingDelivery = Number(row.awaiting_delivery || 0);
  const awaitingConfirm = Number(row.awaiting_confirm || 0);
  return {
    awaiting_delivery: awaitingDelivery,
    delivery_count: row.delivery_count || 0,
    awaiting_confirm: awaitingConfirm,
    confirm_count: row.confirm_count || 0,
    total: awaitingDelivery + awaitingConfirm,
  };
}

async function getPendingDeliveries(vendorId) {
  const { rows } = await query(
    `SELECT id, item_name, amount, created_at, buyer_jid,
            REPLACE(REPLACE(buyer_jid, '@s.whatsapp.net', ''), '@lid', '') AS buyer_phone
     FROM transactions
     WHERE vendor_id = $1 AND status = 'paid' AND delivery_confirmed IS NULL
       AND (delivery_status IS NULL OR delivery_status = '')
     ORDER BY created_at ASC`,
    [vendorId]
  );
  return rows || [];
}

async function getAwaitingConfirmation(vendorId) {
  const { rows } = await query(
    `SELECT id, item_name, amount, created_at, updated_at AS delivered_at,
            escrow_release_at
     FROM transactions
     WHERE vendor_id = $1 AND status = 'paid' AND delivery_confirmed IS NULL
       AND delivery_status IS NOT NULL AND delivery_status != ''
     ORDER BY updated_at ASC`,
    [vendorId]
  );
  return rows || [];
}

async function getAvailableBalance(vendorId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS ready
     FROM transactions
     WHERE vendor_id = $1 AND status = 'paid' AND payout_released = true`,
    [vendorId]
  );
  const ready = Number(rows[0]?.ready || 0);
  return { ready };
}

async function getNextScheduledPayout(vendorId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS amount, MIN(escrow_release_at) AS release_at
     FROM transactions
     WHERE vendor_id = $1 AND status = 'paid' AND payout_released = false
       AND delivery_confirmed = true AND escrow_release_at IS NOT NULL AND escrow_release_at > NOW()`,
    [vendorId]
  );
  const row = rows[0];
  if (!row || !row.release_at) return null;
  const release = new Date(row.release_at);
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
  return {
    amount: Number(row.amount || 0),
    time: release.toLocaleTimeString('en-NG', opts),
    date: release.toLocaleDateString('en-NG', { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
  };
}

async function getWeeklyStats(vendorId) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' AND created_at >= date_trunc('week', CURRENT_DATE) THEN amount ELSE 0 END), 0)::bigint AS earned,
       COALESCE(SUM(CASE WHEN payout_released = true AND updated_at >= date_trunc('week', CURRENT_DATE) THEN amount ELSE 0 END), 0)::bigint AS paid_out
     FROM transactions
     WHERE vendor_id = $1`,
    [vendorId]
  );
  const row = rows[0] || {};
  return {
    earned: Number(row.earned || 0),
    fees: 0,
    paid_out: Number(row.paid_out || 0),
  };
}

async function getAllTimeStats(vendorId) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0)::bigint AS total_earned,
       COALESCE(SUM(CASE WHEN payout_released = true THEN amount ELSE 0 END), 0)::bigint AS total_paid_out
     FROM transactions
     WHERE vendor_id = $1`,
    [vendorId]
  );
  const row = rows[0] || {};
  return {
    total_earned: Number(row.total_earned || 0),
    total_paid_out: Number(row.total_paid_out || 0),
  };
}

async function getPayoutHistoryByDay(vendorId, limitDays = 7) {
  const { rows } = await query(
    `SELECT date_trunc('day', updated_at)::date AS day,
            SUM(amount)::bigint AS total
     FROM transactions
     WHERE vendor_id = $1 AND payout_released = true
       AND updated_at >= CURRENT_DATE - ($2::int || ' days')::interval
     GROUP BY date_trunc('day', updated_at)
     ORDER BY day DESC
     LIMIT 14`,
    [vendorId, limitDays]
  );
  return rows || [];
}

async function getPayoutHistoryForMonth(vendorId, year, month) {
  const { rows } = await query(
    `SELECT date_trunc('day', updated_at)::date AS day,
            SUM(amount)::bigint AS total
     FROM transactions
     WHERE vendor_id = $1 AND payout_released = true
       AND EXTRACT(YEAR FROM updated_at) = $2 AND EXTRACT(MONTH FROM updated_at) = $3
     GROUP BY date_trunc('day', updated_at)
     ORDER BY day DESC`,
    [vendorId, year, month]
  );
  return rows || [];
}

// --- Handlers ---

async function handleBalanceCommand(sock, vendorJid, vendor) {
  const [available, escrow, weekly, alltime] = await Promise.all([
    getAvailableBalance(vendor.id),
    getEscrowBreakdown(vendor.id),
    getWeeklyStats(vendor.id),
    getAllTimeStats(vendor.id),
  ]);
  const nextPayout = await getNextScheduledPayout(vendor.id);

  const msg =
    `💰 *${vendor.business_name || 'Store'} — Balance*\n\n` +
    `*AVAILABLE*\n` +
    `Ready to withdraw:    ₦${fmt(available.ready / 100)}\n` +
    (nextPayout
      ? `Next payout:          ₦${fmt(nextPayout.amount / 100)}\n  releases ${nextPayout.time}\n`
      : '') +
    `\n*IN ESCROW*\n` +
    `Awaiting delivery:    ₦${fmt(escrow.awaiting_delivery / 100)} (${escrow.delivery_count} orders)\n` +
    `Awaiting confirmation:₦${fmt(escrow.awaiting_confirm / 100)} (${escrow.confirm_count} orders)\n` +
    `Total locked:         ₦${fmt(escrow.total / 100)}\n` +
    `\n*THIS WEEK*\n` +
    `Earned:               ₦${fmt(weekly.earned / 100)}\n` +
    `Fees paid:            ₦${fmt(weekly.fees / 100)}\n` +
    `Paid out:             ₦${fmt(weekly.paid_out / 100)}\n` +
    `\n*ALL TIME*\n` +
    `Total earned:         ₦${fmt(alltime.total_earned / 100)}\n` +
    `Total paid out:       ₦${fmt(alltime.total_paid_out / 100)}\n` +
    `\n_Reply PENDING to see what's in escrow_\n` +
    `_Reply HISTORY for past payouts_`;

  await sendWithDelay(sock, vendorJid, msg);
  logReply('[BALANCE]');
}

async function handlePendingCommand(sock, vendorJid, vendor) {
  const [undelivered, awaitingConfirm] = await Promise.all([
    getPendingDeliveries(vendor.id),
    getAwaitingConfirmation(vendor.id),
  ]);

  if (!undelivered.length && !awaitingConfirm.length) {
    await sendWithDelay(sock, vendorJid,
      `✅ No pending orders right now.\nAll caught up!`
    );
    logReply('[PENDING] empty');
    return;
  }

  let msg = `⏳ *${vendor.business_name || 'Store'} — Pending Orders*\n\n`;

  if (undelivered.length) {
    msg += `*AWAITING YOUR DELIVERY (${undelivered.length})*\n`;
    msg += `─────────────────────────\n`;
    undelivered.forEach((order, i) => {
      const ageHours = getOrderAgeHours(order.created_at);
      const urgency =
        ageHours > 48 ? '🚨 Overdue — deliver urgently' :
        ageHours > 24 ? '⚠️ Getting old — deliver today' : '';

      msg +=
        `${i + 1}. ${order.item_name} — ₦${fmt(order.amount / 100)}\n` +
        `   Buyer: wa.me/${(order.buyer_phone || '').replace(/\D/g, '')}\n` +
        `   Ordered: ${timeAgo(order.created_at)}\n` +
        (urgency ? `   ${urgency}\n` : '') +
        `\n`;
    });
  }

  if (awaitingConfirm.length) {
    const offset = undelivered.length;
    msg += `*AWAITING BUYER CONFIRMATION (${awaitingConfirm.length})*\n`;
    msg += `────────────────────────────────\n`;
    awaitingConfirm.forEach((order, i) => {
      const releaseText = formatReleaseTime(order.escrow_release_at);
      msg +=
        `${offset + i + 1}. ${order.item_name} — ₦${fmt(order.amount / 100)}\n` +
        `   Delivered: ${timeAgo(order.delivered_at)}\n` +
        `   Releases: ${releaseText}\n` +
        `\n`;
    });
  }

  const total = [...undelivered, ...awaitingConfirm].reduce((sum, o) => sum + Number(o.amount), 0);
  msg += `Total in escrow: ₦${fmt(total / 100)}\n\n`;
  msg += `_Reply number to act on any order_\n`;
  msg += `_Reply DELIVERED ALL to mark all undelivered_`;

  await sendWithDelay(sock, vendorJid, msg);
  logReply('[PENDING]');

  // Store order IDs for follow-up (vendor_state if available)
  try {
    await query(
      `UPDATE vendors SET vendor_state = $1, vendor_state_data = $2 WHERE id = $3`,
      [
        'viewing_pending',
        JSON.stringify({
          pending_order_ids: undelivered.map((o) => o.id),
          confirm_order_ids: awaitingConfirm.map((o) => o.id),
        }),
        vendor.id,
      ]
    );
  } catch (_) {}
}

async function handleHistoryCommand(sock, vendorJid, vendor, monthArg) {
  const vendorId = vendor.id;
  const biz = vendor.business_name || 'Store';

  if (monthArg) {
    const monthNames = 'JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER OCTOBER NOVEMBER DECEMBER'.split(' ');
    const mi = monthNames.findIndex((m) => m.startsWith(monthArg.trim().toUpperCase().slice(0, 3)));
    const target = new Date();
    if (mi >= 0) {
      target.setMonth(mi);
      target.setDate(1);
    }
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    const rows = await getPayoutHistoryForMonth(vendorId, year, month);
    const monthLabel = target.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
    const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);

    let msg = `📋 *${biz} — Payout History (${monthLabel})*\n\n`;
    if (!rows.length) {
      msg += `No payouts in ${monthLabel}.`;
    } else {
      rows.forEach((r) => {
        const day = new Date(r.day).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
        msg += `${day}\n₦${fmt(r.total / 100)} ✅\n\n`;
      });
      msg += `Total: ₦${fmt(total / 100)}`;
    }
    msg += `\n\n_Reply HISTORY for recent payouts_`;
    await sendWithDelay(sock, vendorJid, msg);
    logReply('[HISTORY month]');
    return;
  }

  const rows = await getPayoutHistoryByDay(vendorId, 7);
  const weekTotal = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthRows = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total
     FROM transactions
     WHERE vendor_id = $1 AND payout_released = true AND updated_at >= $2`,
    [vendorId, monthStart]
  );
  const monthTotal = Number(monthRows.rows[0]?.total || 0);

  let msg = `📋 *${biz} — Payout History*\n\n`;
  if (!rows.length) {
    msg += `No recent payouts.\n\n`;
  } else {
    const today = now.toDateString();
    rows.slice(0, 10).forEach((r) => {
      const d = new Date(r.day);
      const label = d.toDateString() === today ? 'Today' : d.toDateString() === new Date(now - 86400000).toDateString() ? 'Yesterday' : d.toLocaleDateString('en-NG', { weekday: 'short' });
      msg += `${label}\n₦${fmt(r.total / 100)} ✅\n\n`;
    });
    msg += `Last week total: ₦${fmt(weekTotal / 100)}\n`;
  }
  msg += `This month total: ₦${fmt(monthTotal / 100)}\n\n`;
  msg += `_Reply HISTORY [month] for older records_\n`;
  msg += `_e.g. HISTORY JANUARY_`;

  await sendWithDelay(sock, vendorJid, msg);
  logReply('[HISTORY]');
}

module.exports = {
  handleBalanceCommand,
  handlePendingCommand,
  handleHistoryCommand,
  detectVendorFinanceIntent,
  getEscrowBreakdown,
  getPendingDeliveries,
  getAwaitingConfirmation,
  getAvailableBalance,
  getNextScheduledPayout,
  getWeeklyStats,
  getAllTimeStats,
  fmt,
  timeAgo,
  getOrderAgeHours,
  formatReleaseTime,
};
