const env = require('../config/env');
const { query } = require('../db/client');
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
    email: actor.email || null,
    role: actor.role || null,
    tenantId: actor.tenantId || null,
    accountScope: actor.accountScope || 'client',
    isAdmin: actor.accountScope === 'opturon_admin'
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
  resolveActiveTenantForRequest,
  setActiveTenantForAdmin
};
