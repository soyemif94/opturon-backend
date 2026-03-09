const { normalizeDigits, normalizeWhatsAppTo } = require('./normalize-phone');

function normalizeToDigits(input) {
  return normalizeDigits(input);
}

module.exports = {
  normalizeDigits,
  normalizeToDigits,
  normalizeWhatsAppTo
};

