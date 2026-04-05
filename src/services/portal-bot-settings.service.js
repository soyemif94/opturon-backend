const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBotSettingsById,
  updateClinicBotModeById,
  updateClinicBotTransferConfigById
} = require('../repositories/tenant.repository');

const ALLOWED_BOT_MODES = new Set(['sales', 'agenda', 'hybrid']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeBotMode(value, fallback = 'sales') {
  const safe = normalizeString(value).toLowerCase();
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

function mapBotSettings(tenantId, clinic, botMode) {
  return {
    tenantId,
    clinicId: clinic.id,
    clinicName: clinic.name || null,
    mode: normalizeBotMode(botMode, 'sales')
  };
}

function normalizeTransferFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const safe = normalizeString(value).toLowerCase();
  if (!safe) return fallback;
  return safe === 'true' || safe === '1' || safe === 'yes' || safe === 'si' || safe === 'sí';
}

function mapTransferConfig(rawConfig) {
  const safe = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  return {
    enabled: normalizeTransferFlag(safe.enabled, false),
    alias: normalizeString(safe.alias),
    cbu: normalizeString(safe.cbu),
    titular: normalizeString(safe.titular || safe.holderName),
    bank: normalizeString(safe.bank || safe.bankName),
    instructions: normalizeString(safe.instructions),
    destinationId: normalizeString(safe.destinationId) || null,
    reference: normalizeString(safe.reference) || null
  };
}

function mapPortalTransferSettings(tenantId, clinic) {
  const botSettings = clinic && clinic.botSettings && typeof clinic.botSettings === 'object'
    ? clinic.botSettings
    : {};

  return {
    tenantId,
    clinicId: clinic.id,
    clinicName: clinic.name || null,
    transferConfig: mapTransferConfig(botSettings.transferConfig)
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

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: mapBotSettings(safeTenantId, clinic, clinic.botMode)
  };
}

async function updatePortalBotSettings(tenantId, payload) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar la configuracion del bot.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const nextMode = normalizeString(payload && payload.mode).toLowerCase();
  if (!ALLOWED_BOT_MODES.has(nextMode)) {
    return buildReason('invalid_bot_mode', 'El modo del bot debe ser sales, agenda o hybrid.', {
      tenantId: safeTenantId
    });
  }

  const clinic = await updateClinicBotModeById(context.clinic.id, nextMode);
  if (!clinic) {
    return buildReason('bot_settings_not_saved', 'No pudimos persistir la configuracion del bot.', {
      tenantId: safeTenantId
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: mapBotSettings(safeTenantId, clinic, clinic.botMode)
  };
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
    enabled: normalizeTransferFlag(payload && payload.enabled, false),
    alias: normalizeString(payload && payload.alias),
    cbu: normalizeString(payload && payload.cbu),
    titular: normalizeString(payload && payload.titular),
    bank: normalizeString(payload && payload.bank),
    instructions: normalizeString(payload && payload.instructions),
    holderName: normalizeString(payload && payload.titular),
    bankName: normalizeString(payload && payload.bank)
  };

  if (nextTransferConfig.enabled && !normalizeString(nextTransferConfig.alias) && !normalizeString(nextTransferConfig.cbu)) {
    return buildReason('invalid_transfer_config', 'Para activar transferencia, cargá al menos alias o CBU.', {
      tenantId: safeTenantId
    });
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
