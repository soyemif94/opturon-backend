const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBotSettingsById,
  updateClinicBotActiveById,
  updateClinicBotModeById,
  updateClinicBotConfigById,
  updateClinicBotTransferConfigById
} = require('../repositories/tenant.repository');
const {
  buildTransferInstructionsText,
  normalizeHumanText,
  normalizeTransferConfig,
  validateTransferConfig
} = require('../utils/transfer-config');
const { DEFAULT_BOT_CONFIG, normalizeBotConfig, validateBotConfig } = require('../utils/bot-config');
const { resolveEffectiveEntitlements, canCapability } = require('./effective-entitlements');
const {
  getAiUsageSummary,
  crossedQuotaThresholds,
  claimAiQuotaWarnings
} = require('../repositories/ai-provisioning.repository');

const ALLOWED_BOT_MODES = new Set(['automatic', 'sales', 'agenda']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeBotMode(value, fallback = 'automatic') {
  const safe = normalizeString(value).toLowerCase();
  if (safe === 'hybrid') return 'automatic';
  if (safe === 'commerce') return 'sales';
  return ALLOWED_BOT_MODES.has(safe) ? safe : fallback;
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

function resolveBotStatus(entitlements, botActive, provisioning, usage, channelOperational) {
  if (!canCapability(entitlements, 'bot.enabled')) return { code: 'not_included', label: 'No incluido en tu plan', detail: 'El asistente inteligente está disponible desde Growth.' };
  if (provisioning?.status === 'pending') return { code: 'provisioning_pending', label: 'Configuración inicial en proceso', detail: 'La preparación inicial puede demorar entre 24 y 48 horas.' };
  if (provisioning?.status === 'blocked') return { code: 'provisioning_blocked', label: 'Configuración pendiente', detail: 'Contactá a soporte para continuar.' };
  if (provisioning?.status === 'failed') return { code: 'provisioning_failed', label: 'No pudimos completar la configuración', detail: 'Contactá a soporte para continuar.' };
  if (provisioning && provisioning.status !== 'ready') return { code: 'provisioning_unavailable', label: 'Configuración no disponible', detail: 'La configuración inicial aún no está lista.' };
  if (!channelOperational) return { code: 'channel_unavailable', label: 'Canal no disponible', detail: 'Conectá un canal compatible para utilizar atención automática.' };
  if (usage && !usage.quotaAvailable) return { code: 'quota_exhausted', label: 'Activo — pausado por límite de respuestas', detail: 'Alcanzaste el límite de respuestas inteligentes del período.' };
  if (!botActive) return { code: 'disabled', label: 'Desactivado por el cliente', detail: 'El asistente está apagado.' };
  return { code: 'ready_on', label: 'Configuración lista', detail: 'El asistente está activo.' };
}

function mapBotSettings(tenantId, clinic, botMode, effectiveEntitlements = null, context = {}, aiUsage = null, quotaWarnings = []) {
  const botSettings = clinic && clinic.botSettings && typeof clinic.botSettings === 'object'
    ? clinic.botSettings
    : {};

  const entitlements = effectiveEntitlements || resolveEffectiveEntitlements(clinic.settings);
  const botConfig = normalizeBotConfig(botSettings.config, DEFAULT_BOT_CONFIG);
  if (!canCapability(entitlements, 'bot.ai_custom_instructions')) botConfig.businessInstructions = '';
  return {
    tenantId,
    clinicId: clinic.id,
    clinicName: clinic.name || null,
    mode: normalizeBotMode(botMode, 'automatic'),
    botActive: clinic.settings?.botActive === true,
    entitlements,
    botConfig,
    aiProvisioning: context.aiProvisioning || null,
    aiUsage,
    botStatus: resolveBotStatus(
      entitlements,
      clinic.settings?.botActive === true,
      context.aiProvisioning,
      aiUsage,
      context.onboarding?.hasChannel === true
    ),
    quotaWarnings
  };
}

async function loadUsageAndWarnings(clinicId, context) {
  if (!context.aiProvisioning) return { usage: null, warnings: [] };
  try {
    const usage = await getAiUsageSummary(clinicId, context.aiProvisioning);
    const thresholds = crossedQuotaThresholds(usage?.percent);
    const warnings = await claimAiQuotaWarnings(clinicId, context.aiProvisioning.periodStart, thresholds);
    return { usage, warnings };
  } catch (error) {
    if (error?.code === '42P01') return { usage: null, warnings: [] };
    throw error;
  }
}

function mapPortalTransferSettings(tenantId, clinic) {
  const botSettings = clinic && clinic.botSettings && typeof clinic.botSettings === 'object'
    ? clinic.botSettings
    : {};
  const transferConfig = normalizeTransferConfig(botSettings.transferConfig, false);

  return {
    tenantId,
    clinicId: clinic.id,
    clinicName: clinic.name || null,
    transferConfig,
    previewText: buildTransferInstructionsText(transferConfig)
  };
}

async function getPortalBotSettings(tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar la configuracion del bot.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clinica asociada a este workspace.', {
      tenantId: safeTenantId
    });
  }

  const { usage, warnings } = await loadUsageAndWarnings(context.clinic.id, context);

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: mapBotSettings(safeTenantId, clinic, clinic.botMode, context.entitlements, context, usage, warnings)
  };
}

