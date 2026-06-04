const crypto = require('crypto');
const env = require('../config/env');

const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';

function normalizeString(value) {
  return String(value || '').trim();
}

function getConfiguredWebhookUrl() {
  const base = normalizeString(env.opturonApiPublicUrl).replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/webhooks/mercadopago`;
}

function getConfiguredBackUrl() {
  const base = normalizeString(env.opturonPublicAppUrl).replace(/\/$/, '');
  if (!base) return null;
  return `${base}/login`;
}

function assertMercadoPagoConfigured() {
  if (!env.mercadoPagoAccessToken) {
    const error = new Error('mercado_pago_not_configured');
    error.status = 500;
    throw error;
  }
}

function buildMercadoPagoHeaders(extraHeaders = {}) {
  assertMercadoPagoConfigured();
  const headers = {
    Authorization: `Bearer ${env.mercadoPagoAccessToken}`,
    'Content-Type': 'application/json',
    ...extraHeaders
  };
  if (env.mercadoPagoEnvironment === 'test') {
    headers['X-scope'] = 'stage';
  }
  return headers;
}

async function mercadoPagoFetch(path, init = {}) {
  const response = await fetch(`${MERCADO_PAGO_API_BASE}${path}`, {
    ...init,
    headers: buildMercadoPagoHeaders(init.headers || {})
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(json?.message || json?.error || `mercado_pago_request_failed_${response.status}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }

  return json;
}

function buildCreatePreapprovalPayload(input) {
  const payload = {
    reason: input.reason,
    external_reference: input.externalReference,
    payer_email: input.payerEmail,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: Number(input.amount),
      currency_id: input.currency || 'ARS'
    },
    status: 'authorized'
  };

  const backUrl = getConfiguredBackUrl();
  if (backUrl) {
    payload.back_url = backUrl;
  }

  const webhookUrl = getConfiguredWebhookUrl();
  if (webhookUrl) {
    payload.notification_url = webhookUrl;
  }

  return payload;
}

async function createPreapproval(input) {
  return mercadoPagoFetch('/preapproval', {
    method: 'POST',
    body: JSON.stringify(buildCreatePreapprovalPayload(input))
  });
}

async function getPreapproval(preapprovalId) {
  return mercadoPagoFetch(`/preapproval/${encodeURIComponent(preapprovalId)}`, {
    method: 'GET'
  });
}

async function updatePreapproval(preapprovalId, payload) {
  return mercadoPagoFetch(`/preapproval/${encodeURIComponent(preapprovalId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload || {})
  });
}

async function pausePreapproval(preapprovalId) {
  return updatePreapproval(preapprovalId, { status: 'paused' });
}

async function cancelPreapproval(preapprovalId) {
  return updatePreapproval(preapprovalId, { status: 'canceled' });
}

async function reactivatePreapproval(preapprovalId) {
  return updatePreapproval(preapprovalId, { status: 'authorized' });
}

async function getPayment(paymentId) {
  return mercadoPagoFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET'
  });
}

function parseSignatureHeader(headerValue) {
  const raw = normalizeString(headerValue);
  if (!raw) return { ts: null, v1: null };
  return raw.split(',').reduce(
    (acc, chunk) => {
      const [key, value] = String(chunk).split('=');
      const safeKey = normalizeString(key).toLowerCase();
      const safeValue = normalizeString(value);
      if (safeKey === 'ts') acc.ts = safeValue;
      if (safeKey === 'v1') acc.v1 = safeValue;
      return acc;
    },
    { ts: null, v1: null }
  );
}

function buildWebhookManifest(req, ts) {
  const queryDataId = normalizeString(req.query['data.id'] || req.query.id);
  const requestId = normalizeString(req.get('x-request-id'));
  return `id:${queryDataId};request-id:${requestId};ts:${ts};`;
}

function verifyWebhookSignature(req) {
  if (!env.mercadoPagoWebhookSecret) {
    return null;
  }

  const { ts, v1 } = parseSignatureHeader(req.get('x-signature'));
  if (!ts || !v1) return false;

  const manifest = buildWebhookManifest(req, ts);
  const expected = crypto
    .createHmac('sha256', env.mercadoPagoWebhookSecret)
    .update(manifest)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(v1);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function mapMercadoPagoPreapprovalStatus(status) {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === 'authorized' || normalized === 'active') return 'active';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'canceled';
  if (normalized === 'pending') return 'pending';
  if (
    normalized === 'payment_in_process' ||
    normalized === 'payment_method_change_required' ||
    normalized === 'payment_required'
  ) {
    return 'payment_failed';
  }
  if (normalized === 'ended' || normalized === 'finished') return 'canceled';
  if (normalized === 'suspended') return 'suspended';
  return 'pending';
}

function mapMercadoPagoPaymentStatus(status) {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === 'approved') return 'active';
  if (normalized === 'authorized' || normalized === 'in_process' || normalized === 'pending') return 'pending';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'rejected' || normalized === 'refunded') {
    return 'payment_failed';
  }
  return 'pending';
}

module.exports = {
  createPreapproval,
  getPreapproval,
  updatePreapproval,
  pausePreapproval,
  cancelPreapproval,
  reactivatePreapproval,
  getPayment,
  verifyWebhookSignature,
  mapMercadoPagoPreapprovalStatus,
  mapMercadoPagoPaymentStatus,
  getConfiguredWebhookUrl,
  getConfiguredBackUrl
};
