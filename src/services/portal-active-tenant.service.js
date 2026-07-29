const env = require('../config/env');
const { query } = require('../db/client');
const { listActiveStaff } = require('../repositories/staff.repository');
const { findPortalUserById } = require('../repositories/portal-users.repository');
const { getClinicPortalAccountConfigById } = require('../repositories/tenant.repository');
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeString(value)
  );
}

function hasPortalInternalAuth(req) {
  const configuredKey = normalizeString(env.portalInternalKey);
  if (!configuredKey && String(env.nodeEnv || '').toLowerCase() !== 'production') {
    return true;
  }

  const providedKey = normalizeString(req.get('x-portal-key'));
  return Boolean(configuredKey && providedKey && providedKey === configuredKey);
}

async function findPortalActorContext(actorUserId) {
  const safeActorUserId = normalizeString(actorUserId);
  if (!isUuid(safeActorUserId)) return null;

  const result = await query(
    `SELECT su.id,
            su."clinicId",
            su.name,
            su.email,
            su.role,
            c."externalTenantId" AS "tenantId",
            CASE
              WHEN LOWER(COALESCE(
                c.settings #>> '{portal,accountScope}',
                c.settings #>> '{portal,scope}',
                c.settings #>> '{accountScope}',
                c.settings #>> '{tenantScope}',
                ''
              )) IN ('opturon_admin', 'global_admin', 'superadmin')
              OR LOWER(COALESCE(c.settings #>> '{portal,isOpturonAdmin}', '')) = 'true'
              OR LOWER(COALESCE(c.settings #>> '{portal,isGlobalAdmin}', '')) = 'true'
              THEN 'opturon_admin'
              ELSE 'client'
            END AS "accountScope"
     FROM staff_users su
     INNER JOIN clinics c ON c.id = su."clinicId"
     WHERE su.id = $1::uuid
       AND su.active = TRUE
     LIMIT 1`,
    [safeActorUserId]
  );

  const actor = result.rows[0] || null;
  if (!actor) return null;

  return {
    id: actor.id,
    clinicId: actor.clinicId,
    name: actor.name || null,
    email: actor.email || null,
    role: actor.role || null,
    tenantId: actor.tenantId || null,
    accountScope: actor.accountScope || 'client',
    isAdmin: actor.accountScope === 'opturon_admin'
  };
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function mapActorRecord(actor, clinic, accountScope) {
  if (!actor || !clinic) return null;
  return {
    id: actor.id,
    clinicId: actor.clinicId || clinic.id,
    name: actor.name || null,
    email: actor.email || null,
    role: actor.role || null,
    tenantId: clinic.externalTenantId || null,
    accountScope: accountScope || 'client',
    isAdmin: accountScope === 'opturon_admin'
  };
}

function selectAdminActorCandidate(candidates, options = {}) {
  const safeCandidates = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (safeCandidates.length === 0) {
    return { ok: false, reason: 'admin_actor_not_found' };
  }

  const primaryPortalUserId = normalizeString(options.primaryPortalUserId);
  if (primaryPortalUserId) {
    const primaryCandidate = safeCandidates.find((candidate) => String(candidate.id || '') === primaryPortalUserId);
    if (primaryCandidate) {
      return { ok: true, actor: primaryCandidate, source: 'primary_portal_user_id' };
    }
  }

  const safeEmail = normalizeEmail(options.email);
  if (safeEmail) {
    const emailMatches = safeCandidates.filter((candidate) => normalizeEmail(candidate.email) === safeEmail);
    if (emailMatches.length === 1) {
      return { ok: true, actor: emailMatches[0], source: 'email_match' };
    }
    if (emailMatches.length > 1) {
      return { ok: false, reason: 'admin_actor_email_ambiguous' };
    }
  }

  if (safeCandidates.length === 1) {
    return { ok: true, actor: safeCandidates[0], source: 'single_internal_staff_actor' };
  }

  return { ok: false, reason: 'admin_actor_ambiguous' };
}

async function resolveAdminPortalActor({ tenantId, email = null }) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return { ok: false, reason: 'missing_tenant_id', status: 400 };
  }

  const clinic = await findClinicByExternalTenantId(safeTenantId);
  if (!clinic) {
    return { ok: false, reason: 'tenant_not_found', status: 404 };
  }

  const accountConfig = await getClinicPortalAccountConfigById(clinic.id);
  if (!accountConfig || accountConfig.accountScope !== 'opturon_admin') {
    return { ok: false, reason: 'admin_scope_required', status: 403 };
  }

  const candidates = [];
  const primaryPortalUserId = normalizeString(accountConfig.primaryPortalUserId);
  if (primaryPortalUserId) {
    const primaryPortalUser = await findPortalUserById(primaryPortalUserId);
    if (primaryPortalUser && String(primaryPortalUser.clinicId || '') === String(clinic.id)) {
      candidates.push(primaryPortalUser);
    }
  }

  const activeStaff = await listActiveStaff(clinic.id);
  for (const actor of activeStaff) {
    if (!candidates.find((candidate) => String(candidate.id || '') === String(actor.id || ''))) {
      candidates.push(actor);
    }
  }

  const selected = selectAdminActorCandidate(candidates, {
    primaryPortalUserId,
    email
  });

  if (!selected.ok) {
    return {
      ok: false,
      reason: selected.reason,
      status: selected.reason === 'admin_actor_not_found' ? 404 : 409
    };
  }

  return {
    ok: true,
    actor: mapActorRecord(selected.actor, clinic, accountConfig.accountScope),
    source: selected.source
  };
}

