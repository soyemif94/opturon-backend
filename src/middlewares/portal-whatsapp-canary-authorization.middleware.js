const { findPortalActorContext, hasPortalInternalAuth } = require('../services/portal-active-tenant.service');

const WRITE_ROLES = new Set(['owner', 'manager']);

function normalize(value) { return String(value || '').trim(); }

function createWhatsAppCanaryAuthorization(overrides = {}) {
  const dependencies = { findPortalActorContext, hasPortalInternalAuth, ...overrides };
  return async function authorize(req, res, next, write) {
  try {
    if (!dependencies.hasPortalInternalAuth(req)) return res.status(403).json({ success: false, error: 'portal_whatsapp_canary_forbidden' });
    const actor = await dependencies.findPortalActorContext(normalize(req.get('x-portal-actor-id')));
    const tenantId = normalize(req.activeTenantId || req.params.tenantId);
    if (!actor || !tenantId) return res.status(403).json({ success: false, error: 'portal_whatsapp_canary_forbidden' });
    const selectedByAdmin = actor.isAdmin && req.activeTenantContext && req.activeTenantContext.source === 'active_tenant'
      && normalize(req.activeTenantContext.actorUserId) === normalize(actor.id)
      && normalize(req.activeTenantContext.activeTenantId) === tenantId;
    const sameTenant = normalize(actor.tenantId) === tenantId;
    if ((!sameTenant && !selectedByAdmin) || (write && !actor.isAdmin && !WRITE_ROLES.has(normalize(actor.role).toLowerCase()))) {
      return res.status(403).json({ success: false, error: 'portal_whatsapp_canary_forbidden' });
    }
    req.whatsappCanaryActor = actor;
    return next();
  } catch {
    return res.status(500).json({ success: false, error: 'portal_whatsapp_canary_authorization_failed' });
  }
  };
}

const authorize = createWhatsAppCanaryAuthorization();
function requireWhatsAppCanaryRead(req, res, next) { return authorize(req, res, next, false); }
function requireWhatsAppCanaryWrite(req, res, next) { return authorize(req, res, next, true); }

module.exports = { WRITE_ROLES, createWhatsAppCanaryAuthorization, requireWhatsAppCanaryRead, requireWhatsAppCanaryWrite };
