const { CANONICAL_PLAN_CATALOG, LEGACY_BILLING_PLAN_CODES, billingPlan, canonicalKey } = require('./plan-catalog');
const PLAN_CATALOG = CANONICAL_PLAN_CATALOG;

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveSaasPlanDefinition(planCode) {
  const normalized = normalizeString(planCode);
  if (canonicalKey(normalized)) return billingPlan(normalized);
  return LEGACY_BILLING_PLAN_CODES[normalized] || null;
}

module.exports = {
  PLAN_CATALOG,
  resolveSaasPlanDefinition
};
