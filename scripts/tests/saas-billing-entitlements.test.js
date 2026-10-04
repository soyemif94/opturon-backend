const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../src/services/plan-catalog');
const { resolveEffectiveEntitlements: resolve, canCapability: can, canBotRespond: bot, canBotTool: tool } = require('../../src/services/effective-entitlements');

const settings = (planKey, botActive = true, state = 'active') => ({ botActive, portal: {
  entitlements: { source: 'billing', planKey, entitlementProfileVersion: 1 },
  billing: { entitlement: { state, paidAccessAllowed: state === 'active' } }
} });
const channel = { clinicId: 'tenant-a', status: 'active', provider: 'whatsapp_cloud' };
const profile = (key, botActive = true, state = 'active') => resolve(settings(key, botActive, state));
const legacySnapshot = legacyPlanCode => ({ botActive: true, bot: { enabled: true, active: true }, portal: { entitlements: {
  source: 'legacy_090', planKey: 'legacy_grandfathered', entitlementProfileVersion: 1, legacyPlanCode,
  capabilities: { ...catalog.emptyCapabilities(), inbox: true, 'channels.whatsapp': true,
    'bot.enabled': true, 'bot.tier': 'custom', 'bot.ai_catalog': true, 'bot.ai_orders': true,
    'bot.ai_inventory': true, 'bot.ai_customer_history': true, 'bot.ai_custom_instructions': true }
} } });

