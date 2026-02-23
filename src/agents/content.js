const { query } = require('../db');
const { getInventory } = require('../inventory/manager');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');
const OpenAI = require('openai').default;

const kimi = process.env.KIMI_API_KEY && process.env.KIMI_BASE_URL
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: process.env.KIMI_BASE_URL })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5';
const VENDBOT_NUMBER = (process.env.VENDBOT_NUMBER || '').replace(/\D/g, '');

async function runContentAgent() {
  const res = await query("SELECT * FROM vendors WHERE status IN ('active', 'probation')");
  const vendors = res.rows || [];
  const sock = getSock();
  if (!sock || !kimi) return;

  for (const vendor of vendors) {
    try {
      const inventory = await getInventory(vendor);
      if (!inventory.length) continue;

      const topItems = inventory.slice(0, 5)
        .map(i => `${i.name} — ₦${i.price.toLocaleString()} (${i.quantity} left)`).join('\n');

      const systemPrompt = [
        '## TASK',
        'Generate marketing copy for a Nigerian WhatsApp vendor. Return valid JSON only.',
        '',
        '## OUTPUT FORMAT',
        '{"status":"...","instagram":"..."}',
        'No markdown, no explanation, no text outside the JSON.',
        '',
        '## RULES',
        '1. status — WhatsApp Status text. Max 2 lines. Use emoji. Put [LINK] where the store link should go.',
        '2. instagram — Instagram post/caption. 3–4 lines + relevant hashtags (e.g. #Lagos #VendBot #ShopSmall).',
        '3. Tone: friendly, inviting, Nigerian English. Highlight the products given.'
      ].join('\n');

      const chat = await kimi.chat.completions.create({
        model,
        max_tokens: 300,
        temperature: 0.8,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Business: ${vendor.business_name}\nItems:\n${topItems}` }
        ]
      });

      const raw = (chat.choices[0].message.content || '').replace(/```json|```/g, '').trim();
      let content = {};
      try {
        content = JSON.parse(raw);
      } catch (_) {
        content = { status: raw.slice(0, 100), instagram: '' };
      }
      const storeLink = vendor.store_code ? `wa.me/${VENDBOT_NUMBER}?text=${vendor.store_code}` : '';
      const status = (content.status || '').replace('[LINK]', storeLink);
      const instagram = content.instagram || '';

      await sendWithDelay(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `📢 *Your content for today*\n\n*WhatsApp Status:*\n${status}\n\n*Instagram:*\n${instagram}`
      );
    } catch (e) {
      console.error('[CONTENT AGENT]', vendor.business_name || vendor.id, e.message);
    }
  }
}

module.exports = { runContentAgent };
