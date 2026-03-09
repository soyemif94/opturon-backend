const crypto = require('crypto');
const env = require('../config/env');

function isDebugKeyMatch(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ''), 'utf-8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf-8');
  return (
    providedBuffer.length === expectedBuffer.length &&
    providedBuffer.length > 0 &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function requireDebugAccess(req, res, next) {
  if (!env.whatsappDebug) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }

  const providedKey = String(req.get('x-debug-key') || '').trim();
  if (!isDebugKeyMatch(providedKey, env.whatsappDebugKey)) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }

  return next();
}

module.exports = { requireDebugAccess };

