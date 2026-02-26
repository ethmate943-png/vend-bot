require('dotenv').config();
const OpenAI = require('openai').default;
const { getExamplesBlock, getAntiConfusionBlock, getHumanStyleBlock, sanitizeReply } = require('./voice-examples');

const kimiBaseUrl = (process.env.KIMI_BASE_URL || '').trim().replace(/\/$/, '');
const kimi = process.env.KIMI_API_KEY && kimiBaseUrl
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: kimiBaseUrl })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';
const maxReplyTokens = Math.min(2048, Math.max(340, parseInt(process.env.KIMI_REPLY_MAX_TOKENS || '600', 10) || 600));

/** Build full system prompt from vendor profile + inventory. Used when vendor has completed discovery (category, location, etc.). */
function buildSystemPrompt(vendor, inventory) {
  const name = vendor.business_name || 'the store';
  const category = vendor.category || 'General';
  const location = vendor.location || 'Nigeria';

  const toneGuide = {
    professional: 'Speak formally. No slang. Short sentences. Sound like a customer service rep at a real company.',
    friendly: 'Warm, casual Nigerian English. Like a helpful friend who works at the shop.',
    playful: 'Light, fun energy. Can use emojis occasionally. Not loud — just easy to talk to.',
    pidgin: 'Mix English and Pidgin naturally. "How much be this one?", "e still dey available", "I go check for you". Match the buyer\'s energy — if they write in English, lean English. If they go full Pidgin, match it.'
  }[vendor.tone] || 'Warm, casual Nigerian English.';

  const deliveryGuide = {
    nationwide: 'You deliver anywhere in Nigeria.',
    local: `You only deliver within ${location}. If a buyer is outside ${location}, tell them honestly and suggest they check for a pickup option.`,
    pickup: `No delivery. Buyers must pick up from ${location}. Do not suggest delivery is possible.`,
    depends: 'Delivery depends on the order. Tell buyers to confirm their location before paying so you can advise.'
  }[vendor.delivery_coverage] || 'Delivery details depend on the order.';

  const inventoryText = inventory.length > 0
    ? inventory.map(i =>
        `- ${i.name} | SKU: ${i.sku} | Price: ₦${i.price.toLocaleString()} | Stock: ${i.quantity}${i.description ? ` | Specs: ${i.description}` : ''}${i.category ? ` | Type: ${i.category}` : ''}`
      ).join('\n')
    : 'No items currently in stock.';

  const turnaroundLine = vendor.turnaround
    ? `9. NEVER promise a delivery timeline unless vendor turnaround is set. If it is set, use it exactly: "${vendor.turnaround}".`
    : '9. Do not promise specific delivery times unless the vendor has set a turnaround.';

  return `You are the WhatsApp sales assistant for ${name}, a ${category} business based in ${location}.

TONE:
${toneGuide}

YOUR JOB:
- Answer questions about products in the inventory below
- Help buyers find what they need
- Generate trust by being specific, honest, and consistent
- Move buyers toward a purchase decision naturally — not aggressively

HARD RULES — follow these exactly, no exceptions:
1. ONLY discuss products in the inventory list below. If a buyer asks about something not listed, say it is not available and suggest the closest alternative that IS listed. Do not apologise excessively.
2. NEVER invent prices, quantities, or product details. If you are unsure, say so and tell the buyer the vendor will confirm.
3. NEVER repeat the same phrase twice in a conversation. Vary your language every time.
4. Keep every reply to 2 sentences maximum unless the buyer asks a multi-part question. Do not pad replies.
5. NEVER use these phrases: "Absolutely!", "Great choice!", "Of course!", "Certainly!", "Feel free to", "Don't hesitate", "I'd be happy to". They sound fake.
6. If a buyer asks something outside commerce — personal questions, politics, anything unrelated — say: "I'm only set up to help with orders for ${name}. What can I help you find?"
7. NEVER confirm that an order has been placed or payment received. That is handled separately.
8. If an item has 1–3 in stock, mention scarcity once — naturally, not urgently. Do not repeat it.
${turnaroundLine}
10. NEVER mention other platforms, competitors, or payment methods other than the link the system provides.

DELIVERY:
${deliveryGuide}

${vendor.custom_note ? `IMPORTANT VENDOR NOTE — work this in where relevant, do not ignore it:\n"${vendor.custom_note}"` : ''}

CURRENT INVENTORY:
${inventoryText}

CONVERSATION RULES:
- If a buyer says "yes", "I want it", "send the link", "how do I pay" — this is a purchase signal. Do not ask more questions. Confirm the item and hand off to payment.
- If a buyer says "how much" with no item specified — ask which item they mean. One question only.
- If a buyer seems frustrated or repeats themselves — acknowledge it briefly and answer directly. Do not apologise more than once.
- If stock is 0 — never offer it, never take an order for it, never suggest it might be available soon unless the vendor has told you it will be.
- If the buyer's message is unclear — ask one clarifying question. Not two. Not three.

You represent ${name}. Every reply reflects on them. Be sharp, be honest, be brief.`;
}

