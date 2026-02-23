#!/usr/bin/env node
/**
 * Simulate an incoming WhatsApp message without another person.
 * Runs the same handler as the real bot and prints what the bot would reply (no WhatsApp sent).
 *
 * Usage:
 *   node scripts/simulate-message.js <from_phone> <message>
 *
 * Examples:
 *   node scripts/simulate-message.js 2348012345678 "AMAKA"
 *   node scripts/simulate-message.js 2348012345678 "1"
 *   node scripts/simulate-message.js 2348098765432 "list"
 *
 * Use your own number as from_phone to test buyer flow; use the vendor number to test vendor commands.
 * Bot identity comes from VENDBOT_NUMBER in .env (so the correct vendor is looked up).
 */
require('dotenv').config();

const fromPhone = (process.argv[2] || '').replace(/\D/g, '');
const text = process.argv.slice(3).join(' ').trim();

if (!fromPhone || !text) {
  console.error('Usage: node scripts/simulate-message.js <from_phone> <message>');
  console.error('Example: node scripts/simulate-message.js 2348012345678 "AMAKA"');
  process.exit(1);
}

const botNumber = (process.env.VENDBOT_NUMBER || process.env.BOT_WHATSAPP_NUMBER || '').replace(/\D/g, '');
if (!botNumber) {
  console.error('Set VENDBOT_NUMBER (or BOT_WHATSAPP_NUMBER) in .env so the script knows which vendor to use.');
  process.exit(1);
}

const buyerJid = fromPhone + '@s.whatsapp.net';

const replies = [];
const mockSock = {
  user: { id: botNumber + ':0' },
  sendMessage: async (jid, content) => {
    const msg = content.text || content.caption || '[non-text message]';
    replies.push({ to: jid, text: msg });
    console.log('\n  📤 REPLY →', jid.replace('@s.whatsapp.net', ''), '\n  ', msg.split('\n').join('\n   '));
  },
  sendPresenceUpdate: async () => {}
};

const msg = {
  key: {
    remoteJid: buyerJid,
    fromMe: false,
    id: 'sim-' + Date.now()
  },
  message: {
    conversation: text
  },
  messageTimestamp: Math.floor(Date.now() / 1000)
};

async function main() {
  console.log('\n  📩 SIMULATE:', fromPhone, '→', JSON.stringify(text));
  console.log('  Bot number:', botNumber, '(vendor lookup)');
  const { handleMessage } = require('../src/whatsapp/listener');
  try {
    await handleMessage(mockSock, msg);
    if (replies.length === 0) {
      console.log('\n  (No reply was sent – handler may have returned early or ignored the message.)');
    }
  } catch (err) {
    console.error('\n  ❌ Error:', err.message);
    process.exitCode = 1;
  }
  console.log('');
}

main();
