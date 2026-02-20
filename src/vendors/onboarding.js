const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');

const VENDBOT_NUMBER = process.env.VENDBOT_NUMBER || '';

async function handleOnboarding(sock, jid, text, vendor) {
  if (!vendor) return false;
  const step = vendor.onboarding_step || 'start';

  if (step === 'start') {
    await sendWithDelay(sock, jid,
      `Welcome to VendBot! 🚀\n\nLet's set up your store in 5 minutes.\n\n*What is your business name?*`
    );
    await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['business_name', vendor.id]);
    return true;
  }

  if (step === 'business_name') {
    const name = (text || '').trim();
    if (!name) return true;
    await query('UPDATE vendors SET business_name = $1, onboarding_step = $2 WHERE id = $3', [name, 'store_code', vendor.id]);
    await sendWithDelay(sock, jid,
      `Love it — *${name}* 🔥\n\nNow choose a *store code*. Short, memorable, all caps.\nExamples: AMAKA, SNEAKERHUB\n\n*What's your store code?*`
    );
    return true;
  }

  if (step === 'store_code') {
    const code = (text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return true;
    const existing = await query('SELECT id FROM vendors WHERE store_code = $1 AND id != $2 LIMIT 1', [code, vendor.id]);
    if (existing.rows && existing.rows.length > 0) {
      await sendWithDelay(sock, jid, `"${code}" is taken 😅 Try another.`);
      return true;
    }
    await query('UPDATE vendors SET store_code = $1, onboarding_step = $2 WHERE id = $3', [code, 'sheet_link', vendor.id]);
    await sendWithDelay(sock, jid,
      `*${code}* is yours! ✅\n\nYour store link:\nwa.me/${VENDBOT_NUMBER.replace(/\D/g, '')}?text=${code}\n\nShare your *Google Sheet link* — or reply *SKIP* to add products via WhatsApp later.`
    );
    return true;
  }

  if (step === 'sheet_link') {
    const msg = (text || '').trim();
    if (msg.toUpperCase() !== 'SKIP') {
      const match = msg.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        await query('UPDATE vendors SET sheet_id = $1, onboarding_step = $2 WHERE id = $3', [match[1], 'negotiation', vendor.id]);
      } else {
        await sendWithDelay(sock, jid, 'That doesn\'t look right. Paste the full Google Sheet URL, or reply SKIP.');
        return true;
      }
    } else {
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['negotiation', vendor.id]);
    }
    await sendWithDelay(sock, jid,
      `Almost done! 🙌\n\nHow should the bot handle price negotiation?\n\n*1* — Fixed price (no negotiation)\n*2* — Alert me when buyer asks to negotiate\n\nReply 1 or 2`
    );
    return true;
  }

  if (step === 'negotiation') {
    const policy = (text || '').trim() === '1' ? 'fixed' : 'escalate';
    await query(
      'UPDATE vendors SET negotiation_policy = $1, onboarding_step = $2, onboarding_complete = true, status = $3 WHERE id = $4',
      [policy, 'complete', 'probation', vendor.id]
    );
    const v = await query('SELECT business_name, store_code FROM vendors WHERE id = $1', [vendor.id]);
    const row = v.rows && v.rows[0];
    const biz = row ? row.business_name : vendor.business_name;
    const code = row ? row.store_code : vendor.store_code;
    await sendWithDelay(sock, jid,
      `🎉 *Your store is LIVE!*\n\n` +
      `Business: ${biz}\n` +
      `Store code: ${code}\n` +
      `Link: wa.me/${VENDBOT_NUMBER.replace(/\D/g, '')}?text=${code}\n\n` +
      `*Commands:*\n` +
      `• "add: [item], [price], [qty]"\n` +
      `• "sold: [item]"\n` +
      `• "restock: [item], [qty]"\n` +
      `• "list" — see inventory\n\n` +
      `First sale incoming 🚀`
    );
    return true;
  }

  return false;
}

module.exports = { handleOnboarding };
