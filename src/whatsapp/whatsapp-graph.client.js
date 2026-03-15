const env = require('../config/env');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const GRAPH_API_VERSION = String(env.getWhatsAppGraphVersion()).trim();

function buildGraphUrl(path, query = null, apiVersion = null) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  const version = String(apiVersion || GRAPH_API_VERSION).trim();
  const url = new URL(`https://graph.facebook.com/${version}${normalizedPath}`);

  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(String(key), String(value));
      }
    });
  }

  return url.toString();
}

function buildMessagesEndpointUrl(phoneNumberId, apiVersion = null) {
  const safePhoneNumberId = String(phoneNumberId || '').trim();
  if (!safePhoneNumberId) {
    throw new Error('Missing WhatsApp phoneNumberId for Graph messages endpoint');
  }

  return buildGraphUrl(`/${safePhoneNumberId}/messages`, null, apiVersion);
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return null;

  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;

  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reduceRawBody(rawBody, maxChars = 2000) {
  const body = String(rawBody || '');
  return body.length > maxChars ? `${body.slice(0, maxChars)}...[truncated]` : body;
}

function classifyGraphError(status) {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 400) return 'bad_request';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'unknown';
}

function toPlainHeaders(headers) {
  if (!headers || typeof headers.forEach !== 'function') return {};
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseGraphErrorFields(data) {
  const error = data && data.error ? data.error : null;
  return {
    fbtrace_id: error && error.fbtrace_id ? error.fbtrace_id : null,
    error_subcode: error && error.error_subcode ? error.error_subcode : null,
    error_code: error && error.code ? error.code : null,
    error_message: error && error.message ? error.message : null
  };
}

function normalizeToDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function resolveLegacyAccessToken(credentials = null) {
  const credentialToken =
    credentials && credentials.accessToken ? String(credentials.accessToken).trim() : '';
  const envToken = String(env.whatsappAccessToken || '').trim();

  const accessToken = credentialToken || envToken;
  if (!accessToken) {
    throw new Error('Missing WhatsApp access token');
  }

  return {
    accessToken,
    authSource: credentialToken ? 'credentials' : 'env'
  };
}

function resolveScopedAccessToken(credentials = null) {
  const accessToken =
    credentials && credentials.accessToken ? String(credentials.accessToken).trim() : '';

  if (!accessToken) {
    throw new Error('Missing WhatsApp channel access token');
  }

  return {
    accessToken,
    authSource: 'channel_scoped'
  };
}

function resolveLegacyPhoneNumberId(credentials = null, explicitPhoneNumberId = null) {
  const phoneNumberId =
    (credentials && credentials.phoneNumberId && String(credentials.phoneNumberId).trim()) ||
    (explicitPhoneNumberId ? String(explicitPhoneNumberId).trim() : '') ||
    String(env.whatsappPhoneNumberId || '').trim();

  if (!phoneNumberId) {
    throw new Error('Missing WhatsApp phoneNumberId');
  }

  return phoneNumberId;
}

function resolveScopedPhoneNumberId(credentials = null, explicitPhoneNumberId = null) {
  const phoneNumberId =
    (credentials && credentials.phoneNumberId && String(credentials.phoneNumberId).trim()) ||
    (explicitPhoneNumberId ? String(explicitPhoneNumberId).trim() : '');

  if (!phoneNumberId) {
    throw new Error('Missing WhatsApp channel phoneNumberId');
  }

  return phoneNumberId;
}

function extractFbTraceIdFromRaw(rawBody) {
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : null;
    return parsed && parsed.error && parsed.error.fbtrace_id ? parsed.error.fbtrace_id : null;
  } catch (error) {
    return null;
  }
}

async function sendTextMessageViaGraphInternal({
  phoneNumberId,
  to,
  text,
  requestId = null,
  credentials = null,
  mode = 'legacy_global'
}) {
  const normalizedPhoneNumberId =
    mode === 'channel_scoped'
      ? resolveScopedPhoneNumberId(credentials, phoneNumberId)
      : resolveLegacyPhoneNumberId(credentials, phoneNumberId);
  const { accessToken, authSource } =
    mode === 'channel_scoped'
      ? resolveScopedAccessToken(credentials)
      : resolveLegacyAccessToken(credentials);
  const normalizedTo = normalizeToDigits(to);
  const messageText = String(text || '').trim();
  const toLast4 = normalizedTo ? normalizedTo.slice(-4) : null;
  const toLen = normalizedTo ? normalizedTo.length : 0;

  if (!/^\d{8,15}$/.test(normalizedTo)) {
    throw new Error('Invalid "to". Expected E164 digits only (8..15).');
  }

  if (!messageText) {
    throw new Error('text is required.');
  }

  const url = buildMessagesEndpointUrl(normalizedPhoneNumberId, GRAPH_API_VERSION);
  console.log('WA_GRAPH_SEND', {
    phoneNumberId: normalizedPhoneNumberId,
    url,
    to: normalizedTo
  });
  logInfo('graph_request_prepare', {
    requestId,
    method: 'POST',
    phoneNumberId: normalizedPhoneNumberId,
    authSource,
    toLast4,
    toLen,
    graphVersion: GRAPH_API_VERSION
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizedTo,
      type: 'text',
      text: { body: messageText }
    })
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (error) {
    parsed = null;
  }
  const fbtrace_id = extractFbTraceIdFromRaw(raw);

  return {
    ok: response.ok,
    status: response.status,
    raw,
    json: parsed,
    fbtrace_id
  };
}

