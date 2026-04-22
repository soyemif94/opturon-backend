const { setActiveTenantForAdmin } = require('../services/portal-active-tenant.service');

async function postSetActiveTenant(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || (req.body && req.body.actorUserId) || '').trim();
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

module.exports = {
  postSetActiveTenant
};
