/**
 * Hard block for out-of-scope messages before the model sees them.
 * Stops the bot from engaging with meta questions, other platforms, etc.
 */

const OUT_OF_SCOPE_TRIGGERS = [
  /who (are|is) you/i,
  /what (are|is) (you|your)/i,
  /chatgpt/i,
  /openai/i,
  /anthropic/i,
  /artificial intelligence/i,
  /are you (a )?bot/i,
  /are you (a )?robot/i,
  /are you human/i,
  /who made you/i,
  /who built you/i,
];

function isOutOfScope(text) {
  if (!text || typeof text !== 'string') return false;
  return OUT_OF_SCOPE_TRIGGERS.some(r => r.test(text));
}

module.exports = { isOutOfScope, OUT_OF_SCOPE_TRIGGERS };
