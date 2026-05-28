const { query } = require('../db/client');

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
const MAX_LIMITS = {
  maxPortalUsers: 10000,
  maxAutomations: 10000,
  maxContacts: 1000000
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

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeLimits(value) {
  const limits = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    maxPortalUsers: parsePositiveInt(limits.maxPortalUsers ?? limits.portalUsers ?? limits.subaccounts, DEFAULT_LIMITS.maxPortalUsers, MAX_LIMITS.maxPortalUsers),
    maxAutomations: parsePositiveInt(limits.maxAutomations, DEFAULT_LIMITS.maxAutomations, MAX_LIMITS.maxAutomations),
    maxContacts: parsePositiveInt(limits.maxContacts, DEFAULT_LIMITS.maxContacts, MAX_LIMITS.maxContacts)
  };
}

function pickBooleanModules(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return MODULES.reduce((acc, key) => {
    if (typeof input[key] === 'boolean') acc[key] = input[key];
    return acc;
  }, {});
}

function normalizeEnabledModules(value) {
  const input = pickBooleanModules(value);
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
        policy.limits?.portalUsers ??
        policy.limits?.subaccounts ??
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

function getBusinessProfileName(settings) {
  const safeSettings = parseSettings(settings);
  const businessProfile = safeSettings.businessProfile && typeof safeSettings.businessProfile === 'object'
    ? safeSettings.businessProfile
    : {};
  return normalizeString(businessProfile.name);
}

function buildTenantDisplayName(clinic) {
  return (
    normalizeString(clinic.name) ||
    getBusinessProfileName(clinic.settings) ||
    normalizeString(clinic.primaryEmail) ||
    normalizeString(clinic.externalTenantId)
  );
}

function normalizeEmail(value) {
  const email = normalizeString(value).toLowerCase();
  return email && email.includes('@') ? email : null;
}

function buildTenantLifecycle(settings, membership = {}) {
  const safeSettings = parseSettings(settings);
  const portal = safeSettings.portal && typeof safeSettings.portal === 'object' ? safeSettings.portal : {};
  const lifecycle = portal.lifecycle && typeof portal.lifecycle === 'object' ? portal.lifecycle : {};
  const statusCandidates = [
    lifecycle.status,
    lifecycle.state,
    portal.lifecycleStatus,
    portal.status,
    safeSettings.status
  ];
  const status = statusCandidates
    .map((value) => normalizeString(value).toLowerCase())
    .find(Boolean) || 'active';
  const archivedAt = normalizeString(lifecycle.archivedAt || portal.archivedAt || safeSettings.archivedAt) || null;
  const deletedAt = normalizeString(lifecycle.deletedAt || portal.deletedAt || safeSettings.deletedAt) || null;
  const activePortalUsers = Number.isInteger(Number(membership.activePortalUsers))
    ? Number(membership.activePortalUsers)
    : 0;
  const activeOwners = Number.isInteger(Number(membership.activeOwners))
    ? Number(membership.activeOwners)
    : 0;
  const visible =
    !['archived', 'deleted', 'inactive', 'cancelled'].includes(status) &&
    !archivedAt &&
    !deletedAt &&
    activePortalUsers > 0 &&
    activeOwners > 0;

  return {
    status,
    archivedAt,
    deletedAt,
    activePortalUsers,
    activeOwners,
    visible
  };
}

function buildClinicBasicsPatch(input, currentClinic) {
  const currentDisplayName = buildTenantDisplayName(currentClinic);
  const currentEmail = normalizeEmail(currentClinic.primaryEmail);
  const nextDisplayName = normalizeString(input.displayName ?? input.name ?? currentDisplayName);
  const nextPrimaryEmail = input.primaryEmail === undefined ? currentEmail : normalizeEmail(input.primaryEmail);

  return {
    displayName: nextDisplayName || currentDisplayName || normalizeString(currentClinic.externalTenantId),
    primaryEmail: nextPrimaryEmail
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
  const safeTenantId = normalizeString(externalTenantId);
  const result = await query(
    `SELECT c.id,
            c.name,
            c.timezone,
            c."externalTenantId",
            c.settings,
            c."createdAt",
            c."updatedAt",
            primary_user.email AS "primaryEmail"
     FROM clinics c
     LEFT JOIN LATERAL (
       SELECT su.email
       FROM staff_users su
       WHERE su."clinicId" = c.id
         AND su."accountType" = 'client_portal'
         AND su.email IS NOT NULL
         AND su.active = TRUE
       ORDER BY
         CASE
           WHEN NULLIF(c.settings->'portal'->>'primaryPortalUserId', '') IS NOT NULL
             AND su.id::TEXT = c.settings->'portal'->>'primaryPortalUserId'
           THEN 0
           ELSE 1
         END,
         CASE WHEN su.role = 'owner' THEN 0 ELSE 1 END,
         su."createdAt" ASC
       LIMIT 1
     ) primary_user ON TRUE
     WHERE c."externalTenantId" = $1
     LIMIT 1`,
    [safeTenantId]
  );
  const clinic = result.rows[0] || null;
  if (!clinic) {
    return { ok: false, reason: 'tenant_not_found', tenantId: safeTenantId || null };
  }
  return {
    ok: true,
    tenantId: clinic.externalTenantId,
    clinic: {
      id: clinic.id,
      name: clinic.name || null,
      externalTenantId: clinic.externalTenantId || null,
      timezone: clinic.timezone || null,
      settings: clinic.settings || {}
    },
    primaryEmail: clinic.primaryEmail || null,
    policy: buildTenantPolicyFromSettings(clinic.settings)
  };
}

async function listTenantPolicies() {
  const result = await query(
    `SELECT c.id,
            c.name,
            c.timezone,
            c."externalTenantId",
            c.settings,
            c."createdAt",
            c."updatedAt",
            membership."activePortalUsers",
            membership."activeOwners",
            primary_user.email AS "primaryEmail"
     FROM clinics c
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::INT AS "activePortalUsers",
              COUNT(*) FILTER (WHERE su.role = 'owner')::INT AS "activeOwners"
       FROM staff_users su
       WHERE su."clinicId" = c.id
         AND su."accountType" = 'client_portal'
         AND su.email IS NOT NULL
         AND su.active = TRUE
     ) membership ON TRUE
     LEFT JOIN LATERAL (
       SELECT su.email
       FROM staff_users su
       WHERE su."clinicId" = c.id
         AND su."accountType" = 'client_portal'
         AND su.email IS NOT NULL
         AND su.active = TRUE
       ORDER BY
         CASE
           WHEN NULLIF(c.settings->'portal'->>'primaryPortalUserId', '') IS NOT NULL
             AND su.id::TEXT = c.settings->'portal'->>'primaryPortalUserId'
           THEN 0
           ELSE 1
         END,
         CASE WHEN su.role = 'owner' THEN 0 ELSE 1 END,
         su."createdAt" ASC
       LIMIT 1
     ) primary_user ON TRUE
     WHERE NULLIF(TRIM(COALESCE(c."externalTenantId", '')), '') IS NOT NULL
       AND COALESCE(c.settings->'portal'->>'accountScope', '') <> 'opturon_admin'
     ORDER BY c.name ASC NULLS LAST, c."createdAt" DESC`
  );

  return {
    ok: true,
    tenants: result.rows
      .map((clinic) => {
        const displayName = buildTenantDisplayName(clinic);
        const lifecycle = buildTenantLifecycle(clinic.settings, {
          activePortalUsers: clinic.activePortalUsers,
          activeOwners: clinic.activeOwners
        });
        return {
          id: clinic.id,
          name: clinic.name || clinic.externalTenantId,
          displayName,
          primaryEmail: clinic.primaryEmail || null,
          tenantId: clinic.externalTenantId,
          externalTenantId: clinic.externalTenantId,
          timezone: clinic.timezone || null,
          createdAt: clinic.createdAt || null,
          updatedAt: clinic.updatedAt || null,
          lifecycle,
          policy: buildTenantPolicyFromSettings(clinic.settings)
        };
      })
      .filter((tenant) => tenant.lifecycle.visible)
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
  const clinicPatch = buildClinicBasicsPatch(input, {
    ...current.clinic,
    settings: current.clinic.settings,
    primaryEmail: current.primaryEmail
  });
  const nextPolicy = sanitizeTenantPolicyPatch({
    planCode: input.planCode ?? current.policy.planCode,
    limits: {
      ...current.policy.limits,
      ...(input.limits && typeof input.limits === 'object' && !Array.isArray(input.limits) ? input.limits : {})
    },
    capabilities: input.capabilities === undefined ? current.policy.capabilities : input.capabilities,
    enabledModules: {
      ...current.policy.enabledModules,
      ...pickBooleanModules(input.enabledModules)
    }
  });
  const result = await query(
    `WITH updated_clinic AS (
       UPDATE clinics
       SET name = $2,
           settings = jsonb_set(
             jsonb_set(
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
               $3::jsonb,
               true
             ),
             '{businessProfile,name}',
             to_jsonb($2::text),
             true
           ),
           "updatedAt" = NOW()
       WHERE "externalTenantId" = $1
       RETURNING id, name, "externalTenantId", settings, timezone, "createdAt", "updatedAt"
     ),
     updated_primary_user AS (
       UPDATE staff_users su
       SET email = $4,
           "updatedAt" = NOW()
       FROM updated_clinic uc
       WHERE $4::text IS NOT NULL
         AND su."clinicId" = uc.id
         AND su."accountType" = 'client_portal'
         AND su.active = TRUE
         AND su.email IS NOT NULL
         AND su.id::text = COALESCE(NULLIF(uc.settings #>> '{portal,primaryPortalUserId}', ''), '__missing__')
       RETURNING su.id, su.email
     )
     SELECT uc.*,
            COALESCE(
              (SELECT email FROM updated_primary_user LIMIT 1),
              (
                SELECT su.email
                FROM staff_users su
                WHERE su."clinicId" = uc.id
                  AND su."accountType" = 'client_portal'
                  AND su.active = TRUE
                  AND su.email IS NOT NULL
                ORDER BY
                  CASE
                    WHEN NULLIF(uc.settings #>> '{portal,primaryPortalUserId}', '') IS NOT NULL
                      AND su.id::text = uc.settings #>> '{portal,primaryPortalUserId}'
                    THEN 0
                    ELSE 1
                  END,
                  CASE WHEN su.role = 'owner' THEN 0 ELSE 1 END,
                  su."createdAt" ASC
                LIMIT 1
              )
            ) AS "primaryEmail"
     FROM updated_clinic uc`,
    [safeTenantId, clinicPatch.displayName, JSON.stringify(nextPolicy), clinicPatch.primaryEmail]
  );

  const clinic = result.rows[0] || null;
  if (!clinic) return { ok: false, reason: 'tenant_not_found', tenantId: safeTenantId };

  return {
    ok: true,
    tenantId: clinic.externalTenantId,
    clinic: {
      id: clinic.id,
      name: clinic.name || null,
      externalTenantId: clinic.externalTenantId || null,
      primaryEmail: clinic.primaryEmail || null
    },
    primaryEmail: clinic.primaryEmail || null,
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
  listTenantPolicies,
  resolveTenantPolicyByClinicId,
  resolveTenantPolicyByExternalTenantId,
  updateTenantPolicyByExternalTenantId,
  sanitizeTenantPolicyPatch,
  isModuleEnabled
};
