require('dotenv').config();
const OpenAI = require('openai').default;
const { default: Groq, toFile } = require('groq-sdk');

const kimi = process.env.KIMI_API_KEY && process.env.KIMI_BASE_URL
  ? new OpenAI({
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL
    })
  : null;
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';

/**
 * Extract inventory items from vendor's natural language or voice transcription.
 * Returns array of { name, sku, price, quantity, category, image_url? }.
 */
async function extractInventoryFromText(text) {
  if (!text || !text.trim()) return [];

  const systemPrompt = [
    '## TASK',
    'Extract inventory items from the vendor message. Output a JSON array only.',
    '',
    '## OUTPUT FORMAT',
    'Valid JSON array. No markdown, no explanation, no text outside the array.',
    'Each object: {"name":"string","sku":"string","price":number,"quantity":number,"category":"string","image_url":"string or omit"}',
    '',
    '## RULES',
    '1. name — product name (required).',
    '2. sku — if not given, generate from name: UPPERCASE, spaces to hyphens (e.g. "Black Sneakers" → "BLACK-SNEAKERS").',
    '3. price — Naira only, number (e.g. 25000). No currency symbol in value.',
    '4. quantity — integer, minimum 1 if not stated.',
    '5. category — optional, e.g. "shoes", "bags", "electronics".',
    '6. image_url — optional; if the message contains a valid image URL (http/https) for the product, include it; otherwise omit.',
    '',
    '## EXAMPLES',
    'Input: "add: black sneakers 25k 3, red bag 15000 1"',
    'Output: [{"name":"black sneakers","sku":"BLACK-SNEAKERS","price":25000,"quantity":3,"category":""},{"name":"red bag","sku":"RED-BAG","price":15000,"quantity":1,"category":""}]',
    'Input: "add: Sneakers 20k 2 https://example.com/shoe.jpg"',
    'Output: [{"name":"Sneakers","sku":"SNEAKERS","price":20000,"quantity":2,"category":"","image_url":"https://example.com/shoe.jpg"}]'
  ].join('\n');

  const input = text.trim();
  const useKimi = !!kimi;
  const useGroq = !!groq;
  let raw = '';

  try {
    if (useKimi) {
      const res = await kimi.chat.completions.create({
        model,
        max_tokens: 500,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ]
      });
      raw = res.choices[0].message.content || '';
    } else if (useGroq) {
      const res = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL || process.env.GROQ_MODEL_SMART || 'llama-3.1-8b-instant',
        max_tokens: 500,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ]
      });
      raw = res.choices[0].message.content || '';
    } else {
      return [];
    }
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const detail = e?.response?.data || e?.message || e;
    const is404 = status === 404 || e?.response?.status === 404 || String(detail || '').includes('404');

    if (useKimi && useGroq && is404) {
      console.warn('[EXTRACTOR] Kimi 404 in inventory extractor, falling back to Groq');
      try {
        const res = await groq.chat.completions.create({
          model: process.env.GROQ_MODEL || process.env.GROQ_MODEL_SMART || 'llama-3.1-8b-instant',
          max_tokens: 500,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input }
          ]
        });
        raw = res.choices[0].message.content || '';
      } catch (groqErr) {
        console.error('[EXTRACTOR] Groq inventory extractor failed:', groqErr?.message || groqErr);
        return [];
      }
    } else {
      console.error('[EXTRACTOR] Kimi inventory call failed:', status || '', detail);
      return [];
    }
  }
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(i => i && (i.name || i.item))
      .map(i => {
        const url = (i.image_url || i.imageUrl || '').trim();
        return {
          name: (i.name || i.item || '').trim(),
          sku: (i.sku || (i.name || i.item || '').replace(/\s+/g, '-').toUpperCase().slice(0, 32)).trim(),
          price: Number(i.price) || 0,
          quantity: Math.max(0, Number(i.quantity) || 1),
          category: (i.category || '').trim(),
          ...(url && url.startsWith('http') ? { image_url: url } : {})
        };
      });
  } catch (e) {
    console.error('[EXTRACTOR] Parse failed:', e.message);
    return [];
  }
}

/**
 * Transcribe voice/audio buffer with Groq Whisper, then extract inventory from the text.
 * @param {Buffer} audioBuffer - Raw audio data (e.g. ogg, mp3)
 * @param {string} [mimeType] - e.g. 'audio/ogg', 'audio/mpeg'
 * @returns {Promise<Array<{name,sku,price,quantity,category}>>}
 */
async function extractInventoryFromVoice(audioBuffer, mimeType = 'audio/ogg') {
  if (!groq || !audioBuffer || !Buffer.isBuffer(audioBuffer)) return [];
  try {
    const file = await toFile(audioBuffer, 'audio.ogg', { type: mimeType });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      language: 'en'
    });
    const text = (transcription && transcription.text) ? transcription.text : '';
    if (!text.trim()) return [];
    return extractInventoryFromText(text);
  } catch (e) {
    console.error('[EXTRACTOR] Voice transcribe failed:', e.message);
    return [];
  }
}

module.exports = { extractInventoryFromText, extractInventoryFromVoice };
