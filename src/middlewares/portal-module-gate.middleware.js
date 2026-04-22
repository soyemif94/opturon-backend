const {
  resolveTenantPolicyByExternalTenantId,
  isModuleEnabled
} = require('../services/tenant-policy.service');

function requirePortalModule(moduleName) {
  return async function portalModuleGate(req, res, next) {
    const tenantId = String(req.activeTenantId || req.params.tenantId || '').trim();
    if (!tenantId) return next();

    try {
      const result = await resolveTenantPolicyByExternalTenantId(tenantId);
      if (!result.ok) return next();
      if (isModuleEnabled(result.policy, moduleName)) return next();

      return res.status(403).json({
        success: false,
        error: 'tenant_module_disabled',
        tenantId,
        module: moduleName
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'tenant_module_gate_failed',
        details: error.message
      });
    }
  };
}

module.exports = {
  requirePortalModule
};
