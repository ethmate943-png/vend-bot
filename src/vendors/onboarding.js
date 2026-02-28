const { query } = require('../db');
const { sendWithDelay } = require('../whatsapp/sender');
const { resolveBankCode, verifyAccount, createSubaccount } = require('../payments/subaccount');
const { useSheets } = require('../inventory/manager');
const { getVendorById } = require('./resolver');

const VENDBOT_NUMBER = process.env.VENDBOT_NUMBER || '';

function canonicalBuyerJid(jid) {
  if (!jid || typeof jid !== 'string') return jid;
  const phone = jid
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid.*$/i, '')
    .replace(/\D/g, '');
  return phone ? `${phone}@s.whatsapp.net` : jid;
}

async function clearBuyerSessions(senderJid) {
  const c = canonicalBuyerJid(senderJid);
  await query(
    `UPDATE sessions SET
       intent_state = 'idle',
       conversation_history = '[]'::jsonb,
       last_item_name = null,
       last_item_sku = null,
       last_item_price = null,
       updated_at = NOW()
     WHERE buyer_jid = $1`,
    [c]
  );
  console.log(`[ONBOARDING] Cleared buyer sessions for ${c}`);
}

async function updateVendorState(vendorId, state, data) {
  if (!vendorId) return;
  await query(
    `UPDATE vendors SET
       vendor_state = $1,
       vendor_state_data = $2,
       updated_at = NOW()
     WHERE id = $3`,
    [state || null, data ? JSON.stringify(data) : null, vendorId]
  );
}

