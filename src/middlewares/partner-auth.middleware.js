const { requirePortalInternalAuth } = require('./portal-internal-auth.middleware');

const STAFF_ADMIN_ROLES = new Set(['superadmin', 'ops_admin']);

function requirePartnerInternalAuth(req, res, next) {
  return requirePortalInternalAuth(req, res, () => {
    const partnerId = String(req.get('x-partner-id') || '').trim();
    if (!partnerId) {
      return res.status(401).json({
        success: false,
        error: 'partner_unauthorized'
      });
    }
    return next();
  });
}

function requireAdminInternalActor(req, res, next) {
  return requirePortalInternalAuth(req, res, () => {
    const actorRole = String(req.get('x-portal-actor-role') || '').trim().toLowerCase();
    if (!STAFF_ADMIN_ROLES.has(actorRole)) {
      return res.status(403).json({
        success: false,
        error: 'partner_admin_forbidden'
      });
    }
    return next();
  });
}

module.exports = {
  requirePartnerInternalAuth,
  requireAdminInternalActor
};
