const { client } = require('./client');

async function generateReply(buyerMessage, inventory, vendorName, history = []) {
  const inventoryText = inventory.length > 0
    ? inventory.map(i =>
        `- ${i.name} (SKU: ${i.sku}): ₦${i.price.toLocaleString()}, ${i.quantity} in stock${i.category ? `, Category: ${i.category}` : ''}`
      ).join('\n')
    : 'No items currently in stock.';

  const messages = [
    {
      role: 'system',
      content: `You are a friendly WhatsApp sales assistant for ${vendorName}.
Rules:
- ONLY use information from the inventory list below. Never make up prices or products.
- Keep replies to 2-3 sentences max.
- If item is out of stock or not listed, say so clearly and suggest alternatives from the list.
- Use natural Nigerian English. Be warm and helpful.
- If buyer asks about multiple items, address each one.
- When mentioning prices, always include the ₦ symbol.
- If quantity is 1-3, mention scarcity naturally ("Only 2 left!").

Current Inventory:
${inventoryText}`
    }
  ];

  for (const msg of history.slice(-6)) {
    messages.push({
      role: msg.role === 'buyer' ? 'user' : 'assistant',
      content: msg.text
    });
  }

  messages.push({ role: 'user', content: buyerMessage });

  const res = await client.chat.completions.create({
    model: process.env.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile',
    max_tokens: 200,
    temperature: 0.7,
    messages
  });

  return res.choices[0].message.content.trim();
}

module.exports = { generateReply };
