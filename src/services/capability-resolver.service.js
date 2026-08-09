const { buildTenantPolicyFromSettings } = require('./tenant-policy.service');

const CAPABILITY_STATUSES = Object.freeze({
  AVAILABLE_NOW: 'AVAILABLE_NOW',
  AVAILABLE_WITH_CONFIGURATION: 'AVAILABLE_WITH_CONFIGURATION',
  AVAILABLE_WITH_INTEGRATION: 'AVAILABLE_WITH_INTEGRATION',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  UNKNOWN: 'UNKNOWN'
});

const CAPABILITY_SOURCES = Object.freeze({
  PRODUCT_REGISTRY: 'product_capability_registry',
  TENANT_POLICY: 'tenant_policy',
  TENANT_CONFIGURATION: 'tenant_configuration',
  CONNECTED_INTEGRATION: 'connected_integration',
  UNREGISTERED: 'unregistered_capability'
});

const CAPABILITY_DEFINITIONS = Object.freeze({
  inbox: {
    tenantModule: 'inbox',
    tenantCapability: 'inbox',
    productSurface: 'portal'
  },
  catalog: {
    tenantModule: 'catalog',
    tenantCapability: 'catalog',
    botAction: 'catalog_read'
  },
  internal_inventory: {
    tenantModule: 'inventory',
    tenantCapability: 'inventory',
    botAction: 'internal_inventory_read'
  },
  orders: {
    tenantModule: 'orders',
    tenantCapability: 'orders',
    botAction: 'order_create'
  },
  agenda: {
    tenantModule: 'agenda',
    tenantCapability: 'appointments',
    botAction: 'appointment_booking'
  },
  loyalty: {
    tenantModule: 'loyalty',
    tenantCapability: 'loyalty',
    botAction: 'loyalty_lookup'
  },
  automations: {
    tenantModule: 'automations',
    tenantCapability: 'automations',
    botAction: 'automation_reply'
  },
  whatsapp_messaging: {
    tenantModule: 'inbox',
    tenantCapability: 'inbox',
    requiredIntegration: 'whatsapp_cloud',
    missingIntegration: 'active_whatsapp_channel',
    botAction: 'whatsapp_send'
  },
  instagram_inbox: {
    tenantModule: 'inbox',
    tenantCapability: 'inbox',
    requiredIntegration: 'instagram_graph',
    missingIntegration: 'active_instagram_channel',
    productSurface: 'portal'
  },
  transfer_payment_instructions: {
    tenantModule: 'payments',
    tenantCapability: 'payments',
    requiredConfiguration: [
      { key: 'transferDataConfigured', label: 'transfer_data' }
    ],
    botAction: 'transfer_instructions'
  },
  ai_assist: {
    requiredConfiguration: [
      { key: 'aiProviderConfigured', label: 'ai_provider' },
      { key: 'aiEnabled', label: 'tenant_ai_enablement' }
    ],
    botAction: 'ai_assist'
  },
  external_inventory_sync: {
    integrationRequired: ['supported_external_inventory_adapter'],
    supportedIntegrations: [],
    botAction: null
  },
  empretienda_inventory_adapter: {
    unsupportedReason: 'empretienda_adapter_not_implemented'
  },
  tiendanube_inventory_adapter: {
    unsupportedReason: 'tiendanube_adapter_not_implemented'
  },
  cianbox_inventory_adapter: {
    unsupportedReason: 'cianbox_adapter_not_implemented'
  },
  automatic_payment_validation: {
    unsupportedReason: 'payment_validation_requires_human_action'
  },
  fiscal_receipt_issuance: {
    unsupportedReason: 'bot_fiscal_receipt_action_not_implemented'
  },
  cash_management_bot: {
    unsupportedReason: 'bot_cash_action_not_implemented'
  },
  supplier_management_bot: {
    unsupportedReason: 'bot_supplier_action_not_implemented'
  },
  instagram_automatic_replies: {
    unsupportedReason: 'instagram_bot_outbound_not_implemented'
  },
  order_customer_notification: {
    unsupportedReason: 'order_customer_notification_not_implemented'
  }
});

