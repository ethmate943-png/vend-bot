const { query } = require('../db');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');

// Only nudge if buyer has been inactive this long (no message from them)
const INACTIVITY_MINUTES = 45;
// Min age of pending txn before we consider it "abandoned" (avoid nudging right after link sent)
const PENDING_MIN_AGE_MINUTES = 35;
const PENDING_MAX_AGE_HOURS = 6;
// Max one abandonment nudge per buyer per run
const nudgedThisRun = new Set();

async function runAbandonmentAgent() {
  const sock = getSock();
  if (!sock) return;

  nudgedThisRun.clear();

  const now = Date.now();
  const cutoffYoung = new Date(now - PENDING_MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const cutoffOld = new Date(now - PENDING_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
  const activityThreshold = new Date(now - INACTIVITY_MINUTES * 60 * 1000);

  const res = await query(
    `SELECT t.*, v.business_name FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.status = 'pending' AND t.created_at < $1 AND t.created_at > $2`,
    [cutoffYoung, cutoffOld]
  );
  const abandoned = res.rows || [];

  for (const txn of abandoned) {
    try {
      if (nudgedThisRun.has(txn.buyer_jid)) continue;

      const sessionRes = await query(
        'SELECT intent_state, updated_at FROM sessions WHERE buyer_jid = $1 AND vendor_id = $2',
        [txn.buyer_jid, txn.vendor_id]
      );
      const session = sessionRes.rows && sessionRes.rows[0];
      if (session && session.intent_state !== 'awaiting_payment') continue;

      // Activity-based: only nudge if buyer hasn't messaged recently (no spam when they're chatting)
      const lastActivity = session && session.updated_at ? new Date(session.updated_at) : null;
      if (lastActivity && lastActivity > activityThreshold) continue;

      await sendWithDelay(sock, txn.buyer_jid,
        `Hey! Your payment link for *${txn.item_name}* from *${txn.business_name}* is about to expire 😅\n\nStill interested? Reply *YES* and I'll send a fresh one.`
      );
      nudgedThisRun.add(txn.buyer_jid);
      await query(
        'UPDATE sessions SET intent_state = $1 WHERE buyer_jid = $2 AND vendor_id = $3',
        ['awaiting_recovery', txn.buyer_jid, txn.vendor_id]
      );
    } catch (e) {
      console.error('[ABANDONMENT]', e.message);
    }
  }
}

module.exports = { runAbandonmentAgent };
