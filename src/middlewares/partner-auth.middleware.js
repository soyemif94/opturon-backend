const { requirePortalInternalAuth } = require('./portal-internal-auth.middleware');
const { findPortalActorContext } = require('../services/portal-active-tenant.service');
const { findPartnerById } = require('../repositories/partners.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function requirePartnerInternalAuth(req, res, next) {
  return requirePortalInternalAuth(req, res, async () => {
    const partnerId = normalizeString(req.get('x-partner-id'));
    if (!isUuid(partnerId)) {
      return res.status(401).json({
        success: false,
        error: 'partner_unauthorized'
      });
    }

    const partner = await findPartnerById(partnerId);
    if (!partner || partner.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'partner_forbidden'
      });
    }

    req.partnerAuth = {
      partnerId: partner.id,
      email: partner.email,
      status: partner.status
    };
    return next();
  });
}

function requireAdminInternalActor(req, res, next) {
  return requirePortalInternalAuth(req, res, async () => {
    const actorUserId = normalizeString(req.get('x-portal-actor-id'));
    if (!isUuid(actorUserId)) {
      return res.status(401).json({
        success: false,
        error: 'partner_admin_unauthorized'
      });
    }

    const actor = await findPortalActorContext(actorUserId);
    if (!actor || actor.isAdmin !== true) {
      return res.status(403).json({
        success: false,
        error: 'partner_admin_forbidden'
      });
    }

    req.adminActor = actor;
    return next();
  });
}

module.exports = {
  requirePartnerInternalAuth,
  requireAdminInternalActor
};
