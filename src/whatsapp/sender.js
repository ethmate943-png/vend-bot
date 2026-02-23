const { listFooter } = require('../ai/human-phrases');

async function sendMessage(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

/** Send an image with optional caption (e.g. product photo). URL must be publicly reachable. */
async function sendImageWithCaption(sock, jid, imageUrl, caption) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) {
    if (caption) await sendMessage(sock, jid, caption);
    return;
  }
  try {
    await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || undefined
    });
  } catch (err) {
    console.warn('[sender] Image send failed, sending caption only:', err?.message || err);
    if (caption) await sendMessage(sock, jid, caption);
  }
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
 * Rows with image_url get an image when the template supports it; otherwise only text.
 * Row id = sku so selection gives actionable text (we resolve to item and confirm).
 * @param {object} sock - Baileys socket
 * @param {string} jid - Chat JID
 * @param {string} bodyText - Main message text
 * @param {string} buttonTitle - Label on the button that opens the list (e.g. "Choose item")
 * @param {Array<{sku: string, name: string, price: number, quantity?: number, image_url?: string}>} items - Rows; id = sku
 */
async function sendListMessage(sock, jid, bodyText, buttonTitle, items) {
  if (!sock || !jid || !items || items.length === 0) {
    await sendWithDelay(sock, jid, bodyText || 'No options right now.');
    return;
  }
  const slice = items.slice(0, 10);
  const numberedList = slice.map((i, idx) =>
    `${idx + 1}. ${i.name} — ₦${Number(i.price).toLocaleString()}${i.quantity != null ? ` (${i.quantity} left)` : ''}`
  ).join('\n');
  const footer = listFooter();
  const fullText = `${bodyText}\n\n${numberedList}\n\n_${footer}_`;

  try {
    const { hydratedTemplate } = await import('baileys_helpers');
    const sections = [{
      title: 'Items',
      rows: slice.map((i) => {
        const row = {
          id: i.sku,
          title: (i.name || '').slice(0, 24),
          description: `₦${Number(i.price).toLocaleString()} • ${i.quantity ?? '?'} left`
        };
        if (i.image_url && typeof i.image_url === 'string' && i.image_url.startsWith('http')) {
          row.image_url = i.image_url;
        }
        return row;
      })
    }];
    const firstWithImage = slice.find(i => i.image_url && i.image_url.startsWith('http'));
    const templateOpts = {
      text: fullText,
      footer,
      interactiveButtons: [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({ title: buttonTitle, sections })
      }]
    };
    if (firstWithImage && firstWithImage.image_url) {
      templateOpts.headerImageUrl = firstWithImage.image_url;
    }
    await hydratedTemplate(sock, jid, templateOpts);
  } catch (err) {
    console.warn('[sender] Native list failed, falling back to text list:', err?.message || err);
    await sendWithDelay(sock, jid, fullText);
  }
}

module.exports = { sendMessage, sendWithDelay, sendButtons, sendListMessage, sendImageWithCaption };
