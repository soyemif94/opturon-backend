const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../src/services/plan-catalog');
const { resolveEffectiveEntitlements: resolve, canCapability: can, canBotRespond: bot, canBotTool: tool } = require('../../src/services/effective-entitlements');
const settings = (planKey, botActive = true) => ({ botActive, portal: {
  entitlements: { source: 'billing', planKey, entitlementProfileVersion: 1 },
  billing: { entitlement: { state: 'active', paidAccessAllowed: true } }
} });
const channel = { clinicId: 'tenant-a', status: 'active', provider: 'whatsapp_cloud' };
const profile = key => resolve(settings(key));
test('A/F Core manual WhatsApp is independent of a stored true Bot preference', () => {
  const e = profile('core'); assert.equal(can(e, 'inbox'), true); assert.equal(can(e, 'channels.whatsapp'), true);
  assert.equal(e.botActive, true); assert.equal(bot(e, channel, 'tenant-a'), false);
});
test('B Growth explicitly disabled Bot cannot respond', () => assert.equal(bot(resolve(settings('growth', false)), channel, 'tenant-a'), false));
test('C Growth active connected Bot uses standard tier', () => { assert.equal(bot(profile('growth'), channel, 'tenant-a'), true); assert.equal(profile('growth').capabilities['bot.tier'], 'standard'); });
test('D Distribution has advanced Bot capabilities', () => { assert.equal(profile('distribution').capabilities['bot.tier'], 'advanced'); assert.equal(tool(profile('distribution'), 'customer_history'), true); });
test('E Enterprise resolves custom tier without inventing integrations', () => { assert.equal(profile('enterprise').capabilities['bot.tier'], 'custom'); assert.equal(tool(profile('enterprise'), 'custom_instructions'), true); assert.equal(can(profile('enterprise'), 'custom_integrations'), false); });
test('G Growth inventory AI denied', () => assert.equal(tool(profile('growth'), 'inventory'), false));
test('H inventory tool requires BOTH flags and honors tenant restriction', () => {
  assert.equal(tool(profile('distribution'), 'inventory'), true);
  const value = settings('distribution'); value.portal.policy = { enabledModules: { inventory: false } };
  assert.equal(tool(resolve(value), 'inventory'), false);
});
test('I Growth catalog tool allowed', () => assert.equal(tool(profile('growth'), 'catalog'), true));
test('J Core catalog Bot tool denied', () => assert.equal(tool(profile('core'), 'catalog'), false));
test('K tenant capability payload cannot elevate authoritative profile', () => {
  const value = settings('core'); Object.assign(value, { inventory: true, enterprise: true, 'bot.tier': 'custom' });
  value.portal.policy = { capabilities: ['inventory'], enabledModules: { inventory: true } };
  assert.equal(can(resolve(value), 'inventory'), false); assert.equal(resolve(value).capabilities['bot.tier'], 'none');
});
test('L Core base modules allowed', () => ['inbox','crm','pipeline','agenda'].forEach(key => assert.equal(can(profile('core'), key), true)));
for (const [name, key, expected] of [['M','core',false],['N','growth',false],['O','distribution',true]]) {
  test(`${name} inventory module ${key}`, () => assert.equal(can(profile(key), 'inventory'), expected));
}
test('P/Q paid suspension immediately restricts; reactivation restores same profile', () => {
  const value = settings('distribution'); const stored = structuredClone(value.portal.entitlements);
  value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  assert.equal(can(resolve(value), 'inventory'), false); assert.equal(bot(resolve(value), channel, 'tenant-a'), false);
  value.portal.billing.entitlement = { state: 'active', paidAccessAllowed: true };
  assert.equal(can(resolve(value), 'inventory'), true); assert.deepEqual(value.portal.entitlements, stored);
});
test('R unknown plan/version fail closed', () => {
  assert.equal(can(profile('unknown'), 'inbox'), false);
  const value = settings('enterprise'); value.portal.entitlements.entitlementProfileVersion = 2;
  assert.equal(can(resolve(value), 'inventory'), false);
});
test('S unknown capability/prototype key denied', () => { for (const key of ['typo', 'constructor', '__proto__', 'bot.tier']) assert.equal(can(profile('enterprise'), key), false); });
test('T invalid capability values are rejected, never coerced', () => {
  for (const capabilities of [{ 'bot.tier': 'super' }, { inbox: 'true' }, { inventory: 1 }, { arbitrary: true }]) assert.equal(catalog.validCapabilities(capabilities), false);
});
test('U inheritance cycle fails validation', () => assert.throws(() => catalog.flattenProfile('a', { a: { extends: 'b', capabilities: {} }, b: { extends: 'a', capabilities: {} } }), /cycle/));
for (const [name, parent, child] of [['V','growth','distribution'],['W','distribution','enterprise']]) {
  test(`${name} flattened inheritance ${child}`, () => {
    const base = catalog.resolveProfile(parent, 1), resolved = catalog.resolveProfile(child, 1);
    Object.entries(base).filter(([, value]) => value === true).forEach(([key]) => assert.equal(resolved[key], true));
    assert.equal(Object.keys(resolved).length, Object.keys(catalog.CAPABILITY_REGISTRY).length);
  });
}
test('X public DTO and Home keys equal all public internal profiles', () => {
  const plans = catalog.publicPlanCatalog();
  assert.deepEqual(plans.map(p => p.key), ['core','growth','distribution','enterprise']);
  plans.forEach(plan => {
    assert.ok(catalog.resolveProfile(plan.key, 1));
    assert.deepEqual(Object.keys(plan).sort(), ['key','displayName','description','pricingMode','amount','currency','billingCadence','highlights','recommended','ctaMode'].sort());
  });
  assert.deepEqual(plans.map(p => p.key), Object.keys(catalog.PUBLIC_PLANS));
  assert.equal(plans.find(p => p.key === 'growth').recommended, true);
});
test('Y case-normalized canonical key is a safe alias; old names are not guessed', () => { assert.equal(catalog.canonicalKey(' GROWTH '), 'growth'); assert.equal(catalog.canonicalKey('empresa'), null); });
test('Z ambiguous labels do not grant capabilities without stored legacy provenance', () => {
  for (const planCode of ['empresa','enterprise','pro','basic','unknown']) assert.equal(can(resolve({ portal: { policy: { planCode } } }), 'inbox'), false);
  const value = { botActive: true, portal: { entitlements: { planKey: 'legacy_grandfathered', source: 'legacy_090', entitlementProfileVersion: 1,
    capabilities: { ...catalog.emptyCapabilities(), inbox: true } } } };
  assert.equal(can(resolve(value), 'inbox'), true); assert.equal(can(resolve(value), 'inventory'), false);
  value.portal.entitlements.capabilities.arbitrary = true; assert.equal(can(resolve(value), 'inbox'), false);
});
test('AA strict false and missing Bot preferences remain disabled', () => {
  for (const active of [false, null, 'true', 1, undefined]) assert.equal(bot(resolve(settings('growth', active)), channel, 'tenant-a'), active === undefined);
  const value = settings('growth'); delete value.botActive; assert.equal(bot(resolve(value), channel, 'tenant-a'), false);
});
test('AB channel connectivity/foreign tenant cannot grant Bot', () => {
  assert.equal(bot(resolve({ botActive: true }), channel, 'tenant-a'), false);
  assert.equal(bot(profile('growth'), channel, 'tenant-b'), false);
  assert.equal(bot(profile('growth'), { ...channel, status: 'disconnected' }, 'tenant-a'), false);
});
test('AC pending contract or mutable policy label cannot activate a plan', () => {
  assert.equal(can(resolve({ portal: { policy: { planCode: 'enterprise' }, billing: { subscription: { planCode: 'enterprise', status: 'pending' } } } }), 'inventory'), false);
});
test('prices preserve ARS provider values; unset distribution price fails closed', () => {
  assert.deepEqual(Object.values(catalog.LEGACY_BILLING_PLANS).map(p => [p.amount,p.currency]), [[40600,'ARS'],[68600,'ARS'],[208600,'ARS']]);
  assert.equal(catalog.billingPlan('core').amount, 40600); assert.equal(catalog.billingPlan('growth').amount, 68600);
  assert.equal(catalog.billingPlan('distribution'), null); assert.equal(catalog.billingPlan('enterprise'), null);
});
test('tenant restrictions cannot remove source profile or grant denied capability', () => {
  const value = settings('growth'); value.portal.policy = { enabledModules: { catalog: false, inventory: true } };
  assert.equal(can(resolve(value), 'catalog'), false); assert.equal(can(resolve(value), 'inventory'), false);
  assert.equal(catalog.resolveProfile('growth', 1).catalog, true);
});
