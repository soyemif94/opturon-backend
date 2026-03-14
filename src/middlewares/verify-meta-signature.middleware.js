const crypto = require('crypto');

const env = require('../config/env');
const { createFailure } = require('../repositories/inbound-failures.repository');
const { logWarn, logError, logInfo } = require('../utils/logger');

function parseRawBody(bufferValue, parsedBody) {
  if (bufferValue && Buffer.isBuffer(bufferValue) && bufferValue.length > 0) {
    try {
      return JSON.parse(bufferValue.toString('utf8'));
    } catch (error) {
      return { rawText: bufferValue.toString('utf8') };
    }
  }

  if (parsedBody && typeof parsedBody === 'object') {
    return parsedBody;
  }

  return {};
}

async function rejectInvalidSignature(req, res, reason, detail) {
  const requestId = req.requestId || null;
  req.metaSignatureValid = false;
  const rawPayload = parseRawBody(req.rawBody, req.body);

  try {
    await createFailure({
      reason: 'INVALID_SIGNATURE',
      phoneNumberId: null,
      providerMessageId: null,
      requestId,
      raw: rawPayload,
      error: `${reason}${detail ? `: ${detail}` : ''}`
    });
  } catch (error) {
    logError('signature_failure_persist_failed', {
      requestId,
      reason,
      error: error.message
    });
  }

  logWarn('Meta signature rejected', {
    requestId,
    reason,
    detail: detail || null,
    hasRawBody: Buffer.isBuffer(req.rawBody),
    rawBodyBytes: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0,
    signatureHeaderPresent: !!req.get('x-hub-signature-256')
  });

  return res.status(200).json({ success: true, ignored: 'invalid_signature' });
}

async function verifyMetaSignature(req, res, next) {
  if (!env.verifySignature) {
    req.metaSignatureValid = null;
    return next();
  }

  if (!env.metaAppSecret) {
    req.metaSignatureValid = null;
    logWarn('Meta signature skipped: VERIFY_SIGNATURE=true but META_APP_SECRET is empty', {
      requestId: req.requestId || null
    });
    return next();
  }

  const signatureHeader = String(req.get('x-hub-signature-256') || '').trim();
  if (!signatureHeader.startsWith('sha256=')) {
    return rejectInvalidSignature(req, res, 'missing_or_malformed_header');
  }

  const rawBody =
    Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const providedDigest = signatureHeader.slice('sha256='.length);

  if (!rawBody.length) {
    return rejectInvalidSignature(req, res, 'missing_raw_body');
  }

  let providedBuffer;
  try {
    providedBuffer = Buffer.from(providedDigest, 'hex');
  } catch (error) {
    return rejectInvalidSignature(req, res, 'malformed_digest', error.message);
  }

  const expectedDigest = crypto.createHmac('sha256', env.metaAppSecret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expectedDigest, 'hex');

  const isValid =
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!isValid) {
    return rejectInvalidSignature(req, res, 'invalid_digest');
  }

  req.metaSignatureValid = true;
  req.rawBody = rawBody;
  logInfo('Meta signature verified', {
    requestId: req.requestId || null,
    rawBodyBytes: rawBody.length,
    signatureHeaderPresent: true
  });
  return next();
}

function parseMetaWebhookJson(req, res, next) {
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) {
    req.body = {};
    return next();
  }

  try {
    req.body = JSON.parse(req.rawBody.toString('utf8'));
    return next();
  } catch (error) {
    logWarn('Meta webhook JSON parse failed', {
      requestId: req.requestId || null,
      error: error.message
    });
    return res.status(400).json({ success: false, error: 'invalid_webhook_payload' });
  }
}

module.exports = { verifyMetaSignature, parseMetaWebhookJson };

