const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBotSettingsById,
  updateClinicBotModeById
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

module.exports = {
  getPortalBotSettings,
  updatePortalBotSettings
};
