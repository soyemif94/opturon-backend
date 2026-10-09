const { canonicalKey, LEGACY_ENTITLEMENT_PLAN_MAP } = require('./plan-catalog');

const POLICY = Object.freeze({
  core: Object.freeze({ planKey: 'core', botTier: 'none', includedResponses: 0, provisioningRequired: false, routing: 'disabled' }),
  growth: Object.freeze({ planKey: 'growth', botTier: 'standard', includedResponses: 2000, provisioningRequired: true, routing: 'standard' }),
  distribution: Object.freeze({ planKey: 'distribution', botTier: 'advanced', includedResponses: 3500, provisioningRequired: true, routing: 'simple_vs_complex' }),
  enterprise: Object.freeze({ planKey: 'enterprise', botTier: 'custom', includedResponses: null, provisioningRequired: true, routing: 'contractual' })
});

function normalizePlan(value) {
  const raw = String(value || '').trim().toLowerCase();
  return canonicalKey(raw) || LEGACY_ENTITLEMENT_PLAN_MAP[raw] || null;
}

function resolveAiPlanPolicy(plan) {
  const planKey = normalizePlan(plan) || 'core';
  return POLICY[planKey];
}

function resolveAiPolicyFromEntitlements(entitlements) {
  const policy = resolveAiPlanPolicy(entitlements && entitlements.planKey);
  const enabled = Boolean(entitlements && entitlements.state === 'active'
    && entitlements.botActive === true
    && entitlements.capabilities && entitlements.capabilities['bot.enabled'] === true);
  return Object.freeze({ ...policy, enabled });
}

module.exports = { POLICY, normalizePlan, resolveAiPlanPolicy, resolveAiPolicyFromEntitlements };
