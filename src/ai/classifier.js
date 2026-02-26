require('dotenv').config();
const OpenAI = require('openai').default;
const { client: groqClient } = require('./client');
const { inferIntentFromPatterns, normalizeModelIntent } = require('./intent-edge-cases');

const kimiBaseUrl = (process.env.KIMI_BASE_URL || '').trim().replace(/\/$/, '');
const kimi = process.env.KIMI_API_KEY && kimiBaseUrl
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: kimiBaseUrl })
  : null;
const kimiModel = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';

const VALID_INTENTS = ['QUERY', 'PURCHASE', 'NEGOTIATE', 'CANCEL', 'CONFIRM', 'IGNORE', 'OTHER'];

async function classifyIntent(message, sessionContext = {}, history = [], vendor = null) {
  const state = sessionContext.intent_state;
  const lastItem = sessionContext.last_item_name;

  const fastIntent = inferIntentFromPatterns(message, sessionContext);
  if (fastIntent) return fastIntent;

  const categoryContext = (vendor && vendor.category && vendor.business_name)
    ? `Context: This is a ${vendor.category} store called ${vendor.business_name}.\n\n`
    : '';

  const contextHints = [];
  if (state === 'awaiting_payment') contextHints.push('Buyer already has payment link. "resend", "link", "yes", "pay" = CONFIRM.');
  if (state === 'querying' || state === 'selecting_item') contextHints.push('Buyer was just shown product(s). "yes", "that one", "send link", "ok", "number 2", "the first one" = PURCHASE or CONFIRM.');
  if (state === 'negotiating') contextHints.push('Haggling. A number = NEGOTIATE; "ok/deal/yes" = CONFIRM.');
  if (lastItem) contextHints.push(`Last item: "${lastItem}". "it", "that one", "how much", "price", "send link" refer to this → PURCHASE/CONFIRM or QUERY.`);
  const contextBlock = contextHints.length ? contextHints.join(' ') : '(No special context.)';

  const recentChat = history.slice(-6).map(m =>
    `${m.role === 'buyer' ? 'Person' : 'Bot'}: ${m.text}`
  ).join('\n');
  const historyContext = recentChat ? `\nRecent conversation:\n${recentChat}\n` : '';

  const classifierRules = categoryContext ? [
    'RULES: "How much" alone = QUERY, not PURCHASE. "Yes" after seeing a product = PURCHASE. "Yes" after a question = CONFIRM. "Abeg reduce am" = NEGOTIATE. "E don finish?" = QUERY. Anything about delivery, location, timing = QUERY. Personal questions, greetings alone, random messages = OTHER. Reply ONE word only.'
  ] : [];

  const systemPrompt = [
    categoryContext,
    '## TASK',
    'Classify the user message into ONE intent. Be robust: typos, Nigerian English, Pidgin, slang ("abeg", "oya", "nau", "guy", "bro"), partial words, and vague refs are normal. When it could be about products or buying, choose a commerce intent (QUERY/PURCHASE/CONFIRM/NEGOTIATE). Use IGNORE only when clearly unrelated.',
    '',
    '## INTENTS (exactly one word)',
    'QUERY — Product/stock/delivery/buying enquiry. Examples: "what you get?", "how much?", "you have X?", "delivery?", "where to pick?", "send to lekki?", "just checking", "browsing", "show me", "what else?", "do you have", "anything like", "hi do you have phones", "hello price of airpods", "oya what you sell", "abeg wetin you get", "I need something", "looking for", "any black one", "size 42?", "still available?".',
    'PURCHASE — Ready to buy (any phrasing). Examples: "I\'ll take it", "send link", "gimme that", "I want am", "yes", "ok", "go ahead", "abeg send link", "I\'ll pay", "that one", "the first one", "number 2", "option 1", "send payment", "pay now", "i want that one", "make i get am", "i go collect".',
    'NEGOTIATE — Price/offer. Examples: "your last price", "reduce am", "discount?", "can you do 20k?", "15 thousand", "18000", "cheaper?", "abeg reduce", "final price?", "what your last?".',
    'CANCEL — Not interested / stop. Examples: "forget it", "maybe later", "cancel", "no thanks", "no wahala", "next time", "changed my mind", "leave it", "start over".',
    'CONFIRM — Agreeing. Examples: "yes", "ok", "deal", "sure", "nau", "fine", "go", "alright", "done", "accepted".',
    'OTHER — Unclear but could be shopping. Use when borderline; prefer over IGNORE.',
    'IGNORE — Clearly not commerce: only greetings with no product hint, jokes, news, spam. Pure "hi"/"hello" with nothing else → IGNORE.',
    '',
    '## EDGE CASES (robust)',
    '- "how much" / "price" / "amount" with last item in context → QUERY or CONFIRM (they want to proceed).',
    '- "send link" / "link" / "resend" → PURCHASE or CONFIRM.',
    '- "delivery to X" / "pickup at Y" / "send to lekki" → QUERY (or PURCHASE if they already chose item).',
    '- "something else" / "another one" / "different thing" → QUERY.',
    '- Single number (e.g. 15000) in negotiation → NEGOTIATE; in list context could be SELECT (handled elsewhere).',
    '- "that one" / "this one" / "it" with context → PURCHASE or CONFIRM.',
    '- Greeting + anything about product ("hi price", "hello you have") → QUERY.',
    '- One word that could be product name ("sneakers", "airpods") → QUERY.',
    '- Typos / Pidgin: interpret intent; e.g. "wetin you get", "i wan buy", "how much be dis" → QUERY or PURCHASE.',
    '',
    '## CONTEXT',
    contextBlock,
    historyContext || '',
    '',
    '## OUTPUT',
    'Reply with ONLY one word: QUERY, PURCHASE, NEGOTIATE, CANCEL, CONFIRM, IGNORE, or OTHER. No punctuation, no explanation.',
    ...classifierRules
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905');

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
    const raw = (res.choices[0].message.content || '').trim();
    return normalizeModelIntent(raw);
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      console.warn('[classifier] Kimi returned 404, using Groq. Deploy the model at https://build.nvidia.com and set KIMI_MODEL=moonshotai/kimi-k2.5');
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905',
        max_tokens: 15,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim();
      return normalizeModelIntent(raw);
    }
    throw err;
  }
}

