const crypto = require('crypto');
const env = require('../config/env');

const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';
const MAX_DIAGNOSTIC_STRING_LENGTH = 500;
const MAX_RESPONSE_SUMMARY_LENGTH = 2000;
const MAX_DIAGNOSTIC_DEPTH = 4;
const MAX_DIAGNOSTIC_KEYS = 40;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 12;

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
  return `${base}/checkout/return`;
}

function inferTokenKind(value) {
  const raw = normalizeString(value).toUpperCase();
  if (!raw) return 'missing';
  if (raw.startsWith('APP_USR')) return 'production';
  if (raw.startsWith('TEST')) return 'test';
  return 'unknown';
}

function shouldUseMercadoPagoStageScope() {
  return env.mercadoPagoEnvironment === 'test' && inferTokenKind(env.mercadoPagoAccessToken) !== 'production';
}

function maskEmail(value) {
  const email = normalizeString(value).toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  const visibleLocal = local.length <= 2 ? local[0] || '*' : `${local.slice(0, 2)}***`;
  return `${visibleLocal}@${domain}`;
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
  if (shouldUseMercadoPagoStageScope()) {
    headers['X-scope'] = 'stage';
  }
  return headers;
}

async function mercadoPagoFetch(path, init = {}, { includeHttpStatus = false } = {}) {
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
    const diagnostic = buildMercadoPagoErrorDiagnostic(response, json, text);
    const errorCode = classifyMercadoPagoErrorCode(response.status, diagnostic.body);
    const error = new Error(`mercadopago_request_failed_${response.status}`);
    error.code = errorCode;
    error.status = response.status;
    error.statusText = diagnostic.providerStatusText;
    error.body = diagnostic.body;
    error.providerDiagnostic = diagnostic;
    throw error;
  }

  return includeHttpStatus ? { data: json, httpStatus: response.status } : json;
}

function sanitizeMercadoPagoErrorBody(body) {
  return sanitizeMercadoPagoValue(body);
}

function sanitizeMercadoPagoRawBody(text) {
  const raw = normalizeString(text);
  if (!raw) return null;
  return sanitizeDiagnosticString(raw, MAX_RESPONSE_SUMMARY_LENGTH);
}

function sanitizeDiagnosticString(value, maxLength = MAX_DIAGNOSTIC_STRING_LENGTH) {
  let safe = String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:access[_-]?token|card[_-]?token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^,\s"'}]+/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe;
}

function isSensitiveDiagnosticKey(key) {
  return /(authorization|access[_-]?token|token|password|passwd|secret|cookie|card|payer|email|phone|address|document|identification|name)/i.test(String(key || ''));
}

function sanitizeMercadoPagoValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeDiagnosticString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS).map((item) => sanitizeMercadoPagoValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const safe = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_DIAGNOSTIC_KEYS)) {
      safe[key] = isSensitiveDiagnosticKey(key)
        ? '[REDACTED]'
        : sanitizeMercadoPagoValue(item, depth + 1);
    }
    return safe;
  }
  return sanitizeDiagnosticString(value);
}

function getResponseHeader(response, names) {
  for (const name of names) {
    const value = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get(name)
      : null;
    if (value) return sanitizeDiagnosticString(value, 200);
  }
  return null;
}

