require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL, { fullResults: true });

const BOT_NUMBER = process.argv[2];
if (!BOT_NUMBER) {
  console.error('Usage: node register_vendor.js 2348XXXXXXXXX');
  process.exit(1);
}

async function register() {
  try {
    const res = await sql.query(
      `INSERT INTO vendors (whatsapp_number, business_name, sheet_id, sheet_tab, status)
       VALUES ($1, $2, $3, $4, 'probation')
       ON CONFLICT (whatsapp_number) DO UPDATE SET sheet_id = $3, sheet_tab = $4
       RETURNING id, business_name, whatsapp_number, sheet_id, sheet_tab`,
      [BOT_NUMBER, 'Test Vendor Store', '1cuDyxy9hzs_gevvc1XfwGu2E88ltWwtj-xX30gSmsYI', 'test_inventory']
    );
    console.log('Vendor registered:');
    console.log(res.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

register();