/** Local fallback: extract first number from text; handle 20k, 5k, 15,000, etc. */
function parsePriceFromText(text) {
  if (!text || typeof text !== 'string') return 0;
  const t = text.trim();
  const kMatch = t.match(/(\d{1,4})\s*k\b/i);
  if (kMatch) return parseInt(kMatch[1], 10) * 1000;
  const thousandMatch = t.match(/(\d{1,4})\s*thousand/i);
  if (thousandMatch) return parseInt(thousandMatch[1], 10) * 1000;
  const numMatch = t.match(/₦?\s*(\d{1,3}(?:,\d{3})*|\d+)/);
  if (numMatch) return parseInt(numMatch[1].replace(/,/g, ''), 10);
  return 0;
}

async function extractOffer(message) {
  const localPrice = parsePriceFromText(message);
  const systemPrompt = [
    '## TASK',
    'Extract the price in Naira the buyer is offering. Return ONLY the number, no currency, no commas, no words.',
    '',
    '## EDGE CASES & EXAMPLES',
    '20k / 20K → 20000',
    '5k → 5000',
    '15,000 / 15000 → 15000',
    '₦18000 / N18000 → 18000',
    '20 thousand → 20000',
    'one hundred thousand → 100000 (if you can; else 0)',
    'Can I get it for 20k? → 20000',
    'I\'ll pay 15,000 → 15000',
    'Give me last price → 0',
    'How about 18k? → 18000',
    'abeg 25k → 25000',
    'make am 30 thousand → 30000',
    'No number / no price → 0'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905');

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
    const modelPrice = isNaN(num) ? 0 : num;
    return modelPrice > 0 ? modelPrice : (localPrice || 0);
  } catch (err) {
    if (useKimi && groqClient && (err.status === 404 || err.response?.status === 404 || String(err.message || '').includes('404'))) {
      const res = await groqClient.chat.completions.create({
        model: process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905',
        max_tokens: 20,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim();
      const num = parseInt(raw.replace(/[^0-9]/g, ''), 10);
      const modelPrice = isNaN(num) ? 0 : num;
      return modelPrice > 0 ? modelPrice : (localPrice || 0);
    }
    return localPrice || 0;
  }
}

async function matchProducts(message, inventory) {
  if (!inventory.length) return [];

  const catalog = inventory.map((item, i) =>
    `  ${i}: ${item.name} (${item.category || 'general'})`
  ).join('\n');

  const systemPrompt = [
    '## TASK',
    'Match the buyer message to product INDEX numbers from the catalog. Be robust: typos, partial names, Nigerian English, and vague refs are normal.',
    '',
    '## CATALOG (index: name category)',
    catalog,
    '',
    '## MATCHING RULES',
    '- Match by name and category. "airpods" / "air pod" / "earbuds" → audio/earphone items only. "sneakers" / "shoe" / "footwear" → shoes only. "phone" / "iphone" / "samsung" → phones.',
    '- Partial and typo-friendly: "sneaker", "snickers", "airpod", "iphone 12", "black bag" → match closest items.',
    '- "the black one", "size 42", "red", "cheapest" → if catalog has such variants, include them; else match by main product type.',
    '- Return up to 5 matches, best first. Format: comma-separated index numbers, e.g. 0,4,9',
    '- If message is not about a product (e.g. "yes", "how much", "cancel") or no catalog item matches, return exactly: NONE',
    '- Vague but product-ish ("something for running", "gift for her") → return any plausible match from catalog, or NONE if nothing fits.',
    '',
    '## OUTPUT',
    'Either: NONE — or — index numbers only, e.g. 0,2,5. No other text.'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905');

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
        model: process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905',
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

function inferListContextIntent(userMessage, listItemNames = []) {
  const t = (userMessage || '').toLowerCase().trim();
  if (!t) return null;
  if (/^(cancel|forget it|never mind|no thanks|not now|leave it|stop|abort|start over|next time)$/i.test(t)) return 'CANCEL';
  if (/(send|resend|show)\s*(the\s*)?list|(can't|cannot)\s*see|didn't get|need (the )?list|list (again|please)|options\?|what options/i.test(t)) return 'WANT_LIST_AGAIN';
  if (/^(1|2|3|4|5|6|7|8|9|10)\s*[.)]?\s*$/.test(t)) return 'SELECT_ITEM';
  if (/^(first|second|third|1st|2nd|3rd)\s*one|number\s*[1-9]|option\s*[1-9]|(the\s*)?(first|second|third|one|that one|this one)$/i.test(t)) return 'SELECT_ITEM';
  const nameFromList = listItemNames.length && listItemNames.some(name => name && t.includes((name || '').toLowerCase().slice(0, 8)));
  if (nameFromList) return 'SELECT_ITEM';
  return null;
}

/**
 * When the buyer was just shown a list of items, classify what they mean now.
 * Robust: typos, "I can't see", "something else", "the second one", product names from list.
 */
async function classifyListContextIntent(userMessage, listItemNames = []) {
  const fast = inferListContextIntent(userMessage, listItemNames);
  if (fast) return fast;

  const listPreview = listItemNames.length > 0
    ? `The list they were shown had items like: ${listItemNames.slice(0, 5).join(', ')}.`
    : 'They were shown a list of options to pick from.';

  const systemPrompt = [
    '## CONTEXT',
    'WhatsApp seller chat. The bot just sent a list of products (e.g. "Reply 1–10 or tap to pick").',
    listPreview,
    '',
    '## TASK',
    'Classify into ONE intent. Be robust: typos, Pidgin, vague refs.',
    '',
    'CANCEL — Stop / not interested: "cancel", "forget it", "maybe later", "no thanks", "not now", "never mind", "start over", "leave it", "next time".',
    'WANT_LIST_AGAIN — Want list again or didn\'t get it: "send the list", "I need a list", "I can\'t see the list", "show me again", "resend", "what options?", "list please", "didn\'t receive", "send again", "options?".',
    'NEW_QUESTION — Different product / new request: "what else do you have?", "do you have X?", "I want Y", "show me other things", "anything else?", "something different", "any phones?", new product name.',
    'SELECT_ITEM — Choosing from list: number 1–10, "that one", "the first one", "the second one", "number 3", "option 2", item name that appears in the list.',
    '',
    '## EDGE CASES',
    '- "something else" / "another one" without naming product → WANT_LIST_AGAIN or NEW_QUESTION (either is fine; WANT_LIST_AGAIN = show same list again).',
    '- "I can\'t see" / "didn\'t get the list" → WANT_LIST_AGAIN.',
    '- "what else" / "do you have sneakers?" → NEW_QUESTION.',
    '- Single digit 1–10 or "number 2" → SELECT_ITEM.',
    '- Item name that matches something in the list → SELECT_ITEM.',
    '',
    '## OUTPUT',
    'Only one word: CANCEL, WANT_LIST_AGAIN, NEW_QUESTION, or SELECT_ITEM.'
  ].join('\n');

  const useKimi = !!kimi;
  const client = kimi || groqClient;
  const model = useKimi ? kimiModel : (process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905');

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
        model: process.env.GROQ_MODEL || 'moonshotai/kimi-k2-instruct-0905',
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

module.exports = { classifyIntent, extractOffer, matchProducts, classifyListContextIntent, parsePriceFromText };
