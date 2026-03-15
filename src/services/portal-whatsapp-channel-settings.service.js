const { logInfo, logWarn } = require('../utils/logger');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  findChannelByIdAndClinicId,
  listWhatsAppChannelsByClinicId,
  getClinicWhatsAppSettingsById,
  updateClinicWhatsAppDefaultChannelId
} = require('../repositories/tenant.repository');

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

function summarizeChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    provider: channel.provider || null,
    phoneNumberId: channel.phoneNumberId || null,
    displayPhoneNumber: channel.displayPhoneNumber || null,
    verifiedName: channel.verifiedName || null,
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
}

function normalizeChannels(channels) {
  return (Array.isArray(channels) ? channels : []).map(summarizeChannel);
}

function selectDefaultChannel(activeChannels, explicitDefaultChannelId) {
  const channels = Array.isArray(activeChannels) ? activeChannels : [];
  const explicit = normalizeString(explicitDefaultChannelId);

  if (explicit) {
    const matched = channels.find((channel) => channel.id === explicit) || null;
    return {
      channel: matched,
      strategy: matched ? 'explicit_settings' : 'explicit_settings_missing',
      source: 'settings.whatsapp.defaultChannelId'
    };
  }

  if (channels.length === 1) {
    return {
      channel: channels[0],
      strategy: 'single_active_fallback',
      source: 'single_active_channel'
    };
  }

  return {
    channel: null,
    strategy: channels.length > 1 ? 'ambiguous_multiple_active' : 'no_active_channel',
    source: explicit ? 'settings.whatsapp.defaultChannelId' : 'derived'
  };
}

async function getPortalWhatsAppChannelSettings(tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar la configuracion de WhatsApp.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [clinicSettings, channels] = await Promise.all([
    getClinicWhatsAppSettingsById(context.clinic.id),
    listWhatsAppChannelsByClinicId(context.clinic.id)
  ]);

  const normalizedChannels = normalizeChannels(channels);
  const activeChannels = normalizedChannels.filter((channel) => normalizeString(channel.status).toLowerCase() === 'active');
  const explicitDefaultChannelId = normalizeString(clinicSettings && clinicSettings.defaultWhatsAppChannelId);
  const selected = selectDefaultChannel(activeChannels, explicitDefaultChannelId);

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    defaultChannelId: explicitDefaultChannelId || null,
    defaultChannel: selected.channel,
    activeChannels,
    strategy: selected.strategy,
    source: selected.source,
    reason: context.reason
  };
}

async function updatePortalWhatsAppDefaultChannel(tenantId, payload = {}) {
  const safeTenantId = normalizeString(tenantId);
  const channelId = normalizeString(payload && payload.channelId);

  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para configurar el canal por defecto.');
  }

  if (!channelId) {
    return buildReason('missing_channel_id', 'Necesitamos el channelId para guardar el canal por defecto.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const channel = await findChannelByIdAndClinicId(channelId, context.clinic.id);
  if (!channel) {
    return buildReason('default_channel_not_found', 'El canal seleccionado no pertenece a este workspace.', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id
    });
  }

  const provider = normalizeString(channel.provider).toLowerCase();
  const status = normalizeString(channel.status).toLowerCase();

  if (provider !== 'whatsapp_cloud') {
    return buildReason('default_channel_invalid_provider', 'El canal seleccionado no es un canal de WhatsApp Cloud.', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      channelId: channel.id
    });
  }

  if (status !== 'active') {
    return buildReason('default_channel_inactive', 'Solo puedes seleccionar canales activos como canal por defecto.', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      channelId: channel.id
    });
  }

  const updatedClinic = await updateClinicWhatsAppDefaultChannelId(context.clinic.id, channel.id);
  if (!updatedClinic) {
    return buildReason('default_channel_not_persisted', 'No pudimos guardar el canal por defecto del workspace.', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      channelId: channel.id
    });
  }

  logInfo('portal_whatsapp_default_channel_updated', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    channelId: channel.id,
    phoneNumberId: channel.phoneNumberId || null,
    wabaId: channel.wabaId || null,
    source: 'settings.whatsapp.defaultChannelId'
  });

  const refreshed = await getPortalWhatsAppChannelSettings(safeTenantId);
  if (!refreshed.ok) {
    logWarn('portal_whatsapp_default_channel_updated_but_reload_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      channelId: channel.id,
      reason: refreshed.reason
    });
    return {
      ok: true,
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      defaultChannelId: channel.id,
      defaultChannel: summarizeChannel(channel),
      activeChannels: [summarizeChannel(channel)],
      strategy: 'explicit_settings',
      source: 'settings.whatsapp.defaultChannelId'
    };
  }

  return refreshed;
}

module.exports = {
  getPortalWhatsAppChannelSettings,
  updatePortalWhatsAppDefaultChannel
};
