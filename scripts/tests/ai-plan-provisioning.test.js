const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAiPlanPolicy, resolveAiPolicyFromEntitlements, resolveAiExecutionPolicy } = require('../../src/services/ai-plan-policy.service');

test('canonical AI plan matrix is stable', () => {
  assert.deepEqual(resolveAiPlanPolicy('core'), { planKey: 'core', botTier: 'none', includedResponses: 0, provisioningRequired: false, routing: 'disabled' });
  assert.equal(resolveAiPlanPolicy('growth').includedResponses, 2000);
  assert.equal(resolveAiPlanPolicy('distribution').includedResponses, 3500);
  assert.equal(resolveAiPlanPolicy('empresa').planKey, 'enterprise');
  assert.equal(resolveAiPlanPolicy('enterprise').botTier, 'custom');
});

test('AI runtime requires active entitlement and bot preference', () => {
  const base = { state: 'active', planKey: 'growth', botActive: true, capabilities: { 'bot.enabled': true } };
  assert.equal(resolveAiPolicyFromEntitlements(base).enabled, true);
  assert.equal(resolveAiPolicyFromEntitlements({ ...base, botActive: false }).enabled, false);
  assert.equal(resolveAiPolicyFromEntitlements({ ...base, state: 'inactive' }).enabled, false);
  assert.equal(resolveAiPolicyFromEntitlements({ ...base, planKey: 'core' }).botTier, 'none');
});

test('execution routing resolves plan-specific logical routes', () => {
  const entitlements = (planKey) => ({ planKey, state: 'active', botActive: true, capabilities: { 'bot.enabled': true } });
  assert.equal(resolveAiExecutionPolicy({ entitlements: entitlements('growth') }).logicalRoute, 'growth_standard');
  assert.equal(resolveAiExecutionPolicy({ entitlements: entitlements('distribution'), message: '¿Cuál es el precio?' }).logicalRoute, 'distribution_simple');
  assert.equal(resolveAiExecutionPolicy({ entitlements: entitlements('distribution'), message: 'Compará inventario e historial de pedidos con varias condiciones' }).logicalRoute, 'distribution_complex');
  assert.equal(resolveAiExecutionPolicy({ entitlements: entitlements('enterprise') }).logicalRoute, 'enterprise_custom');
});

test('092 creates durable provisioning and usage records without secrets', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/092_ai_plan_provisioning_usage.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE ai_tenant_provisioning/);
  assert.match(migration, /CREATE TABLE ai_usage_events/);
  assert.match(migration, /UNIQUE \("clinicId", "conversationId", "messageId"\)/);
  assert.doesNotMatch(migration, /OPENAI_API_KEY|Authorization|MERCADO_PAGO_ACCESS_TOKEN|DATABASE_URL/);
});