async function resolveActiveTenantForRequest(req, requestedTenantId) {
  const defaultTenantId = normalizeString(requestedTenantId);
  const activeTenantId = normalizeString(req.get('x-active-tenant-id'));
  if (!activeTenantId || activeTenantId === defaultTenantId) {
    return {
      ok: true,
      tenantId: defaultTenantId,
      activeTenantId: null,
      actor: null,
      source: 'requested_tenant'
    };
  }

  if (!hasPortalInternalAuth(req)) {
    return {
      ok: true,
      tenantId: defaultTenantId,
      activeTenantId: null,
      actor: null,
      source: 'requested_tenant'
    };
  }

  const actor = await findPortalActorContext(req.get('x-portal-actor-id'));
  if (!actor || !actor.isAdmin) {
    return {
      ok: true,
      tenantId: defaultTenantId,
      activeTenantId: null,
      actor,
      source: 'requested_tenant'
    };
  }

  const targetClinic = await findClinicByExternalTenantId(activeTenantId);
  if (!targetClinic) {
    return {
      ok: false,
      status: 404,
      reason: 'active_tenant_not_found',
      tenantId: defaultTenantId,
      activeTenantId,
      actor
    };
  }

  return {
    ok: true,
    tenantId: activeTenantId,
    activeTenantId,
    actor,
    source: 'active_tenant'
  };
}

async function setActiveTenantForAdmin(actorUserId, tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return { ok: false, reason: 'missing_tenant_id', status: 400 };
  }

  const actor = await findPortalActorContext(actorUserId);
  if (!actor || !actor.isAdmin) {
    return { ok: false, reason: 'admin_required', status: 403 };
  }

  const targetClinic = await findClinicByExternalTenantId(safeTenantId);
  if (!targetClinic) {
    return { ok: false, reason: 'tenant_not_found', status: 404, actor };
  }

  return {
    ok: true,
    actor,
    activeTenantId: safeTenantId,
    tenant: {
      id: targetClinic.id,
      name: targetClinic.name || null,
      externalTenantId: targetClinic.externalTenantId || safeTenantId
    }
  };
}

module.exports = {
  hasPortalInternalAuth,
  findPortalActorContext,
  resolveAdminPortalActor,
  selectAdminActorCandidate,
  resolveActiveTenantForRequest,
  setActiveTenantForAdmin
};
