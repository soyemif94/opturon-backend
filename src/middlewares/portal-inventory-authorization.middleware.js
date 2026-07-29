const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const SENSITIVE_TENANT_ROLES = new Set(['owner', 'manager']);
const OPERATIONAL_RECEIPT_TENANT_ROLES = new Set(['owner', 'manager', 'seller']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === 'editor' ? 'seller' : normalized;
}

function buildForbiddenResponse(res) {
  return res.status(403).json({
    success: false,
    error: 'portal_inventory_role_forbidden'
  });
}

function buildInventoryRoleGate(allowedTenantRoles) {
  return async function portalInventoryRoleGate(req, res, next) {
    if (!hasPortalInternalAuth(req)) {
      return buildForbiddenResponse(res);
    }

    const actorUserId = normalizeString(req.get('x-portal-actor-id'));
    const actor = actorUserId ? await findPortalActorContext(actorUserId) : null;
    if (!actor) {
      return buildForbiddenResponse(res);
    }
    if (actor.isAdmin) {
      return buildForbiddenResponse(res);
    }
    if (normalizeString(req.params?.tenantId) && normalizeString(actor.tenantId) && normalizeString(req.params.tenantId) !== normalizeString(actor.tenantId)) {
      return buildForbiddenResponse(res);
    }

    const actorRole = normalizeRole(actor.role);
    if (allowedTenantRoles.has(actorRole)) {
      return next();
    }

    return buildForbiddenResponse(res);
  };
}

function requireSensitiveInventoryRole() {
  return buildInventoryRoleGate(SENSITIVE_TENANT_ROLES);
}

function requireInventoryReceiptRole() {
  return buildInventoryRoleGate(OPERATIONAL_RECEIPT_TENANT_ROLES);
}

module.exports = {
  requireSensitiveInventoryRole,
  requireInventoryReceiptRole
};
