const { verifyWebhookSignature, getVerifiedWebhookContext } = require('../services/mercado-pago.service');
const { processMercadoPagoWebhook } = require('../services/saas-billing.service');
const { logError, logInfo, logWarn } = require('../utils/logger');

function logWebhook(logger, event, fields) {
  // Observability must not change an auth decision or a committed result.
  try { logger(event, fields); } catch { /* The durable event is authoritative. */ }
}

function retryableFailure(res) {
  return res.status(503).json({ success: false, error: 'webhook_processing_failed' });
}

function normalizePayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf-8');
    return text ? JSON.parse(text) : {};
  }

  return {};
}

async function postMercadoPagoWebhook(req, res) {
  let signatureValid = null;

  try {
    signatureValid = verifyWebhookSignature(req);
  } catch {
    logWebhook(logError, 'mercado_pago_webhook_signature_error', {
      requestId: req.requestId || req.get('x-request-id') || null,
      outcome: 'REJECTED_AUTH'
    });
    return res.status(401).json({ success: false, error: 'webhook_signature_invalid' });
  }

  if (signatureValid !== true) {
    const signatureHeader = String(req.get('x-signature') || '').trim();
    const logEvent = signatureHeader
      ? signatureValid === null
        ? 'mercado_pago_webhook_signature_error'
        : 'mercado_pago_webhook_signature_invalid'
      : 'mercado_pago_webhook_signature_missing';

    logWebhook(logWarn, logEvent, {
      requestId: req.requestId || req.get('x-request-id') || null,
      signatureValid,
      outcome: 'REJECTED_AUTH'
    });
    return res.status(401).json({ success: false, error: 'webhook_signature_invalid' });
  }

  logWebhook(logInfo, 'mercado_pago_webhook_signature_valid', {
    requestId: req.requestId || req.get('x-request-id') || null,
    signatureValid: true
  });

  let payload = {};

  try {
    payload = normalizePayload(req);
  } catch {
    logWebhook(logWarn, 'mercado_pago_webhook_invalid_json', {
      requestId: req.requestId || null,
      outcome: 'PERMANENT_NON_RETRYABLE_FAILURE'
    });
    return res.status(200).json({ success: true, ignored: true, error: 'invalid_json' });
  }

  try {
    const topic = String(payload.type || payload.topic || '').trim().toLowerCase() || null;
    const action = String(payload.action || '').trim().toLowerCase() || null;
    const resourceId =
      String(
        (payload.data && payload.data.id) ||
        payload.resource_id ||
        payload.resource ||
        ''
      ).trim() || null;
    const result = await processMercadoPagoWebhook(payload, {
      requestId: req.requestId || req.get('x-request-id') || null,
      signatureValid,
      verifiedDelivery: getVerifiedWebhookContext(req)
    });

    if (!result || result.ok !== true) {
      logWebhook(logError, 'mercado_pago_webhook_retryable_failure', {
        requestId: req.requestId || null, outcome: 'RETRYABLE_PROCESSING_FAILURE'
      });
      return retryableFailure(res);
    }

    const outcome = ['CONTRACT_REJECTED', 'MANUAL_REVIEW'].includes(result.outcome) ? result.outcome
      : result.duplicate ? 'ALREADY_PROCESSED'
      : result.ignored ? 'IGNORED_UNSUPPORTED_EVENT' : 'PROCESSED_SUCCESSFULLY';
    logWebhook(logInfo, 'mercado_pago_webhook_processed', {
      requestId: req.requestId || null,
      topic,
      action,
      resourceId,
      duplicate: result.duplicate === true,
      ignored: result.ignored === true,
      subscriptionId: result.subscription ? result.subscription.id : null,
      outcome,
      signatureValid
    });

    return res.status(200).json({
      success: true,
      duplicate: result.duplicate === true,
      ignored: result.ignored === true,
      ...(['CONTRACT_REJECTED', 'MANUAL_REVIEW'].includes(result.outcome)
        ? { outcome: result.outcome } : {})
    });
  } catch {
    logWebhook(logError, 'mercado_pago_webhook_retryable_failure', {
      requestId: req.requestId || null,
      signatureValid,
      outcome: 'RETRYABLE_PROCESSING_FAILURE'
    });
    return retryableFailure(res);
  }
}

module.exports = {
  postMercadoPagoWebhook
};
