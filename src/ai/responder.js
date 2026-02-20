require('dotenv').config();
const OpenAI = require('openai').default;

const kimi = process.env.KIMI_API_KEY && process.env.KIMI_BASE_URL
  ? new OpenAI({
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL
    })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2';

async function generateReply(buyerMessage, inventory, vendorName, history = []) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i => {
        const scarcity = i.quantity === 1 ? ' — LAST ONE' : i.quantity <= 3 ? ` — only ${i.quantity} left` : '';
        return `  • ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}${scarcity}`;
      }).join('\n')
    : '  (No items in stock.)';

  const contextBlock = history?.length
    ? '\n## RECENT CHAT\n' + history.slice(-4).map(m => `  ${m.role}: ${m.text}`).join('\n')
    : '';

  const systemPromptKimi = [
    '## ROLE',
    `WhatsApp sales assistant for ${vendorName} in Nigeria.`,
    '',
    '## TONE',
    'Warm, brief (2–3 sentences), natural Nigerian English. Helpful and professional.',
    '',
    '## RULES',
    '1. Only mention items from the inventory below. Never invent products or prices.',
    '2. If an item has quantity 1, say "last one remaining" or similar.',
    '3. Always use ₦ for prices. Do not make up stock or discounts.',
    '4. If the buyer asks for something not in stock, say so and suggest similar items if any.',
    contextBlock,
    '## INVENTORY',
    inventoryText
  ].join('\n');

  if (kimi) {
    const res = await kimi.chat.completions.create({
      model,
      max_tokens: 220,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPromptKimi },
        { role: 'user', content: buyerMessage }
      ]
    });
    return (res.choices[0].message.content || '').trim();
  }

  const { client } = require('./client');
  const systemPromptGroq = [
    `## ROLE: WhatsApp sales assistant for ${vendorName}.`,
    '## RULES: Use only the inventory below. 2–3 sentences. Nigerian English. No invented products or prices.',
    '## INVENTORY:',
    inventoryText
  ].join('\n');
  const messages = [
    { role: 'system', content: systemPromptGroq }
  ];
  for (const msg of (history || []).slice(-6)) {
    messages.push({ role: msg.role === 'buyer' ? 'user' : 'assistant', content: msg.text });
  }
  messages.push({ role: 'user', content: buyerMessage });
  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile',
    max_tokens: 200,
    temperature: 0.7,
    messages
  });
  return (res.choices[0].message.content || '').trim();
}

module.exports = { generateReply };