const CONFIGURATION_LABELS = Object.freeze({
  active_whatsapp_channel: 'un canal de WhatsApp activo',
  active_instagram_channel: 'un canal de Instagram activo',
  transfer_data: 'los datos de transferencia',
  ai_provider: 'el proveedor de IA',
  tenant_ai_enablement: 'la habilitacion de IA para este tenant'
});

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeCapability(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTenantId(tenant) {
  return normalizeString(tenant && (tenant.id || tenant.clinicId || tenant.tenantId)) || null;
}

function normalizeIntegration(value, tenantId) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const itemTenantId = normalizeString(item.tenantId || item.clinicId) || null;
  if (!tenantId || !itemTenantId || itemTenantId !== tenantId) return null;

  const type = normalizeCapability(item.type || item.provider || item.integration);
  if (!type) return null;
  return {
    tenantId,
    type,
    status: normalizeString(item.status).toLowerCase() || 'unknown',
    configured: item.configured === true
  };
}

function buildChannelIntegrationSnapshot(channel, tenantId) {
  const safeChannel = channel && typeof channel === 'object' && !Array.isArray(channel) ? channel : {};
  const channelTenantId = normalizeString(safeChannel.clinicId || safeChannel.tenantId) || tenantId;
  if (!tenantId || channelTenantId !== tenantId) return null;

  const provider = normalizeCapability(safeChannel.provider);
  const type = normalizeCapability(safeChannel.type);
  if (provider === 'whatsapp_cloud') {
    return {
      tenantId,
      type: 'whatsapp_cloud',
      status: normalizeString(safeChannel.status).toLowerCase() || 'unknown',
      configured: Boolean(
        normalizeString(safeChannel.phoneNumberId) &&
        safeChannel.credentialsConfigured === true
      )
    };
  }
  if (provider === 'instagram_graph' || type === 'instagram') {
    return {
      tenantId,
      type: 'instagram_graph',
      status: normalizeString(safeChannel.status).toLowerCase() || 'unknown',
      configured: Boolean(
        safeChannel.credentialsConfigured === true &&
        normalizeString(safeChannel.instagramUserId || safeChannel.externalId)
      )
    };
  }
  return null;
}

function buildTenantCapabilitySnapshot({
  clinic,
  channels = [],
  integrations = [],
  configuration = {},
  botActions = null
} = {}) {
  const safeClinic = clinic && typeof clinic === 'object' && !Array.isArray(clinic) ? clinic : {};
  const id = normalizeTenantId(safeClinic);
  const settings = parseObject(safeClinic.settings);
  const safeConfiguration = parseObject(configuration);
  const channelIntegrations = (Array.isArray(channels) ? channels : [])
    .map((channel) => buildChannelIntegrationSnapshot(channel, id))
    .filter(Boolean);
  const explicitIntegrations = (Array.isArray(integrations) ? integrations : [])
    .map((integration) => normalizeIntegration(integration, id))
    .filter(Boolean);

  return {
    id,
    policy: buildTenantPolicyFromSettings(settings),
    integrations: [...channelIntegrations, ...explicitIntegrations],
    configuration: {
      transferDataConfigured: safeConfiguration.transferDataConfigured === true,
      aiProviderConfigured: safeConfiguration.aiProviderConfigured === true,
      aiEnabled: safeConfiguration.aiEnabled === true
    },
    botActions: Array.isArray(botActions)
      ? botActions.map(normalizeCapability).filter(Boolean)
      : null
  };
}

function getTenantPolicy(tenant) {
  if (tenant && tenant.policy && typeof tenant.policy === 'object' && !Array.isArray(tenant.policy)) {
    return tenant.policy;
  }
  return buildTenantPolicyFromSettings(tenant && tenant.settings);
}

