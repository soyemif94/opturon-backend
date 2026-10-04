const test = require('node:test');
const assert = require('node:assert/strict');

test('BILL-007 nonpayment: existing module/capability gates consume durable entitlement without deleting settings', async t => {
  const dbPath = require.resolve('../../src/db/client');
  const policyPath = require.resolve('../../src/services/tenant-policy.service');
  const gatePath = require.resolve('../../src/middlewares/portal-module-gate.middleware');
  const originals = new Map([dbPath, policyPath, gatePath].map(id => [id, require.cache[id]]));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { query: () => { throw new Error('database_access_forbidden'); } } };
  delete require.cache[policyPath];
  const policyService = require(policyPath);
  let settings;
  require.cache[policyPath].exports = { ...policyService,
    resolveTenantPolicyByExternalTenantId: async () => ({ ok: true,
      clinic: { settings }, policy: policyService.buildTenantPolicyFromSettings(settings) }) };
  delete require.cache[gatePath];
  const { requirePortalModule, requirePortalCapability } = require(gatePath);
  async function check(gate, expected) {
    let next = false;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    await gate({ activeTenantId: 'tenant-test', body: { paidAccessAllowed: true } }, res, () => { next = true; });
    assert.equal(res.statusCode, expected); assert.equal(next, expected === 200);
    if (expected === 403) assert.equal(res.body.error, 'billing_entitlement_suspended');
  }
  try {
    for (const state of [null, 'active', 'payment_retrying', 'subscription_cancelled', 'suspended_for_nonpayment']) {
      await t.test(`state=${state}: only explicit nonpayment suspension denies paid modules`, async () => {
        settings = { portal: { accountScope: 'client', policy: { planCode: 'growth',
          capabilities: ['inventory'], enabledModules: { inventory: true } }, billing: { entitlement: state
          ? { state, paidAccessAllowed: state !== 'suspended_for_nonpayment', subscriptionId: 'fixture' } : null } } };
        const before = structuredClone(settings);
        const expected = state === 'suspended_for_nonpayment' ? 403 : 200;
        await check(requirePortalModule('inventory'), expected);
        await check(requirePortalCapability('inventory'), expected);
        assert.deepEqual(settings, before);
      });
    }
    await t.test('regularization restores access using unchanged configured capabilities', async () => {
      settings.portal.billing.entitlement = { state: 'active', paidAccessAllowed: true, subscriptionId: 'fixture' };
      await check(requirePortalModule('inventory'), 200); await check(requirePortalCapability('inventory'), 200);
      assert.equal(settings.portal.policy.planCode, 'growth');
      assert.deepEqual(settings.portal.policy.capabilities, ['inventory']);
    });
    await t.test('internal Opturon administration retains its existing bypass', async () => {
      settings.portal.accountScope = 'opturon_admin';
      settings.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
      await check(requirePortalModule('inventory'), 200); await check(requirePortalCapability('inventory'), 200);
    });
  } finally {
    for (const [id, value] of originals) { if (value) require.cache[id] = value; else delete require.cache[id]; }
  }
});
