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

function maskValuePrefix(value, visible = 7) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return raw.slice(0, visible);
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
      prefix: maskValuePrefix(accessToken),
      length: accessToken.length || 0,
      kind: tokenKind
    },
    publicKey: {
      present: Boolean(publicKey),
      prefix: maskValuePrefix(publicKey),
      length: publicKey.length || 0
    },
    environment,
    xScopeStageEnabled: shouldUseMercadoPagoStageScope(),
    environmentMismatch: environment === 'test' && tokenKind === 'production',
    webhookUrl: getConfiguredWebhookUrl(),
    backUrl: getConfiguredBackUrl()
  };
}

async function runMercadoPagoAuthDiagnostics(options = {}) {
  const planCode = normalizeString(options.planCode) || 'crecimiento';
  const amount = Number(options.amount);
  const currency = normalizeString(options.currency).toUpperCase() || 'ARS';
  const payerEmail = normalizeString(options.payerEmail);
  const tenantId = normalizeString(options.tenantId) || 'mp-auth-diag';
  const envDiagnostics = getMercadoPagoEnvDiagnostics();

  const result = {
    env: envDiagnostics,
    usersMe: null,
    preapproval: null
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

  if (!payerEmail || !Number.isFinite(amount) || amount <= 0) {
    return result;
  }

  const payload = buildCreatePreapprovalPayload({
    reason: `Opturon ${planCode || 'crecimiento'} - ${tenantId}`,
    externalReference: `mp-diag:${tenantId}:${Date.now()}`,
    payerEmail,
    amount,
    currency
  });

  result.preapproval = {
    attempted: true,
    payload
  };

  try {
    const created = await mercadoPagoFetch('/preapproval', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    result.preapproval = {
      ...result.preapproval,
      ok: true,
      status: 201,
      body: sanitizeMercadoPagoErrorBody(created)
    };
  } catch (error) {
    result.preapproval = {
      ...result.preapproval,
      ok: false,
      status: Number.isInteger(Number(error && error.status)) ? Number(error.status) : null,
      error: normalizeString(error && (error.code || error.message)) || 'mercadopago_preapproval_failed',
      detail: error && error.message ? error.message : 'mercadopago_preapproval_failed',
      body: sanitizeMercadoPagoErrorBody(error && error.body)
    };
  }

  if (
    result.usersMe &&
    result.usersMe.ok &&
    result.preapproval &&
    result.preapproval.ok === false &&
    result.preapproval.status === 403 &&
    result.preapproval.body &&
    typeof result.preapproval.body === 'object' &&
    result.preapproval.body.code === 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES'
  ) {
    result.analysis = {
      rootCause: envDiagnostics.environmentMismatch
        ? 'production_token_with_test_stage_scope'
        : 'mercadopago_policy_unauthorized_for_preapproval',
      message: envDiagnostics.environmentMismatch
        ? 'Production token detected with MERCADO_PAGO_ENVIRONMENT=test. Backend was sending X-scope: stage to Mercado Pago.'
        : 'Mercado Pago authenticated the token on /users/me but rejected /preapproval by policy.'
    };
  }

  return result;
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

function verifyWebhookSignature(req) {
  if (!env.mercadoPagoWebhookSecret) {
    return null;
  }

  const { ts, v1 } = parseSignatureHeader(req.get('x-signature'));
  if (!ts || !v1) return false;

  const manifest = buildWebhookManifest(req, ts);
  if (!manifest) {
    return false;
  }
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
  getMercadoPagoUserMe,
  getMercadoPagoEnvDiagnostics,
  runMercadoPagoAuthDiagnostics,
  verifyWebhookSignature,
  mapMercadoPagoPreapprovalStatus,
  mapMercadoPagoPaymentStatus,
  getConfiguredWebhookUrl,
  getConfiguredBackUrl
};
