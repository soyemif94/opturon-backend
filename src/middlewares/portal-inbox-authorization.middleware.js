const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const DELETE_CONVERSATION_ROLES = new Set(['owner', 'manager']);
const DELETE_CONVERSATION_ADMIN_ROLES = new Set(['superadmin', 'ops_admin']);

function normalize(value) {
  return String(value || '').trim();
}

function isAuthorizedAdminTenantSelection(req, actor, targetTenantId) {
  if (normalize(actor.tenantId) === targetTenantId) return true;
  const context = req.activeTenantContext || {};
  return context.source === 'active_tenant' &&
    normalize(context.actorUserId) === normalize(actor.id) &&
    normalize(context.activeTenantId) === targetTenantId;
}

function requireConversationDeleteRole() {
  return async function portalConversationDeleteRole(req, res, next) {
    if (!hasPortalInternalAuth(req)) {
      return res.status(403).json({ success: false, error: 'portal_inbox_delete_forbidden' });
    }

    const actorId = normalize(req.get('x-portal-actor-id'));
    const actor = actorId ? await findPortalActorContext(actorId) : null;
    const targetTenantId = normalize(req.activeTenantId || (req.params && req.params.tenantId));
    const actorTenantId = normalize(actor && actor.tenantId);
    const role = normalize(actor && actor.role).toLowerCase();
    const globalRole = normalize(req.get('x-portal-actor-global-role')).toLowerCase();

    const authorizedAdmin = actor &&
      actor.isAdmin === true &&
      normalize(actor.accountScope).toLowerCase() === 'opturon_admin' &&
      DELETE_CONVERSATION_ADMIN_ROLES.has(globalRole) &&
      isAuthorizedAdminTenantSelection(req, actor, targetTenantId);
    const authorizedTenantActor = actor &&
      actor.isAdmin !== true &&
      actorTenantId &&
      actorTenantId === targetTenantId &&
      DELETE_CONVERSATION_ROLES.has(role);

    if (!authorizedAdmin && !authorizedTenantActor) {
      return res.status(403).json({ success: false, error: 'portal_inbox_delete_forbidden' });
    }

    req.inboxActor = actor;
    return next();
  };
}

module.exports = {
  DELETE_CONVERSATION_ROLES,
  DELETE_CONVERSATION_ADMIN_ROLES,
  requireConversationDeleteRole
};
