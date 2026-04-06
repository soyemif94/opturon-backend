const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicBusinessProfileById,
  updateClinicBusinessProfileById
} = require('../repositories/tenant.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function isValidHttpUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
    legalName: '',
    taxId: '',
    taxIdType: 'NONE',
    vatCondition: '',
    grossIncomeNumber: '',
    fiscalAddress: '',
    city: '',
    province: '',
    pointOfSaleSuggested: '',
    defaultSuggestedFiscalVoucherType: 'NONE',
    accountantEmail: '',
    accountantName: '',
    profileImageUrl: '',
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
    legalName: normalizeString(profile.legalName || clinic.name),
    taxId: normalizeString(profile.taxId),
    taxIdType: ['DNI', 'CUIT', 'CUIL', 'NONE'].includes(normalizeString(profile.taxIdType)) ? normalizeString(profile.taxIdType) : 'NONE',
    vatCondition: normalizeString(profile.vatCondition),
    grossIncomeNumber: normalizeString(profile.grossIncomeNumber),
    fiscalAddress: normalizeString(profile.fiscalAddress || profile.address),
    city: normalizeString(profile.city),
    province: normalizeString(profile.province),
    pointOfSaleSuggested: normalizeString(profile.pointOfSaleSuggested),
    defaultSuggestedFiscalVoucherType: ['A', 'B', 'C', 'NONE'].includes(normalizeString(profile.defaultSuggestedFiscalVoucherType))
      ? normalizeString(profile.defaultSuggestedFiscalVoucherType)
      : 'NONE',
    accountantEmail: normalizeString(profile.accountantEmail),
    accountantName: normalizeString(profile.accountantName),
    profileImageUrl: normalizeString(profile.profileImageUrl),
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
  if (!isValidHttpUrl(nextProfile.profileImageUrl)) {
    return buildReason('invalid_business_profile_image_url', 'La imagen del negocio debe ser una URL http o https valida.', {
      tenantId: safeTenantId
    });
  }
  const clinic = await updateClinicBusinessProfileById(context.clinic.id, {
    legalName: nextProfile.legalName,
    taxId: nextProfile.taxId,
    taxIdType: nextProfile.taxIdType,
    vatCondition: nextProfile.vatCondition,
    grossIncomeNumber: nextProfile.grossIncomeNumber,
    fiscalAddress: nextProfile.fiscalAddress,
    city: nextProfile.city,
    province: nextProfile.province,
    pointOfSaleSuggested: nextProfile.pointOfSaleSuggested,
    defaultSuggestedFiscalVoucherType: nextProfile.defaultSuggestedFiscalVoucherType,
    accountantEmail: nextProfile.accountantEmail,
    accountantName: nextProfile.accountantName,
    profileImageUrl: nextProfile.profileImageUrl,
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
