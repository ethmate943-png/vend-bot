require('dotenv').config();
const OpenAI = require('openai').default;

const kimi = process.env.KIMI_API_KEY && process.env.KIMI_BASE_URL
  ? new OpenAI({
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL
    })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2';

/**
 * Extract inventory items from vendor's natural language or voice transcription.
 * Returns array of { name, sku, price, quantity, category }.
 */
async function extractInventoryFromText(text) {
  if (!kimi || !text || !text.trim()) return [];

  const systemPrompt = [
    '## TASK',
    'Extract inventory items from the vendor message. Output a JSON array only.',
    '',
    '## OUTPUT FORMAT',
    'Valid JSON array. No markdown, no explanation, no text outside the array.',
    'Each object: {"name":"string","sku":"string","price":number,"quantity":number,"category":"string"}',
    '',
    '## RULES',
    '1. name — product name (required).',
    '2. sku — if not given, generate from name: UPPERCASE, spaces to hyphens (e.g. "Black Sneakers" → "BLACK-SNEAKERS").',
    '3. price — Naira only, number (e.g. 25000). No currency symbol in value.',
    '4. quantity — integer, minimum 1 if not stated.',
    '5. category — optional, e.g. "shoes", "bags", "electronics".',
    '',
    '## EXAMPLES',
    'Input: "add: black sneakers 25k 3, red bag 15000 1"',
    'Output: [{"name":"black sneakers","sku":"BLACK-SNEAKERS","price":25000,"quantity":3,"category":""},{"name":"red bag","sku":"RED-BAG","price":15000,"quantity":1,"category":""}]'
  ].join('\n');

  const res = await kimi.chat.completions.create({
    model,
    max_tokens: 500,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text.trim() }
    ]
  });

  const raw = res.choices[0].message.content || '';
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(i => i && (i.name || i.item))
      .map(i => ({
        name: (i.name || i.item || '').trim(),
        sku: (i.sku || (i.name || i.item || '').replace(/\s+/g, '-').toUpperCase().slice(0, 32)).trim(),
        price: Number(i.price) || 0,
        quantity: Math.max(0, Number(i.quantity) || 1),
        category: (i.category || '').trim()
      }));
  } catch (e) {
    console.error('[EXTRACTOR] Parse failed:', e.message);
    return [];
  }
}

module.exports = { extractInventoryFromText };
