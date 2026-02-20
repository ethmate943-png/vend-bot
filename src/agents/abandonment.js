const { query } = require('../db');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');

async function runAbandonmentAgent() {
  const sock = getSock();
  if (!sock) return;

  const cutoff30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const cutoff6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const res = await query(
    `SELECT t.*, v.business_name FROM transactions t
     JOIN vendors v ON v.id = t.vendor_id
     WHERE t.status = 'pending' AND t.created_at < $1 AND t.created_at > $2`,
    [cutoff30, cutoff6h]
  );
  const abandoned = res.rows || [];

  for (const txn of abandoned) {
    try {
      const sessionRes = await query(
        'SELECT intent_state FROM sessions WHERE buyer_jid = $1 AND vendor_id = $2',
        [txn.buyer_jid, txn.vendor_id]
      );
      const session = sessionRes.rows && sessionRes.rows[0];
      if (session && session.intent_state !== 'awaiting_payment') continue;

      await sendWithDelay(sock, txn.buyer_jid,
        `Hey! Your payment link for *${txn.item_name}* from *${txn.business_name}* is about to expire 😅\n\nStill interested? Reply *YES* and I'll send a fresh one.`
      );
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