function buildMercadoPagoErrorDiagnostic(response, json, text) {
  const body = json !== null ? sanitizeMercadoPagoErrorBody(json) : sanitizeMercadoPagoRawBody(text);
  const summaryValue = json !== null ? body : sanitizeMercadoPagoRawBody(text);
  return {
    providerHttpStatus: Number(response && response.status) || null,
    providerStatusText: sanitizeDiagnosticString(response && response.statusText, 200) || null,
    providerError: json && typeof json === 'object' ? sanitizeDiagnosticString(json.error) || null : null,
    providerErrorCode: json && typeof json === 'object' ? sanitizeDiagnosticString(json.code) || null : null,
    providerErrorMessage: json && typeof json === 'object' ? sanitizeDiagnosticString(json.message) || null : null,
    providerErrorStatus: json && typeof json === 'object' ? sanitizeDiagnosticString(json.status) || null : null,
    providerCause: json && typeof json === 'object' ? sanitizeMercadoPagoValue(json.cause) : null,
    providerCauses: json && typeof json === 'object' ? sanitizeMercadoPagoValue(json.causes) : null,
    providerDetails: json && typeof json === 'object' ? sanitizeMercadoPagoValue(json.details) : null,
    providerResponseSummary: sanitizeDiagnosticString(
      typeof summaryValue === 'string' ? summaryValue : JSON.stringify(summaryValue),
      MAX_RESPONSE_SUMMARY_LENGTH
    ) || null,
    providerRequestId: getResponseHeader(response, ['x-request-id', 'x-correlation-id', 'x-meli-request-id']),
    body
  };
}

function sanitizeMercadoPagoUserBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body || null;
  return {
    id: body.id || null,
    nickname: normalizeString(body.nickname) || null,
    country_id: normalizeString(body.country_id) || null,
    site_id: normalizeString(body.site_id) || null,
    email: maskEmail(body.email),
    user_type: normalizeString(body.user_type) || null,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : [],
    status: body.status && typeof body.status === 'object'
      ? {
          site_status: normalizeString(body.status.site_status) || null,
          confirmed_email: Boolean(body.status.confirmed_email),
          mercadopago_account_type: normalizeString(body.status.mercadopago_account_type) || null
        }
      : null
  };
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

async function getMercadoPagoUserMe() {
  return mercadoPagoFetch('/users/me', {
    method: 'GET'
  });
}

function getMercadoPagoEnvDiagnostics() {
  const accessToken = normalizeString(env.mercadoPagoAccessToken);
  const publicKey = normalizeString(env.mercadoPagoPublicKey);
  const environment = normalizeString(env.mercadoPagoEnvironment).toLowerCase() || 'production';
  const tokenKind = inferTokenKind(accessToken);

  return {
    keysRead: {
      accessToken: 'MERCADO_PAGO_ACCESS_TOKEN',
      publicKey: 'MERCADO_PAGO_PUBLIC_KEY',
      environment: 'MERCADO_PAGO_ENVIRONMENT',
      aliasesSupported: []
    },
    token: {
      present: Boolean(accessToken),
      kind: tokenKind
    },
    publicKey: {
      present: Boolean(publicKey)
    },
    environment,
    xScopeStageEnabled: shouldUseMercadoPagoStageScope(),
    environmentMismatch: environment === 'test' && tokenKind === 'production',
    webhookUrl: getConfiguredWebhookUrl(),
    backUrl: getConfiguredBackUrl()
  };
}

async function runMercadoPagoAuthDiagnostics() {
  const envDiagnostics = getMercadoPagoEnvDiagnostics();

  const result = {
    mode: 'read_only',
    env: envDiagnostics,
    usersMe: null
  };

  try {
    const user = await getMercadoPagoUserMe();
    result.usersMe = {
      ok: true,
      status: 200,
      body: sanitizeMercadoPagoUserBody(user)
    };
  } catch (error) {
    result.usersMe = {
      ok: false,
      status: Number.isInteger(Number(error && error.status)) ? Number(error.status) : null,
      error: normalizeString(error && (error.code || error.message)) || 'mercadopago_users_me_failed',
      detail: error && error.message ? error.message : 'mercadopago_users_me_failed',
      body: sanitizeMercadoPagoErrorBody(error && error.body)
    };
    return result;
  }

  return result;
}

async function getPreapproval(preapprovalId, { signal, includeHttpStatus = false } = {}) {
  return mercadoPagoFetch(`/preapproval/${encodeURIComponent(preapprovalId)}`, {
    method: 'GET', signal
  }, { includeHttpStatus });
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
  return mercadoPagoFetch(`/preapproval/${encodeURIComponent(preapprovalId)}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'canceled' })
  }, { includeHttpStatus: true });
}

async function reactivatePreapproval(preapprovalId) {
  return updatePreapproval(preapprovalId, { status: 'pending' });
}

async function getPayment(paymentId, { signal } = {}) {
  return mercadoPagoFetch(`/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET', signal
  });
}

