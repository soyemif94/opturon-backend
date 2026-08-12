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
    error: 'portal_whatsapp_templates_admin_required'
  });
}

function isAuthorizedAdminTenantSelection(req, actor, targetTenantId) {
  if (normalizeString(actor.tenantId) === targetTenantId) return true;
  const context = req.activeTenantContext || {};
  return context.source === 'active_tenant'
    && normalizeString(context.actorUserId) === normalizeString(actor.id)
    && normalizeString(context.activeTenantId) === targetTenantId;
}

function createWhatsAppTemplateSyncAdminAuthorization(overrides = {}) {
  const dependencies = {
    hasInternalAuth: hasPortalInternalAuth,
    findActor: findPortalActorContext,
    ...overrides
  };

  return async function requireWhatsAppTemplateSyncAdmin(req, res, next) {
    try {
      if (!dependencies.hasInternalAuth(req)) return forbidden(res);
      const actorId = normalizeString(req.get('x-portal-actor-id'));
      const targetTenantId = normalizeString(req.activeTenantId || req.params.tenantId);
      if (!actorId || !targetTenantId) return forbidden(res);

      const actor = await dependencies.findActor(actorId);
      if (
        !actor ||
        actor.isAdmin !== true ||
        !isAuthorizedAdminTenantSelection(req, actor, targetTenantId)
      ) {
        return forbidden(res);
      }

      req.whatsAppTemplateSyncActor = actor;
      return next();
    } catch {
      return res.status(500).json({
        success: false,
        error: 'portal_whatsapp_templates_authorization_failed'
      });
    }
  };
}

const requireWhatsAppTemplateSyncAdmin = createWhatsAppTemplateSyncAdminAuthorization();

module.exports = {
  requireWhatsAppTemplateSyncAdmin,
  createWhatsAppTemplateSyncAdminAuthorization
};
