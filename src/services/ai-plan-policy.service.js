const { canonicalKey, LEGACY_ENTITLEMENT_PLAN_MAP } = require('./plan-catalog');
const env = require('../config/env');

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

function resolveAiExecutionPolicy({ entitlements, message = '', decision = null, context = {} } = {}) {
  const base = resolveAiPolicyFromEntitlements(entitlements);
  if (!base.enabled) return Object.freeze({ ...base, logicalRoute: 'disabled', providerModel: null, routeReason: 'not_entitled' });
  const text = String(message || '').toLowerCase();
  const complexSignals = ['historial', 'inventario', 'pedido', 'pedidos', 'varios', 'varias', 'condiciones', 'comparar', 'distribu', 'ambig', 'multi-turn'];
  const hasContext = Boolean(context && typeof context === 'object' && Object.keys(context).length > 2);
  const complex = base.planKey === 'distribution' && (hasContext || complexSignals.some(signal => text.includes(signal)) || String(decision?.intent || '').includes('multi') || String(decision?.intent || '').includes('distribution'));
  if (base.planKey === 'growth') return Object.freeze({ ...base, logicalRoute: 'growth_standard', providerModel: env.aiModelGrowth, routeReason: 'growth_policy' });
  if (base.planKey === 'distribution') return Object.freeze({ ...base, logicalRoute: complex ? 'distribution_complex' : 'distribution_simple', providerModel: complex ? env.aiModelDistributionComplex : env.aiModelDistributionSimple, routeReason: complex ? 'complex_signal' : 'simple_default' });
  if (base.planKey === 'enterprise') return Object.freeze({ ...base, logicalRoute: 'enterprise_custom', providerModel: env.aiModelEnterpriseDefault, routeReason: 'enterprise_default' });
  return Object.freeze({ ...base, logicalRoute: 'disabled', providerModel: null, routeReason: 'core_policy' });
}

module.exports = { POLICY, normalizePlan, resolveAiPlanPolicy, resolveAiPolicyFromEntitlements, resolveAiExecutionPolicy };
