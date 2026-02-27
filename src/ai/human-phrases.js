/**
 * Varied, human-sounding one-liners for system messages.
 * Picking at random avoids the same robotic line every time.
 * Use {{itemName}}, {{price}}, {{max}} in strings; pick() substitutes them.
 */

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fill(template, params = {}) {
  let s = template;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`{{${k}}}`, 'g'), String(v ?? ''));
  }
  return s;
}

const SELECTION_CONFIRM = [
  'Got it — *{{itemName}}* at ₦{{price}}. Sending your payment link now.',
  'Sweet — *{{itemName}}*, ₦{{price}}. I\'ll send the link.',
  'That\'s *{{itemName}}* — ₦{{price}}. Link coming.',
  'Cool, *{{itemName}}* (₦{{price}}). Sending the link.',
  'Done — *{{itemName}}* for ₦{{price}}. Link on the way.'
];

const OUT_OF_STOCK = [
  'Sorry, *{{itemName}}* is out of stock now. Need anything else?',
  'Ah, *{{itemName}}* just finished. Anything else you want?',
  'That one\'s finished o. Need something else?',
  'We don\'t have *{{itemName}}* in stock right now. Something else?'
];

const OUT_OF_STOCK_GENERIC = [
  'That item\'s out of stock now. Need anything else?',
  'Just finished that one. Something else?',
  'No longer in stock — want to try something else?'
];

const LIST_PROMPT = [
  'Tell me which one — you can reply with the number or describe what you want 😊',
  'Pick one, or say what you\'re looking for and I\'ll help.',
  'Reply with the number, or just tell me what you need.',
  'Which one works for you? Or describe what you want.'
];

const LIST_PROMPT_NO_ITEMS = [
  'No items in that list — tell me what you\'re looking for and I\'ll help.',
  'List\'s empty for now — what do you need? I\'ll check.',
  'Nothing in that list right now. What are you looking for?'
];

const LIST_INTRO_FIRST = [
  'I found a few options for you. Tap to pick one:',
  'Here are some options — tap one or reply with the number:',
  'Got a few that might work. Take a look:',
  'Here you go — pick one or tell me what you want:'
];

/** When query suggests a category (phone, shirt), use contextual intro. */
function listIntroForCategory(query, matches) {
  const t = (query || '').toLowerCase();
  if (/\bphone|iphone|pixel|samsung|smartphone\b/i.test(t) && matches.some(m => (m.category || '').toLowerCase().includes('phone'))) {
    return pick([
      "Here's what we have for phones — tap one:",
      'We\'ve got these phones in stock. Pick one:',
      'Phones we have right now:'
    ]);
  }
  if (/\bshirt|tee|clothes|wear\b/i.test(t) && matches.some(m => (m.category || '').toLowerCase().includes('cloth'))) {
    return pick([
      "Here are the clothes we have — tap to pick:",
      'Shirts and wear. Take a look:',
      'These are in stock. Pick one:'
    ]);
  }
  return listIntroFirst();
}

const LIST_INTRO_SEARCH = [
  "We've got some options for you — here's what we have in stock:",
  "Here's what we have that might work for you:",
  'Found a few that match. Take a look:',
  "This is what we have in stock right now:"
];

const LIST_INTRO_AGAIN = [
  'Here\'s the list again. Tap to pick or reply with the number:',
  'Sending the list again — tap one or reply 1 to {{max}}:',
  'No wahala — here it is again. Pick one:'
];

const LIST_INTRO_PURCHASE = [
  'Which one would you like?',
  'Pick one:',
  'Which one do you want?'
];

const ALREADY_HAVE_LINK = [
  'You already have a payment link for *{{itemName}}* 😊 You can use that one again, or reply *resend* if you need a fresh link.',
  'Link for *{{itemName}}* was already sent — check your chat. If you need it again, reply *resend*.',
  'We already sent you the link for *{{itemName}}*. Use that link, or type *resend* if you want it sent again.'
];

const PAYMENT_FAILED = [
  'Sorry — couldn\'t generate the link right now. Try again in a bit?',
  'Something went wrong on our end. Please try again in a moment.',
  'Link didn\'t go through. Give it another try in a sec.'
];

const PAYMENT_INTRO = [
  'Here\'s your link 👇',
  'Payment link below —',
  'Got it — pay here:'
];

const NO_MATCH = [
  'We don\'t have that right now. Need anything else? 😊',
  'Don\'t have that one at the moment. Something else?',
  'Not in stock right now. Want to try something else?'
];

const DAILY_CAP = [
  'Sorry — this store has hit its daily limit. Try again tomorrow.',
  'Store\'s limit for today is full. Come back tomorrow?',
  'We\'ve reached today\'s limit. Try again tomorrow.'
];

const VENDOR_UNAVAILABLE = [
  'This store is temporarily unavailable. Try again later.',
  'Store\'s not available right now. Check back in a bit.',
  'Temporarily unavailable — please try again later.'
];

const LIST_FOOTER = [
  'Tap to pick or reply with the number.',
  'Pick one — tap or type the number.',
  'Choose one below.'
];

function selectionConfirm(itemName, price) {
  return fill(pick(SELECTION_CONFIRM), { itemName, price: Number(price).toLocaleString() });
}

function outOfStock(itemName) {
  return itemName ? fill(pick(OUT_OF_STOCK), { itemName }) : pick(OUT_OF_STOCK_GENERIC);
}

function listPrompt(max) {
  return max ? fill(pick(LIST_PROMPT), { max }) : pick(LIST_PROMPT_NO_ITEMS);
}

function listIntroFirst() {
  return pick(LIST_INTRO_FIRST);
}

function listIntroSearch() {
  return pick(LIST_INTRO_SEARCH);
}

function listIntroAgain(max) {
  return max ? fill(pick(LIST_INTRO_AGAIN), { max }) : pick(LIST_INTRO_AGAIN);
}

function alreadyHaveLink(itemName) {
  return fill(pick(ALREADY_HAVE_LINK), { itemName: itemName || 'your item' });
}

function paymentFailed() {
  return pick(PAYMENT_FAILED);
}

function paymentIntro() {
  return pick(PAYMENT_INTRO);
}

function noMatch() {
  return pick(NO_MATCH);
}

function dailyCap() {
  return pick(DAILY_CAP);
}

function vendorUnavailable() {
  return pick(VENDOR_UNAVAILABLE);
}

function listFooter() {
  return pick(LIST_FOOTER);
}

function listIntroPurchase() {
  return pick(LIST_INTRO_PURCHASE);
}

module.exports = {
  selectionConfirm,
  outOfStock,
  listPrompt,
  listIntroFirst,
  listIntroForCategory,
  listIntroSearch,
  listIntroAgain,
  listIntroPurchase,
  listFooter,
  alreadyHaveLink,
  paymentFailed,
  paymentIntro,
  noMatch,
  dailyCap,
  vendorUnavailable
};
