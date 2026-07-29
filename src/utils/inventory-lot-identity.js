const LOT_NUMBER_MAX_LENGTH = 80;

function normalizeLotNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[^A-Z0-9._\- /]/g, '')
    .slice(0, LOT_NUMBER_MAX_LENGTH)
    .trim() || null;
}

module.exports = {
  LOT_NUMBER_MAX_LENGTH,
  normalizeLotNumber
};
