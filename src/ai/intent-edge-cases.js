/**
 * Fast local rules for obvious intents. Run before or as fallback to the model.
 * Handles typos, Nigerian English, and clear phrases so the bot stays robust.
 */

const VALID_INTENTS = ['QUERY', 'PURCHASE', 'NEGOTIATE', 'CANCEL', 'CONFIRM', 'IGNORE', 'OTHER'];

// One-word or very short messages that are clearly "ready to buy" in any context
const PURCHASE_WORDS = [
  'yes', 'yea', 'yeah', 'yep', 'yup', 'ok', 'okay', 'k', 'kk', 'sure', 'fine', 'deal', 'nau', 'now',
  'send', 'link', 'pay', 'buy', 'take', 'gimme', 'give', 'want', 'need', 'proceed', 'go', 'abeg',
  'confirm', 'accepted', 'done', 'alright', 'alright', 'collected', 'i want am', 'i want it'
];

// Phrases that strongly indicate purchase/confirm (substring match, lowercased)
const PURCHASE_PHRASES = [
  'send link', 'send me link', 'send the link', 'i\'ll take', 'i will take', 'i want that',
  'i want this', 'i want it', 'i want am', 'give me', 'gimme that', 'i\'ll pay', 'i will pay',
  'i\'ll buy', 'ready to pay', 'ready to buy', 'go ahead', 'proceed', 'that one', 'this one',
  'the first one', 'the second one', 'number 1', 'number 2', 'num 1', 'num 2', 'option 1',
  'abeg send', 'oya send', 'just send', 'send payment', 'payment link', 'pay now', 'buy now',
  'i agree', 'we have a deal', 'make we do am', 'let\'s do it', 'i\'m taking', 'i am taking'
];

const CANCEL_PHRASES = [
  'cancel', 'forget it', 'forget that', 'never mind', 'nevermind', 'no thanks', 'no thank you',
  'not interested', 'maybe later', 'next time', 'no wahala', 'leave it', 'stop', 'abort',
  'i don\'t want', 'i dont want', 'changed my mind', 'start over', 'clear', 'reset'
];

const NEGOTIATE_PHRASES = [
  'last price', 'your last', 'reduce', 'discount', 'cheaper', 'lower', 'can you do',
  'how about', 'what about', 'make am', 'abeg', 'final price', 'best price', 'lowest',
  '20k', '30k', '15k', '10k', '50k', '100k', '₦', 'naira', 'thousand', 'hundred'
];

// Greeting-only (no product hint) -> IGNORE. Check after trimming.
const PURE_GREETING = /^(hi|hello|hey|good morning|good afternoon|good evening|gm|ga|ge|sup|yo|wassup|how far|how you dey|how body)\s*[!.]*$/i;

// Single number that could be list selection (1-10) - we don't classify here; selecting-item handles it
// So we leave numbers to the model when context is list.

function normalizeForMatch(t) {
  return (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * If we can confidently infer intent from the message alone (and optional context), return it.
 * Otherwise return null and let the model decide.
 */
function inferIntentFromPatterns(message, sessionContext = {}) {
  const state = sessionContext.intent_state;
  const lastItem = sessionContext.last_item_name;
  const text = normalizeForMatch(message);
  if (!text) return null;

  // Pure greeting with nothing else -> IGNORE
  if (PURE_GREETING.test(text)) return 'IGNORE';

  // Strong cancel
  if (CANCEL_PHRASES.some(p => text.includes(p))) return 'CANCEL';

  // Awaiting payment: resend/link/yes -> CONFIRM
  if (state === 'awaiting_payment') {
    if (/\b(resend|link|send link|again|yes|ok|pay|payment)\b/i.test(text)) return 'CONFIRM';
  }

  // Negotiating: number or deal -> let model handle; but "last price" etc already in NEGOTIATE_PHRASES
  if (state === 'negotiating') {
    if (PURCHASE_WORDS.some(w => text === w || text.startsWith(w + ' ') || text.endsWith(' ' + w))) return 'CONFIRM';
    if (/^\d{1,6}\s*$/.test(text.replace(/[,.]/g, ''))) return 'NEGOTIATE'; // just a number
  }

  // Querying or selecting_item: short "yes/ok/send link/that one" -> PURCHASE or CONFIRM
  if (state === 'querying' || state === 'selecting_item') {
    const short = text.length < 60;
    if (short && PURCHASE_WORDS.some(w => text === w || text.startsWith(w + ' ') || text.endsWith(' ' + w))) return 'CONFIRM';
    if (short && PURCHASE_PHRASES.some(p => text.includes(p))) return 'PURCHASE';
  }

  // Any context: clear purchase phrasing
  if (PURCHASE_PHRASES.some(p => text.includes(p))) return 'PURCHASE';
  if (text.length < 25 && PURCHASE_WORDS.some(w => text === w || text === w + '.' || text === w + '!')) return 'CONFIRM';

  // Number that looks like price offer (e.g. 15000, 20k) in a short message -> NEGOTIATE
  if (/^(₦?\s*)?(\d{1,3}(,\d{3})*|\d+)\s*(k|thousand|naira)?\s*[?!.]*$/i.test(text)) return 'NEGOTIATE';

  return null;
}

/**
 * Run classifier: use pattern inference first; if we get a confident result, return it.
 * Otherwise call the model-based classifier and normalize its output.
 */
function normalizeModelIntent(raw) {
  const intent = (raw || '').trim().toUpperCase().split(/[\s.,;:\/]+/)[0];
  return VALID_INTENTS.includes(intent) ? intent : 'OTHER';
}

module.exports = {
  inferIntentFromPatterns,
  normalizeModelIntent,
  VALID_INTENTS,
  PURE_GREETING
};
