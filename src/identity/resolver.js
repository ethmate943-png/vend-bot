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
  const senderVendor = await getVendorByPhone(senderPhone);

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

  if (text === 'VENDOR-SETUP' || (text && text.trim() === 'VENDOR-SETUP')) {
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

module.exports = { resolveIdentity, resolveContext, VENDOR_COMMANDS };
