/**
 * Pre-demo system checks: DB, Groq, Kimi, Paystack, inventory.
 * Use GET /health/systems to confirm all green before a demo.
 */
const axios = require('axios');
const { query } = require('../db');
const { client: groq } = require('../ai/client');
const { getInventory } = require('../inventory/manager');

async function runSystemChecks() {
  const checks = {};

  try {
    await query('SELECT 1');
    checks.db = true;
  } catch {
    checks.db = false;
  }

  try {
    await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || process.env.GROQ_MODEL_SMART || 'llama-3.3-70b-versatile',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }]
    });
    checks.groq = true;
  } catch {
    checks.groq = false;
  }

  const kimiBase = (process.env.KIMI_BASE_URL || '').trim().replace(/\/$/, '');
  if (kimiBase && process.env.KIMI_API_KEY) {
    try {
      await axios.post(
        `${kimiBase}/chat/completions`,
        {
          model: process.env.KIMI_MODEL || 'moonshotai/kimi-k2.5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }]
        },
        {
          headers: { Authorization: `Bearer ${process.env.KIMI_API_KEY}` },
          timeout: 10000
        }
      );
      checks.kimi = true;
    } catch {
      checks.kimi = false;
    }
  } else {
    checks.kimi = null; // not configured
  }

  if (process.env.PAYSTACK_SECRET_KEY) {
    try {
      await axios.get('https://api.paystack.co/bank', {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        timeout: 8000
      });
      checks.paystack = true;
    } catch {
      checks.paystack = false;
    }
  } else {
    checks.paystack = null;
  }

  if (checks.db) {
    const demoStoreCode = (process.env.DEMO_VENDOR_STORE_CODE || '').trim().toUpperCase();
    try {
      const vRes = await query(
        demoStoreCode
          ? 'SELECT id, sheet_id, sheet_tab, whatsapp_number FROM vendors WHERE store_code = $1 AND status = $2 LIMIT 1'
          : 'SELECT id, sheet_id, sheet_tab, whatsapp_number FROM vendors WHERE status = $1 LIMIT 1',
        demoStoreCode ? [demoStoreCode, 'active'] : ['active']
      );
      const vendor = vRes.rows && vRes.rows[0];
      if (vendor) {
        const inv = await getInventory(vendor);
        checks.inventory = inv.length;
        if (demoStoreCode) checks.demoVendor = demoStoreCode;
      } else {
        checks.inventory = null;
        if (demoStoreCode) checks.demoVendor = null;
      }
    } catch {
      checks.inventory = 0;
      if (demoStoreCode) checks.demoVendor = demoStoreCode;
    }
  } else {
    checks.inventory = null;
  }

  return checks;
}

module.exports = { runSystemChecks };
