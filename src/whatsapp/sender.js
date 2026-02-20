async function sendMessage(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function sendWithDelay(sock, jid, text, delayMs = 1000) {
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(r => setTimeout(r, delayMs));
  await sendMessage(sock, jid, text);
  await sock.sendPresenceUpdate('paused', jid);
}

/** Legacy: numbered text list. Kept for fallback. */
async function sendButtons(sock, jid, text, buttons) {
  const buttonRows = buttons.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const full = `${text}\n\n${buttonRows}\n\n_Reply with the number to select._`;
  await sendWithDelay(sock, jid, full);
}

/**
 * Send a native WhatsApp list message: one button that opens a list; user taps a row to select.
 * @param {object} sock - Baileys socket
 * @param {string} jid - Chat JID
 * @param {string} bodyText - Main message text
 * @param {string} buttonTitle - Label on the button that opens the list (e.g. "Choose item")
 * @param {Array<{sku: string, name: string, price: number, quantity?: number}>} items - Rows; id = sku so we can resolve selection
 */
async function sendListMessage(sock, jid, bodyText, buttonTitle, items) {
  if (!sock || !jid || !items || items.length === 0) {
    await sendWithDelay(sock, jid, bodyText || 'No options right now.');
    return;
  }
  try {
    const { sendInteractiveMessage } = await import('baileys_helpers');
    const sections = [{
      title: 'Items',
      rows: items.slice(0, 10).map((i) => ({
        id: i.sku,
        title: (i.name || '').slice(0, 24),
        description: `₦${Number(i.price).toLocaleString()} • ${i.quantity ?? '?'} left`
      }))
    }];
    await sendInteractiveMessage(sock, jid, {
      text: bodyText,
      footer: 'Tap the button below and choose an item.',
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({ title: buttonTitle, sections })
      }]
    });
  } catch (err) {
    console.warn('[sender] Native list failed, falling back to text list:', err?.message || err);
    const fallback = items.map((i, idx) => `${idx + 1}. ${i.name} — ₦${Number(i.price).toLocaleString()}`).join('\n');
    await sendWithDelay(sock, jid, `${bodyText}\n\n${fallback}\n\n_Reply with the number to select._`);
  }
}

module.exports = { sendMessage, sendWithDelay, sendButtons, sendListMessage };
