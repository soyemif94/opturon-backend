const { requirePortalInternalAuth } = require('./portal-internal-auth.middleware');
const { findPortalActorContext } = require('../services/portal-active-tenant.service');
const { resolveTenantLifecycle } = require('../services/tenant-lifecycle-gate.service');

async function requireOperationalTenant(req, res, next) {
  return requirePortalInternalAuth(req, res, async () => {
    try {
      const actorId = String(req.get('x-portal-actor-id') || '').trim();
      if (actorId) {
        const actor = await findPortalActorContext(actorId);
        if (actor && actor.isAdmin) return next();
      }
      const tenantId = String(req.activeTenantId || req.params.tenantId || '').trim();
      const lifecycle = await resolveTenantLifecycle({ tenantId });
      if (!lifecycle.ok) {
        return res.status(503).json({ success: false, error: 'tenant_lifecycle_unavailable' });
      }
      if (!lifecycle.suspended) return next();
      return res.status(423).json({
        success: false,
        error: 'tenant_suspended',
        message: 'Tu cuenta está temporalmente suspendida. Contactá al administrador de Opturon.'
      });
    } catch {
      return res.status(503).json({ success: false, error: 'tenant_lifecycle_gate_failed' });
    }
  });
}

module.exports = { requireOperationalTenant };
