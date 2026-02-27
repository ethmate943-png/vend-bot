/**
 * Download media from WhatsApp (Baileys). Returns buffer.
 * WhatsApp media is encrypted and expires — download and re-upload to Cloudinary immediately.
 */
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

/**
 * @param {object} msg - Full Baileys message object (msg.message.imageMessage etc.)
 * @param {object} sock - Baileys socket (for reuploadRequest if needed)
 * @returns {Promise<Buffer|null>}
 */
async function downloadWhatsAppMedia(msg, sock) {
  const imageMessage = msg?.message?.imageMessage;
  const videoMessage = msg?.message?.videoMessage;
  const docMessage = msg?.message?.documentMessage;

  let mediaType = 'image';
  let mediaObj = imageMessage;

  if (imageMessage) {
    mediaType = 'image';
    mediaObj = imageMessage;
  } else if (videoMessage) {
    mediaType = 'video';
    mediaObj = videoMessage;
  } else if (docMessage) {
    mediaType = 'document';
    mediaObj = docMessage;
  } else {
    return null;
  }

  try {
    const stream = await downloadContentFromMessage(mediaObj, mediaType, {}, {
      reuploadRequest: sock && typeof sock.updateMediaMessage === 'function' ? sock.updateMediaMessage : undefined
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('[MEDIA] Download failed:', err.message);
    return null;
  }
}

/**
 * @param {object} msg - Full message
 * @returns {'image'|'video'|'audio'|'document'|'none'}
 */
function getMediaType(msg) {
  if (!msg?.message) return 'none';
  if (msg.message.imageMessage) return 'image';
  if (msg.message.videoMessage) return 'video';
  if (msg.message.audioMessage || msg.message.pttMessage) return 'audio';
  if (msg.message.documentMessage) return 'document';
  return 'none';
}

module.exports = { downloadWhatsAppMedia, getMediaType };
