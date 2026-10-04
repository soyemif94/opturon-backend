const { emptyCapabilities, validCapabilities, resolveProfile, MODULE_CAPABILITIES, LEGACY_CAPABILITY_MAP,
  CAPABILITY_REGISTRY } = require('./plan-catalog');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const INACTIVE = new Set(['unactivated', 'inactive', 'suspended', 'suspended_for_nonpayment', 'reversed', 'archived', 'deleted']);

// No cache: every backend guard/tool resolves the current durable clinic settings.
function resolveEffectiveEntitlements(settings = {}) {
  const safeSettings = object(settings);
  const portal = object(safeSettings.portal), stored = object(portal.entitlements);
  const billing = object(object(portal.billing).entitlement), policy = object(portal.policy);
  const knownLegacy = stored.source === 'legacy_090' && stored.entitlementProfileVersion === 1
    && stored.planKey === 'legacy_grandfathered' && validCapabilities(stored.capabilities, true);
  const profile = knownLegacy ? stored.capabilities : stored.source === 'billing'
    ? resolveProfile(stored.planKey, stored.entitlementProfileVersion) : null;
  const inactive = INACTIVE.has(billing.state) || billing.paidAccessAllowed === false
    || INACTIVE.has(object(portal.lifecycle).status);
  const capabilities = { ...(profile && !inactive ? profile : emptyCapabilities()) };
  // A settings switch is restrictive only. It can never create an entitlement.
  for (const [module, capability] of Object.entries(MODULE_CAPABILITIES)) {
    if (object(policy.enabledModules)[module] === false) capabilities[capability] = false;
  }
  if (knownLegacy && Array.isArray(policy.capabilities)) {
    for (const [old, capability] of Object.entries(LEGACY_CAPABILITY_MAP)) {
      const strictLegacyGuard = ['contacts','orders','receipts','cash_management','inventory'].includes(old);
      if ((strictLegacyGuard || Number(policy.policyVersion) >= 1)
        && Object.values(MODULE_CAPABILITIES).includes(capability) && !policy.capabilities.includes(old)) capabilities[capability] = false;
    }
  }
  if (!capabilities['bot.enabled']) capabilities['bot.tier'] = 'none';
  return Object.freeze({ registryVersion: 1, planKey: profile ? stored.planKey : null,
    entitlementProfileVersion: profile ? stored.entitlementProfileVersion : null,
    state: !profile ? 'unactivated' : inactive ? 'inactive' : 'active',
    reason: !profile ? 'entitlement_profile_required' : inactive ? 'billing_entitlement_inactive' : null,
    botActive: safeSettings.botActive === true, capabilities: Object.freeze(capabilities) });
}
function canCapability(entitlements, key) {
  return Object.hasOwn(CAPABILITY_REGISTRY, key) && CAPABILITY_REGISTRY[key].type === 'boolean'
    && entitlements?.capabilities?.[key] === true;
}
function canBotRespond(entitlements, channel, clinicId) {
  return Boolean(channel && channel.clinicId === clinicId && channel.provider === 'whatsapp_cloud'
    && channel.status === 'active' && canCapability(entitlements, 'channels.whatsapp')
    && canCapability(entitlements, 'bot.enabled') && entitlements.botActive === true);
}
const BOT_TOOL_CAPABILITIES = Object.freeze({
  ai_assist: ['bot.enabled'],
  catalog: ['bot.ai_catalog', 'catalog'], orders: ['bot.ai_orders', 'orders'],
  inventory: ['bot.ai_inventory', 'inventory'], customer_history: ['bot.ai_customer_history'],
  custom_instructions: ['bot.ai_custom_instructions'], agenda: ['agenda'], loyalty: ['loyalty'],
  automations: ['automations'], payments: ['payments']
});
function canBotTool(entitlements, tool) {
  return canCapability(entitlements, 'bot.enabled') && entitlements.botActive === true
    && Object.hasOwn(BOT_TOOL_CAPABILITIES, tool) && BOT_TOOL_CAPABILITIES[tool].every(key => canCapability(entitlements, key));
}
module.exports = { resolveEffectiveEntitlements, canCapability, canBotRespond, canBotTool, BOT_TOOL_CAPABILITIES };
