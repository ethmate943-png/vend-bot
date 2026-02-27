require('dotenv').config();
const { Pool, neonConfig } = require('@neondatabase/serverless');

// Node has no built-in WebSocket; use 'ws' so Neon's Pool works
try {
  const ws = require('ws');
  neonConfig.webSocketConstructor = ws;
} catch (_) {
  // ws optional; without it only HTTP neon() works, not Pool
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 7500,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (e) {
    console.error('[DB] Query error:', e.message, '\nQuery:', text.slice(0, 100));
    throw e;
  }
}

/** Retry wrapper for critical queries. Default 3 retries with backoff. */
async function queryWithRetry(text, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`[DB] Query failed, retry ${i + 1}/${retries}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, queryWithRetry, withTransaction, pool };