function isTenantModuleEnabled(policy, moduleName) {
  if (!moduleName) return true;
  const enabledModules = policy && policy.enabledModules && typeof policy.enabledModules === 'object'
    ? policy.enabledModules
    : {};
  return enabledModules[moduleName] === true;
}

function isBotActionEnabled(tenant, action) {
  if (!action) return true;
  if (!Array.isArray(tenant && tenant.botActions)) return true;
  return tenant.botActions.map(normalizeCapability).includes(normalizeCapability(action));
}

function findConnectedIntegration(tenant, integrationType) {
  const tenantId = normalizeTenantId(tenant);
  if (!tenantId) return null;
  const expectedType = normalizeCapability(integrationType);
  return (Array.isArray(tenant && tenant.integrations) ? tenant.integrations : [])
    .map((integration) => normalizeIntegration(integration, tenantId))
    .filter(Boolean)
    .find((integration) => (
      integration.type === expectedType &&
      integration.status === 'active' &&
      integration.configured === true
    )) || null;
}

function sanitizeCapabilityDecision(value) {
  const decision = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = Object.values(CAPABILITY_STATUSES).includes(decision.status)
    ? decision.status
    : CAPABILITY_STATUSES.UNKNOWN;
  const configurationMissing = Array.isArray(decision.configurationMissing)
    ? decision.configurationMissing.map(normalizeCapability).filter(Boolean)
    : [];
  const integrationRequired = Array.isArray(decision.integrationRequired)
    ? decision.integrationRequired.map(normalizeCapability).filter(Boolean)
    : [];
  return {
    capability: normalizeCapability(decision.capability) || 'unknown',
    status,
    reason: normalizeCapability(decision.reason) || 'capability_unresolved',
    source: normalizeCapability(decision.source) || CAPABILITY_SOURCES.UNREGISTERED,
    ...(configurationMissing.length ? { configurationMissing } : {}),
    ...(integrationRequired.length ? { integrationRequired } : {})
  };
}

