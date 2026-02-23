const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');
const { resolveBankCode, verifyAccount, createSubaccount } = require('../payments/subaccount');
const { useSheets } = require('../inventory/manager');

const VENDBOT_NUMBER = process.env.VENDBOT_NUMBER || '';

/** Full list of vendor commands — shown when they finish onboarding and when they type HELP or COMMANDS. */
function getVendorCommandsMessage(vendor) {
  const botNum = (VENDBOT_NUMBER || '').replace(/\D/g, '');
  const link = botNum ? `wa.me/${botNum}?text=${(vendor.store_code || '').toUpperCase()}` : '(store link)';
  const extra = useSheets(vendor) ? '' : '\n• *remove:* item name — remove from list\n• *image:* item name, URL — set product photo\n';
  return (
    `📋 *VendBot commands*\n\n` +
    `*Inventory*\n` +
    `• *add:* name, price, qty — or add: name, price, qty, image URL\n` +
    `• *sold:* item name — mark one sold\n` +
    `• *restock:* item name, new qty — or *set:* item name, qty\n` +
    `• *list* or *inventory* — see all items\n` +
    `• *stock help* — inventory help${extra}\n` +
    `(You can also send a voice note: "Add black sneakers 25k 3...")\n\n` +
    `*Orders*\n` +
    `• *orders* — pending orders\n` +
    `• *DETAILS* — buyer profile for latest order\n` +
    `• *DELIVERED* / *TOMORROW* / *ISSUE* — update delivery for latest order\n\n` +
    `*Other*\n` +
    `• *broadcast:* your message — message all past buyers\n\n` +
    `*Your store link:* ${link}\n\n` +
    `Reply *help* or *commands* anytime to see this again.`
  );
}

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
      'UPDATE vendors SET negotiation_policy = $1, onboarding_step = $2 WHERE id = $3',
      [policy, 'bank_name', vendor.id]
    );
    await sendWithDelay(sock, jid,
      `Almost there! 🙌\n\nWhat *bank* do you use for receiving payments?\nExamples: GTBank, Access, Zenith, Opay, Palmpay, Kuda`
    );
    return true;
  }

  if (step === 'bank_name') {
    const bankCode = resolveBankCode(text.trim());
    if (!bankCode) {
      await sendWithDelay(sock, jid,
        `I don't recognise that bank. Try again.\nExamples: GTBank, Access, Zenith, Opay, Palmpay, Kuda`
      );
      return true;
    }
    await query(
      'UPDATE vendors SET bank_name = $1, bank_code = $2, onboarding_step = $3 WHERE id = $4',
      [text.trim(), bankCode, 'account_number', vendor.id]
    );
    await sendWithDelay(sock, jid, `Got it — ${text.trim()} ✅\n\nWhat is your account number?`);
    return true;
  }

  if (step === 'account_number') {
    const num = (text || '').trim().replace(/[^0-9]/g, '');
    if (num.length !== 10) {
      await sendWithDelay(sock, jid, `Nigerian account numbers are 10 digits. Please check and try again.`);
      return true;
    }
    const v = await query('SELECT bank_code FROM vendors WHERE id = $1', [vendor.id]);
    const bankCode = v.rows[0]?.bank_code;
    if (!bankCode) {
      await sendWithDelay(sock, jid, `Something went wrong. Please start again with *VENDOR-SETUP*.`);
      return true;
    }
    try {
      const accountName = await verifyAccount(num, bankCode);
      await query(
        'UPDATE vendors SET account_number = $1, account_name = $2, onboarding_step = $3 WHERE id = $4',
        [num, accountName, 'confirm_account', vendor.id]
      );
      await sendWithDelay(sock, jid,
        `Account found ✅\n\nName: *${accountName}*\n\nIs this correct? Reply YES or NO`
      );
    } catch (e) {
      await sendWithDelay(sock, jid, `Could not verify that account. Please check the number and try again.`);
    }
    return true;
  }

  if (step === 'confirm_account') {
    if ((text || '').trim().toUpperCase() === 'NO') {
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['bank_name', vendor.id]);
      await sendWithDelay(sock, jid, `No problem — what bank do you use?`);
      return true;
    }
    const v = await query('SELECT * FROM vendors WHERE id = $1', [vendor.id]);
    const fullVendor = v.rows[0];
    if (!fullVendor) return true;
    try {
      await createSubaccount(fullVendor);
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['agreement', vendor.id]);
      await sendWithDelay(sock, jid,
        `Bank account connected ✅\n\nOne last step — please read and agree to our vendor terms:\n\n` +
        `• VendBot charges 5% per transaction\n` +
        `• 10% of each sale is held for 48 hours as dispute cover\n` +
        `• Fraud results in permanent ban and EFCC referral\n` +
        `• Your BVN is on file and linked to this account\n\n` +
        `Reply *AGREE* to activate your store.`
      );
    } catch (e) {
      console.error('[ONBOARDING] createSubaccount error:', e.message);
      await sendWithDelay(sock, jid, `Something went wrong. Please try again or contact support.`);
    }
    return true;
  }

  if (step === 'agreement') {
    if ((text || '').trim().toUpperCase() !== 'AGREE') {
      await sendWithDelay(sock, jid, `Please reply *AGREE* to activate your store.`);
      return true;
    }
    await query(
      `UPDATE vendors SET
        onboarding_step = 'complete',
        onboarding_complete = true,
        status = 'probation',
        agreed_at = NOW()
       WHERE id = $1`,
      [vendor.id]
    );
    const v = await query('SELECT business_name, store_code FROM vendors WHERE id = $1', [vendor.id]);
    const row = v.rows && v.rows[0];
    const biz = row ? row.business_name : vendor.business_name;
    const code = row ? row.store_code : vendor.store_code;
    await sendWithDelay(sock, jid,
      `🎉 *Your store is LIVE!*\n\n` +
      `Business: *${biz}*\n` +
      `Store code: *${code}*\n\n` +
      getVendorCommandsMessage({ ...vendor, business_name: biz, store_code: code })
    );
    return true;
  }

  return false;
}

module.exports = { handleOnboarding, getVendorCommandsMessage };
