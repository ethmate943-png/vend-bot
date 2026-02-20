const { client } = require('./client');

const VALID_INTENTS = ['QUERY', 'PURCHASE', 'NEGOTIATE', 'CANCEL', 'CONFIRM', 'IGNORE', 'OTHER'];

async function classifyIntent(message, sessionContext = {}, history = []) {
  const contextHint = sessionContext.intent_state === 'awaiting_payment'
    ? 'The buyer has already been sent a payment link.'
    : sessionContext.intent_state === 'querying'
    ? 'The buyer was just shown product info.'
    : '';

  const recentChat = history.slice(-5).map(m =>
    `${m.role === 'buyer' ? 'Person' : 'Bot'}: ${m.text}`
  ).join('\n');

  const historyContext = recentChat ? `\nRecent conversation:\n${recentChat}\n` : '';

  const systemPrompt = [
    '## TASK',
    'Classify the user message into exactly one intent. This WhatsApp is used for both shopping and personal chat.',
    '',
    '## INTENTS (choose one)',
    'QUERY — Asking about products: availability, price, details, what\'s in stock.',
    'PURCHASE — Ready to buy: wants to order, saying yes to buying, "I\'ll take it".',
    'NEGOTIATE — Asking for lower price, discount, or better deal.',
    'CANCEL — No longer interested, wants to cancel an order.',
    'CONFIRM — Confirming in a buying context: yes, okay, done, sure (after product/payment discussion).',
    'IGNORE — Personal chat only: greetings, gossip, jokes, news, or anything not about buying/selling. When in doubt, use IGNORE.',
    'OTHER — Unclear but possibly commerce-related.',
    '',
    '## CONTEXT',
    contextHint || '(No special context.)',
    historyContext || '',
    '',
    '## RULES',
    '1. If there is NO prior commerce context in the conversation (no product or bot replies about items/prices), reply IGNORE.',
    '2. Reply with ONLY the intent word: one of QUERY, PURCHASE, NEGOTIATE, CANCEL, CONFIRM, IGNORE, OTHER.',
    '3. No punctuation. No explanation. No other text.'
  ].join('\n');

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 10,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ]
  });

  const intent = res.choices[0].message.content.trim().toUpperCase();
  return VALID_INTENTS.includes(intent) ? intent : 'IGNORE';
}

async function extractOffer(message) {
  const systemPrompt = [
    '## TASK',
    'Extract the price (in Naira) the buyer is offering. Return ONLY the number.',
    '',
    '## OUTPUT',
    'Single integer. No currency symbol, no commas, no text. If no price is mentioned, return 0.',
    '',
    '## EXAMPLES',
    'Can I get it for 20k? → 20000',
    'I\'ll pay 15,000 → 15000',
    'Give me last price → 0',
    'How about ₦18000? → 18000',
    'Can you do 5k? → 5000',
    '20 thousand → 20000'
  ].join('\n');

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 15,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ]
  });

  const num = parseInt(res.choices[0].message.content.trim().replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

async function matchProducts(message, inventory) {
  if (!inventory.length) return [];

  const catalog = inventory.map((item, i) =>
    `  ${i}: ${item.name} (${item.category || 'general'})`
  ).join('\n');

  const systemPrompt = [
    '## TASK',
    'Match the buyer message to product INDEX numbers from the catalog. Return only index numbers or NONE.',
    '',
    '## CATALOG (index: name category)',
    catalog,
    '',
    '## MATCHING RULES',
    '- Match by category, keyword, synonym, or description.',
    '- sneakers / shoes / slides → footwear.',
    '- earbuds / headphones / airpods / galaxy buds → audio.',
    '- bag / tote / handbag → bags.',
    '- dress / clothes / jacket / fabric → apparel.',
    '- chain / jewelry / necklace → accessories.',
    '- Return up to 3 matches, best first. Format: comma-separated numbers, e.g. 0,4,9',
    '- If nothing matches, return exactly: NONE',
    '',
    '## OUTPUT',
    'Either: NONE — or — index numbers only, e.g. 0,2,5. No other text.'
  ].join('\n');

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 30,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ]
  });

  const raw = res.choices[0].message.content.trim();
  if (raw === 'NONE') return [];

  return raw.split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(i => !isNaN(i) && i >= 0 && i < inventory.length)
    .map(i => inventory[i]);
}

module.exports = { classifyIntent, extractOffer, matchProducts };
