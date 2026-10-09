const assert = require('assert');
const {
  summarizeAiUsage,
  crossedQuotaThresholds,
  resolveAiExecutionPolicy
} = (() => {
  const usage = require('../../src/repositories/ai-provisioning.repository');
  const policy = require('../../src/services/ai-plan-policy.service');
  return { ...usage, resolveAiExecutionPolicy: policy.resolveAiExecutionPolicy };
})();

function active(planKey) {
  return {
    state: 'active', botActive: true, planKey,
    capabilities: { 'bot.enabled': planKey !== 'core' }
  };
}

assert.deepStrictEqual(summarizeAiUsage({ includedResponses: 2000, succeededResponses: 1000, periodStart: 'a', periodEnd: 'b' }), {
  usedResponses: 1000, reservedResponses: 0, includedResponses: 2000, remainingResponses: 1000,
  percent: 50, quotaAvailable: true, periodStart: 'a', periodEnd: 'b'
});
assert.strictEqual(summarizeAiUsage({ includedResponses: 2000, succeededResponses: 2000 }).quotaAvailable, false);
assert.deepStrictEqual(crossedQuotaThresholds(49), []);
assert.deepStrictEqual(crossedQuotaThresholds(72), [50, 70]);
assert.deepStrictEqual(crossedQuotaThresholds(100), [50, 70, 100]);
assert.strictEqual(resolveAiExecutionPolicy({ entitlements: active('growth'), message: 'hola' }).logicalRoute, 'growth_standard');
assert.strictEqual(resolveAiExecutionPolicy({ entitlements: active('distribution'), message: 'hola' }).logicalRoute, 'distribution_simple');
assert.strictEqual(resolveAiExecutionPolicy({ entitlements: active('distribution'), message: 'comparar pedidos' }).logicalRoute, 'distribution_complex');
assert.strictEqual(resolveAiExecutionPolicy({ entitlements: active('enterprise'), message: 'hola' }).logicalRoute, 'enterprise_custom');

console.log('AI.QUOTA.CONTRACT validation passed');
