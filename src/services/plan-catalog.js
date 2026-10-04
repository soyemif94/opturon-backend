// BILL-008: the commercial catalog and its immutable v1 entitlement profiles.
// Add a new profile version for future changes; never edit a sold profile in place.
const PROFILE_VERSION = 1;
const BOT_TIERS = Object.freeze(['none', 'standard', 'advanced', 'custom']);
const BOOLEAN_CAPABILITIES = Object.freeze([
  'channels.whatsapp', 'channels.instagram', 'inbox', 'crm', 'pipeline', 'agenda',
  'bot.enabled', 'bot.ai_catalog', 'bot.ai_orders', 'bot.ai_inventory',
  'bot.ai_customer_history', 'bot.ai_custom_instructions', 'automations',
  'catalog', 'orders', 'payments', 'cash', 'loyalty', 'inventory', 'purchases',
  'suppliers', 'sellers', 'metrics', 'advanced_reports', 'receipts',
  'inventory_lots', 'expiration_tracking', 'operational_alerts', 'advanced_permissions'
]);
const CAPABILITY_REGISTRY = Object.freeze(Object.fromEntries([
  ...BOOLEAN_CAPABILITIES.map(key => [key, Object.freeze({ type: 'boolean' })]),
  ['bot.tier', Object.freeze({ type: 'enum', values: BOT_TIERS })]
]));
const LEGACY_CAPABILITY_MAP = Object.freeze({
  inbox: 'inbox', contacts: 'crm', sales_pipeline: 'pipeline', appointments: 'agenda',
  catalog: 'catalog', orders: 'orders', receipts: 'receipts', payments: 'payments',
  cash_management: 'cash', loyalty: 'loyalty', automations: 'automations', metrics: 'metrics',
  inventory: 'inventory', inventory_lots: 'inventory_lots', expiration_tracking: 'expiration_tracking',
  suppliers: 'suppliers', purchasing: 'purchases', field_sales: 'sellers'
});
const MODULE_CAPABILITIES = Object.freeze({
  inbox: 'inbox', contacts: 'crm', sales: 'pipeline', agenda: 'agenda', catalog: 'catalog',
  orders: 'orders', invoices: 'receipts', payments: 'payments', cash: 'cash', loyalty: 'loyalty',
  automations: 'automations', metrics: 'metrics', inventory: 'inventory'
});
const granted = keys => Object.fromEntries(keys.map(key => [key, true]));
const PROFILE_DEFINITIONS = Object.freeze({
  core: { capabilities: { ...granted(['channels.whatsapp', 'inbox', 'crm', 'pipeline', 'agenda']), 'bot.tier': 'none' } },
  growth: { extends: 'core', capabilities: { ...granted(['channels.instagram', 'bot.enabled', 'bot.ai_catalog', 'bot.ai_orders',
    'automations', 'catalog', 'orders', 'payments', 'cash', 'receipts', 'loyalty', 'metrics']), 'bot.tier': 'standard' } },
  distribution: { extends: 'growth', capabilities: { ...granted(['bot.enabled', 'bot.ai_catalog', 'bot.ai_orders',
    'bot.ai_inventory', 'bot.ai_customer_history',
    'inventory', 'purchases', 'suppliers', 'sellers', 'advanced_reports', 'inventory_lots', 'expiration_tracking',
    'operational_alerts']), 'bot.tier': 'advanced' } },
  enterprise: { extends: 'distribution', capabilities: { ...granted(['bot.ai_custom_instructions', 'advanced_permissions']), 'bot.tier': 'custom' } }
});
function emptyCapabilities() { return { ...Object.fromEntries(BOOLEAN_CAPABILITIES.map(key => [key, false])), 'bot.tier': 'none' }; }
function validCapabilities(values, complete = false) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  if (complete && Object.keys(values).length !== Object.keys(CAPABILITY_REGISTRY).length) return false;
  return Object.entries(values).every(([key, value]) => Object.hasOwn(CAPABILITY_REGISTRY, key)
    && (CAPABILITY_REGISTRY[key].type === 'boolean' ? typeof value === 'boolean' : BOT_TIERS.includes(value)));
}
function flattenProfile(key, definitions = PROFILE_DEFINITIONS, seen = new Set()) {
  if (!Object.hasOwn(definitions, key)) throw new Error('unknown_plan');
  if (seen.has(key)) throw new Error('plan_inheritance_cycle');
  const definition = definitions[key];
  if (!validCapabilities(definition.capabilities)) throw new Error('invalid_capabilities');
  const path = new Set([...seen, key]);
  return Object.freeze({ ...(definition.extends ? flattenProfile(definition.extends, definitions, path) : emptyCapabilities()), ...definition.capabilities });
}
const RESOLVED_PROFILES = Object.freeze(Object.fromEntries(Object.keys(PROFILE_DEFINITIONS).map(key => [key, flattenProfile(key)])));
function resolveProfile(key, version) {
  return version === PROFILE_VERSION && Object.hasOwn(RESOLVED_PROFILES, key) ? RESOLVED_PROFILES[key] : null;
}
// These existing ARS charges are retained. USD 29/49/79 were never provider authority.
const LEGACY_BILLING_PLANS = Object.freeze(Object.fromEntries([
  ['inicial', 'Plan Inicial', 40600], ['crecimiento', 'Plan Crecimiento', 68600], ['empresa', 'Plan Empresa', 208600]
].map(([code, label, amount]) => [code, Object.freeze({ code, label, amount, currency: 'ARS' })])));
const PUBLIC_PLANS = Object.freeze({
  core: { displayName: 'Core', description: 'Atención y seguimiento comercial.', priceSource: 'inicial', highlights: ['WhatsApp e Inbox', 'CRM, ventas y agenda'] },
  growth: { displayName: 'Growth', description: 'Automatización y operación comercial.', priceSource: 'crecimiento', highlights: ['Todo Core', 'Bot estándar, Instagram, catálogo y pedidos'] },
  distribution: { displayName: 'Distribución', description: 'Stock y operación de distribución.', highlights: ['Todo Growth', 'Bot avanzado, inventario, compras y proveedores'] },
  enterprise: { displayName: 'Enterprise', description: 'Operación con configuración avanzada.', highlights: ['Todo Distribución', 'Bot a medida, instrucciones y permisos avanzados'] }
});
function publicPlanCatalog() {
  return Object.entries(PUBLIC_PLANS).map(([key, plan]) => {
    const price = LEGACY_BILLING_PLANS[plan.priceSource];
    return { key, displayName: plan.displayName, description: plan.description,
      pricingMode: price ? 'fixed' : 'contact', amount: price?.amount ?? null,
      currency: price?.currency ?? null, billingCadence: 'monthly',
      highlights: [...plan.highlights], recommended: key === 'growth', ctaMode: price ? 'select_plan' : 'contact' };
  });
}
function canonicalKey(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(PUBLIC_PLANS, key) ? key : null;
}
function billingPlan(key) {
  const plan = PUBLIC_PLANS[key], price = plan && LEGACY_BILLING_PLANS[plan.priceSource];
  return price ? Object.freeze({ code: key, label: plan.displayName, amount: price.amount, currency: price.currency,
    entitlementProfileVersion: PROFILE_VERSION }) : null;
}
// Historical lifecycle labels are retained solely for old immutable contracts.
const LEGACY_LIFECYCLE_PLAN_MAP = Object.freeze({ inicial: 'basic', crecimiento: 'growth', empresa: 'enterprise' });
function lifecyclePlan(contract) { return contract.entitlementProfileVersion ? canonicalKey(contract.planCode) : LEGACY_LIFECYCLE_PLAN_MAP[contract.planCode] || null; }
// Entitlement normalization is deliberately separate from BILL-007's historical
// lifecycle codes; it never rewrites immutable subscription or contract rows.
const LEGACY_ENTITLEMENT_PLAN_MAP = Object.freeze({
  inicial: 'core', basic: 'core', core: 'core',
  crecimiento: 'growth', growth: 'growth',
  distribution: 'distribution',
  empresa: 'enterprise', enterprise: 'enterprise'
});
function legacyEntitlementPlan(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LEGACY_ENTITLEMENT_PLAN_MAP[code] || null;
}
module.exports = { PROFILE_VERSION, BOT_TIERS, CAPABILITY_REGISTRY, BOOLEAN_CAPABILITIES, LEGACY_CAPABILITY_MAP,
  MODULE_CAPABILITIES, PROFILE_DEFINITIONS, emptyCapabilities, validCapabilities, flattenProfile, resolveProfile,
  LEGACY_BILLING_PLANS, PUBLIC_PLANS, publicPlanCatalog, canonicalKey, billingPlan, lifecyclePlan,
  LEGACY_ENTITLEMENT_PLAN_MAP, legacyEntitlementPlan };
