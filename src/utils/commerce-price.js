function parseCommercePrice(value) {
  if (value === null || value === undefined) {
    return { valid: false, value: null, explicitZero: false };
  }

  if (typeof value === 'string' && !value.trim()) {
    return { valid: false, value: null, explicitZero: false };
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return { valid: false, value: null, explicitZero: false };
  }

  return { valid: true, value: numericValue, explicitZero: numericValue === 0 };
}

function resolveProductPrice(product) {
  if (!product || typeof product !== 'object') {
    return { valid: false, value: null, explicitZero: false };
  }

  const candidates = [];
  if (Object.prototype.hasOwnProperty.call(product, 'unitPrice')) candidates.push(product.unitPrice);
  if (Object.prototype.hasOwnProperty.call(product, 'price')) candidates.push(product.price);

  for (const candidate of candidates) {
    const parsed = parseCommercePrice(candidate);
    if (parsed.valid) return parsed;
  }

  return { valid: false, value: null, explicitZero: false };
}

module.exports = { parseCommercePrice, resolveProductPrice };
