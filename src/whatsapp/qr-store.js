/**
 * In-memory store for the current WhatsApp QR payload.
 * Updated by client.js; read by server /qr route so phone users can scan via a webpage.
 */
let state = { qr: null, connected: false };

function setQR(qr) {
  state.qr = qr;
  state.connected = false;
}

function setConnected(connected) {
  state.connected = connected;
  if (connected) state.qr = null;
}

function getState() {
  return { ...state };
}

module.exports = { setQR, setConnected, getState };
