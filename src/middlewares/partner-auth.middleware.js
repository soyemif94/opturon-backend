const { requirePortalInternalAuth } = require('./portal-internal-auth.middleware');
const { findPortalActorContext } = require('../services/portal-active-tenant.service');
const { findPartnerById } = require('../repositories/partners.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function getPartnerIdentityTraceId(req) {
  return normalizeString(req.get('x-partner-identity-trace-id'));
}

function logPartnerIdentityTrace(payload) {
  console.info('partner_identity_trace', {
    event: 'partner_identity_trace',
    layer: 'express_backend',
    lookupTable: 'partner_accounts',
    ...payload
  });
}

function requirePartnerInternalAuth(req, res, next) {
  return requirePortalInternalAuth(req, res, async () => {
    const partnerId = normalizeString(req.get('x-partner-id'));
    const traceId = getPartnerIdentityTraceId(req);
    if (!isUuid(partnerId)) {
      if (traceId) {
        logPartnerIdentityTrace({
          traceId,
          requestPath: req.originalUrl || req.path,
          forwardedPartnerId: partnerId || null,
          backendActorPartnerId: null,
          repositoryLookupId: partnerId || null,
          found: false,
          active: false
        });
      }
      return res.status(401).json({
        success: false,
        error: 'partner_unauthorized'
      });
    }

    const partner = await findPartnerById(partnerId);
    if (traceId) {
      logPartnerIdentityTrace({
        traceId,
        requestPath: req.originalUrl || req.path,
        forwardedPartnerId: partnerId,
        backendActorPartnerId: partner ? partner.id : null,
        repositoryLookupId: partnerId,
        found: Boolean(partner),
        active: Boolean(partner && partner.status === 'active')
      });
    }
    if (!partner) {
      return res.status(403).json({
        success: false,
        error: 'partner_identity_invalid'
      });
    }
    if (partner.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'partner_inactive'
      });
    }

    req.partnerAuth = {
      partnerId: partner.id,
      email: partner.email,
      status: partner.status,
      traceId
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
