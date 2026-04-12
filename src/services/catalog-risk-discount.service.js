function normalizeDateOnly(value) {
  const safeValue = String(value || '').trim();
  if (!safeValue) return null;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(safeValue)
    ? safeValue
    : /^\d{4}-\d{2}-\d{2}T/.test(safeValue)
      ? safeValue.slice(0, 10)
      : null;

  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function startOfToday(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function differenceInDays(target, now) {
  return Math.floor((target.getTime() - startOfToday(now).getTime()) / 86400000);
}

function getProductExpirationState(expirationDate, now = new Date()) {
  const parsed = normalizeDateOnly(expirationDate);
  if (!parsed) return null;

  const daysUntilExpiration = differenceInDays(parsed, now);
  if (daysUntilExpiration < 0) {
    return {
      state: 'expired',
      daysUntilExpiration
    };
  }

  if (daysUntilExpiration <= 3) {
    return {
      state: 'critical',
      daysUntilExpiration
    };
  }

  if (daysUntilExpiration <= 10) {
    return {
      state: 'expiring_soon',
      daysUntilExpiration
    };
  }

  return {
    state: 'normal',
    daysUntilExpiration
  };
}

function normalizeDiscountPercentage(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(100, Math.round(parsed * 100) / 100);
}

function buildCatalogRiskDiscountSuggestion(product, now = new Date()) {
  const expiration = getProductExpirationState(product && product.expirationDate, now);
  if (!expiration || (expiration.state !== 'critical' && expiration.state !== 'expiring_soon')) {
    return null;
  }

  const suggestedDiscountPercentage = expiration.state === 'critical' ? 25 : 15;
  const currentDiscountPercentage = normalizeDiscountPercentage(product && product.discountPercentage);
  const deltaPercentage =
    currentDiscountPercentage == null
      ? suggestedDiscountPercentage
      : Math.round((suggestedDiscountPercentage - currentDiscountPercentage) * 100) / 100;

  return {
    key: 'catalog_risk_discount',
    status: expiration.state,
    suggestedDiscountPercentage,
    currentDiscountPercentage,
    deltaPercentage,
    hasManualDiscount: currentDiscountPercentage != null,
    canApply: currentDiscountPercentage !== suggestedDiscountPercentage,
    label: expiration.state === 'critical' ? 'Sugerencia automatica critica' : 'Sugerencia automatica',
    helper:
      expiration.state === 'critical'
        ? `Sugerimos ${suggestedDiscountPercentage}% para mover stock critico antes del vencimiento.`
        : `Sugerimos ${suggestedDiscountPercentage}% para acelerar la salida de productos proximos a vencer.`
  };
}

module.exports = {
  getProductExpirationState,
  buildCatalogRiskDiscountSuggestion
};
