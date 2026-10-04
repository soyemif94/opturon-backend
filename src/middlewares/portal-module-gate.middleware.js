const {
  resolveTenantPolicyByExternalTenantId,
  isModuleEnabled
} = require('../services/tenant-policy.service');
const { MODULE_TO_CAPABILITY } = require('../services/tenant-operating-profile.service');
const { canCapability } = require('../services/effective-entitlements');
const { LEGACY_CAPABILITY_MAP, CAPABILITY_REGISTRY, MODULE_CAPABILITIES } = require('../services/plan-catalog');

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
    if (!tenantId || !Object.hasOwn(MODULE_CAPABILITIES, moduleName)) return res.status(403).json({ success: false, error: 'tenant_module_disabled' });

    try {
      const result = await resolveTenantPolicyByExternalTenantId(tenantId);
      if (!result.ok) return res.status(403).json({ success: false, error: 'tenant_entitlements_unavailable' });
      if (isOpturonAdminTenant(result)) return next();
      if (isSuspendedForNonpayment(result.policy)) return nonpaymentResponse(res, tenantId);
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
    const canonical = LEGACY_CAPABILITY_MAP[targetCapability] || targetCapability;
    if (!tenantId || !Object.hasOwn(CAPABILITY_REGISTRY, canonical)) return res.status(403).json({ success: false, error: 'tenant_capability_disabled' });

    try {
      const result = await resolveTenantPolicyByExternalTenantId(tenantId);
      if (!result.ok) return res.status(403).json({ success: false, error: 'tenant_entitlements_unavailable' });
      if (isOpturonAdminTenant(result)) return next();
      if (isSuspendedForNonpayment(result.policy)) return nonpaymentResponse(res, tenantId);
      if (canCapability(result.policy?.entitlements, canonical)) {
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

function isSuspendedForNonpayment(policy) {
  return policy?.billingEntitlement?.state === 'suspended_for_nonpayment'
    && policy.billingEntitlement.paidAccessAllowed === false;
}
function nonpaymentResponse(res, tenantId) {
  return res.status(403).json({ success: false, error: 'billing_entitlement_suspended', tenantId });
}

module.exports = {
  requirePortalModule,
  requirePortalCapability
};
