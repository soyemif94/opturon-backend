const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const DELETE_CONVERSATION_ROLES = new Set(['owner', 'manager']);

function normalize(value) {
  return String(value || '').trim();
}

function requireConversationDeleteRole() {
  return async function portalConversationDeleteRole(req, res, next) {
    if (!hasPortalInternalAuth(req)) {
      return res.status(403).json({ success: false, error: 'portal_inbox_delete_forbidden' });
    }

    const actorId = normalize(req.get('x-portal-actor-id'));
    const actor = actorId ? await findPortalActorContext(actorId) : null;
    const targetTenantId = normalize(req.params && req.params.tenantId);
    const actorTenantId = normalize(actor && actor.tenantId);
    const role = normalize(actor && actor.role).toLowerCase();

    if (!actor || actor.isAdmin || !actorTenantId || actorTenantId !== targetTenantId || !DELETE_CONVERSATION_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'portal_inbox_delete_forbidden' });
    }

    req.inboxActor = actor;
    return next();
  };
}

module.exports = { DELETE_CONVERSATION_ROLES, requireConversationDeleteRole };
