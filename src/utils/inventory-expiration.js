function normalizeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized.slice(0, 10);
  return null;
}

function utcDateOnly(date) {
  const source = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  return Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate());
}

function calculateInventoryExpirationStatus(expiresAt, now = new Date()) {
  const normalized = normalizeDateOnly(expiresAt);
  if (!normalized) {
    return { status: 'no_expiration', daysUntilExpiration: null };
  }

  const expirationDate = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(expirationDate.getTime())) {
    return { status: 'no_expiration', daysUntilExpiration: null };
  }

  const daysUntilExpiration = Math.floor((utcDateOnly(expirationDate) - utcDateOnly(now)) / 86400000);
  if (daysUntilExpiration < 0) return { status: 'expired', daysUntilExpiration };
  if (daysUntilExpiration <= 3) return { status: 'critical', daysUntilExpiration };
  if (daysUntilExpiration <= 7) return { status: 'urgent', daysUntilExpiration };
  if (daysUntilExpiration <= 15) return { status: 'warning', daysUntilExpiration };
  if (daysUntilExpiration <= 30) return { status: 'upcoming', daysUntilExpiration };
  return { status: 'normal', daysUntilExpiration };
}

module.exports = {
  calculateInventoryExpirationStatus,
  normalizeDateOnly
};