function resolveCapability({ tenant, capability, context = {} } = {}) {
  const safeCapability = normalizeCapability(capability);
  const definition = CAPABILITY_DEFINITIONS[safeCapability];
  const tenantId = normalizeTenantId(tenant);

  if (!definition) {
    return sanitizeCapabilityDecision({
      capability: safeCapability || 'unknown',
      status: CAPABILITY_STATUSES.UNKNOWN,
      reason: 'capability_not_registered',
      source: CAPABILITY_SOURCES.UNREGISTERED
    });
  }

  if (definition.unsupportedReason) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.NOT_SUPPORTED,
      reason: definition.unsupportedReason,
      source: CAPABILITY_SOURCES.PRODUCT_REGISTRY
    });
  }

  if (!tenantId) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.UNKNOWN,
      reason: 'tenant_context_missing',
      source: CAPABILITY_SOURCES.TENANT_POLICY
    });
  }

  if (Array.isArray(definition.integrationRequired)) {
    const supportedIntegrations = Array.isArray(definition.supportedIntegrations)
      ? definition.supportedIntegrations
      : [];
    const connectedSupportedIntegration = supportedIntegrations.find((integration) => (
      findConnectedIntegration(tenant, integration)
    ));
    if (!connectedSupportedIntegration) {
      const requestedSystems = Array.isArray(context && context.requestedSystems)
        ? context.requestedSystems.map(normalizeCapability).filter(Boolean)
        : [];
      return sanitizeCapabilityDecision({
        capability: safeCapability,
        status: CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION,
        reason: 'supported_adapter_required',
        source: CAPABILITY_SOURCES.PRODUCT_REGISTRY,
        integrationRequired: [
          ...definition.integrationRequired,
          ...requestedSystems.map((system) => `${system}_adapter`)
        ]
      });
    }
  }

  const policy = getTenantPolicy(tenant);
  const policyCapabilities = Array.isArray(policy && policy.capabilities)
    ? policy.capabilities.map(normalizeCapability).filter(Boolean)
    : [];
  if (
    definition.tenantCapability &&
    Number(policy && policy.policyVersion) >= 1 &&
    !policyCapabilities.includes(definition.tenantCapability)
  ) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION,
      reason: 'tenant_capability_disabled',
      source: CAPABILITY_SOURCES.TENANT_POLICY,
      configurationMissing: [`capability_${definition.tenantCapability}`]
    });
  }
  if (definition.tenantModule && !isTenantModuleEnabled(policy, definition.tenantModule)) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION,
      reason: 'tenant_module_disabled',
      source: CAPABILITY_SOURCES.TENANT_POLICY,
      configurationMissing: [`module_${definition.tenantModule}`]
    });
  }

  const configuration = parseObject(tenant && tenant.configuration);
  const configurationMissing = (Array.isArray(definition.requiredConfiguration)
    ? definition.requiredConfiguration
    : [])
    .filter((requirement) => configuration[requirement.key] !== true)
    .map((requirement) => requirement.label);
  if (configurationMissing.length) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION,
      reason: 'tenant_configuration_missing',
      source: CAPABILITY_SOURCES.TENANT_CONFIGURATION,
      configurationMissing
    });
  }

  if (definition.requiredIntegration && !findConnectedIntegration(tenant, definition.requiredIntegration)) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION,
      reason: 'connected_integration_missing',
      source: CAPABILITY_SOURCES.CONNECTED_INTEGRATION,
      configurationMissing: [definition.missingIntegration || definition.requiredIntegration]
    });
  }

  if (!isBotActionEnabled(tenant, definition.botAction)) {
    return sanitizeCapabilityDecision({
      capability: safeCapability,
      status: CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION,
      reason: 'tenant_bot_action_disabled',
      source: CAPABILITY_SOURCES.TENANT_CONFIGURATION,
      configurationMissing: [`bot_action_${definition.botAction}`]
    });
  }

  return sanitizeCapabilityDecision({
    capability: safeCapability,
    status: CAPABILITY_STATUSES.AVAILABLE_NOW,
    reason: 'product_tenant_and_runtime_confirmed',
    source: definition.requiredIntegration
      ? CAPABILITY_SOURCES.CONNECTED_INTEGRATION
      : CAPABILITY_SOURCES.TENANT_POLICY
  });
}

function formatConfigurationMissing(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => CONFIGURATION_LABELS[item] || String(item || '').replace(/_/g, ' '))
    .filter(Boolean)
    .join(', ');
}

function buildSafeCapabilityReply(decision, options = {}) {
  const safeDecision = sanitizeCapabilityDecision(decision);
  const subject = normalizeString(options.subject) || 'esa capacidad';

  if (safeDecision.status === CAPABILITY_STATUSES.AVAILABLE_NOW) {
    return `${subject} esta disponible con la configuracion actual, dentro de las acciones ya implementadas.`;
  }
  if (safeDecision.status === CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION) {
    const missing = formatConfigurationMissing(safeDecision.configurationMissing);
    return `${subject} requiere completar${missing ? ` ${missing}` : ' configuracion del tenant'}. No voy a asumir que ya esta activo.`;
  }
  if (safeDecision.status === CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION) {
    return `${subject} requiere una integracion especifica. No puedo confirmar que exista un adaptador conectado o compatible sin verificarlo.`;
  }
  if (safeDecision.status === CAPABILITY_STATUSES.NOT_SUPPORTED) {
    return `${subject} no esta soportado actualmente por el bot. Puedo dejar el caso preparado para una alternativa o revision humana.`;
  }
  return `No tengo una fuente controlada que confirme ${subject}. Prefiero recopilar el contexto necesario y escalarlo antes que prometer algo incierto.`;
}

module.exports = {
  CAPABILITY_STATUSES,
  CAPABILITY_SOURCES,
  CAPABILITY_DEFINITIONS,
  buildTenantCapabilitySnapshot,
  buildChannelIntegrationSnapshot,
  resolveCapability,
  sanitizeCapabilityDecision,
  buildSafeCapabilityReply
};
