const {
  resolveTenantPolicyByExternalTenantId,
  isModuleEnabled
} = require('../services/tenant-policy.service');
const { MODULE_TO_CAPABILITY } = require('../services/tenant-operating-profile.service');

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function isOpturonAdminTenant(result) {
  const settings = result && result.clinic && result.clinic.settings && typeof result.clinic.settings === 'object'
    ? result.clinic.settings
    : {};
  const candidates = [
    settings?.portal?.accountScope,
    settings?.portal?.scope,
    settings?.accountScope,
    settings?.tenantScope
  ];

  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized === 'opturon_admin' || normalized === 'global_admin' || normalized === 'superadmin') {
      return true;
    }
  }

  return settings?.portal?.isOpturonAdmin === true || settings?.portal?.isGlobalAdmin === true;
}

function requirePortalModule(moduleName) {
  return async function portalModuleGate(req, res, next) {
    const tenantId = String(req.activeTenantId || req.params.tenantId || '').trim();
    if (!tenantId) return next();

    try {
      const result = await resolveTenantPolicyByExternalTenantId(tenantId);
      if (!result.ok) return next();
      if (isOpturonAdminTenant(result)) return next();
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

function requirePortalCapability(capabilityName) {
  const targetCapability = String(capabilityName || '').trim().toLowerCase();

  return async function portalCapabilityGate(req, res, next) {
    const tenantId = String(req.activeTenantId || req.params.tenantId || '').trim();
    if (!tenantId || !targetCapability) return next();

    try {
      const result = await resolveTenantPolicyByExternalTenantId(tenantId);
      if (!result.ok) return next();
      if (isOpturonAdminTenant(result)) return next();
      if (Array.isArray(result.policy?.capabilities) && result.policy.capabilities.includes(targetCapability)) {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: 'tenant_capability_disabled',
        tenantId,
        capability: targetCapability,
        module:
          Object.entries(MODULE_TO_CAPABILITY).find(([, capability]) => capability === targetCapability)?.[0] || null
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'tenant_capability_gate_failed',
        details: error.message
      });
    }
  };
}

module.exports = {
  requirePortalModule,
  requirePortalCapability
};
