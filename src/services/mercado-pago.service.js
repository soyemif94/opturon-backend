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
    error.code = 'billing_subscription_env_missing';
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const sanitizedBody = sanitizeMercadoPagoErrorBody(json);
    const errorCode = classifyMercadoPagoErrorCode(response.status, sanitizedBody);
    const detail = buildMercadoPagoErrorDetail(response.status, sanitizedBody, text);
    const error = new Error(detail);
    error.code = errorCode;
    error.status = response.status;
    error.body = sanitizedBody || sanitizeMercadoPagoRawBody(text);
    throw error;
  }

  return json;
}

function sanitizeMercadoPagoErrorBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body || null;
  const safe = {};
  for (const [key, value] of Object.entries(body)) {
    const normalizedKey = String(key || '').toLowerCase();
    if (
      normalizedKey.includes('token') ||
      normalizedKey.includes('access_token') ||
      normalizedKey.includes('card_token') ||
      normalizedKey.includes('security')
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      safe[key] = value.map((item) => sanitizeMercadoPagoErrorBody(item) || item);
      continue;
    }
    if (value && typeof value === 'object') {
      safe[key] = sanitizeMercadoPagoErrorBody(value);
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function sanitizeMercadoPagoRawBody(text) {
  const raw = normalizeString(text);
  if (!raw) return null;
  return raw.slice(0, 500);
}

function extractMercadoPagoCause(body) {
  if (!body || typeof body !== 'object') return '';

  const parts = [];
  const message = normalizeString(body.message);
  const error = normalizeString(body.error);
  const detail = normalizeString(body.detail);

  if (message) parts.push(message);
  if (error && error !== message) parts.push(error);
  if (detail && detail !== message && detail !== error) parts.push(detail);

  if (Array.isArray(body.cause)) {
    for (const cause of body.cause) {
      if (!cause || typeof cause !== 'object') continue;
      const causeDescription = normalizeString(cause.description || cause.message || cause.code);
      if (causeDescription) parts.push(causeDescription);
    }
  }

  return parts.filter(Boolean).join(' | ');
}

function classifyMercadoPagoErrorCode(status, body) {
  if (status === 401 || status === 403) {
    return 'mercadopago_credentials_invalid';
  }

  if (status === 400 || status === 404 || status === 422) {
    return 'mercadopago_invalid_payload';
  }

  return 'mercadopago_preapproval_failed';
}

function buildMercadoPagoErrorDetail(status, body, rawText) {
  const safeCause = extractMercadoPagoCause(body) || sanitizeMercadoPagoRawBody(rawText);
  if (safeCause) {
    return `mercadopago_request_failed_${status}: ${safeCause}`;
  }
  return `mercadopago_request_failed_${status}`;
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
    status: 'pending'
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
  return updatePreapproval(preapprovalId, { status: 'pending' });
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
