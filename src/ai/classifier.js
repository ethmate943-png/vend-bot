require('dotenv').config();
const OpenAI = require('openai').default;
const { client: groqClient } = require('./client');

const kimiBaseUrl = (process.env.KIMI_BASE_URL || '').trim().replace(/\/$/, '');
const kimi = process.env.KIMI_API_KEY && kimiBaseUrl
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: kimiBaseUrl })
  : null;
const kimiModel = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';

const VALID_INTENTS = ['QUERY', 'PURCHASE', 'NEGOTIATE', 'CANCEL', 'CONFIRM', 'IGNORE', 'OTHER'];

async function classifyIntent(message, sessionContext = {}, history = []) {
  const state = sessionContext.intent_state;
  const lastItem = sessionContext.last_item_name;

  const contextHints = [];
  if (state === 'awaiting_payment') contextHints.push('The buyer has already been sent a payment link. "resend", "link", "yes" = still buying.');
  if (state === 'querying' || state === 'selecting_item') contextHints.push('The buyer was just shown product(s). Short replies like "yes", "that one", "I\'ll take it", "send link", "ok" = ready to buy (PURCHASE or CONFIRM).');
  if (state === 'negotiating') contextHints.push('They are haggling. A number or "ok/deal" = NEGOTIATE or CONFIRM.');
  if (lastItem) contextHints.push(`Last item discussed: "${lastItem}". Vague refs like "it", "that one", "how much", "price" refer to this.`);
  const contextBlock = contextHints.length ? contextHints.join(' ') : '(No special context.)';

  const recentChat = history.slice(-6).map(m =>
    `${m.role === 'buyer' ? 'Person' : 'Bot'}: ${m.text}`
  ).join('\n');
  const historyContext = recentChat ? `\nRecent conversation:\n${recentChat}\n` : '';

  const systemPrompt = [
    '## TASK',
    'Classify the user message. Only commerce and product-related messages get a reply. Everything else gets IGNORE.',
    '',
    '## INTENTS (choose one)',
    'QUERY — Clear product enquiry: asking what\'s in stock, prices, "what do you have?", "how much?", delivery, size, or anything about products/stock.',
    'PURCHASE — Ready to buy: "I\'ll take it", "send link", "I want that", "I\'ll pay", "give me one", "yes" (after product was shown).',
    'NEGOTIATE — Price negotiation: lower price, discount, "your last price", or offering a number.',
    'CANCEL — No longer interested: "forget it", "maybe later", "cancel", "no thanks".',
    'CONFIRM — Agreeing in a buying context: "yes", "ok", "deal", "go ahead" (after price/product discussion).',
    'IGNORE — Not commerce: greetings only (hi, hello), small talk, jokes, news, random statements, or anything that does NOT ask about products, prices, or buying. Use IGNORE whenever the message has no product/price/purchase content.',
    'OTHER — Unclear but could be a product question (e.g. one word that might mean an item). If clearly no product/purchase intent, use IGNORE instead.',
    '',
    '## CONTEXT',
    contextBlock,
    historyContext || '',
    '',
    '## RULES (only commerce gets a reply)',
    '1. If the message is only a greeting (hi, hello, hey) or general chat with no product/price/buying mention → IGNORE.',
    '2. If they ask about products, stock, price, delivery, or say they want to buy → QUERY, PURCHASE, CONFIRM, or NEGOTIATE.',
    '3. After the bot showed an item/price, short "yes", "ok", "send link", "that one" → PURCHASE or CONFIRM.',
    '4. When in doubt whether it\'s about products/buying → use IGNORE. We only respond to commerce-related and product enquiries.',
    '5. Reply with ONLY one word: QUERY, PURCHASE, NEGOTIATE, CANCEL, CONFIRM, IGNORE, or OTHER. No punctuation.'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'llama-3.1-8b-instant');

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 15,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });
    const raw = (res.choices[0].message.content || '').trim().toUpperCase();
    const intent = raw.split(/[\s.,]/)[0];
    return VALID_INTENTS.includes(intent) ? intent : 'IGNORE';
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      console.warn('[classifier] Kimi returned 404, using Groq. Deploy the model at https://build.nvidia.com and set KIMI_MODEL=moonshotai/kimi-k2.5');
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        max_tokens: 15,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim().toUpperCase();
      const intent = raw.split(/[\s.,]/)[0];
      return VALID_INTENTS.includes(intent) ? intent : 'IGNORE';
    }
    throw err;
  }
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

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'llama-3.1-8b-instant');

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 20,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });
    const raw = (res.choices[0].message.content || '').trim();
    const num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    return isNaN(num) ? 0 : num;
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        max_tokens: 20,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim();
      const num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
      return isNaN(num) ? 0 : num;
    }
    throw err;
  }
}

