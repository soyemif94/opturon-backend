const { verifyWebhookSignature } = require('../services/mercado-pago.service');
const { processMercadoPagoWebhook } = require('../services/saas-billing.service');
const { logError, logInfo, logWarn } = require('../utils/logger');

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
  const signatureValid = verifyWebhookSignature(req);
  let payload = {};

  try {
    payload = normalizePayload(req);
  } catch (error) {
    logWarn('mercado_pago_webhook_invalid_json', {
      requestId: req.requestId || null,
      error: error.message
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
      signatureValid
    });

    logInfo('mercado_pago_webhook_processed', {
      requestId: req.requestId || null,
      topic,
      action,
      resourceId,
      duplicate: result.duplicate === true,
      ignored: result.ignored === true,
      subscriptionId: result.subscription ? result.subscription.id : null,
      signatureValid
    });

    return res.status(200).json({
      success: true,
      duplicate: result.duplicate === true,
      ignored: result.ignored === true
    });
  } catch (error) {
    logError('mercado_pago_webhook_failed', {
      requestId: req.requestId || null,
      topic: String(payload.type || payload.topic || '').trim().toLowerCase() || null,
      action: String(payload.action || '').trim().toLowerCase() || null,
      resourceId:
        String(
          (payload.data && payload.data.id) ||
          payload.resource_id ||
          payload.resource ||
          ''
        ).trim() || null,
      signatureValid,
      error: error.message
    });
    return res.status(200).json({ success: true, error: error.message });
  }
}

module.exports = {
  postMercadoPagoWebhook
};