async function sendTemplateMessageViaGraphInternal({
  phoneNumberId,
  to,
  templateName,
  languageCode = 'es',
  components = [],
  requestId = null,
  credentials = null,
  mode = 'legacy_global'
}) {
  const normalizedPhoneNumberId =
    mode === 'channel_scoped'
      ? resolveScopedPhoneNumberId(credentials, phoneNumberId)
      : resolveLegacyPhoneNumberId(credentials, phoneNumberId);
  const { accessToken, authSource } =
    mode === 'channel_scoped'
      ? resolveScopedAccessToken(credentials)
      : resolveLegacyAccessToken(credentials);
  const normalizedTo = normalizeToDigits(to);
  const normalizedTemplateName = String(templateName || '').trim();
  const normalizedLanguageCode = String(languageCode || 'es').trim() || 'es';
  const toLast4 = normalizedTo ? normalizedTo.slice(-4) : null;
  const toLen = normalizedTo ? normalizedTo.length : 0;

  if (!/^\d{8,15}$/.test(normalizedTo)) {
    throw new Error('Invalid "to". Expected E164 digits only (8..15).');
  }

  if (!normalizedTemplateName) {
    throw new Error('templateName is required.');
  }

  const body = {
    messaging_product: 'whatsapp',
    to: normalizedTo,
    type: 'template',
    template: {
      name: normalizedTemplateName,
      language: { code: normalizedLanguageCode }
    }
  };
  if (Array.isArray(components) && components.length > 0) {
    body.template.components = components;
  }

  const url = buildMessagesEndpointUrl(normalizedPhoneNumberId, GRAPH_API_VERSION);
  console.log('WA_GRAPH_TEMPLATE_SEND', {
    phoneNumberId: normalizedPhoneNumberId,
    url,
    to: normalizedTo
  });
  logInfo('graph_request_prepare', {
    requestId,
    method: 'POST',
    phoneNumberId: normalizedPhoneNumberId,
    authSource,
    toLast4,
    toLen,
    graphVersion: GRAPH_API_VERSION
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (error) {
    parsed = null;
  }
  const fbtrace_id = extractFbTraceIdFromRaw(raw);

  return {
    ok: response.ok,
    status: response.status,
    raw,
    json: parsed,
    fbtrace_id
  };
}

async function sendTextMessageViaGraphScoped(options) {
  return sendTextMessageViaGraphInternal({
    ...(options || {}),
    mode: 'channel_scoped'
  });
}

async function sendTextMessageViaGraphLegacy(options) {
  return sendTextMessageViaGraphInternal({
    ...(options || {}),
    mode: 'legacy_global'
  });
}

async function sendTemplateMessageViaGraphScoped(options) {
  return sendTemplateMessageViaGraphInternal({
    ...(options || {}),
    mode: 'channel_scoped'
  });
}

async function sendTemplateMessageViaGraphLegacy(options) {
  return sendTemplateMessageViaGraphInternal({
    ...(options || {}),
    mode: 'legacy_global'
  });
}

async function request(method, path, options = {}) {
  const requestId = options.requestId || null;
  const query = options.query || null;
  const body = options.body === undefined ? null : options.body;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const credentials = options.credentials || null;
  const tokenResolution = resolveAccessToken(
    credentials ||
      (options.accessToken
        ? {
            accessToken: options.accessToken,
            phoneNumberId: options.phoneNumberId || null
          }
        : null)
  );
  const accessToken = tokenResolution.accessToken;
  const authSource = tokenResolution.authSource;
  const apiVersion = String(
    options.apiVersion || GRAPH_API_VERSION
  ).trim();

  const url = buildGraphUrl(path, query, apiVersion);
  const graphPath = new URL(url).pathname + new URL(url).search;
  const isMessagesEndpoint = /\/messages(\?|$)/.test(graphPath);
  const pathPhoneNumberId = isMessagesEndpoint ? graphPath.split('/').filter(Boolean).slice(-2, -1)[0] || null : null;
  const phoneNumberId = pathPhoneNumberId || (credentials && credentials.phoneNumberId ? String(credentials.phoneNumberId).trim() : null);
  const to = body && typeof body === 'object' ? body.to || null : null;
  const toLast4 = to ? String(to).slice(-4) : null;
  const toLen = to ? String(to).length : 0;

  let attempt = 0;
  while (attempt <= maxRetries) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logInfo('graph_request_prepare', {
        requestId,
        method,
        phoneNumberId,
        authSource,
        toLast4,
        toLen,
        graphVersion: apiVersion
      });

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);

      const rawBody = await response.text();
      let data = null;
      try {
        data = rawBody ? JSON.parse(rawBody) : null;
      } catch (parseError) {
        data = null;
      }

      const durationMs = Date.now() - startedAt;
      const status = response.status;
      const errFields = parseGraphErrorFields(data);

      logInfo('graph_call', {
        event: 'graph_call',
        requestId,
        method,
        url,
        path: graphPath,
        phoneNumberId,
        to,
        status,
        durationMs,
        fbtrace_id: errFields.fbtrace_id,
        error_subcode: errFields.error_subcode,
        tokenLen: accessToken.length
      });

      if (response.ok) {
        return {
          ok: true,
          status,
          data,
          headers: toPlainHeaders(response.headers),
          durationMs,
          graphPath,
          fbtrace_id: errFields.fbtrace_id,
          error_subcode: errFields.error_subcode
        };
      }

      const category = classifyGraphError(status);
      const retryAfterMs = parseRetryAfterMs(response.headers);

      logWarn('graph_call_failed', {
        event: 'graph_call',
        requestId,
        method,
        url,
        path: graphPath,
        phoneNumberId,
        to,
        status,
        durationMs,
        fbtrace_id: errFields.fbtrace_id,
        error_subcode: errFields.error_subcode,
        graphErrorCode: errFields.error_code,
        graphErrorSubcode: errFields.error_subcode,
        graphErrorMessage: errFields.error_message,
        errorCategory: category,
        rawGraphErrorBody: reduceRawBody(rawBody),
        tokenLen: accessToken.length
      });

      const retryable = RETRYABLE_STATUSES.has(status);
      if (retryable && attempt < maxRetries) {
        const backoffMs = retryAfterMs !== null ? retryAfterMs : 400 * Math.pow(2, attempt);
        await wait(backoffMs);
        attempt += 1;
        continue;
      }

      return {
        ok: false,
        status,
        data,
        headers: toPlainHeaders(response.headers),
        durationMs,
        graphPath,
        fbtrace_id: errFields.fbtrace_id,
        error_subcode: errFields.error_subcode,
        error_code: errFields.error_code,
        errorCategory: category
      };
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      logWarn('graph_call_exception', {
        event: 'graph_call',
        requestId,
        method,
        url,
        path: graphPath,
        phoneNumberId,
        to,
        status: null,
        durationMs,
        error: error.message,
        tokenLen: accessToken.length
      });

      if (attempt < maxRetries) {
        const backoffMs = 400 * Math.pow(2, attempt);
        await wait(backoffMs);
        attempt += 1;
        continue;
      }

      return {
        ok: false,
        status: null,
        data: null,
        headers: {},
        durationMs,
        graphPath,
        fbtrace_id: null,
        error_subcode: null,
        error_code: null,
        errorCategory: 'transient',
        exception: error
      };
    }
  }

  return {
    ok: false,
    status: null,
    data: null,
    headers: {},
    durationMs: null,
    graphPath,
    fbtrace_id: null,
    error_subcode: null,
    error_code: null,
    errorCategory: 'unknown'
  };
}

function resolveAccessToken(credentials = null) {
  return resolveLegacyAccessToken(credentials);
}

async function sendTextMessageViaGraph(options) {
  return sendTextMessageViaGraphLegacy(options);
}

async function sendTemplateMessageViaGraph(options) {
  return sendTemplateMessageViaGraphLegacy(options);
}

module.exports = {
  request,
  buildGraphUrl,
  buildMessagesEndpointUrl,
  classifyGraphError,
  sendTextMessageViaGraph,
  sendTextMessageViaGraphScoped,
  sendTextMessageViaGraphLegacy,
  sendTemplateMessageViaGraph,
  sendTemplateMessageViaGraphScoped,
  sendTemplateMessageViaGraphLegacy
};
