const { listFooter } = require('../ai/human-phrases');

// Track IDs of messages this process sends, so we can ignore their echoes in the listener.
const OUTGOING_TTL_MS = 60000;
const outgoingIds = new Set();

function registerOutgoingId(id) {
  if (!id) return;
  if (outgoingIds.has(id)) return;
  outgoingIds.add(id);
  setTimeout(() => outgoingIds.delete(id), OUTGOING_TTL_MS);
}

function isOutgoingMessageId(id) {
  return !!id && outgoingIds.has(id);
}

async function sendMessage(sock, jid, text) {
  const res = await sock.sendMessage(jid, { text });
  if (res && res.key && res.key.id) {
    registerOutgoingId(res.key.id);
  }
  return res;
}

/** Send an image with optional caption (e.g. product photo).
 * imageUrl must be a direct link to the image file (e.g. .jpg, .png). The bot fetches it and
 * sends it as image media so the buyer sees the photo, not a link. Use a direct image URL or
 * upload photos via the vendor "send photo" flow so the stored URL is reachable. */
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

async function sendWithDelay(sock, jid, text, delayMs) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  let computedDelay = 1000;
  if (typeof delayMs === 'number' && !Number.isNaN(delayMs)) {
    computedDelay = delayMs;
  } else {
    const wordCount = words.length;
    // Base typing time: 600ms + 120ms per word, clamped between 600ms and 2500ms.
    computedDelay = 600 + wordCount * 120;
    if (computedDelay < 600) computedDelay = 600;
    if (computedDelay > 2500) computedDelay = 2500;
  }
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(r => setTimeout(r, computedDelay));
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
 * Row id = sku so selection gives actionable text (we resolve to item and confirm).
 * Falls back to plain numbered text if native list fails.
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
  const footer = listFooter();

  const fallback = async () => {
    const numberedList = slice.map((i, idx) =>
      `${idx + 1}. ${i.name} — ₦${Number(i.price).toLocaleString()}${i.quantity != null ? ` (${i.quantity} left)` : ''}`
    ).join('\n');
    const fullText = `${bodyText}\n\n${numberedList}\n\n_${footer}_`;
    await sendWithDelay(sock, jid, fullText);
  };

  try {
    const rows = slice.map((i) => {
      const title = `${i.name} — ₦${Number(i.price).toLocaleString()}`.slice(0, 72);
      const description = (i.quantity != null ? `${i.quantity} left` : '').slice(0, 72);
      return { title, description: description || undefined, rowId: String(i.sku).slice(0, 200) };
    });
    const listPayload = {
      text: (bodyText || 'Pick an option').slice(0, 1024),
      title: (bodyText || 'Options').split('\n')[0].slice(0, 60) || 'Options',
      buttonText: (buttonTitle || 'Choose').slice(0, 20),
      footer: footer.slice(0, 60),
      sections: [{ rows }]
    };
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 800));
    const res = await sock.sendMessage(jid, listPayload);
    if (res && res.key && res.key.id) {
      registerOutgoingId(res.key.id);
    }
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    console.warn('[sender] Native list failed, falling back to text:', err?.message || err);
    await fallback();
  }
}

/** Text quick-reply hints after a product or list (Baileys has no reliable native buttons). */
const QUICK_REPLY_OPTIONS =
  `_Reply:_ *Price?* · *I want this* · *Something else* · *Delivery*`;

async function sendQuickReplyOptions(sock, jid, delayMs = 600) {
  await new Promise(r => setTimeout(r, delayMs));
  await sendMessage(sock, jid, QUICK_REPLY_OPTIONS);
}

module.exports = {
  sendQuickReplyOptions,
  QUICK_REPLY_OPTIONS,
  sendMessage,
  sendWithDelay,
  sendButtons,
  sendListMessage,
  sendImageWithCaption,
  isOutgoingMessageId
};
