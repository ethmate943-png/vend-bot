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
  connectionString: process.env.DATABASE_URL
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

module.exports = { query, withTransaction, pool };
