const axios = require('axios');
const { query } = require('../db');

const BANK_CODES = {
  'gtbank': '058', 'gtb': '058',
  'access': '044', 'access bank': '044',
  'zenith': '057', 'zenith bank': '057',
  'first bank': '011', 'firstbank': '011',
  'uba': '033',
  'fidelity': '070',
  'sterling': '232',
  'opay': '999992',
  'palmpay': '999991',
  'kuda': '50211',
  'moniepoint': '50515',
  'wema': '035',
  'fcmb': '214'
};

function resolveBankCode(bankName) {
  return BANK_CODES[bankName.toLowerCase().trim()] || null;
}

async function verifyAccount(accountNumber, bankCode) {
  const res = await axios.get(
    `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return res.data.data.account_name;
}

async function createSubaccount(vendor) {
  const res = await axios.post(
    'https://api.paystack.co/subaccount',
    {
      business_name: vendor.business_name,
      settlement_bank: vendor.bank_code,
      account_number: vendor.account_number,
      percentage_charge: vendor.platform_fee_percent || 5.0
    },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );

  const code = res.data.data.subaccount_code;
  await query(
    'UPDATE vendors SET paystack_subaccount_code = $1, subaccount_created = true WHERE id = $2',
    [code, vendor.id]
  );
  return code;
}

module.exports = { resolveBankCode, verifyAccount, createSubaccount };
