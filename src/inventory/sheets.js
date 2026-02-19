const { google } = require('googleapis');

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getInventory(sheetId, tab = 'Sheet1') {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A:G`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const [, ...data] = rows;
  return data
    .map(r => {
      const price = Number(r[2]) || 0;
      const minPrice = Number(r[6]) || 0;
      return {
        name: r[0] || '',
        sku: r[1] || '',
        price,
        quantity: Number(r[3]) || 0,
        category: r[4] || '',
        minPrice: minPrice > 0 ? minPrice : price,
      };
    })
    .filter(item => item.quantity > 0 && item.name);
}

async function decrementQty(sheetId, tab, sku) {
  const sheets = getSheetsClient();
  const inventory = await getInventory(sheetId, tab);
  const idx = inventory.findIndex(i => i.sku === sku);
  if (idx === -1) throw new Error(`SKU not found: ${sku}`);
  const excelRow = idx + 2;
  const newQty = Math.max(0, inventory[idx].quantity - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!D${excelRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[newQty]] },
  });
  return newQty;
}

module.exports = { getInventory, decrementQty };
