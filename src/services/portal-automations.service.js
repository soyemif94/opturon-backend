const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  createAutomation,
  listAutomationsByClinicId,
  updateAutomationById,
  deleteAutomationById
} = require('../repositories/automations.repository');
const {
  getClinicBusinessProfileById,
  getClinicBotSettingsById,
  updateClinicBotRuntimeConfigById
} = require('../repositories/tenant.repository');
const {
  listAutomationTemplates,
  findAutomationTemplateByKey,
  listTenantAutomationTemplatesByClinicId,
  upsertTenantAutomationTemplate
} = require('../repositories/automation-templates.repository');
const {
  normalizeBusinessType,
  normalizeCapabilities,
  buildResolvedCapabilities,
  evaluateTemplateCompatibility
} = require('./automation-enablement.service');

const ALLOWED_TRIGGERS = new Set(['message_received', 'keyword', 'off_hours', 'new_contact']);
const ALLOWED_ACTIONS = new Set(['send_message', 'assign_human', 'tag_contact']);
const RUNTIME_TEMPLATE_MAP = {
  conversation_welcome: ['Conversational Welcome Menu'],
  conversation_products_menu: ['Conversational Menu Products'],
  conversation_pricing_menu: ['Conversational Menu Pricing'],
  conversation_human_handoff: ['Conversational Menu Human'],
  conversation_fallback: ['Conversational Menu Fallback']
};
const GENERATED_SALES_BOT_TEMPLATE_KEY = 'generated_sales_bot';