async function getAuthorizedPayment(invoiceId, { signal } = {}) {
  return mercadoPagoFetch(`/authorized_payments/${encodeURIComponent(invoiceId)}`, {
    method: 'GET', signal
  });
}

async function searchAuthorizedPaymentsByPaymentId(paymentId, { signal } = {}) {
  return mercadoPagoFetch(`/authorized_payments/search?payment_id=${encodeURIComponent(paymentId)}&offset=0&limit=2`, {
    method: 'GET', signal
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

function normalizeWebhookQueryDataId(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return /^[a-z0-9_-]+$/i.test(raw) ? raw.toLowerCase() : raw;
}

function buildWebhookManifest(req, ts) {
  const parts = [];
  const queryDataId = normalizeWebhookQueryDataId(req.query['data.id'] || req.query.id);
  const requestId = normalizeString(req.get('x-request-id'));

  if (queryDataId) {
    parts.push(`id:${queryDataId};`);
  }
  if (requestId) {
    parts.push(`request-id:${requestId};`);
  }
  if (ts) {
    parts.push(`ts:${ts};`);
  }

  return parts.join('');
}

const verifiedRequests = new WeakMap();
const verifiedContexts = new WeakSet();
function verifyWebhookSignature(req) {
  verifiedRequests.delete(req);
  if (!env.mercadoPagoWebhookSecret) return null;
  const header = req.get('x-signature');
  const requestId = req.get('x-request-id');
  const rawId = req.query?.['data.id'] ?? req.query?.id;
  if (typeof header !== 'string' || header.length > 256 || typeof requestId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId.trim()) || typeof rawId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(rawId.trim())) return false;
  const parts = header.split(',').map(x => x.trim().split('='));
  if (parts.length !== 2 || parts.some(x => x.length !== 2)
    || new Set(parts.map(x => x[0].trim())).size !== 2) return false;
  const fields = Object.fromEntries(parts.map(([k,v]) => [k.trim(),v.trim()]));
  if (!/^\d{1,16}$/.test(fields.ts || '') || !/^[0-9a-f]{64}$/.test(fields.v1 || '')) return false;
  const manifest = buildWebhookManifest(req, fields.ts);
  const expected = crypto.createHmac('sha256', env.mercadoPagoWebhookSecret).update(manifest).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(fields.v1))) return false;
  const context = Object.freeze({ manifest, resourceId: normalizeWebhookQueryDataId(rawId),
    requestId: requestId.trim(), timestamp: fields.ts });
  verifiedRequests.set(req, context); verifiedContexts.add(context);
  return true;
}
function getVerifiedWebhookContext(req) { return verifiedRequests.get(req) || null; }
function signedDeliveryIdentity(context) {
  if (!context || !verifiedContexts.has(context)) throw new Error('verified_delivery_context_required');
  return 'mp:delivery:v1:' + crypto.createHash('sha256')
    .update(JSON.stringify(['mercado_pago', 'delivery:v1', context.manifest]), 'utf8').digest('hex');
}
async function getPreapprovalPlan(id, { signal } = {}) {
  return mercadoPagoFetch('/preapproval_plan/' + encodeURIComponent(id), { method: 'GET', signal });
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
  getPreapprovalPlan,
  getVerifiedWebhookContext,
  signedDeliveryIdentity,
  updatePreapproval,
  pausePreapproval,
  cancelPreapproval,
  reactivatePreapproval,
  getPayment,
  getAuthorizedPayment,
  searchAuthorizedPaymentsByPaymentId,
  getMercadoPagoUserMe,
  getMercadoPagoEnvDiagnostics,
  runMercadoPagoAuthDiagnostics,
  verifyWebhookSignature,
  mapMercadoPagoPreapprovalStatus,
  mapMercadoPagoPaymentStatus,
  getConfiguredWebhookUrl,
  getConfiguredBackUrl
};
