const { query } = require('../db');
const { getInventory } = require('../inventory/sheets');
const { getSock } = require('../whatsapp/client');
const { sendWithDelay } = require('../whatsapp/sender');
const OpenAI = require('openai').default;

const kimi = process.env.KIMI_API_KEY && process.env.KIMI_BASE_URL
  ? new OpenAI({ apiKey: process.env.KIMI_API_KEY, baseURL: process.env.KIMI_BASE_URL })
  : null;
const model = process.env.KIMI_MODEL || 'moonshotai/kimi-k2';

async function runPricingAgent() {
  const res = await query("SELECT * FROM vendors WHERE status IN ('active', 'probation')");
  const vendors = res.rows || [];
  const sock = getSock();
  if (!sock || !kimi) return;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const vendor of vendors) {
    try {
      if (!vendor.sheet_id) continue;
      const salesRes = await query(
        'SELECT item_name, amount FROM transactions WHERE vendor_id = $1 AND status = $2 AND created_at >= $3',
        [vendor.id, 'paid', weekAgo]
      );
      const sales = salesRes.rows || [];
      const inventory = await getInventory(vendor.sheet_id, vendor.sheet_tab || 'Sheet1');

      const salesText = sales.map(s => `${s.item_name}: ₦${(s.amount / 100).toLocaleString()}`).join('\n') || 'No sales this week';
      const invText = inventory.map(i => `${i.name}: ${i.quantity} in stock, ₦${i.price.toLocaleString()}`).join('\n');

      const systemPrompt = [
        '## TASK',
        'Write a short weekly business report for a Nigerian WhatsApp vendor.',
        '',
        '## RULES',
        '1. Be specific: reference actual sales and inventory numbers given.',
        '2. Be actionable: one or two clear suggestions (e.g. restock, promote a slow item).',
        '3. Be encouraging: positive tone, use emojis where natural.',
        '4. Length: max 200 words. No markdown headers (no ## or #).',
        '5. Language: Nigerian English, conversational.'
      ].join('\n');

      const chat = await kimi.chat.completions.create({
        model,
        max_tokens: 400,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Business: ${vendor.business_name}\n\nWeek sales:\n${salesText}\n\nCurrent inventory:\n${invText}` }
        ]
      });

      const report = (chat.choices[0].message.content || '').trim();
      await sendWithDelay(sock, `${vendor.whatsapp_number}@s.whatsapp.net`,
        `📊 *Weekly Report — ${vendor.business_name}*\n\n${report}`
      );
    } catch (e) {
      console.error('[PRICING AGENT]', vendor.store_code || vendor.id, e.message);
    }
  }
}

module.exports = { runPricingAgent };
