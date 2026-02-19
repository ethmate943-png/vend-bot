async function sendMessage(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendWithDelay(sock, jid, text, delayMs = 1000) {
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(r => setTimeout(r, delayMs));
  await sendMessage(sock, jid, text);
  await sock.sendPresenceUpdate('paused', jid);
}

async function sendButtons(sock, jid, text, buttons) {
  const buttonRows = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const full = `${text}\n\n${buttonRows}\n\n_Reply with the number to select._`;
  await sendWithDelay(sock, jid, full);
}

module.exports = { sendMessage, sendWithDelay, sendButtons };
