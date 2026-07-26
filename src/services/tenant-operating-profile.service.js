const POLICY_VERSION = 1;

const INDUSTRY_PROFILES = Object.freeze([
  'wholesale_distribution',
  'retail_commerce',
  'appointment_services',
  'professional_services',
  'commerce_and_service',
  'custom'
]);

const OPERATING_MODELS = Object.freeze([
  'physical_goods',
  'services',
  'hybrid',
  'assets'
]);

const CAPABILITY_CATALOG = Object.freeze([
  'inbox',
  'contacts',
  'catalog',
  'orders',
  'receipts',
  'payments',
  'cash_management',
  'sales_pipeline',
  'appointments',
  'loyalty',
  'automations',
  'metrics',
  'inventory',
  'inventory_lots',
  'expiration_tracking',
  'suppliers',
  'purchasing',
  'customer_credit',
  'collections',
  'field_sales',
  'mobile_inventory',
  'whatsapp_documents'
]);

const MODULE_TO_CAPABILITY = Object.freeze({
  inbox: 'inbox',
  contacts: 'contacts',
  catalog: 'catalog',
  inventory: 'inventory',
  orders: 'orders',
  invoices: 'receipts',
  payments: 'payments',
  cash: 'cash_management',
  sales: 'sales_pipeline',
  agenda: 'appointments',
  loyalty: 'loyalty',
  automations: 'automations',
  metrics: 'metrics'
});

const IMPLEMENTED_MODULES = Object.freeze(Object.keys(MODULE_TO_CAPABILITY));

const LEGACY_ALWAYS_ENABLED_MODULES = Object.freeze([
  'home',
  'ops',
  'integrations',
  'settings',
  'users',
  'business',
  'faqs'
]);

const PRESET_DEFINITIONS = Object.freeze({
  wholesale_distribution: {
    key: 'wholesale_distribution',
    label: 'Distribucion mayorista',
    industryProfile: 'wholesale_distribution',
    operatingModel: 'physical_goods',
    recommendedCapabilities: [
      'inbox',
      'contacts',
      'catalog',
      'orders',
      'receipts',
      'payments',
      'cash_management',
      'sales_pipeline',
      'automations',
      'metrics'
    ],
    futureCapabilities: [
      'inventory',
      'inventory_lots',
      'expiration_tracking',
      'suppliers',
      'purchasing',
      'customer_credit',
      'collections',
      'field_sales',
      'mobile_inventory',
      'whatsapp_documents'
    ]
  },
  retail_commerce: {
    key: 'retail_commerce',
    label: 'Comercio minorista',
    industryProfile: 'retail_commerce',
    operatingModel: 'physical_goods',
    recommendedCapabilities: ['inbox', 'contacts', 'catalog', 'orders', 'receipts', 'payments', 'cash_management', 'metrics'],
    futureCapabilities: ['inventory']
  },
  appointment_services: {
    key: 'appointment_services',
    label: 'Servicios con agenda',
    industryProfile: 'appointment_services',
    operatingModel: 'services',
    recommendedCapabilities: ['inbox', 'contacts', 'appointments', 'payments', 'automations', 'metrics'],
    futureCapabilities: ['collections']
  },
  professional_services: {
    key: 'professional_services',
    label: 'Servicios profesionales',
    industryProfile: 'professional_services',
    operatingModel: 'services',
    recommendedCapabilities: ['inbox', 'contacts', 'appointments', 'payments', 'automations', 'metrics'],
    futureCapabilities: []
  },
  commerce_and_service: {
    key: 'commerce_and_service',
    label: 'Comercio y servicio',
    industryProfile: 'commerce_and_service',
    operatingModel: 'hybrid',
    recommendedCapabilities: ['inbox', 'contacts', 'catalog', 'orders', 'receipts', 'payments', 'appointments', 'automations', 'metrics'],
    futureCapabilities: ['inventory']
  },
  custom: {
    key: 'custom',
    label: 'Configuracion personalizada',
    industryProfile: 'custom',
    operatingModel: 'hybrid',
    recommendedCapabilities: ['inbox', 'contacts', 'payments', 'metrics'],
    futureCapabilities: []
  }
});

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeSlug(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeUniqueCapabilities(value) {
  const items = Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      items
        .map((item) => normalizeSlug(item))
        .filter((item) => CAPABILITY_CATALOG.includes(item))
    )
  );
}

