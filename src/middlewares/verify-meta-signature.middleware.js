const crypto = require('crypto');

const env = require('../config/env');
const { createFailure } = require('../repositories/inbound-failures.repository');
const { logWarn, logError, logInfo } = require('../utils/logger');

function previewDigest(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 12) : null;
}

function buildExpectedSignature(rawBody) {
  const digest = crypto.createHmac('sha256', env.metaAppSecret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

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
  const detailText =
    detail && typeof detail === 'object' ? JSON.stringify(detail) : detail ? String(detail) : null;

  try {
    await createFailure({
      reason: 'INVALID_SIGNATURE',
      phoneNumberId: null,
      providerMessageId: null,
      requestId,
      raw: rawPayload,
      error: `${reason}${detailText ? `: ${detailText}` : ''}`
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
    signatureHeaderPresent: !!req.get('x-hub-signature-256'),
    signaturePrefix: previewDigest(req.get('x-hub-signature-256')),
    expectedPrefix: detail && detail.expected ? previewDigest(detail.expected) : null,
    receivedPrefix: detail && detail.received ? previewDigest(detail.received) : null,
    expectedLength: detail && Number.isInteger(detail.expectedLength) ? detail.expectedLength : null,
    receivedLength: detail && Number.isInteger(detail.receivedLength) ? detail.receivedLength : null,
    signatureAlgorithm: detail && detail.signatureAlgorithm ? detail.signatureAlgorithm : null
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
  const signatureAlgorithm = signatureHeader.includes('=') ? signatureHeader.split('=')[0] : null;
  if (!signatureHeader.startsWith('sha256=')) {
    return rejectInvalidSignature(req, res, 'missing_or_malformed_header', {
      signatureAlgorithm
    });
  }

  const rawBody =
    Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!rawBody.length) {
    return rejectInvalidSignature(req, res, 'missing_raw_body');
  }

  const providedSignature = signatureHeader;
  if (!/^sha256=[a-f0-9]+$/i.test(providedSignature)) {
    return rejectInvalidSignature(req, res, 'malformed_digest', {
      signatureAlgorithm,
      received: providedSignature,
      receivedLength: providedSignature.length
    });
  }

  const expectedSignature = buildExpectedSignature(rawBody);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');

  const isValid =
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!isValid) {
    return rejectInvalidSignature(req, res, 'invalid_digest', {
      signatureAlgorithm,
      expected: expectedSignature,
      received: providedSignature,
      expectedLength: expectedSignature.length,
      receivedLength: providedSignature.length
    });
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