/** Full list of vendor commands — shown when they finish onboarding and when they type HELP or COMMANDS. */
function getVendorCommandsMessage(vendor) {
  const botNum = (VENDBOT_NUMBER || '').replace(/\D/g, '');
  const code = (vendor.store_code || '').toUpperCase();
  const textParam = code ? encodeURIComponent(`${code} hi`) : '';
  const link = botNum && textParam ? `wa.me/${botNum}?text=${textParam}` : '(store link)';
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
    `• *PROFILE* — see and edit your settings (includes business name, store code, etc.)\n` +
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

    const badNamePattern = /(something went wrong|wrong name|test store|stupid|nonsense|asdf|qwer)/i;
    if (badNamePattern.test(name) || name.length < 3) {
      await sendWithDelay(sock, jid,
        `This business name doesn't look right.\n\nPlease reply with the *real* name buyers should see — e.g. "Amaka Fashion", "Lekki Gadget Hub".`
      );
      return true;
    }

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
    await query('UPDATE vendors SET store_code = $1, onboarding_step = $2 WHERE id = $3', [code, 'category', vendor.id]);
    await sendWithDelay(sock, jid,
      `*${code}* is yours! ✅\n\nQuick questions so the bot can represent you properly:\n\n*What do you sell?* Pick the closest:\n` +
      `1 — Fashion & clothing\n2 — Food & drinks\n3 — Electronics & gadgets\n4 — Beauty & skincare\n5 — Home & furniture\n6 — Other (tell me in one sentence)`
    );
    return true;
  }

  if (step === 'category') {
    const raw = (text || '').trim();
    const num = raw === '6' || /^6\s*[.)]?\s*$/i.test(raw) ? 6 : parseInt(raw, 10);
    const categoryMap = { 1: 'Fashion & clothing', 2: 'Food & drinks', 3: 'Electronics & gadgets', 4: 'Beauty & skincare', 5: 'Home & furniture' };
    if (num === 6) {
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['category_other', vendor.id]);
      await sendWithDelay(sock, jid, `Describe what you sell in one sentence — e.g. "Handmade jewellery and accessories" or "Phone repairs and accessories".`);
      return true;
    }
    if (categoryMap[num]) {
      await query('UPDATE vendors SET category = $1, onboarding_step = $2 WHERE id = $3', [categoryMap[num], 'location', vendor.id]);
      await sendWithDelay(sock, jid,
        `Got it — ${categoryMap[num]} 👍\n\n` +
        `If you ever change what you sell, you can update this later with: TYPE\n\n` +
        `*Where are you based?* Just the city or area — e.g. Lagos Island, Abuja, Kano`
      );
      return true;
    }
    // Not a number (e.g. first message "VENDOR-SETUP <CODE>" from landing) — show full category list
    const biz = (vendor.business_name || vendor.store_code || 'Your store').trim();
    await sendWithDelay(sock, jid,
      `Hi! *${biz}* is set up on the site — just a few quick questions so the bot can represent you well.\n\n*What do you sell?* Pick the closest:\n` +
      `1 — Fashion & clothing\n2 — Food & drinks\n3 — Electronics & gadgets\n4 — Beauty & skincare\n5 — Home & furniture\n6 — Other (tell me in one sentence)`
    );
    return true;
  }

  if (step === 'category_other') {
    const desc = (text || '').trim();
    if (!desc) return true;
    await query('UPDATE vendors SET category = $1, onboarding_step = $2 WHERE id = $3', [desc.slice(0, 200), 'location', vendor.id]);
    await sendWithDelay(sock, jid,
      `Nice — we'll use that 👍\n\n` +
      `If you ever change what you sell, you can update this later with: TYPE\n\n` +
      `*Where are you based?* Just the city or area — e.g. Lagos Island, Abuja, Kano`
    );
    return true;
  }

  if (step === 'location') {
    const loc = (text || '').trim().slice(0, 200);
    if (!loc) return true;
    await query('UPDATE vendors SET location = $1, onboarding_step = $2 WHERE id = $3', [loc, 'delivery_coverage', vendor.id]);
    await sendWithDelay(sock, jid,
      `*Do you deliver?*\n1 — Yes, anywhere in Nigeria\n2 — Only in my city\n3 — Pickup only\n4 — Depends on the order`
    );
    return true;
  }

  if (step === 'delivery_coverage') {
    const n = (text || '').trim().replace(/\s*[.)]\s*$/, '');
    const map = { '1': 'nationwide', '2': 'local', '3': 'pickup', '4': 'depends' };
    const val = map[n] || map[String(parseInt(n, 10))];
    if (!val) {
      await sendWithDelay(sock, jid, `Reply 1, 2, 3, or 4.`);
      return true;
    }
    await query('UPDATE vendors SET delivery_coverage = $1, onboarding_step = $2 WHERE id = $3', [val, 'turnaround', vendor.id]);
    await sendWithDelay(sock, jid,
      `*How quickly do you typically deliver or prepare an order?*\n1 — Same day\n2 — 1–2 days\n3 — 3–5 days\n4 — Made to order (tell me how long)`
    );
    return true;
  }

  if (step === 'turnaround') {
    const n = (text || '').trim();
    const map = { '1': 'Same day', '2': '1–2 days', '3': '3–5 days' };
    let turnaroundText = map[n] || null;
    if (n === '4' || /^4\s*[.)]?\s*$/i.test(n)) {
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['turnaround_other', vendor.id]);
      await sendWithDelay(sock, jid, `How long does a typical made-to-order item take? e.g. "5–7 days" or "2 weeks"`);
      return true;
    }
    if (!turnaroundText) {
      await sendWithDelay(sock, jid, `Reply 1, 2, 3, or 4.`);
      return true;
    }
    await query('UPDATE vendors SET turnaround = $1, onboarding_step = $2 WHERE id = $3', [turnaroundText, 'tone', vendor.id]);
    await sendWithDelay(sock, jid,
      `*How do you want your store assistant to sound?*\n1 — Professional and formal\n2 — Friendly and conversational\n3 — Playful and fun\n4 — Mix of English and Pidgin`
    );
    return true;
  }

  if (step === 'turnaround_other') {
    const t = (text || '').trim().slice(0, 100);
    if (!t) return true;
    await query('UPDATE vendors SET turnaround = $1, onboarding_step = $2 WHERE id = $3', [t, 'tone', vendor.id]);
    await sendWithDelay(sock, jid,
      `*How do you want your store assistant to sound?*\n1 — Professional and formal\n2 — Friendly and conversational\n3 — Playful and fun\n4 — Mix of English and Pidgin`
    );
    return true;
  }

  if (step === 'tone') {
    const n = (text || '').trim();
    const map = { '1': 'professional', '2': 'friendly', '3': 'playful', '4': 'pidgin' };
    const toneVal = map[n] || null;
    if (!toneVal) {
      await sendWithDelay(sock, jid, `Reply 1, 2, 3, or 4.`);
      return true;
    }
    await query('UPDATE vendors SET tone = $1, onboarding_step = $2 WHERE id = $3', [toneVal, 'custom_note', vendor.id]);
    await sendWithDelay(sock, jid,
      `*Is there anything important you want buyers to know before they order?*\nE.g. "All items available immediately", "Custom orders take 5 days", "We don't do returns".\n\nReply with one short sentence or *SKIP*.`
    );
    return true;
  }

  if (step === 'custom_note') {
    const note = (text || '').trim().toUpperCase() === 'SKIP' ? '' : (text || '').trim().slice(0, 300);
    await query('UPDATE vendors SET custom_note = $1, onboarding_step = $2 WHERE id = $3', [note || null, 'sheet_link', vendor.id]);
    await sendWithDelay(sock, jid,
      `All set 👍\n\nShare your *Google Sheet link* — or reply *SKIP* to add products via WhatsApp later.`
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
    const raw = (text || '').trim();
    if (!raw) return true;
    const bankCode = resolveBankCode(raw);
    if (!bankCode) {
      const q = raw.toLowerCase().replace(/bank/g, '').trim();
      const knownBanks = ['GTBank', 'Access Bank', 'Zenith Bank', 'First Bank', 'UBA', 'Fidelity', 'Sterling', 'Opay', 'Palmpay', 'Kuda', 'Moniepoint', 'Wema', 'FCMB'];
      const matches = q
        ? knownBanks.filter(name => name.toLowerCase().replace(/bank/g, '').includes(q)).slice(0, 5)
        : knownBanks.slice(0, 7);
      const suggestions = matches.length
        ? `\n\nBanks I know that look close:\n- ${matches.join('\n- ')}`
        : `\n\nSupported examples include: GTBank, Access, Zenith, Opay, Palmpay, Kuda, FCMB.`;
      await sendWithDelay(sock, jid,
        `I don't recognise that bank name yet.\n\nPlease type the *exact* bank name you use (e.g. "GTBank", "Access Bank", "Kuda").` +
        suggestions
      );
      return true;
    }
    await query(
      'UPDATE vendors SET bank_name = $1, bank_code = $2, onboarding_step = $3 WHERE id = $4',
      [raw, bankCode, 'account_number', vendor.id]
    );
    await sendWithDelay(sock, jid, `Got it — ${raw} ✅\n\nWhat is your account number?`);
    return true;
  }

  if (step === 'account_number') {
    const raw = (text || '').trim();
    const upper = raw.toUpperCase();

    // Allow vendor to jump back and change bank if they realise it's wrong.
    if (upper === 'BANK' || upper === 'CHANGE BANK') {
      await query('UPDATE vendors SET onboarding_step = $1 WHERE id = $2', ['bank_name', vendor.id]);
      await sendWithDelay(sock, jid, `No wahala — let's fix it.\n\nWhat *bank* do you use for receiving payments?`);
      return true;
    }

    const num = raw.replace(/[^0-9]/g, '');
    if (num.length !== 10) {
      await sendWithDelay(sock, jid,
        `Nigerian account numbers are 10 digits.\n\nIf you picked the *wrong bank*, reply *BANK* to change it.\nIf the bank is correct, please type the correct 10-digit account number.`
      );
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
      await sendWithDelay(sock, jid,
        `Could not verify that account.\n\nIf you think the *bank is wrong*, reply *BANK* to change it.\nOtherwise, please check the account number and try again.`
      );
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

async function handleLandingPageEntry(sock, senderJid, text) {
  const c = canonicalBuyerJid(senderJid);
  const raw = (text || '').trim();
  const token = raw.replace(/^MOOV-/i, '').trim().split(/\s+/)[0] || '';

  if (!token) {
    await sendWithDelay(sock, c,
      `Hi! To set up your store, please reply *VENDOR-SETUP* from this WhatsApp number.`
    );
    return;
  }

  console.log(`[ONBOARDING] Landing page entry — token: ${token}`);

  const res = await query(
    `SELECT * FROM onboarding_tokens
     WHERE token = $1
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [token]
  );
  const record = res.rows && res.rows[0];

  if (!record) {
    console.warn(`[ONBOARDING] Token not found or expired: ${token} — falling back`);
    await sendWithDelay(sock, c,
      `This link has expired.\n\nReply *VENDOR-SETUP* here to start setting up your store on VendBot.`
    );
    return;
  }

  await query(
    `UPDATE onboarding_tokens
       SET status = 'used', used_at = NOW()
     WHERE token = $1`,
    [token]
  );

  const type = String(token).charAt(0) || 'N';

  if (type === 'C' && record.vendor_id) {
    await handleAlreadyOnboarded(sock, c, record);
    return;
  }

  if (type === 'R' && record.vendor_id) {
    await handleResumeOnboarding(sock, c, record);
    return;
  }

  await handleFreshOnboarding(sock, c, record);
}

async function handleAlreadyOnboarded(sock, senderJid, record) {
  const vendor = await getVendorById(record.vendor_id);
  if (!vendor) {
    await sendWithDelay(sock, senderJid,
      `Hi! Your store is already live.\n\nReply *VENDOR-SETUP* to manage your store settings or *HELP* to see vendor commands.`
    );
    return;
  }

  await clearBuyerSessions(senderJid);

  const invRes = await query(
    `SELECT name, price, quantity
       FROM inventory_items
      WHERE vendor_id = $1
      ORDER BY created_at DESC
      LIMIT 5`,
    [vendor.id]
  );
  const inventory = invRes.rows || [];
  const hasStock = inventory.length > 0;

  if (hasStock) {
    const stockList = inventory
      .map(i => `• ${i.name} — ₦${Number(i.price / 100).toLocaleString()} (${i.quantity} left)`)
      .join('\n');

    await sendWithDelay(sock, senderJid,
      `Hey! Your store *${vendor.business_name || vendor.store_code || 'your store'}* is already live ✅\n\n` +
      `Here's a quick look at your latest products:\n${stockList}\n\n` +
      `Reply *HELP* to see everything you can do with VendBot.`
    );
  } else {
    await sendWithDelay(sock, senderJid,
      `Hey! Your store *${vendor.business_name || vendor.store_code || 'your store'}* is live ✅\n\n` +
      `But your inventory is empty — buyers can't order yet.\n\n` +
      `Add your first product:\n` +
      `Just send the name, price, and quantity.\n\n` +
      `Example:\n` +
      `_Black Sneakers, ₦45,000, 10 pairs_\n\n` +
      `Or type *HELP* if you're stuck.`
    );
  }
}

async function handleResumeOnboarding(sock, senderJid, record) {
  if (!record.vendor_id) {
    await handleFreshOnboarding(sock, senderJid, record);
    return;
  }
  const vendor = await getVendorById(record.vendor_id);
  if (!vendor) {
    await handleFreshOnboarding(sock, senderJid, record);
    return;
  }

  await clearBuyerSessions(senderJid);

  const step = vendor.onboarding_step || 'start';
  console.log(`[ONBOARDING] Resuming vendor ${vendor.id} at step ${step}`);

  let msg;
  switch (step) {
    case 'start':
    case 'business_name':
      msg =
        `Welcome back 👋 Let's finish setting up *${vendor.business_name || 'your store'}*.\n\n` +
        `What's your business name?`;
      break;
    case 'store_code':
      msg =
        `Welcome back 👋 Almost there.\n\n` +
        `Remind me — *what's your store code?* (Short, memorable, all caps. E.g. AMAKA, SNEAKERHUB)`;
      break;
    case 'category':
    case 'category_other':
      msg =
        `Welcome back 👋\n\n` +
        `What do you sell? Pick the closest:\n` +
        `1 — Fashion & clothing\n` +
        `2 — Food & drinks\n` +
        `3 — Electronics & gadgets\n` +
        `4 — Beauty & skincare\n` +
        `5 — Home & furniture\n` +
        `6 — Other (tell me in one sentence)`;
      break;
    case 'location':
      msg =
        `Welcome back 👋\n\n` +
        `Where are you based? Just the city or area — e.g. Lagos Island, Abuja, Kano.`;
      break;
    case 'delivery_coverage':
      msg =
        `Welcome back 👋\n\n` +
        `*Do you deliver?*\n1 — Yes, anywhere in Nigeria\n2 — Only in my city\n3 — Pickup only\n4 — Depends on the order`;
      break;
    case 'turnaround':
    case 'turnaround_other':
      msg =
        `Welcome back 👋\n\n` +
        `How quickly do you typically deliver or prepare an order?\n` +
        `1 — Same day\n2 — 1–2 days\n3 — 3–5 days\n4 — Made to order (tell me how long)`;
      break;
    case 'tone':
      msg =
        `Welcome back 👋\n\n` +
        `How do you want your store assistant to sound?\n` +
        `1 — Professional and formal\n2 — Friendly and conversational\n3 — Playful and fun\n4 — Mix of English and Pidgin`;
      break;
    case 'custom_note':
      msg =
        `Welcome back 👋\n\n` +
        `Is there anything important you want buyers to know before they order?\n\n` +
        `Reply with one short sentence or *SKIP*.`;
      break;
    case 'sheet_link':
      msg =
        `Welcome back 👋\n\n` +
        `Paste your Google Sheet link here, or reply *SKIP* to add products via WhatsApp later.`;
      break;
    case 'negotiation':
      msg =
        `Welcome back 👋\n\n` +
        `How should the bot handle price negotiation?\n\n` +
        `1 — Fixed price (no negotiation)\n2 — Alert me when buyer asks to negotiate\n\n` +
        `Reply 1 or 2.`;
      break;
    case 'bank_name':
      msg =
        `Welcome back 👋\n\n` +
        `What *bank* do you use for receiving payments?\nExamples: GTBank, Access, Zenith, Opay, Palmpay, Kuda`;
      break;
    case 'account_number':
    case 'confirm_account':
    case 'agreement':
      msg =
        `Welcome back 👋\n\n` +
        `Reply *VENDOR-SETUP* to continue from where you stopped in your onboarding.`;
      break;
    default:
      msg =
        `Welcome back 👋\n\n` +
        `Reply *VENDOR-SETUP* to continue setting up your store with VendBot.`;
  }

  await sendWithDelay(sock, senderJid, msg);
  await updateVendorState(vendor.id, 'onboarding_resume', {
    current_step: step,
    resumed_from: 'landing_page',
  });
}

async function handleFreshOnboarding(sock, senderJid, record) {
  const phone = canonicalBuyerJid(senderJid).replace('@s.whatsapp.net', '');
  await clearBuyerSessions(senderJid);

  const category = record && record.category ? record.category : null;

  const insertRes = await query(
    `INSERT INTO vendors (
       whatsapp_number, category, onboarding_step, onboarding_complete, status, created_at
     )
     VALUES ($1, $2, 'start', false, 'onboarding', NOW())
     ON CONFLICT (whatsapp_number) DO NOTHING
     RETURNING *`,
    [phone, category]
  );

  let vendor = insertRes.rows && insertRes.rows[0];
  if (!vendor) {
    const found = await query('SELECT * FROM vendors WHERE whatsapp_number = $1 LIMIT 1', [phone]);
    vendor = found.rows && found.rows[0];
  }

  if (!vendor) {
    await sendWithDelay(sock, senderJid,
      `Hi! 👋 Welcome to VendBot.\n\nReply *VENDOR-SETUP* to start setting up your store.`
    );
    return;
  }

  const nameHint = record && record.name ? record.name : null;

  if (nameHint) {
    await sendWithDelay(sock, senderJid,
      `Hi ${nameHint}! 👋 Welcome to VendBot.\n\n` +
      `Let's get your store live. It takes about 5 minutes.\n\n` +
      `What's your business name?`
    );
  } else {
    await sendWithDelay(sock, senderJid,
      `Hi! 👋 Welcome to VendBot.\n\n` +
      `Let's get your store live in 5 minutes.\n\n` +
      `What's your business name?`
    );
  }

  await updateVendorState(vendor.id, 'awaiting_business_name', {
    current_step: 'business_name',
    resumed_from: 'landing_page',
  });
}

module.exports = { handleOnboarding, getVendorCommandsMessage, handleLandingPageEntry };
