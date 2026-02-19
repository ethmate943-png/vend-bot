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

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 10,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: `This is a WhatsApp account used by a vendor who also chats personally with friends and family. You must decide if a message is about SHOPPING or just NORMAL CHAT.

Read the recent conversation history carefully to understand context.

Classify the message into exactly one intent:
QUERY - asking about product availability, details, price, or what's in stock
PURCHASE - ready to buy, wants to order, saying yes to buying
NEGOTIATE - asking for a lower price, discount, or better deal
CANCEL - no longer interested in buying, wants to cancel an order
CONFIRM - confirming a purchase or delivery (yes, okay, done, sure) in a buying context
IGNORE - normal personal chat, greetings, gossip, jokes, news, or anything NOT related to buying/selling products. If unsure, choose IGNORE.
OTHER - unclear but might be commerce-related
${contextHint}${historyContext}
IMPORTANT: If the conversation history shows NO prior commerce context (no product discussion, no bot replies about items/prices), default to IGNORE.

Reply with ONLY the intent word. No punctuation. No explanation.`
      },
      { role: 'user', content: message }
    ]
  });

  const intent = res.choices[0].message.content.trim().toUpperCase();
  return VALID_INTENTS.includes(intent) ? intent : 'IGNORE';
}

async function extractOffer(message) {
  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 15,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Extract the price the buyer is offering from their message.
Return ONLY the number (no currency symbol, no commas).
If no specific price is mentioned, return 0.
Examples:
"Can I get it for 20k?" → 20000
"I'll pay 15,000" → 15000
"Give me last price" → 0
"How about ₦18000?" → 18000
"Can you do 5k?" → 5000`
      },
      { role: 'user', content: message }
    ]
  });

  const num = parseInt(res.choices[0].message.content.trim().replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

async function matchProducts(message, inventory) {
  if (!inventory.length) return [];

  const catalog = inventory.map((item, i) =>
    `${i}: ${item.name} (${item.category || 'general'})`
  ).join('\n');

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    max_tokens: 30,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You are a product matcher. Given a buyer's message and a product catalog, return the INDEX numbers of products that match what the buyer is looking for.

Rules:
- Match by category, type, keyword, synonym, or description
- "sneakers" matches any shoes/sneakers/slides
- "earbuds" or "headphones" matches airpods, galaxy buds, etc.
- "bag" matches tote bag, handbag, etc.
- "dress" or "clothes" matches dresses, jackets, fabric, etc.
- "chain" or "jewelry" matches necklaces, chains, etc.
- Return ONLY comma-separated index numbers (e.g. "0,4,9")
- If nothing matches, return "NONE"
- Max 3 matches, best match first

Catalog:
${catalog}`
      },
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
