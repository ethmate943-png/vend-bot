/** Logging for incoming messages and bot replies */

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

const noChatLogs = process.env.PRIVACY_NO_CHAT_LOGS === 'true' || process.env.PRIVACY_NO_CHAT_LOGS === '1';

function logMessage(vendor, buyerJid, text, intent) {
  const phone = buyerJid.replace('@s.whatsapp.net', '');
  const time = new Date().toLocaleTimeString();
  console.log(`\n${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.green}📩 INCOMING MESSAGE${COLORS.reset}  ${COLORS.dim}${time}${COLORS.reset}`);
  console.log(`${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  console.log(`  ${COLORS.bright}Vendor:${COLORS.reset}  ${vendor}`);
  console.log(`  ${COLORS.bright}Buyer:${COLORS.reset}   ${noChatLogs ? '[redacted]' : phone}`);
  console.log(`  ${COLORS.bright}Message:${COLORS.reset} ${noChatLogs ? '(content not logged)' : `${COLORS.yellow}"${text}"${COLORS.reset}`}`);
  console.log(`  ${COLORS.bright}Intent:${COLORS.reset}  ${COLORS.magenta}${intent}${COLORS.reset}`);
  console.log(`${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
}

function logReply(text) {
  if (noChatLogs) {
    console.log(`  ${COLORS.bright}${COLORS.blue}💬 REPLY:${COLORS.reset} (content not logged)`);
  } else {
    console.log(`  ${COLORS.bright}${COLORS.blue}💬 REPLY:${COLORS.reset} ${String(text).replace(/\n/g, '\n          ')}`);
  }
  console.log('');
}

module.exports = { COLORS, noChatLogs, logMessage, logReply };
