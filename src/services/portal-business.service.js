const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBusinessProfileById,
  updateClinicBusinessProfileById
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

function emptyBusinessProfile(tenantId, clinic = null) {
  return {
    tenantId: tenantId || '',
    clinicId: clinic && clinic.id ? clinic.id : null,
    clinicName: clinic && clinic.name ? clinic.name : null,
    openingHours: '',
    address: '',
    deliveryZones: '',
    paymentMethods: '',
    policies: ''
  };
}

function normalizeBusinessProfile(tenantId, clinic, value) {
  const profile = value && typeof value === 'object' ? value : {};
  return {
    tenantId,
    clinicId: clinic.id,
    clinicName: clinic.name || null,
    openingHours: normalizeString(profile.openingHours),
    address: normalizeString(profile.address),
    deliveryZones: normalizeString(profile.deliveryZones),
    paymentMethods: normalizeString(profile.paymentMethods),
    policies: normalizeString(profile.policies)
  };
}

async function getPortalBusinessSettings(tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para cargar los datos del negocio.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const clinic = await getClinicBusinessProfileById(context.clinic.id);
  if (!clinic) {
    return buildReason('tenant_mapping_not_found', 'No encontramos la clínica asociada a este workspace.', {
      tenantId: safeTenantId
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: normalizeBusinessProfile(safeTenantId, clinic, clinic.businessProfile)
  };
}

async function updatePortalBusinessSettings(tenantId, payload) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para guardar los datos del negocio.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const nextProfile = normalizeBusinessProfile(safeTenantId, context.clinic, payload || {});
  const clinic = await updateClinicBusinessProfileById(context.clinic.id, {
    openingHours: nextProfile.openingHours,
    address: nextProfile.address,
    deliveryZones: nextProfile.deliveryZones,
    paymentMethods: nextProfile.paymentMethods,
    policies: nextProfile.policies
  });

  if (!clinic) {
    return buildReason(
      'business_settings_not_saved',
      'No pudimos persistir los datos del negocio para este workspace.',
      { tenantId: safeTenantId }
    );
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: clinic.id,
    settings: normalizeBusinessProfile(safeTenantId, clinic, clinic.businessProfile)
  };
}

module.exports = {
  emptyBusinessProfile,
  getPortalBusinessSettings,
  updatePortalBusinessSettings
};
