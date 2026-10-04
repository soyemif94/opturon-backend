const { LEGACY_BILLING_PLANS, billingPlan } = require('./plan-catalog');
const PLAN_CATALOG = LEGACY_BILLING_PLANS;

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveSaasPlanDefinition(planCode) {
  const normalized = normalizeString(planCode);
  return Object.hasOwn(PLAN_CATALOG, normalized) ? PLAN_CATALOG[normalized] : billingPlan(normalized);
}

module.exports = {
  PLAN_CATALOG,
  resolveSaasPlanDefinition
};
