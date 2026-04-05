const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBotSettingsById,
  updateClinicBotModeById,
  updateClinicBotTransferConfigById
} = require('../repositories/tenant.repository');
const {
  buildTransferInstructionsText,
  normalizeHumanText,
  normalizeTransferConfig,
  validateTransferConfig
} = require('../utils/transfer-config');

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
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar la configuración del bot.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clínica asociada a este workspace.', {
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
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar la configuración del bot.');
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
    return buildReason('bot_settings_not_saved', 'No pudimos persistir la configuración del bot.', {
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
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar la configuración de transferencia.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clínica asociada a este workspace.', {
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
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar la configuración de transferencia.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBotSettingsById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clínica asociada a este workspace.', {
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
      validation.errors.general || validation.errors.alias || validation.errors.cbu || 'Configuración de transferencia inválida.',
      {
        tenantId: safeTenantId,
        fieldErrors: validation.errors
      }
    );
  }

  const updatedClinic = await updateClinicBotTransferConfigById(context.clinic.id, nextTransferConfig);
  if (!updatedClinic) {
    return buildReason('transfer_config_not_saved', 'No pudimos guardar la configuración de transferencia.', {
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
