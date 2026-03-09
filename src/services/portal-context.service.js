const { findClinicByExternalTenantId, findPreferredWhatsAppChannelByClinicId } = require('../repositories/tenant.repository');

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
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
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

  const channel = await findPreferredWhatsAppChannelByClinicId(clinic.id);
  return {
    ok: true,
    tenantId: safeTenantId,
    clinic: summarizeClinic(clinic),
    channel: summarizeChannel(channel),
    reason: channel ? 'resolved' : 'mapped_clinic_without_whatsapp_channel'
  };
}

module.exports = {
  resolvePortalTenantContext
};
