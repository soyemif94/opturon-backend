function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

module.exports = { isNonEmptyString, sanitizeString };