async function updatePortalBotSettings(tenantId, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['mode', 'botConfig', 'botActive'].includes(key))
    || (Object.hasOwn(payload, 'botActive') && typeof payload.botActive !== 'boolean')
    || (Object.hasOwn(payload, 'botConfig') && (!payload.botConfig || Array.isArray(payload.botConfig)
      || typeof payload.botConfig !== 'object' || Object.keys(payload.botConfig).some(key => !Object.hasOwn(DEFAULT_BOT_CONFIG, key))))) {
    return buildReason('invalid_bot_settings_payload', 'La configuración contiene campos no permitidos.');
  }
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar la configuracion del bot.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const hasModePayload = payload && Object.prototype.hasOwnProperty.call(payload, 'mode');
  const hasBotConfigPayload = Boolean(payload && payload.botConfig && typeof payload.botConfig === 'object');
  if (!hasModePayload && !hasBotConfigPayload && !Object.hasOwn(payload, 'botActive')) {
    return buildReason('invalid_bot_settings_payload', 'No recibimos cambios para guardar en la configuracion del bot.', {
      tenantId: safeTenantId
    });
  }

  const currentClinic = await getClinicBotSettingsById(context.clinic.id);
  if (!currentClinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clinica asociada a este workspace.', {
      tenantId: safeTenantId
    });
  }

  if (Object.hasOwn(payload, 'botActive') && payload.botActive === true) {
    if (!canCapability(context.entitlements, 'bot.enabled')) {
      return buildReason('bot_activation_unavailable', 'El asistente inteligente no está incluido en tu plan.', { tenantId: safeTenantId });
    }
    if (context.aiProvisioning && context.aiProvisioning.status !== 'ready') {
      return buildReason('bot_activation_unavailable', 'Podrás activar la atención automática cuando finalice la configuración.', { tenantId: safeTenantId });
    }
  }

  let clinic = currentClinic;
  // Validate the entire request before its first write.
  if (hasModePayload && !ALLOWED_BOT_MODES.has(normalizeBotMode(payload.mode, ''))) return buildReason('invalid_bot_mode');
  let validatedBotConfig = null;
  if (hasBotConfigPayload) {
    validatedBotConfig = validateBotConfig({
      ...normalizeBotConfig(currentClinic.botSettings?.config, DEFAULT_BOT_CONFIG),
      ...payload.botConfig
    });
    if (!validatedBotConfig.ok) {
      return buildReason(
        'invalid_bot_config',
        validatedBotConfig.errors.name || validatedBotConfig.errors.tone || validatedBotConfig.errors.treatment ||
          validatedBotConfig.errors.businessProfilePreset || validatedBotConfig.errors.commercialObjective ||
          validatedBotConfig.errors.salesMode || validatedBotConfig.errors.businessInstructions || 'La configuracion del bot no es valida.',
        { tenantId: safeTenantId, fieldErrors: validatedBotConfig.errors }
      );
    }
  }
  if (hasModePayload) {
    const nextMode = normalizeBotMode(payload && payload.mode, '');
    if (!ALLOWED_BOT_MODES.has(nextMode)) {
      return buildReason('invalid_bot_mode', 'El modo del bot debe ser automatic, sales o agenda.', {
        tenantId: safeTenantId
      });
    }

    clinic = await updateClinicBotModeById(context.clinic.id, nextMode);
    if (!clinic) {
      return buildReason('bot_settings_not_saved', 'No pudimos persistir la configuracion del bot.', {
        tenantId: safeTenantId
      });
    }
  }

  if (hasBotConfigPayload) {
    const botSettings = clinic && clinic.botSettings && typeof clinic.botSettings === 'object'
      ? clinic.botSettings
      : {};
    const validation = validatedBotConfig || validateBotConfig({
      ...normalizeBotConfig(botSettings.config, DEFAULT_BOT_CONFIG),
      ...payload.botConfig
    });
    if (!validation.ok) {
      return buildReason(
        'invalid_bot_config',
        validation.errors.name ||
          validation.errors.tone ||
          validation.errors.treatment ||
          validation.errors.businessProfilePreset ||
          validation.errors.commercialObjective ||
          validation.errors.salesMode ||
          validation.errors.businessInstructions ||
          'La configuracion del bot no es valida.',
        {
          tenantId: safeTenantId,
          fieldErrors: validation.errors
        }
      );
    }

    clinic = await updateClinicBotConfigById(context.clinic.id, validation.value);
    if (!clinic) {
      return buildReason('bot_settings_not_saved', 'No pudimos persistir la configuracion visual del bot.', {
        tenantId: safeTenantId
      });
    }
  }

  if (Object.hasOwn(payload, 'botActive')) clinic = await updateClinicBotActiveById(context.clinic.id, payload.botActive);
  const { usage, warnings } = await loadUsageAndWarnings(context.clinic.id, context);
  return { ok: true, tenantId: safeTenantId, clinicId: clinic.id,
    settings: mapBotSettings(safeTenantId, clinic, clinic.botMode, context.entitlements, context, usage, warnings) };
}

