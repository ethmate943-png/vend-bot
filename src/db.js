require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL, { fullResults: true });

async function query(text, params, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await sql.query(text, params || []);
      return res;
    } catch (err) {
      if (attempt < retries && (err.message.includes('fetch') || err.message.includes('timeout') || err.message.includes('ECONNRESET'))) {
        console.warn(`[DB] Query failed (attempt ${attempt + 1}), retrying...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { query };
