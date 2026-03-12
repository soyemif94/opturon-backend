const env = require('../config/env');

function requirePortalInternalAuth(req, res, next) {
  const configuredKey = String(env.portalInternalKey || '').trim();

  if (!configuredKey) {
    if (String(env.nodeEnv || '').toLowerCase() === 'production') {
      return res.status(503).json({
        success: false,
        error: 'portal_internal_key_not_configured'
      });
    }
    return next();
  }

  const providedKey = String(req.get('x-portal-key') || '').trim();
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({
      success: false,
      error: 'portal_internal_unauthorized'
    });
  }

  return next();
}

module.exports = {
  requirePortalInternalAuth
};