function normalizeString(value) {
  return String(value || '').trim();
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

function normalizeTrigger(payload) {
  const type = normalizeString(payload && payload.type).toLowerCase();
  return {
    type,
    keyword: normalizeString(payload && payload.keyword) || null
  };
}

async function normalizeBusinessProfileSnapshot(clinic, rawProfile, context) {
  const profile = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
  const explicitCapabilities = normalizeCapabilities(profile.capabilities);
  const resolvedCapabilities = await buildResolvedCapabilities({ clinic, capabilitiesHint: explicitCapabilities });

  return {
    clinicId: clinic && clinic.id ? clinic.id : null,
    clinicName: clinic && clinic.name ? clinic.name : null,
    businessType: normalizeBusinessType(profile.businessType),
    capabilities: explicitCapabilities,
    resolvedCapabilities
  };
}

function getRuntimeTemplateNames(template) {
  if (template && template.metadata && Array.isArray(template.metadata.runtimeAutomationNames)) {
    return template.metadata.runtimeAutomationNames.map((item) => normalizeString(item)).filter(Boolean);
  }
  return RUNTIME_TEMPLATE_MAP[template && template.key ? template.key : ''] || [];
}

function buildTemplateAvailability(template, tenantTemplate, businessProfile, automations) {
  const compatibility = evaluateTemplateCompatibility({
    template,
    businessType: businessProfile.businessType,
    resolvedCapabilities: businessProfile.resolvedCapabilities
  });
  const runtimeNames = getRuntimeTemplateNames(template);
  const linkedAutomations = Array.isArray(automations)
    ? automations.filter((automation) => runtimeNames.includes(normalizeString(automation.name)))
    : [];
  const runtimeEnabled = linkedAutomations.some((automation) => automation.enabled !== false);
  const tenantEnabled = tenantTemplate ? tenantTemplate.enabled === true : template.defaultEnabled === true;
  const managedBy = runtimeNames.length ? 'hybrid' : 'catalog';

  return {
    ...template,
    linkedAutomationIds: linkedAutomations.map((item) => item.id),
    linkedAutomationCount: linkedAutomations.length,
    managedBy,
    compatible: compatibility.compatible,
    tenantEnabled,
    runtimeEnabled,
    effectiveEnabled: runtimeEnabled || tenantEnabled,
    businessTypeMatch: compatibility.businessTypeMatch,
    missingCapabilities: compatibility.missingCapabilities
  };
}

function getRegisteredGeneratedBotRuntime(clinic) {
  const botSettings = clinic && clinic.botSettings && typeof clinic.botSettings === 'object' ? clinic.botSettings : {};
  const runtimeConfig = botSettings.runtimeConfig && typeof botSettings.runtimeConfig === 'object' ? botSettings.runtimeConfig : null;
  if (!runtimeConfig || runtimeConfig.templateKey !== GENERATED_SALES_BOT_TEMPLATE_KEY) return null;
  return runtimeConfig;
}

function withGeneratedRuntimeAvailability(template, availability, clinic) {
  if (!template || template.key !== GENERATED_SALES_BOT_TEMPLATE_KEY) return availability;
  const runtimeConfig = getRegisteredGeneratedBotRuntime(clinic);
  const runtimeEnabled = Boolean(runtimeConfig && runtimeConfig.enabled === true);

  return {
    ...availability,
    linkedAutomationIds: [],
    linkedAutomationCount: runtimeConfig ? 1 : 0,
    managedBy: 'runtime_config',
    runtimeEnabled,
    tenantEnabled: runtimeEnabled,
    effectiveEnabled: runtimeEnabled
  };
}

function normalizeConditions(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const normalized = { ...payload };

  if (normalized.priority !== undefined && normalized.priority !== null && normalized.priority !== '') {
    const parsedPriority = Number(normalized.priority);
    normalized.priority = Number.isFinite(parsedPriority) ? parsedPriority : undefined;
  }

  if (Array.isArray(normalized.exactKeywords)) {
    normalized.exactKeywords = normalized.exactKeywords.map((item) => normalizeString(item)).filter(Boolean);
  }

  if (Array.isArray(normalized.containsKeywords)) {
    normalized.containsKeywords = normalized.containsKeywords.map((item) => normalizeString(item)).filter(Boolean);
  }

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function normalizeActions(payload) {
  const items = Array.isArray(payload) ? payload : [];
  return items
    .map((item) => ({
      type: normalizeString(item && item.type).toLowerCase(),
      message: normalizeString(item && item.message) || null,
      tag: normalizeString(item && item.tag) || null
    }))
    .filter((item) => item.type);
}

function validateAutomationPayload(input) {
  if (!input.name) return 'missing_automation_name';
  if (!ALLOWED_TRIGGERS.has(input.trigger.type)) return 'invalid_automation_trigger';
  if (input.trigger.type === 'keyword' && !input.trigger.keyword) return 'missing_automation_keyword';
  if (!Array.isArray(input.actions) || input.actions.length === 0) return 'missing_automation_actions';

  for (const action of input.actions) {
    if (!ALLOWED_ACTIONS.has(action.type)) return 'invalid_automation_action';
    if (action.type === 'send_message' && !action.message) return 'missing_automation_message';
    if (action.type === 'tag_contact' && !action.tag) return 'missing_automation_tag';
  }

  return null;
}

async function listPortalAutomations(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [automations, clinic, botClinic, templates, tenantTemplates] = await Promise.all([
    listAutomationsByClinicId(context.clinic.id),
    getClinicBusinessProfileById(context.clinic.id),
    getClinicBotSettingsById(context.clinic.id),
    listAutomationTemplates(),
    listTenantAutomationTemplatesByClinicId(context.clinic.id)
  ]);
  const businessProfile = await normalizeBusinessProfileSnapshot(clinic || context.clinic, clinic && clinic.businessProfile, context);
  const tenantTemplateMap = new Map(tenantTemplates.map((item) => [item.templateKey, item]));
  const catalog = templates.map((template) =>
    withGeneratedRuntimeAvailability(
      template,
      buildTemplateAvailability(template, tenantTemplateMap.get(template.key) || null, businessProfile, automations),
      botClinic
    )
  ).filter((template) => template.compatible === true);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automations,
    businessProfile,
    catalog
  };
}

async function createPortalAutomation(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const input = {
    name: normalizeString(payload && payload.name),
    trigger: normalizeTrigger(payload && payload.trigger),
    conditions: normalizeConditions(payload && payload.conditions),
    actions: normalizeActions(payload && payload.actions),
    enabled: payload && payload.enabled !== false
  };

  const reason = validateAutomationPayload(input);
  if (reason) {
    return buildReason(reason, null, { tenantId: context.tenantId });
  }

  const automation = await createAutomation({
    clinicId: context.clinic.id,
    externalTenantId: context.tenantId,
    ...input
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automation
  };
}

async function updatePortalAutomation(tenantId, automationId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const normalizedAutomationId = normalizeString(automationId);
  if (!normalizedAutomationId) {
    return buildReason('missing_automation_id', null, { tenantId: context.tenantId });
  }

  if (typeof payload?.enabled !== 'boolean') {
    return buildReason('invalid_automation_enabled', null, { tenantId: context.tenantId });
  }

  const automation = await updateAutomationById(context.clinic.id, normalizedAutomationId, {
    enabled: payload.enabled
  });

  if (!automation) {
    return buildReason('automation_not_found', null, { tenantId: context.tenantId });
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automation
  };
}

async function updatePortalAutomationTemplate(tenantId, templateKey, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const normalizedTemplateKey = normalizeString(templateKey);
  if (!normalizedTemplateKey) {
    return buildReason('missing_automation_template_key', null, { tenantId: context.tenantId });
  }
  if (typeof payload?.enabled !== 'boolean') {
    return buildReason('invalid_automation_template_enabled', null, { tenantId: context.tenantId });
  }

  const [template, clinic, botClinic, automations] = await Promise.all([
    findAutomationTemplateByKey(normalizedTemplateKey),
    getClinicBusinessProfileById(context.clinic.id),
    getClinicBotSettingsById(context.clinic.id),
    listAutomationsByClinicId(context.clinic.id)
  ]);

  if (!template || template.status !== 'active') {
    return buildReason('automation_template_not_found', null, { tenantId: context.tenantId });
  }

  const businessProfile = await normalizeBusinessProfileSnapshot(clinic || context.clinic, clinic && clinic.businessProfile, context);
  const currentTemplate = withGeneratedRuntimeAvailability(
    template,
    buildTemplateAvailability(template, null, businessProfile, automations),
    botClinic
  );
  if (payload.enabled === true && !currentTemplate.compatible) {
    return buildReason('automation_template_incompatible', null, {
      tenantId: context.tenantId,
      missingCapabilities: currentTemplate.missingCapabilities,
      businessType: businessProfile.businessType
    });
  }

  const linkedAutomationNames = getRuntimeTemplateNames(template);
  const linkedAutomations = automations.filter((automation) => linkedAutomationNames.includes(normalizeString(automation.name)));
  const updatedAutomations = [];

  for (const automation of linkedAutomations) {
    const updated = await updateAutomationById(context.clinic.id, automation.id, { enabled: payload.enabled });
    if (updated) updatedAutomations.push(updated);
  }

  const tenantTemplate = await upsertTenantAutomationTemplate({
    clinicId: context.clinic.id,
    externalTenantId: context.tenantId,
    templateKey: normalizedTemplateKey,
    enabled: payload.enabled,
    config: {},
    metadata: {
      source: linkedAutomations.length ? 'hybrid_toggle' : 'catalog_toggle'
    }
  });

  let updatedBotClinic = botClinic;
  if (normalizedTemplateKey === GENERATED_SALES_BOT_TEMPLATE_KEY) {
    const runtimeConfig = getRegisteredGeneratedBotRuntime(botClinic);
    if (!runtimeConfig && payload.enabled === true) {
      return buildReason('generated_runtime_config_not_found', null, { tenantId: context.tenantId });
    }
    if (runtimeConfig) {
      updatedBotClinic = await updateClinicBotRuntimeConfigById(context.clinic.id, {
        ...runtimeConfig,
        enabled: payload.enabled === true,
        templateKey: GENERATED_SALES_BOT_TEMPLATE_KEY
      });
    }
  }

  const nextAutomations = automations.map((automation) => {
    const updated = updatedAutomations.find((item) => item.id === automation.id);
    return updated || automation;
  });
  const nextTemplate = withGeneratedRuntimeAvailability(
    template,
    buildTemplateAvailability(template, tenantTemplate, businessProfile, nextAutomations),
    updatedBotClinic
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    template: nextTemplate
  };
}

async function deletePortalAutomation(tenantId, automationId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const normalizedAutomationId = normalizeString(automationId);
  if (!normalizedAutomationId) {
    return buildReason('missing_automation_id', null, { tenantId: context.tenantId });
  }

  const automation = await deleteAutomationById(context.clinic.id, normalizedAutomationId);
  if (!automation) {
    return buildReason('automation_not_found', null, { tenantId: context.tenantId });
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automation
  };
}

module.exports = {
  ALLOWED_TRIGGERS: Array.from(ALLOWED_TRIGGERS),
  ALLOWED_ACTIONS: Array.from(ALLOWED_ACTIONS),
  listPortalAutomations,
  createPortalAutomation,
  updatePortalAutomation,
  updatePortalAutomationTemplate,
  deletePortalAutomation
};
