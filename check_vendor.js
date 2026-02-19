require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL, { fullResults: true });

async function check() {
  const res = await sql.query('SELECT * FROM vendors');
  console.log('Vendors in database:', res.rows.length);
  res.rows.forEach(v => console.log(v));
}
check();
