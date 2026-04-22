const { query } = require('../db/client');
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');

const PLAN_CODES = new Set(['basic', 'growth', 'pro', 'enterprise']);
const CAPABILITIES = new Set([
  'whatsapp',
  'contacts',
  'crm',
  'agenda',
  'catalog',
  'automations',
  'sales',
  'payments',
  'payments_transfer',
  'loyalty'
]);
const MODULES = ['inbox', 'agenda', 'catalog', 'automations', 'sales', 'loyalty', 'payments'];

const DEFAULT_LIMITS = {
  maxPortalUsers: 5,
  maxAutomations: 20,
  maxContacts: 1000
};

const DEFAULT_MODULES = Object.freeze({
  inbox: true,
  agenda: true,
  catalog: true,
  automations: true,
  sales: true,
  loyalty: true,
  payments: true
});

function normalizeString(value) {
  return String(value || '').trim();
}

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePlanCode(value) {
  const planCode = normalizeString(value).toLowerCase();
  return PLAN_CODES.has(planCode) ? planCode : 'basic';
}

function normalizeCapabilities(value) {
  const items = Array.isArray(value) ? value : [];
  return Array.from(new Set(items.map((item) => normalizeString(item).toLowerCase()).filter((item) => CAPABILITIES.has(item))));
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeLimits(value) {
  const limits = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    maxPortalUsers: parsePositiveInt(limits.maxPortalUsers ?? limits.portalUsers ?? limits.subaccounts, DEFAULT_LIMITS.maxPortalUsers),
    maxAutomations: parsePositiveInt(limits.maxAutomations, DEFAULT_LIMITS.maxAutomations),
    maxContacts: parsePositiveInt(limits.maxContacts, DEFAULT_LIMITS.maxContacts)
  };
}

function normalizeEnabledModules(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return MODULES.reduce((acc, key) => {
    acc[key] = input[key] === undefined ? DEFAULT_MODULES[key] : input[key] === true;
    return acc;
  }, {});
}

function buildTenantPolicyFromSettings(settings) {
  const safeSettings = parseSettings(settings);
  const portal = safeSettings.portal && typeof safeSettings.portal === 'object' ? safeSettings.portal : {};
  const businessProfile = safeSettings.businessProfile && typeof safeSettings.businessProfile === 'object'
    ? safeSettings.businessProfile
    : {};
  const policy = portal.policy && typeof portal.policy === 'object' && !Array.isArray(portal.policy) ? portal.policy : {};
  const legacyLimit = portal.limits && typeof portal.limits === 'object' ? portal.limits : {};

  return {
    planCode: normalizePlanCode(policy.planCode || portal.planCode),
    limits: normalizeLimits({
      ...legacyLimit,
      ...(policy.limits || {}),
      maxPortalUsers:
        policy.limits?.maxPortalUsers ??
        portal.maxPortalUsers ??
        legacyLimit.maxPortalUsers ??
        legacyLimit.subaccounts ??
        portal.subaccountLimit
    }),
    capabilities: normalizeCapabilities(policy.capabilities || businessProfile.capabilities),
    enabledModules: normalizeEnabledModules(policy.enabledModules),
    source: policy && Object.keys(policy).length ? 'settings.portal.policy' : 'defaults'
  };
}

async function resolveTenantPolicyByClinicId(clinicId, client = null) {
  const result = await (client || { query }).query(
    `SELECT settings
     FROM clinics
     WHERE id = $1::uuid
     LIMIT 1`,
    [clinicId]
  );
  return buildTenantPolicyFromSettings(result.rows[0] && result.rows[0].settings);
}

async function resolveTenantPolicyByExternalTenantId(externalTenantId) {
  const clinic = await findClinicByExternalTenantId(externalTenantId);
  if (!clinic) {
    return { ok: false, reason: 'tenant_not_found', tenantId: normalizeString(externalTenantId) || null };
  }
  return {
    ok: true,
    tenantId: clinic.externalTenantId,
    clinic: {
      id: clinic.id,
      name: clinic.name || null,
      externalTenantId: clinic.externalTenantId || null
    },
    policy: buildTenantPolicyFromSettings(clinic.settings)
  };
}

function sanitizeTenantPolicyPatch(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    planCode: normalizePlanCode(input.planCode),
    limits: normalizeLimits(input.limits),
    capabilities: normalizeCapabilities(input.capabilities),
    enabledModules: normalizeEnabledModules(input.enabledModules)
  };
}

async function updateTenantPolicyByExternalTenantId(externalTenantId, payload) {
  const safeTenantId = normalizeString(externalTenantId);
  if (!safeTenantId) return { ok: false, reason: 'missing_tenant_id' };

  const current = await resolveTenantPolicyByExternalTenantId(safeTenantId);
  if (!current.ok) return current;

  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const nextPolicy = sanitizeTenantPolicyPatch({
    planCode: input.planCode ?? current.policy.planCode,
    limits: {
      ...current.policy.limits,
      ...(input.limits && typeof input.limits === 'object' && !Array.isArray(input.limits) ? input.limits : {})
    },
    capabilities: input.capabilities === undefined ? current.policy.capabilities : input.capabilities,
    enabledModules: {
      ...current.policy.enabledModules,
      ...(input.enabledModules && typeof input.enabledModules === 'object' && !Array.isArray(input.enabledModules) ? input.enabledModules : {})
    }
  });
  const result = await query(
    `UPDATE clinics
     SET settings = jsonb_set(
       jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{portal}',
         COALESCE(
           CASE WHEN jsonb_typeof(settings -> 'portal') = 'object' THEN settings -> 'portal' ELSE '{}'::jsonb END,
           '{}'::jsonb
         ),
         true
       ),
       '{portal,policy}',
       $2::jsonb,
       true
     ),
     "updatedAt" = NOW()
     WHERE "externalTenantId" = $1
     RETURNING id, name, "externalTenantId", settings`,
    [safeTenantId, JSON.stringify(nextPolicy)]
  );

  const clinic = result.rows[0] || null;
  if (!clinic) return { ok: false, reason: 'tenant_not_found', tenantId: safeTenantId };

  return {
    ok: true,
    tenantId: clinic.externalTenantId,
    clinic: {
      id: clinic.id,
      name: clinic.name || null,
      externalTenantId: clinic.externalTenantId || null
    },
    policy: buildTenantPolicyFromSettings(clinic.settings)
  };
}

function isModuleEnabled(policy, moduleName) {
  const key = normalizeString(moduleName);
  if (!key || !MODULES.includes(key)) return true;
  const safePolicy = policy && typeof policy === 'object' ? policy : {};
  const enabledModules = normalizeEnabledModules(safePolicy.enabledModules);
  return enabledModules[key] !== false;
}

module.exports = {
  MODULES,
  buildTenantPolicyFromSettings,
  resolveTenantPolicyByClinicId,
  resolveTenantPolicyByExternalTenantId,
  updateTenantPolicyByExternalTenantId,
  sanitizeTenantPolicyPatch,
  isModuleEnabled
};