test('A Core plus WhatsApp plus botActive=true keeps manual Inbox and Bot off', () => {
  const e = profile('core');
  assert.equal(can(e, 'channels.whatsapp'), true); assert.equal(can(e, 'inbox'), true);
  assert.equal(e.botActive, true); assert.equal(bot(e, channel, 'tenant-a'), false);
  assert.equal(can(e, 'bot.enabled'), false); assert.equal(e.capabilities['bot.tier'], 'none');
});
test('B Growth plus WhatsApp plus botActive=true includes Standard Bot', () => {
  const e = profile('growth'); assert.equal(bot(e, channel, 'tenant-a'), true);
  assert.equal(can(e, 'bot.enabled'), true); assert.equal(e.capabilities['bot.tier'], 'standard');
});
test('C Growth Standard entitlement is available with Instagram but response entrypoint stays WhatsApp-only', () => {
  const e = profile('growth');
  assert.equal(can(e, 'channels.instagram'), true); assert.equal(can(e, 'bot.enabled'), true);
  assert.equal(bot(e, { ...channel, provider: 'instagram' }, 'tenant-a'), false);
});
test('D Growth plus botActive=false keeps the included entitlement but cannot answer', () => {
  const e = profile('growth', false); assert.equal(can(e, 'bot.enabled'), true);
  assert.equal(e.capabilities['bot.tier'], 'standard'); assert.equal(bot(e, channel, 'tenant-a'), false);
});
test('E Growth catalog AI is allowed', () => assert.equal(tool(profile('growth'), 'catalog'), true));
test('F Growth order AI is allowed', () => assert.equal(tool(profile('growth'), 'orders'), true));
test('G Growth inventory AI is blocked', () => assert.equal(tool(profile('growth'), 'inventory'), false));
test('H Growth customer-history AI is blocked', () => assert.equal(tool(profile('growth'), 'customer_history'), false));
test('I Distribution plus botActive=true uses Advanced Bot', () => {
  const e = profile('distribution'); assert.equal(bot(e, channel, 'tenant-a'), true);
  assert.equal(e.capabilities['bot.tier'], 'advanced');
});
test('J Distribution inventory AI is allowed', () => assert.equal(tool(profile('distribution'), 'inventory'), true));
test('K Distribution customer-history AI is allowed', () => assert.equal(tool(profile('distribution'), 'customer_history'), true));
test('L Enterprise custom instructions are allowed without inventing custom integrations', () => {
  const e = profile('enterprise'); assert.equal(e.capabilities['bot.tier'], 'custom');
  assert.equal(tool(e, 'custom_instructions'), true); assert.equal(can(e, 'custom_integrations'), false);
});
test('M WhatsApp connection state cannot change a plan entitlement', () => {
  const before = profile('growth'); const disconnected = { ...channel, status: 'disconnected' };
  assert.equal(bot(before, disconnected, 'tenant-a'), false);
  assert.equal(can(before, 'bot.enabled'), true); assert.equal(before.capabilities['bot.tier'], 'standard');
});
test('N Instagram connection state cannot change a plan entitlement', () => {
  const before = profile('growth'); const connected = { ...channel, provider: 'instagram' };
  assert.equal(bot(before, connected, 'tenant-a'), false);
  assert.equal(can(before, 'bot.enabled'), true); assert.equal(before.capabilities['bot.tier'], 'standard');
});
test('O Core settings cannot self-grant bot, tier or AI capabilities', () => {
  const value = settings('core'); value.bot = { enabled: true, tier: 'custom' };
  value.portal.commercialEntitlements = ['bot_standard'];
  value.portal.entitlements.capabilities = { 'bot.enabled': true, 'bot.tier': 'custom', 'bot.ai_catalog': true };
  const e = resolve(value); assert.equal(can(e, 'bot.enabled'), false); assert.equal(e.capabilities['bot.tier'], 'none');
  assert.equal(tool(e, 'catalog'), false);
});
test('P Growth Standard comes from its plan with no add-on input', () => {
  const e = resolve(settings('growth')); assert.equal(e.capabilities['bot.enabled'], true);
  assert.equal(e.capabilities['bot.tier'], 'standard'); assert.deepEqual(e.commercialAddons, undefined);
});
test('Q BILL-007 suspension disables the included Growth Bot', () => {
  const e = profile('growth', true, 'suspended_for_nonpayment');
  assert.equal(can(e, 'bot.enabled'), false); assert.equal(bot(e, channel, 'tenant-a'), false);
});
test('R BILL-007 reactivation restores the same Growth Standard Bot profile', () => {
  const stored = settings('growth'); const value = structuredClone(stored);
  value.portal.billing.entitlement = { state: 'suspended_for_nonpayment', paidAccessAllowed: false };
  assert.equal(bot(resolve(value), channel, 'tenant-a'), false);
  value.portal.billing.entitlement = { state: 'active', paidAccessAllowed: true };
  assert.equal(bot(resolve(value), channel, 'tenant-a'), true);
  assert.deepEqual(value.portal.entitlements, stored.portal.entitlements);
  assert.equal(resolve(value).capabilities['bot.tier'], 'standard');
});
test('S legacy Core cannot retain a blanket Bot grant from legacy_090', () => {
  const e = resolve(legacySnapshot('inicial'));
  assert.equal(e.planKey, 'core'); assert.equal(can(e, 'channels.whatsapp'), true);
  assert.equal(can(e, 'catalog'), false); assert.equal(can(e, 'bot.enabled'), false);
  assert.equal(e.capabilities['bot.tier'], 'none'); assert.equal(e.botActive, true);
});
test('T legacy Growth resolves to Standard Bot and canonical Growth capabilities', () => {
  const e = resolve(legacySnapshot('crecimiento'));
  assert.equal(e.planKey, 'growth'); assert.equal(can(e, 'bot.enabled'), true);
  assert.equal(e.capabilities['bot.tier'], 'standard'); assert.equal(can(e, 'catalog'), true);
  assert.equal(tool(e, 'catalog'), true); assert.equal(tool(e, 'orders'), true);
  assert.equal(tool(e, 'inventory'), false); assert.equal(e.botActive, true);
});
test('Legacy Enterprise normalizes to custom while historical BILL-007 plan codes remain intact', () => {
  assert.equal(resolve(legacySnapshot('empresa')).capabilities['bot.tier'], 'custom');
  assert.equal(catalog.lifecyclePlan({ planCode: 'inicial' }), 'basic');
  assert.equal(catalog.lifecyclePlan({ planCode: 'crecimiento' }), 'growth');
  assert.equal(catalog.lifecyclePlan({ planCode: 'empresa' }), 'enterprise');
});
test('Unknown legacy plan retains its frozen non-Bot snapshot but fails closed for Bot', () => {
  const value = legacySnapshot('unknown'); const e = resolve(value);
  assert.equal(can(e, 'inbox'), true); assert.equal(can(e, 'bot.enabled'), false);
  assert.equal(e.capabilities['bot.tier'], 'none');
});
test('Unknown or unsupported billing profile fails closed', () => {
  assert.equal(can(resolve(settings('unknown')), 'inbox'), false);
  const value = settings('enterprise'); value.portal.entitlements.entitlementProfileVersion = 2;
  assert.equal(can(resolve(value), 'inventory'), false);
});
test('Tenant capability settings can restrict but never elevate the canonical profile', () => {
  const value = settings('growth'); value.portal.policy = { enabledModules: { catalog: false, inventory: true }, capabilities: ['inventory'] };
  assert.equal(can(resolve(value), 'catalog'), false); assert.equal(can(resolve(value), 'inventory'), false);
  assert.equal(can(resolve(settings('core')), 'bot.enabled'), false);
});
test('Bot preference requires a strict boolean true and remains separate from entitlement', () => {
  for (const active of [false, null, 'true', 1, undefined]) {
    const value = settings('growth', active); if (active === undefined) delete value.botActive;
    const e = resolve(value); assert.equal(can(e, 'bot.enabled'), true); assert.equal(bot(e, channel, 'tenant-a'), false);
  }
});
test('Channel ownership, provider, status and plan are all enforced', () => {
  const e = profile('growth');
  assert.equal(bot(e, { ...channel, clinicId: 'tenant-b' }, 'tenant-a'), false);
  assert.equal(bot(e, { ...channel, status: 'pending' }, 'tenant-a'), false);
  assert.equal(bot(e, { ...channel, provider: 'instagram' }, 'tenant-a'), false);
  assert.equal(bot(profile('core'), channel, 'tenant-a'), false);
});
test('Growth and Distribution tool checks require all plan-specific capabilities', () => {
  assert.equal(tool(profile('growth'), 'catalog'), true); assert.equal(tool(profile('growth'), 'orders'), true);
  assert.equal(tool(profile('growth'), 'inventory'), false); assert.equal(tool(profile('distribution'), 'inventory'), true);
});
test('Core modules remain available without Bot', () => ['inbox','crm','pipeline','agenda','channels.whatsapp']
  .forEach(key => assert.equal(can(profile('core'), key), true)));
