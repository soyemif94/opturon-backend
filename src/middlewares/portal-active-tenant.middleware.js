const { resolveActiveTenantForRequest } = require('../services/portal-active-tenant.service');

async function applyPortalActiveTenant(req, res, next) {
  const requestedTenantId = String(req.params.tenantId || '').trim();
  if (!requestedTenantId) return next();

  try {
    const result = await resolveActiveTenantForRequest(req, requestedTenantId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || requestedTenantId,
        activeTenantId: result.activeTenantId || null
      });
    }

    req.activeTenantId = result.tenantId;
    req.activeTenantContext = {
      source: result.source,
      requestedTenantId,
      activeTenantId: result.activeTenantId,
      actorUserId: result.actor && result.actor.id ? result.actor.id : null
    };
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_active_tenant_resolution_failed',
      details: error.message
    });
  }
}

module.exports = {
  applyPortalActiveTenant
};
