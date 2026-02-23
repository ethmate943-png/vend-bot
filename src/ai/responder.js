require('dotenv').config();
const OpenAI = require('openai').default;
const { getExamplesBlock, getAntiConfusionBlock, getHumanStyleBlock, sanitizeReply } = require('./voice-examples');

const kimiBaseUrl = (process.env.KIMI_BASE_URL || '').trim().replace(/\/$/, '');
const kimi = process.env.KIMI_API_KEY && kimiBaseUrl
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: kimiBaseUrl })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';
const maxReplyTokens = Math.min(2048, Math.max(340, parseInt(process.env.KIMI_REPLY_MAX_TOKENS || '600', 10) || 600));

async function generateReply(buyerMessage, inventory, vendorName, history = [], sessionContext = {}) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i => {
        const scarcity = i.quantity === 1 ? ' — LAST ONE' : i.quantity <= 3 ? ` — only ${i.quantity} left` : '';
        return `  • ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}${scarcity}`;
      }).join('\n')
    : '  (No items in stock.)';

  const contextBlock = history?.length
    ? '\n## RECENT CHAT\n' + history.slice(-5).map(m => `  ${m.role}: ${m.text}`).join('\n')
    : '';

  const lastItem = sessionContext.last_item_name;
  const lastPrice = sessionContext.last_item_price;
  const lastItemBlock = lastItem
    ? `\n## LAST ITEM DISCUSSED\n  "${lastItem}"${lastPrice != null ? ` at ₦${Number(lastPrice).toLocaleString()}` : ''}. Use this when the buyer says "it", "that one", "how much again?", "price?", or "I\'ll take it" without naming the product.\n`
    : '';

  const examplesBlock = getExamplesBlock();
  const antiConfusionBlock = getAntiConfusionBlock();

  const systemPromptKimi = [
    '## ROLE',
    `You're the WhatsApp sales assistant for ${vendorName} in Nigeria. Reply like a real person texting — warm, natural, no corporate speak.`,
    '',
    '## TONE',
    'Warm, natural Nigerian English. Short sentences when possible. Repeat item name and price when it helps. Handle vague refs ("it", "that one") and typos using context.',
    getHumanStyleBlock(),
    lastItemBlock,
    examplesBlock,
    '## RULES',
    '1. Only mention items from the inventory below. Never invent products or prices.',
    '2. If an item has quantity 1, say "last one remaining" or similar.',
    '3. Always use ₦ for prices. Do not make up stock or discounts.',
    '4. If the buyer asks for something not in stock, say so and suggest similar items from the list if any.',
    '5. When they say "that one", "it", "how much again?" use the last item discussed if it fits.',
    antiConfusionBlock,
    contextBlock,
    '## INVENTORY',
    inventoryText
  ].join('\n');

  const is404 = (err) => err?.status === 404 || err?.response?.status === 404 || String(err?.message || '').includes('404');

  const runGroq = async () => {
    const { client } = require('./client');
    const systemPromptGroq = [
      `## ROLE: You're the WhatsApp sales assistant for ${vendorName}. Reply like a real person texting — natural Nigerian English, short sentences.`,
      getHumanStyleBlock(),
      lastItemBlock,
      examplesBlock,
      '## RULES: Use only the inventory below. Be generous: 2–4 sentences, repeat item/price when helpful. No invented products or prices. Use last item discussed for "it", "that one", "k", "how much again?".',
      antiConfusionBlock,
      '## INVENTORY:',
      inventoryText
    ].join('\n');
    const messages = [{ role: 'system', content: systemPromptGroq }];
    for (const msg of (history || []).slice(-6)) {
      messages.push({ role: msg.role === 'buyer' ? 'user' : 'assistant', content: msg.text });
    }
    messages.push({ role: 'user', content: buyerMessage });
    const res = await client.chat.completions.create({
      model: process.env.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile',
      max_tokens: maxReplyTokens,
      temperature: 0.6,
      messages
    });
    return (res.choices[0].message.content || '').trim();
  };

  let raw = '';
  if (kimi) {
    try {
      const res = await kimi.chat.completions.create({
        model,
        max_tokens: maxReplyTokens,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPromptKimi },
          { role: 'user', content: buyerMessage }
        ]
      });
      raw = (res.choices[0].message.content || '').trim();
    } catch (err) {
      if (is404(err)) {
        console.warn('[responder] Kimi returned 404, using Groq. Deploy the model at https://build.nvidia.com and set KIMI_MODEL=moonshotai/kimi-k2.5');
        raw = await runGroq();
      } else {
        throw err;
      }
    }
  } else {
    raw = await runGroq();
  }

  const out = sanitizeReply(raw, vendorName);
  return out !== null ? out : raw;
}

/**
 * Natural cancel reply + invite to ask what we have. Uses Kimi K2.
 */
async function generateCancelReply(buyerMessage, inventory, vendorName) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i => `  • ${i.name}: ₦${i.price.toLocaleString()}${i.quantity != null ? ` (${i.quantity} left)` : ''}`).join('\n')
    : '  (No items in stock.)';

  const systemPrompt = [
    `## ROLE`,
    `You're the WhatsApp sales assistant for ${vendorName} in Nigeria. The customer just cancelled or said they're not buying right now.`,
    '',
    '## TASK',
    'Reply in one short, natural message (2–4 sentences) that:',
    '1. Acknowledges them warmly (no problem, no wahala, anytime, etc.).',
    '2. Invites them to ask what you have in stock when they\'re ready — e.g. "Just ask what we have or what you\'re looking for."',
    '3. Optionally mention 1–2 example items from the inventory below if it feels natural.',
    getHumanStyleBlock(),
    '## TONE',
    'Warm, casual Nigerian English. No pressure. Sound like a person texting, not a script.',
    '',
    '## INVENTORY (for reference; you may mention a couple)',
    inventoryText
  ].join('\n');

  const userPrompt = `Customer said: "${buyerMessage}"\n\nGenerate your reply.`;

  if (kimi) {
    try {
      const res = await kimi.chat.completions.create({
        model,
        max_tokens: maxReplyTokens,
        temperature: 0.5,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });
      const raw = (res.choices[0].message.content || '').trim();
      const out = sanitizeReply(raw, vendorName);
      return out !== null ? out : raw;
    } catch (e) {
      const is404 = e?.status === 404 || e?.response?.status === 404 || String(e?.message || '').includes('404');
      if (is404) {
        console.warn('[responder] Kimi 404 in generateCancelReply, using Groq');
        try {
          const { client } = require('./client');
          const res = await client.chat.completions.create({
            model: process.env.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile',
            max_tokens: maxReplyTokens,
            temperature: 0.5,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ]
          });
          const raw = (res.choices[0].message.content || '').trim();
          const out = sanitizeReply(raw, vendorName);
          return out !== null ? out : raw;
        } catch (groqErr) {
          console.warn('[responder] Groq fallback failed:', groqErr?.message || groqErr);
        }
      } else {
        console.warn('[responder] generateCancelReply failed:', e?.message || e);
      }
    }
  }
  return "No problem at all! When you're ready, just ask what we have or what you're looking for. 😊";
}

/**
 * Natural reply when customer asks "what do you have" / "show me stuff" — full catalog summary. Uses Kimi K2.
 */
async function generateCatalogReply(buyerMessage, inventory, vendorName, history = []) {
  return generateReply(buyerMessage, inventory, vendorName, history, {});
}

module.exports = { generateReply, generateCancelReply, generateCatalogReply };