test('Unknown capability and prototype keys are denied', () => {
  for (const key of ['typo', 'constructor', '__proto__', 'bot.tier']) assert.equal(can(profile('enterprise'), key), false);
});
test('Invalid capability values are rejected without coercion', () => {
  for (const capabilities of [{ 'bot.tier': 'super' }, { inbox: 'true' }, { inventory: 1 }, { arbitrary: true }]) {
    assert.equal(catalog.validCapabilities(capabilities), false);
  }
});
test('Legacy snapshot with malformed or untrusted capability shape fails closed', () => {
  const value = legacySnapshot('crecimiento'); value.portal.entitlements.capabilities.arbitrary = true;
  assert.equal(can(resolve(value), 'bot.enabled'), false);
});
test('Plan profile inheritance preserves all parent capabilities', () => {
  for (const [parent, child] of [['core','growth'],['growth','distribution'],['distribution','enterprise']]) {
    const base = catalog.resolveProfile(parent, 1), resolved = catalog.resolveProfile(child, 1);
    Object.entries(base).filter(([, value]) => value === true).forEach(([key]) => assert.equal(resolved[key], true));
    assert.equal(Object.keys(resolved).length, Object.keys(catalog.CAPABILITY_REGISTRY).length);
  }
});
test('Public plan DTOs preserve canonical keys, API shape and the included Growth Bot', () => {
  const plans = catalog.publicPlanCatalog();
  assert.deepEqual(plans.map(p => p.key), ['core','growth','distribution','enterprise']);
  plans.forEach(plan => {
    assert.ok(catalog.resolveProfile(plan.key, 1));
    assert.deepEqual(Object.keys(plan).sort(), ['key','displayName','description','pricingMode','amount','currency','billingCadence','highlights','recommended','ctaMode'].sort());
  });
  assert.match(plans.find(p => p.key === 'growth').highlights.join(' '), /bot estándar/i);
  assert.match(plans.find(p => p.key === 'distribution').highlights.join(' '), /bot avanzado/i);
});
test('Prices and provider billing amounts are unchanged', () => {
  assert.deepEqual(Object.values(catalog.LEGACY_BILLING_PLANS).map(p => [p.amount,p.currency]), [[40600,'ARS'],[68600,'ARS'],[208600,'ARS']]);
  assert.equal(catalog.billingPlan('core').amount, 40600); assert.equal(catalog.billingPlan('growth').amount, 68600);
  assert.equal(catalog.billingPlan('distribution'), null); assert.equal(catalog.billingPlan('enterprise'), null);
});
test('Case-normalized canonical key is a safe alias; historical Empresa is mapped only for entitlements', () => {
  assert.equal(catalog.canonicalKey(' GROWTH '), 'growth'); assert.equal(catalog.canonicalKey('empresa'), null);
  assert.equal(catalog.legacyEntitlementPlan(' EMPRESA '), 'enterprise');
});
test('Pending contracts and mutable policy labels cannot activate a paid plan', () => {
  const value = { portal: { policy: { planCode: 'enterprise' }, billing: { subscription: { planCode: 'enterprise', status: 'pending' } } } };
  assert.equal(can(resolve(value), 'inventory'), false);
});
