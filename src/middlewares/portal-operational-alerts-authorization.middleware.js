const {
  findPortalActorContext,
  hasPortalInternalAuth
} = require('../services/portal-active-tenant.service');

const OPERATIONAL_ALERTS_READ_ROLES = new Set(['owner', 'manager']);
const OPERATIONAL_ALERTS_WRITE_ROLES = new Set(['owner', 'manager']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeRole(value) {
  const role = normalizeString(value).toLowerCase();
  return role === 'editor' ? 'seller' : role;
}

function forbidden(res) {
  return res.status(403).json({
    success: false,
    error: 'portal_operational_alerts_forbidden'
  });
}

function isAuthorizedAdminTenantSelection(req, actor, targetTenantId) {
  if (normalizeString(actor.tenantId) === targetTenantId) return true;
  const context = req.activeTenantContext || {};
  return context.source === 'active_tenant'
    && normalizeString(context.actorUserId) === normalizeString(actor.id)
    && normalizeString(context.activeTenantId) === targetTenantId;
}

function buildOperationalAlertsAuthorization(allowedRoles) {
  return async function operationalAlertsAuthorization(req, res, next) {
    try {
      if (!hasPortalInternalAuth(req)) return forbidden(res);
      const actorId = normalizeString(req.get('x-portal-actor-id'));
      const targetTenantId = normalizeString(req.activeTenantId || req.params.tenantId);
      if (!actorId || !targetTenantId) return forbidden(res);

      const actor = await findPortalActorContext(actorId);
      if (!actor) return forbidden(res);
      if (actor.isAdmin) {
        if (!isAuthorizedAdminTenantSelection(req, actor, targetTenantId)) return forbidden(res);
      } else if (
        normalizeString(actor.tenantId) !== targetTenantId ||
        !allowedRoles.has(normalizeRole(actor.role))
      ) {
        return forbidden(res);
      }

      req.operationalAlertsActor = actor;
      return next();
    } catch {
      return res.status(500).json({
        success: false,
        error: 'portal_operational_alerts_authorization_failed'
      });
    }
  };
}

function requireOperationalAlertsReadPermission() {
  return buildOperationalAlertsAuthorization(OPERATIONAL_ALERTS_READ_ROLES);
}

function requireOperationalAlertsWritePermission() {
  return buildOperationalAlertsAuthorization(OPERATIONAL_ALERTS_WRITE_ROLES);
}

module.exports = {
  OPERATIONAL_ALERTS_READ_ROLES,
  OPERATIONAL_ALERTS_WRITE_ROLES,
  requireOperationalAlertsReadPermission,
  requireOperationalAlertsWritePermission
};
