const { provisionCleanClinicForExternalTenant } = require('../repositories/tenant.repository');

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

async function provisionPortalTenant(tenantId, payload = {}) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para provisionar el workspace.');
  }

  const clinic = await provisionCleanClinicForExternalTenant({
    externalTenantId: safeTenantId,
    name: normalizeString(payload.name) || safeTenantId,
    timezone: normalizeString(payload.timezone) || 'America/Argentina/Buenos_Aires'
  });

  if (!clinic) {
    return buildReason('tenant_provision_failed', 'No pudimos crear el workspace limpio.', {
      tenantId: safeTenantId
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinic: {
      id: clinic.id,
      name: clinic.name || null,
      timezone: clinic.timezone || null,
      externalTenantId: clinic.externalTenantId || null
    }
  };
}

module.exports = {
  provisionPortalTenant
};
