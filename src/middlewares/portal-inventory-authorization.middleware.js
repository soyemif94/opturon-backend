const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const SENSITIVE_TENANT_ROLES = new Set(['owner', 'manager']);
const OPERATIONAL_RECEIPT_TENANT_ROLES = new Set(['owner', 'manager', 'seller']);
const INVENTORY_READ_TENANT_ROLES = new Set(['owner', 'manager', 'seller', 'viewer']);
const CATALOG_WRITE_TENANT_ROLES = new Set(['owner', 'manager']);
const OPTURON_ADMIN_ROLES = new Set(['superadmin', 'ops_admin']);

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

function isAuthorizedAdminTenantSelection(req, actor, targetTenantId) {
  if (normalizeString(actor.tenantId) === targetTenantId) return true;
  const context = req.activeTenantContext || {};
  return context.source === 'active_tenant' &&
    normalizeString(context.actorUserId) === normalizeString(actor.id) &&
    normalizeString(context.activeTenantId) === targetTenantId;
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
      const globalRole = normalizeRole(req.get('x-portal-actor-global-role'));
      const targetTenantId = normalizeString(req.activeTenantId || req.params?.tenantId);
      if (
        allowOpturonAdmin &&
        normalizeString(actor.accountScope).toLowerCase() === 'opturon_admin' &&
        OPTURON_ADMIN_ROLES.has(globalRole) &&
        isAuthorizedAdminTenantSelection(req, actor, targetTenantId)
      ) {
        req.inventoryActor = actor;
        return next();
      }
      return buildForbiddenResponse(res);
    }
    const targetTenantId = normalizeString(req.activeTenantId || req.params?.tenantId);
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
  return buildInventoryRoleGate(OPERATIONAL_RECEIPT_TENANT_ROLES, { allowOpturonAdmin: true });
}

function requireCatalogWriteRole() {
  return buildInventoryRoleGate(CATALOG_WRITE_TENANT_ROLES, { allowOpturonAdmin: true });
}

module.exports = {
  INVENTORY_READ_TENANT_ROLES,
  CATALOG_WRITE_TENANT_ROLES,
  requireInventoryReadRole,
  requireSensitiveInventoryRole,
  requireInventoryReceiptRole,
  requireCatalogWriteRole
};
