/**
 * Buyer identity: display name from WhatsApp profile or conversation, greetings.
 */

/**
 * Get buyer display name from the message (Baileys provides pushName when available).
 * @param {object} msg - Incoming message from Baileys (may have msg.pushName)
 * @returns {string|null} Display name or null
 */
function getBuyerDisplayNameFromMessage(msg) {
  if (!msg) return null;
  const name = (msg.pushName || msg.key?.pushName || '').trim();
  return name || null;
}

/**
 * Extract name from conversation if they introduce themselves.
 * @param {string} text - Message text
 * @param {string|null} existingName - Already stored name
 * @returns {string|null} First name if found, else null
 */
function extractNameFromMessage(text, existingName) {
  if (existingName) return null;
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  const introPattern = /(?:i am|i'm|my name is|na me be|call me|this is)\s+([A-Za-z][A-Za-z\s]{0,40})/i;
  const match = t.match(introPattern);
  if (match) {
    const name = match[1].trim().slice(0, 80);
    return name || null;
  }
  return null;
}

/**
 * Build greeting for welcome/returning buyer.
 * @param {object} vendor - Store vendor
 * @param {object} session - Buyer session (may have buyer_name)
 * @param {boolean} isReturning - Has recent transactions with this vendor
 * @param {string|null} displayName - Buyer display name if known
 * @returns {string} Greeting line (no "Welcome to X" catalogue — caller adds that)
 */
function buildGreeting(vendor, session, isReturning, displayName) {
  const storeName = vendor?.business_name || 'this store';
  const first = (displayName || session?.buyer_name || '').trim().split(/\s+/)[0];

  if (isReturning && first) {
    return `Welcome back ${first} 👋`;
  }
  if (isReturning) {
    return 'Welcome back! Good to see you again 👋';
  }
  if (first) {
    return `Hi ${first}!`;
  }
  return 'Hi!';
}

module.exports = {
  getBuyerDisplayNameFromMessage,
  extractNameFromMessage,
  buildGreeting
};
