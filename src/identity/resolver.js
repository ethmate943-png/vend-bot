/**
 * Identity resolution: who is messaging and in what context?
 * Run this first, before any other routing.
 * Answers: Is sender a vendor? Store code in message? What context (buyer / vendor_management / vendor_onboarding / vendor_or_buyer / unknown)?
 */

const { getVendorByBotNumber, getVendorByStoreCode, getVendorByPhone } = require('../vendors/resolver');

const VENDOR_COMMANDS = [
  'ORDERS', 'BALANCE', 'DELIVERED', 'TAKEOVER', 'HANDBACK',
  'ADD:', 'REMOVE:', 'RESTOCK:', 'SET:', 'SOLD:', 'PRICE:', 'LIST', 'INVENTORY',
  'TRUST:', 'RELEASE', 'HELP', 'COMMANDS', 'MENU', 'BROADCAST:',
  'DETAILS', 'IMAGE:', 'SPECS:', 'FIND:', 'SEARCH:'
];

// Sticky onboarding: after VENDOR-SETUP, keep this JID in onboarding so numeric replies (e.g. "6") are handled
const ONBOARDING_TTL_MS = 30 * 60 * 1000;
const onboardingByJid = new Map();

function onboardingKey(jid) {
  return (jid || '').replace(/@s.whatsapp.net$/i, '').replace(/@lid$/i, '').replace(/\D/g, '') || '';
}

function setOnboardingSession(jid, vendor, ttlMs = ONBOARDING_TTL_MS) {
  const key = onboardingKey(jid);
  if (!key || !vendor) return;
  onboardingByJid.set(key, { vendor, until: Date.now() + ttlMs });
}

function getOnboardingSession(jid) {
  const key = onboardingKey(jid);
  const entry = onboardingByJid.get(key);
  if (!entry || Date.now() > entry.until) {
    if (entry) onboardingByJid.delete(key);
    return null;
  }
  return entry.vendor;
}

/**
 * @param {string} senderJid - e.g. 2348012345678@s.whatsapp.net
 * @param {string} text - raw message text
 * @param {string} botNum - digits of the bot's phone (which store this is)
 * @returns {Promise<{ isVendor, vendor, isOnboarding, hasStoreCode, targetStore, context }>}
 */
async function resolveIdentity(senderJid, text, botNum) {
  const senderPhone = (senderJid || '').replace(/@s.whatsapp.net$/, '').replace(/@lid$/, '').replace(/\D/g, '');
  const upper = (text || '').trim().toUpperCase();
  const firstWord = upper.split(/\s+/).filter(Boolean)[0] || '';

  const storeVendor = await getVendorByBotNumber(botNum);
  let senderVendor = await getVendorByPhone(senderPhone);
  const stickyVendor = getOnboardingSession(senderJid);
  if (stickyVendor && (!senderVendor || (stickyVendor.onboarding_step && stickyVendor.onboarding_step !== 'complete'))) {
    senderVendor = stickyVendor;
  }

  let storeCodeVendor = null;
  if (firstWord.length >= 2) {
    const code = firstWord.replace(/[^A-Z0-9]/g, '');
    if (code.length >= 2) {
      storeCodeVendor = await getVendorByStoreCode(code);
    }
  }
  const hasStoreCode = !!(
    storeCodeVendor &&
    (storeCodeVendor.whatsapp_number || '').replace(/\D/g, '') === botNum
  );
  const targetStore = storeVendor || null;

  const context = resolveContext(senderVendor, hasStoreCode, upper, storeVendor, botNum);

  return {
    isVendor: !!senderVendor,
    vendor: senderVendor || null,
    isOnboarding: !!(senderVendor && (senderVendor.onboarding_step && senderVendor.onboarding_step !== 'complete')),
    hasStoreCode,
    targetStore,
    context,
    storeVendor,
    senderPhone
  };
}

/**
 * @param {object|null} vendor - sender as vendor (getVendorByPhone result)
 * @param {boolean} hasStoreCode - message contains store code for this bot's store
 * @param {string} text - message in uppercase
 * @param {object|null} storeVendor - vendor that owns this bot
 * @param {string} botNum - digits of bot phone
 */
function resolveContext(vendor, hasStoreCode, text, storeVendor, botNum) {
  const isStoreOwner = vendor && storeVendor && (vendor.whatsapp_number || '').replace(/\D/g, '') === botNum;

  // Vendor coming from landing or explicit setup keyword (e.g. "VENDOR-SETUP AMAKA-STORE")
  if (text === 'VENDOR-SETUP' || (text && text.trim() === 'VENDOR-SETUP') || text.startsWith('VENDOR-SETUP ')) {
    return 'vendor_onboarding';
  }

  // Any sender who is a vendor (by phone) with incomplete onboarding stays in onboarding — don't require isStoreOwner
  if (vendor && (vendor.onboarding_step && vendor.onboarding_step !== 'complete')) {
    return 'vendor_onboarding';
  }

  if (hasStoreCode) {
    return 'buyer';
  }

  if (isStoreOwner && VENDOR_COMMANDS.some(cmd => text.startsWith(cmd))) {
    return 'vendor_management';
  }

  if (isStoreOwner && (vendor.onboarding_step && vendor.onboarding_step !== 'complete')) {
    return 'vendor_onboarding';
  }

  if (isStoreOwner) {
    return 'vendor_or_buyer';
  }

  if (storeVendor) {
    return 'buyer';
  }

  return 'unknown';
}

module.exports = { resolveIdentity, resolveContext, VENDOR_COMMANDS, setOnboardingSession };
