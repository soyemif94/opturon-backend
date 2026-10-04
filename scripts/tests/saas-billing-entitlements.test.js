const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../src/services/plan-catalog');
const { resolveEffectiveEntitlements: resolve, canCapability: can, canBotRespond: bot, canBotTool: tool } = require('../../src/services/effective-entitlements');
const settings = (planKey, botActive = true) => ({ botActive, portal: {
  entitlements: { source: 'billing', planKey, entitlementProfileVersion: 1 },
  billing: { entitlement: { state: 'active', paidAccessAllowed: true } }
} });
const channel = { clinicId: 'tenant-a', status: 'active', provider: 'whatsapp_cloud' };
const profile = (key, addons = []) => resolve(settings(key), addons);
test('A Core manual WhatsApp is independent of a stored true Bot preference', () => {
  const e = profile('core'); assert.equal(can(e, 'inbox'), true); assert.equal(can(e, 'channels.whatsapp'), true);
  assert.equal(e.botActive, true); assert.equal(bot(e, channel, 'tenant-a'), false);
});
test('B Growth + WhatsApp + botActive remains Bot-off and tier none', () => { assert.equal(bot(profile('growth'), channel, 'tenant-a'), false); assert.equal(profile('growth').capabilities['bot.tier'], 'none'); });
test('C Growth + Instagram + botActive remains Bot-off', () => { const e = profile('growth'); assert.equal(can(e, 'channels.instagram'), true); assert.equal(bot(e, { ...channel, provider: 'instagram' }, 'tenant-a'), false); });
test('D Growth keeps manual WhatsApp, Instagram and Inbox without Bot', () => {
  const e = profile('growth'); assert.equal(can(e, 'channels.whatsapp'), true); assert.equal(can(e, 'channels.instagram'), true);
  assert.equal(can(e, 'inbox'), true); assert.equal(e.botActive, true); assert.equal(can(e, 'bot.enabled'), false);
});
test('E Distribution + botActive uses Advanced Bot', () => { assert.equal(bot(profile('distribution'), channel, 'tenant-a'), true); assert.equal(profile('distribution').capabilities['bot.tier'], 'advanced'); assert.equal(tool(profile('distribution'), 'customer_history'), true); });
test('F Distribution + botActive=false keeps Bot off', () => assert.equal(bot(resolve(settings('distribution', false)), channel, 'tenant-a'), false));
test('G Enterprise resolves Custom tier without inventing integrations', () => { assert.equal(profile('enterprise').capabilities['bot.tier'], 'custom'); assert.equal(tool(profile('enterprise'), 'custom_instructions'), true); assert.equal(can(profile('enterprise'), 'custom_integrations'), false); });
test('H Growth cannot invoke Bot or catalog/order AI without commercial add-on', () => { assert.equal(tool(profile('growth'), 'ai_assist'), false); assert.equal(tool(profile('growth'), 'catalog'), false); assert.equal(tool(profile('growth'), 'orders'), false); });
test('I tenant settings/API-shaped fields cannot self-grant the commercial add-on', () => {
  const value = settings('growth'); value.portal.commercialEntitlements = ['bot_standard']; value.portal.entitlements.commercialAddons = ['bot_standard'];
  value.authorizedCommercialAddons = ['bot_standard']; value.botStandard = true;
  const e = resolve(value); assert.equal(can(e, 'bot.enabled'), false); assert.equal(bot(e, channel, 'tenant-a'), false);
});
test('J authorized standard add-on enables Growth Bot at Standard tier and catalog/orders tools', () => {
  const e = profile('growth', ['bot_standard']); assert.equal(bot(e, channel, 'tenant-a'), true);
  assert.equal(e.capabilities['bot.tier'], 'standard'); assert.equal(tool(e, 'catalog'), true); assert.equal(tool(e, 'orders'), true);
});
test('K standard add-on does not grant inventory AI', () => { const e = profile('growth', ['bot_standard']); assert.equal(tool(e, 'inventory'), false); assert.equal(tool(e, 'customer_history'), false); });
test('L Distribution can access inventory AI', () => assert.equal(tool(profile('distribution'), 'inventory'), true));
test('M WhatsApp connection alone never creates a commercial Bot grant', () => assert.equal(bot(profile('growth'), channel, 'tenant-a'), false));
test('N Instagram connection alone never creates a commercial Bot grant', () => assert.equal(bot(profile('growth'), { ...channel, provider: 'instagram' }, 'tenant-a'), false));
test('O suspended BILL-007 entitlement disables included Distribution Bot', () => {
  const value = settings('distribution'); value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  assert.equal(bot(resolve(value), channel, 'tenant-a'), false); assert.equal(can(resolve(value), 'bot.enabled'), false);
});
test('P later valid reactivation restores included Bot without changing profile', () => {
  const value = settings('distribution'); value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  assert.equal(bot(resolve(value), channel, 'tenant-a'), false); value.portal.billing.entitlement = { state: 'active', paidAccessAllowed: true };
  assert.equal(bot(resolve(value), channel, 'tenant-a'), true); assert.equal(resolve(value).capabilities['bot.tier'], 'advanced');
});
test('Q botActive preference survives suspension while effective Bot is disabled', () => {
  const value = settings('distribution', true); value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  const e = resolve(value); assert.equal(e.botActive, true); assert.equal(can(e, 'bot.enabled'), false);
});
test('R unknown plan or add-on fails closed', () => { assert.equal(can(resolve(settings('unknown'), ['bot_standard']), 'bot.enabled'), false); assert.equal(can(profile('growth', ['unknown_addon']), 'bot.enabled'), false); });
test('Inventory tool requires BOTH flags and honors tenant restriction', () => {
  assert.equal(tool(profile('distribution'), 'inventory'), true);
  const value = settings('distribution'); value.portal.policy = { enabledModules: { inventory: false } };
  assert.equal(tool(resolve(value), 'inventory'), false);
});
test('Core catalog Bot tool denied', () => assert.equal(tool(profile('core'), 'catalog'), false));
test('Tenant capability payload cannot elevate authoritative profile', () => {
  const value = settings('core'); Object.assign(value, { inventory: true, enterprise: true, 'bot.tier': 'custom' });
  value.portal.policy = { capabilities: ['inventory'], enabledModules: { inventory: true } };
  assert.equal(can(resolve(value), 'inventory'), false); assert.equal(resolve(value).capabilities['bot.tier'], 'none');
});
test('Core base modules allowed', () => ['inbox','crm','pipeline','agenda'].forEach(key => assert.equal(can(profile('core'), key), true)));
for (const [key, expected] of [['core',false],['growth',false],['distribution',true]]) {
  test(`Inventory module ${key}`, () => assert.equal(can(profile(key), 'inventory'), expected));
}
test('Paid suspension immediately restricts; reactivation restores same profile', () => {
  const value = settings('distribution'); const stored = structuredClone(value.portal.entitlements);
  value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  assert.equal(can(resolve(value), 'inventory'), false); assert.equal(bot(resolve(value), channel, 'tenant-a'), false);
  value.portal.billing.entitlement = { state: 'active', paidAccessAllowed: true };
  assert.equal(can(resolve(value), 'inventory'), true); assert.deepEqual(value.portal.entitlements, stored);
});
test('Unknown plan/version fail closed', () => {
  assert.equal(can(profile('unknown'), 'inbox'), false);
  const value = settings('enterprise'); value.portal.entitlements.entitlementProfileVersion = 2;
  assert.equal(can(resolve(value), 'inventory'), false);
});
test('Unknown capability/prototype key denied', () => { for (const key of ['typo', 'constructor', '__proto__', 'bot.tier']) assert.equal(can(profile('enterprise'), key), false); });
test('Invalid capability values are rejected, never coerced', () => {
  for (const capabilities of [{ 'bot.tier': 'super' }, { inbox: 'true' }, { inventory: 1 }, { arbitrary: true }]) assert.equal(catalog.validCapabilities(capabilities), false);
});
test('Inheritance cycle fails validation', () => assert.throws(() => catalog.flattenProfile('a', { a: { extends: 'b', capabilities: {} }, b: { extends: 'a', capabilities: {} } }), /cycle/));
for (const [parent, child] of [['growth','distribution'],['distribution','enterprise']]) {
  test(`Flattened inheritance ${child}`, () => {
    const base = catalog.resolveProfile(parent, 1), resolved = catalog.resolveProfile(child, 1);
    Object.entries(base).filter(([, value]) => value === true).forEach(([key]) => assert.equal(resolved[key], true));
    assert.equal(Object.keys(resolved).length, Object.keys(catalog.CAPABILITY_REGISTRY).length);
  });
}
test('Public DTO and Home keys equal all public internal profiles', () => {
  const plans = catalog.publicPlanCatalog();
  assert.deepEqual(plans.map(p => p.key), ['core','growth','distribution','enterprise']);
  plans.forEach(plan => {
    assert.ok(catalog.resolveProfile(plan.key, 1));
    assert.deepEqual(Object.keys(plan).sort(), ['key','displayName','description','pricingMode','amount','currency','billingCadence','highlights','recommended','ctaMode'].sort());
  });
  assert.deepEqual(plans.map(p => p.key), Object.keys(catalog.PUBLIC_PLANS));
  assert.equal(plans.find(p => p.key === 'growth').recommended, true);
  assert.doesNotMatch(plans.find(p => p.key === 'growth').highlights.join(' '), /bot/i);
  assert.match(plans.find(p => p.key === 'distribution').highlights.join(' '), /bot avanzado/i);
});
test('Case-normalized canonical key is a safe alias; old names are not guessed', () => { assert.equal(catalog.canonicalKey(' GROWTH '), 'growth'); assert.equal(catalog.canonicalKey('empresa'), null); });
test('Ambiguous labels do not grant capabilities without stored legacy provenance', () => {
  for (const planCode of ['empresa','enterprise','pro','basic','unknown']) assert.equal(can(resolve({ portal: { policy: { planCode } } }), 'inbox'), false);
  const value = { botActive: true, portal: { entitlements: { planKey: 'legacy_grandfathered', source: 'legacy_090', entitlementProfileVersion: 1,
    capabilities: { ...catalog.emptyCapabilities(), inbox: true } } } };
  assert.equal(can(resolve(value), 'inbox'), true); assert.equal(can(resolve(value), 'inventory'), false);
  value.portal.entitlements.capabilities.arbitrary = true; assert.equal(can(resolve(value), 'inbox'), false);
});
test('Strict false and missing Growth Bot preferences remain disabled without the add-on', () => {
  for (const active of [false, null, 'true', 1, undefined]) assert.equal(bot(resolve(settings('growth', active)), channel, 'tenant-a'), false);
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