async function matchProducts(message, inventory) {
  if (!inventory.length) return [];

  const catalog = inventory.map((item, i) =>
    `  ${i}: ${item.name} (${item.category || 'general'})`
  ).join('\n');

  const systemPrompt = [
    '## TASK',
    'Match the buyer message to product INDEX numbers from the catalog. Return ONLY products that directly match what they asked for.',
    '',
    '## CATALOG (index: name category)',
    catalog,
    '',
    '## MATCHING RULES',
    '- Only return items that match what the buyer asked for. If they say "airpods" return ONLY airpod/earbud/headphone items, NOT sneakers or bags.',
    '- If they say "sneakers" or "shoes" return ONLY footwear. If they say "airpods" return ONLY audio/earbud items.',
    '- Match by product name and category. Do NOT return unrelated items.',
    '- Return up to 5 matches, best first. Format: comma-separated index numbers, e.g. 0,4,9',
    '- If no product matches what they asked for, return exactly: NONE',
    '',
    '## OUTPUT',
    'Either: NONE — or — index numbers only, e.g. 0,2,5. No other text.'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'llama-3.1-8b-instant');

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 40,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ]
    });
    const raw = (res.choices[0].message.content || '').trim();
    if (raw.toUpperCase() === 'NONE') return [];
    return raw.split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(i => !isNaN(i) && i >= 0 && i < inventory.length)
      .map(i => inventory[i]);
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        max_tokens: 40,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim();
      if (raw.toUpperCase() === 'NONE') return [];
      return raw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(i => !isNaN(i) && i >= 0 && i < inventory.length)
        .map(i => inventory[i]);
    }
    throw err;
  }
}

const LIST_CONTEXT_LABELS = ['CANCEL', 'WANT_LIST_AGAIN', 'NEW_QUESTION', 'SELECT_ITEM'];

/**
 * When the buyer was just shown a list of items, classify what they mean now.
 * Use this instead of regexes so any phrasing works (e.g. "I can't see the list", "something else", "show me again").
 * Returns one of: CANCEL, WANT_LIST_AGAIN, NEW_QUESTION, SELECT_ITEM.
 */
async function classifyListContextIntent(userMessage, listItemNames = []) {
  const listPreview = listItemNames.length > 0
    ? `The list they were shown had items like: ${listItemNames.slice(0, 5).join(', ')}.`
    : 'They were shown a list of options to pick from.';

  const systemPrompt = [
    '## CONTEXT',
    'The user is in a WhatsApp chat with a seller. The bot just sent them a list of products to choose from (e.g. "Reply 1–10 or tap to pick").',
    listPreview,
    '',
    '## TASK',
    'Classify the user\'s message into ONE of these intents:',
    '',
    'CANCEL — They want to stop / not buy / not interested: "cancel", "forget it", "maybe later", "no thanks", "not now", "never mind", "start over", etc.',
    'WANT_LIST_AGAIN — They want to see the list again or didn\'t get it: "send the list", "I need a list", "I can\'t see the list", "show me again", "something else", "what options?", "resend", etc.',
    'NEW_QUESTION — They\'re asking for something different or browsing: "what else do you have?", "do you have X?", "I want to look at Y", "show me other things", "anything else?", new product request, etc.',
    'SELECT_ITEM — They are choosing from the list: a number (1–10), an item name from the list, "that one", "the first one", "I\'ll take number 3", etc.',
    '',
    '## RULES',
    '1. Reply with ONLY one word: CANCEL, WANT_LIST_AGAIN, NEW_QUESTION, or SELECT_ITEM.',
    '2. When in doubt between WANT_LIST_AGAIN and NEW_QUESTION: "show list again" / "can\'t see" = WANT_LIST_AGAIN; "what else" / "do you have X" = NEW_QUESTION.',
    '3. If they say they want something else or a different thing but don\'t name a product, prefer WANT_LIST_AGAIN (show list again) or NEW_QUESTION (what do you have) depending on wording.'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'llama-3.1-8b-instant');

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 10,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });
    const raw = (res.choices[0].message.content || '').trim().toUpperCase();
    const label = raw.split(/[\s.,]/)[0];
    return LIST_CONTEXT_LABELS.includes(label) ? label : 'SELECT_ITEM';
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        max_tokens: 10,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim().toUpperCase();
      const label = raw.split(/[\s.,]/)[0];
      return LIST_CONTEXT_LABELS.includes(label) ? label : 'SELECT_ITEM';
    }
    throw err;
  }
}

module.exports = { classifyIntent, extractOffer, matchProducts, classifyListContextIntent };