async function getPortalBotTransferConfig(tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar la configuracion de transferencia.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clinica asociada a este workspace.', {
      tenantId: safeTenantId
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: mapPortalTransferSettings(safeTenantId, clinic)
  };
}

async function updatePortalBotTransferConfig(tenantId, payload) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar la configuracion de transferencia.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clinica asociada a este workspace.', {
      tenantId: safeTenantId
    });
  }

  const botSettings = clinic.botSettings && typeof clinic.botSettings === 'object' ? clinic.botSettings : {};
  const existingTransferConfig =
    botSettings.transferConfig && typeof botSettings.transferConfig === 'object' ? botSettings.transferConfig : {};

  const nextTransferConfig = {
    ...existingTransferConfig,
    ...normalizeTransferConfig(
      {
        ...existingTransferConfig,
        enabled: payload && payload.enabled,
        alias: normalizeHumanText(payload && payload.alias),
        cbu: normalizeString(payload && payload.cbu),
        titular: normalizeHumanText(payload && payload.titular),
        bank: normalizeHumanText(payload && payload.bank),
        instructions: normalizeHumanText(payload && payload.instructions)
      },
      false
    )
  };

  const validation = validateTransferConfig(nextTransferConfig);
  if (!validation.ok) {
    return buildReason(
      'invalid_transfer_config',
      validation.errors.general || validation.errors.alias || validation.errors.cbu || 'Configuracion de transferencia invalida.',
      {
        tenantId: safeTenantId,
        fieldErrors: validation.errors
      }
    );
  }

  const updatedClinic = await updateClinicBotTransferConfigById(context.clinic.id, nextTransferConfig);
  if (!updatedClinic) {
    return buildReason('transfer_config_not_saved', 'No pudimos guardar la configuracion de transferencia.', {
      tenantId: safeTenantId
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: updatedClinic.id,
    settings: mapPortalTransferSettings(safeTenantId, updatedClinic)
  };
}

module.exports = {
  getPortalBotSettings,
  updatePortalBotSettings,
  getPortalBotTransferConfig,
  updatePortalBotTransferConfig
};
