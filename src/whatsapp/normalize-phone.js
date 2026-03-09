function normalizeDigits(input) {
  return String(input || '').replace(/[^\d]/g, '');
}

function normalizeWhatsAppTo(input) {
  let digits = normalizeDigits(input);

  // Argentina mobile numbers are often represented as 54 9 ...
  // WhatsApp Cloud API expects 54... without the extra 9.
  if (digits.startsWith('549') && digits.length >= 13) {
    digits = `54${digits.slice(3)}`;
  }

  return digits;
}

module.exports = {
  normalizeDigits,
  normalizeWhatsAppTo
};

