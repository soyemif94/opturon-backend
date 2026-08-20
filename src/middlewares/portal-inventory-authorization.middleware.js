const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const SENSITIVE_TENANT_ROLES = new Set(['owner', 'manager']);
const OPERATIONAL_RECEIPT_TENANT_ROLES = new Set(['owner', 'manager', 'seller']);
const INVENTORY_READ_TENANT_ROLES = new Set(['owner', 'manager', 'seller', 'viewer']);

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

function buildInventoryRoleGate(allowedTenantRoles, options = {}) {
  const allowOpturonAdmin = options.allowOpturonAdmin === true;
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
      if (allowOpturonAdmin && normalizeString(actor.accountScope).toLowerCase() === 'opturon_admin') {
        req.inventoryActor = actor;
        return next();
      }
      return buildForbiddenResponse(res);
    }
    const targetTenantId = normalizeString(req.params?.tenantId);
    const actorTenantId = normalizeString(actor.tenantId);
    if (targetTenantId && (!actorTenantId || targetTenantId !== actorTenantId)) {
      return buildForbiddenResponse(res);
    }

    const actorRole = normalizeRole(actor.role);
    if (allowedTenantRoles.has(actorRole)) {
      req.inventoryActor = actor;
      return next();
    }

    return buildForbiddenResponse(res);
  };
}

function requireInventoryReadRole() {
  return buildInventoryRoleGate(INVENTORY_READ_TENANT_ROLES, { allowOpturonAdmin: true });
}

function requireSensitiveInventoryRole() {
  return buildInventoryRoleGate(SENSITIVE_TENANT_ROLES);
}

function requireInventoryReceiptRole() {
  return buildInventoryRoleGate(OPERATIONAL_RECEIPT_TENANT_ROLES);
}

module.exports = {
  INVENTORY_READ_TENANT_ROLES,
  requireInventoryReadRole,
  requireSensitiveInventoryRole,
  requireInventoryReceiptRole
};
