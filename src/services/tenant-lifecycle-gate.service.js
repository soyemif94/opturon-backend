const { query } = require('../db/client');

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function parseSettings(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function lifecycleStatusFromSettings(settings) {
  const safe = parseSettings(settings);
  return normalizeString(
    safe?.portal?.lifecycle?.status ||
    safe?.portal?.lifecycle?.state ||
    safe?.portal?.lifecycleStatus ||
    safe?.portal?.status ||
    safe?.status ||
    'active'
  ) || 'active';
}

async function resolveTenantLifecycle(input, dependencies = {}) {
  const tenantId = String(input && input.tenantId || '').trim();
  const clinicId = String(input && input.clinicId || '').trim();
  if (!tenantId && !clinicId) return { ok: false, reason: 'tenant_identity_missing', suspended: true };
  const runQuery = dependencies.query || query;
  const result = await runQuery(
    `SELECT id, "externalTenantId", settings
     FROM clinics
     WHERE ($1::text <> '' AND "externalTenantId" = $1)
        OR ($2::text <> '' AND id::text = $2)
     LIMIT 1`,
    [tenantId, clinicId]
  );
  const clinic = result.rows[0] || null;
  if (!clinic) return { ok: false, reason: 'tenant_not_found', suspended: true };
  const status = lifecycleStatusFromSettings(clinic.settings);
  return {
    ok: true,
    clinicId: clinic.id,
    tenantId: clinic.externalTenantId,
    status,
    suspended: status === 'suspended'
  };
}

module.exports = {
  lifecycleStatusFromSettings,
  resolveTenantLifecycle
};