function normalizeIndustryProfile(value, fallback = 'custom') {
  const normalized = normalizeSlug(value);
  return INDUSTRY_PROFILES.includes(normalized) ? normalized : fallback;
}

function normalizeOperatingModel(value, fallback = 'hybrid') {
  const normalized = normalizeSlug(value);
  return OPERATING_MODELS.includes(normalized) ? normalized : fallback;
}

function getPresetDefinition(value) {
  const normalized = normalizeIndustryProfile(value);
  return PRESET_DEFINITIONS[normalized] || PRESET_DEFINITIONS.custom;
}

function buildRecommendedCapabilities(presetKey) {
  const preset = getPresetDefinition(presetKey);
  return normalizeUniqueCapabilities([
    ...(preset.recommendedCapabilities || []),
    ...(preset.futureCapabilities || [])
  ]);
}

function normalizeOperatingProfile(value, fallbackPresetKey = 'custom') {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preset = getPresetDefinition(input.industryProfile || input.presetKey || fallbackPresetKey);
  const businessSubtype = normalizeSlug(input.businessSubtype) || null;

  return {
    presetKey: preset.key,
    industryProfile: preset.industryProfile,
    operatingModel: normalizeOperatingModel(input.operatingModel, preset.operatingModel),
    businessSubtype
  };
}

function hasExplicitOperatingConfiguration(policy = {}) {
  if (policy && typeof policy === 'object') {
    if (Number(policy.policyVersion) >= POLICY_VERSION) return true;
    if (policy.operatingProfile && typeof policy.operatingProfile === 'object') return true;
    if (Array.isArray(policy.capabilities) && policy.capabilities.length > 0) return true;
    if (policy.enabledModules && typeof policy.enabledModules === 'object' && Object.keys(policy.enabledModules).length > 0) {
      return true;
    }
  }
  return false;
}

function buildEnabledModules({ capabilities, explicitModules, legacyMode }) {
  const safeExplicit = explicitModules && typeof explicitModules === 'object' && !Array.isArray(explicitModules)
    ? explicitModules
    : {};

  return IMPLEMENTED_MODULES.reduce((acc, moduleName) => {
    const capability = MODULE_TO_CAPABILITY[moduleName];
    const capabilityGranted = capability ? capabilities.includes(capability) : true;

    if (typeof safeExplicit[moduleName] === 'boolean') {
      acc[moduleName] = legacyMode ? safeExplicit[moduleName] === true : capabilityGranted && safeExplicit[moduleName] === true;
      return acc;
    }

    if (!legacyMode && capability) {
      acc[moduleName] = capabilityGranted;
      return acc;
    }

    acc[moduleName] = true;
    return acc;
  }, {});
}

function buildAppModuleAccess(policy = null) {
  const safePolicy = policy && typeof policy === 'object' ? policy : {};
  const enabledModules = safePolicy.enabledModules && typeof safePolicy.enabledModules === 'object'
    ? safePolicy.enabledModules
    : {};

  return [...IMPLEMENTED_MODULES, ...LEGACY_ALWAYS_ENABLED_MODULES].reduce((acc, moduleName) => {
    if (Object.prototype.hasOwnProperty.call(enabledModules, moduleName)) {
      acc[moduleName] = enabledModules[moduleName] !== false;
      return acc;
    }
    acc[moduleName] = true;
    return acc;
  }, {});
}

module.exports = {
  POLICY_VERSION,
  INDUSTRY_PROFILES,
  OPERATING_MODELS,
  CAPABILITY_CATALOG,
  MODULE_TO_CAPABILITY,
  IMPLEMENTED_MODULES,
  PRESET_DEFINITIONS,
  normalizeUniqueCapabilities,
  normalizeOperatingProfile,
  getPresetDefinition,
  buildRecommendedCapabilities,
  buildEnabledModules,
  buildAppModuleAccess,
  hasExplicitOperatingConfiguration
};
