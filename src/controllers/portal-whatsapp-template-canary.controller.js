const service = require('../services/portal-whatsapp-template-canary.service');

function tenantId(req) { return String(req.activeTenantId || req.params.tenantId || '').trim(); }
async function getCanary(req, res) {
  try {
    const result = await service.getCanaryWorkspace(tenantId(req));
    if (!result.ok) return res.status(result.status || 409).json({ success: false, error: result.reason, detail: result.detail || null });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'whatsapp_canary_load_failed', detail: String(error.message || '').slice(0, 300) });
  }
}
async function postCanary(req, res) {
  try {
    const result = await service.sendCanary(tenantId(req), req.body || {}, req.whatsappCanaryActor);
    if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.reason, details: result.details || null, attempt: result.attempt || null });
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'whatsapp_canary_send_failed', detail: String(error.message || '').slice(0, 300) });
  }
}
module.exports = { getCanary, postCanary };
