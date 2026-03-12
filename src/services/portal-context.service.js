const { findClinicByExternalTenantId, listWhatsAppChannelsByClinicId } = require('../repositories/tenant.repository');

function summarizeClinic(clinic) {
  if (!clinic) return null;
  return {
    id: clinic.id,
    name: clinic.name || null,
    timezone: clinic.timezone || null,
    externalTenantId: clinic.externalTenantId || null
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

function pickPortalChannel(channels) {
  const items = Array.isArray(channels) ? channels : [];
  if (!items.length) {
    return { channel: null, reason: 'mapped_clinic_without_whatsapp_channel' };
  }

  const activeChannels = items.filter((channel) => String(channel.status || '').trim().toLowerCase() === 'active');
  if (activeChannels.length === 1) {
    return { channel: activeChannels[0], reason: 'resolved' };
  }
  if (activeChannels.length > 1) {
    return { channel: null, reason: 'multiple_whatsapp_channels_configured' };
  }

  if (items.length === 1) {
    return { channel: items[0], reason: 'resolved' };
  }

  return { channel: null, reason: 'multiple_whatsapp_channels_configured' };
}

async function resolvePortalTenantContext(externalTenantId) {
  const safeTenantId = String(externalTenantId || '').trim();
  if (!safeTenantId) {
    return {
      ok: false,
      tenantId: null,
      clinic: null,
      channel: null,
      reason: 'missing_tenant_id'
    };
  }

  const clinic = await findClinicByExternalTenantId(safeTenantId);
  if (!clinic) {
    return {
      ok: false,
      tenantId: safeTenantId,
      clinic: null,
      channel: null,
      reason: 'tenant_mapping_not_found'
    };
  }

  const channelSelection = pickPortalChannel(await listWhatsAppChannelsByClinicId(clinic.id));
  return {
    ok: true,
    tenantId: safeTenantId,
    clinic: summarizeClinic(clinic),
    channel: summarizeChannel(channelSelection.channel),
    reason: channelSelection.reason
  };
}

module.exports = {
  resolvePortalTenantContext
};