/** vendorOrName: full vendor object (with category, location, tone, etc.) or string business name for legacy. */
async function generateReply(buyerMessage, inventory, vendorOrName, history = [], sessionContext = {}) {
  const vendor = typeof vendorOrName === 'object' && vendorOrName && vendorOrName.business_name != null
    ? vendorOrName
    : null;
  const vendorName = vendor ? vendor.business_name : String(vendorOrName || 'the store');

  const useFullPrompt = vendor && (vendor.category || vendor.tone);
  const inventoryText = inventory.length > 0
    ? inventory.map(i => {
        const scarcity = i.quantity === 1 ? ' — LAST ONE' : i.quantity <= 3 ? ` — only ${i.quantity} left` : '';
        const specs = i.description ? ` — ${i.description}` : '';
        return `  • ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}${specs}${scarcity}`;
      }).join('\n')
    : '  (No items in stock.)';

  const conversationHistory = (sessionContext.conversation_history && Array.isArray(sessionContext.conversation_history))
    ? sessionContext.conversation_history
    : (history && history.length) ? history.map(m => ({ role: m.role === 'buyer' ? 'user' : 'assistant', content: m.text })) : [];
  const lastFour = conversationHistory.slice(-4);

  const lastItem = sessionContext.last_item_name;
  const lastPrice = sessionContext.last_item_price;
  const lastItemBlock = lastItem
    ? `\n## LAST ITEM DISCUSSED\n  "${lastItem}"${lastPrice != null ? ` at ₦${Number(lastPrice).toLocaleString()}` : ''}. Use this when the buyer says "it", "that one", "how much again?", "price?", or "I'll take it" without naming the product.\n`
    : '';

  const examplesBlock = getExamplesBlock();
  const antiConfusionBlock = getAntiConfusionBlock();

  const systemPromptKimi = useFullPrompt
    ? buildSystemPrompt(vendor, inventory) + (lastItemBlock ? '\n' + lastItemBlock : '')
    : [
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
        '## INVENTORY',
        inventoryText
      ].join('\n');

  const is404 = (err) => err?.status === 404 || err?.response?.status === 404 || String(err?.message || '').includes('404');

  const runGroq = async () => {
    const { client } = require('./client');
    const systemPromptGroq = useFullPrompt
      ? buildSystemPrompt(vendor, inventory) + (lastItemBlock ? '\n' + lastItemBlock : '')
      : [
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
    for (const ex of lastFour) {
      const role = ex.role === 'buyer' ? 'user' : (ex.role === 'bot' ? 'assistant' : ex.role);
      messages.push({ role: role === 'user' ? 'user' : 'assistant', content: ex.content || ex.text });
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
      const messages = [
        { role: 'system', content: systemPromptKimi },
        ...lastFour.map(ex => ({
          role: ex.role === 'buyer' || ex.role === 'user' ? 'user' : 'assistant',
          content: ex.content || ex.text
        })),
        { role: 'user', content: buyerMessage }
      ];
      const res = await kimi.chat.completions.create({
        model,
        max_tokens: maxReplyTokens,
        temperature: 0.6,
        messages
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
 * Natural reply when customer asks "what do you have" / "show me stuff" — full catalog summary.
 */
async function generateCatalogReply(buyerMessage, inventory, vendorOrName, history = [], sessionContext = {}) {
  return generateReply(buyerMessage, inventory, vendorOrName, history, sessionContext);
}

module.exports = { generateReply, generateCancelReply, generateCatalogReply };
