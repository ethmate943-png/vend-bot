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
  'Reply with the number (1 to {{max}}) or just tell me what you\'re looking for 😊',
  'Pick a number from 1 to {{max}}, or say what you want and I\'ll help.',
  'You can type the number or tell me what you need — 1 to {{max}}.',
  'Tap the button or reply with a number (1–{{max}}). Or just describe what you want.'
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
  'You already have a payment link for *{{itemName}}* 😊 Reply *resend* if you need it again, or use the one I sent. No stress!',
  'Link for *{{itemName}}* was already sent — check your chat. Reply *resend* and I\'ll send it again.',
  'We already sent you the link for *{{itemName}}*. Want it again? Just say *resend*.'
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
  'Tap the button below or reply with a number.',
  'Pick one below or reply with the number.',
  'Tap to select or type the number.'
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
