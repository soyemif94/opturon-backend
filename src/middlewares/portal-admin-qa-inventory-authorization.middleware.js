const {
  findPortalActorContext,
  hasPortalInternalAuth
} = require('../services/portal-active-tenant.service');

function normalizeString(value) {
  return String(value || '').trim();
}

function forbidden(res) {
  return res.status(403).json({
    success: false,
    error: 'portal_admin_qa_inventory_forbidden'
  });
}

function isOpturonAdmin(actor) {
  return actor &&
    actor.isAdmin === true &&
    normalizeString(actor.accountScope).toLowerCase() === 'opturon_admin';
}

// This endpoint family deliberately requires the active-tenant handoff. Keeping
// the Admin workspace in the URL and the controlled client only in the internal
// header prevents a caller from treating the generic inventory routes as
// cross-tenant Admin APIs.
function isAuthorizedAdminTenantSelection(req, actor, targetTenantId) {
  const context = req.activeTenantContext || {};
  const actorId = normalizeString(req.get('x-portal-actor-id'));

  return context.source === 'active_tenant' &&
    normalizeString(context.actorUserId) === normalizeString(actor.id) &&
    actorId === normalizeString(actor.id) &&
    normalizeString(context.activeTenantId) === targetTenantId &&
    targetTenantId !== normalizeString(actor.tenantId);
}

function createAdminQaInventoryAuthorization(overrides = {}) {
  const dependencies = {
    hasInternalAuth: hasPortalInternalAuth,
    findActor: findPortalActorContext,
    ...overrides
  };

  return async function requireAdminQaInventoryPermission(req, res, next) {
    try {
      if (!dependencies.hasInternalAuth(req)) return forbidden(res);

      const actorId = normalizeString(req.get('x-portal-actor-id'));
      const targetTenantId = normalizeString(req.activeTenantId || req.params?.tenantId);
      if (!actorId || !targetTenantId) return forbidden(res);

      const actor = await dependencies.findActor(actorId);
      if (!isOpturonAdmin(actor) || !isAuthorizedAdminTenantSelection(req, actor, targetTenantId)) {
        return forbidden(res);
      }

      req.adminQaInventoryActor = actor;
      return next();
    } catch {
      return res.status(500).json({
        success: false,
        error: 'portal_admin_qa_inventory_authorization_failed'
      });
    }
  };
}

const requireAdminQaInventoryPermission = createAdminQaInventoryAuthorization();

module.exports = {
  createAdminQaInventoryAuthorization,
  requireAdminQaInventoryPermission,
  __private__: {
    isOpturonAdmin,
    isAuthorizedAdminTenantSelection
  }
};
