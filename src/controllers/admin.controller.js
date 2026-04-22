const { setActiveTenantForAdmin } = require('../services/portal-active-tenant.service');
const {
  resolveTenantPolicyByExternalTenantId,
  updateTenantPolicyByExternalTenantId
} = require('../services/tenant-policy.service');

async function postSetActiveTenant(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String((req.body && req.body.tenantId) || '').trim();

  try {
    const result = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason
      });
    }

    res.set('x-active-tenant-id', result.activeTenantId);
    return res.status(200).json({
      success: true,
      data: {
        activeTenantId: result.activeTenantId,
        tenant: result.tenant,
        header: 'x-active-tenant-id'
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'set_active_tenant_failed',
      details: error.message
    });
  }
}

async function getTenantPolicy(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const access = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!access.ok) {
      return res.status(access.status || 400).json({ success: false, error: access.reason });
    }

    const result = await resolveTenantPolicyByExternalTenantId(tenantId);
    if (!result.ok) {
      return res.status(result.reason === 'tenant_not_found' ? 404 : 400).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'tenant_policy_read_failed',
      details: error.message
    });
  }
}

async function patchTenantPolicy(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const access = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!access.ok) {
      return res.status(access.status || 400).json({ success: false, error: access.reason });
    }

    const result = await updateTenantPolicyByExternalTenantId(tenantId, req.body || {});
    if (!result.ok) {
      return res.status(result.reason === 'tenant_not_found' ? 404 : 400).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'tenant_policy_update_failed',
      details: error.message
    });
  }
}

module.exports = {
  postSetActiveTenant,
  getTenantPolicy,
  patchTenantPolicy
};
