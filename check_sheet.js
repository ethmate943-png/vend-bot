require('dotenv').config();
const { google } = require('googleapis');

async function check() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = '1cuDyxy9hzs_gevvc1XfwGu2E88ltWwtj-xX30gSmsYI';

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  console.log('Sheet tabs:');
  meta.data.sheets.forEach(s => console.log(`  - "${s.properties.title}" (gid: ${s.properties.sheetId})`));

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${meta.data.sheets[0].properties.title}!A:F`,
  });
  console.log('\nFirst 3 rows:');
  (res.data.values || []).slice(0, 3).forEach((r, i) => console.log(`  Row ${i + 1}:`, r));
}

check().catch(e => console.error('Error:', e.message));
