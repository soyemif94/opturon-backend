const env = require('../../config/env');
const graphClient = require('../../whatsapp/whatsapp-graph.client');
const { logInfo, logWarn } = require('../../utils/logger');
const crypto = require('crypto');

const DEFAULT_GRAPH_VERSION = String(env.getWhatsAppGraphVersion()).trim();

function normalizeInstagramOauthProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'instagram_login' || normalized === 'facebook_login') {
    return normalized;
  }
  return null;
}

function getInstagramOauthProvider(providerOverride = null) {
  if (providerOverride !== null && providerOverride !== undefined && String(providerOverride).trim() !== '') {
    const normalizedOverride = normalizeInstagramOauthProvider(providerOverride);
    if (!normalizedOverride) {
      const error = new Error('invalid_instagram_oauth_provider');
      error.reason = 'invalid_instagram_oauth_provider';
      throw error;
    }
    return normalizedOverride;
  }

  return normalizeInstagramOauthProvider(env.instagramOauthProvider) || 'facebook_login';
}

function buildOAuthError(result, fallbackReason) {
  const error = new Error(
    (result && result.data && result.data.error && result.data.error.message) || fallbackReason
  );
  error.reason = fallbackReason;
  error.graphStatus = result && result.status ? result.status : null;
  error.body = result && result.data ? result.data : null;
  return error;
}

function normalizeProviderErrorValue(value, maxLength = 1000) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function sanitizeProviderErrorMessage(value) {
  const normalized = normalizeProviderErrorValue(value);
  if (!normalized) return null;
  return normalized.replace(
    /\b(?:authorization[_ -]?code|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|state)\s*[=:]\s*[^\s&,]+/gi,
    '[REDACTED]'
  );
}

function summarizeInstagramOAuthExchangeFailure({ response, json, requestId = null }) {
  const nestedError = json && typeof json === 'object' && json.error && typeof json.error === 'object'
    ? json.error
    : null;
  const providerError = nestedError || (json && typeof json === 'object' ? json : {});
  const contentType = response && response.headers && typeof response.headers.get === 'function'
    ? normalizeProviderErrorValue(response.headers.get('content-type'), 200)
    : null;

  return {
    stage: 'instagram_oauth_token_exchange',
    requestId: requestId || null,
    providerHttpStatus: response && Number.isFinite(Number(response.status)) ? Number(response.status) : null,
    providerErrorType: normalizeProviderErrorValue(providerError.type || providerError.error_type, 200),
    providerErrorCode: normalizeProviderErrorValue(providerError.code || providerError.error_code, 100),
    providerErrorSubcode: normalizeProviderErrorValue(providerError.error_subcode || providerError.subcode, 100),
    providerErrorMessage: sanitizeProviderErrorMessage(
      providerError.message || providerError.error_message || (typeof json === 'string' ? json : null)
    ),
    responseContentType: contentType
  };
}

function summarizeInstagramMessageSendFailure({
  response,
  json,
  requestId = null,
  channelId = null,
  recipientId = null,
  providerEndpoint = null
}) {
  const providerError = json && typeof json === 'object' && json.error && typeof json.error === 'object'
    ? json.error
    : {};

  return {
    requestId: requestId || null,
    correlationId: requestId || null,
    channelId: channelId || null,
    provider: 'instagram',
    recipientIgsid: recipientId || null,
    providerEndpoint: providerEndpoint || null,
    providerHttpStatus: response && Number.isFinite(Number(response.status)) ? Number(response.status) : null,
    providerErrorType: normalizeProviderErrorValue(providerError.type, 200),
    providerErrorCode: normalizeProviderErrorValue(providerError.code, 100),
    providerErrorSubcode: normalizeProviderErrorValue(providerError.error_subcode, 100),
    providerErrorMessage: sanitizeProviderErrorMessage(providerError.message),
    providerFbtraceId: normalizeProviderErrorValue(providerError.fbtrace_id, 200)
  };
}

function logInstagramOAuthCodeTelemetry(stage, code, { requestId = null, correlationId = null } = {}) {
  const safeCode = String(code || '');
  logInfo('instagram_oauth_code_telemetry', {
    stage,
    requestId: requestId || null,
    correlationId: correlationId || null,
    length: Buffer.byteLength(safeCode, 'utf8'),
    sha256: crypto.createHash('sha256').update(safeCode, 'utf8').digest('hex')
  });
}

function resolveInstagramBusinessLoginCredentials() {
  return {
    clientId: String(env.instagramBusinessAppId || '').trim(),
    clientSecret: String(env.instagramBusinessAppSecret || env.instagramAppSecret || '').trim()
  };
}

async function exchangeOAuthCodeForAccessToken({ code, redirectUri, providerOverride = null, requestId = null, codeTelemetryId = null }) {
  const provider = getInstagramOauthProvider(providerOverride);
  const businessCredentials = resolveInstagramBusinessLoginCredentials();
  const appId = String(provider === 'instagram_login'
    ? businessCredentials.clientId
    : env.instagramOauthAppId || env.instagramAppId || env.metaAppId || env.whatsappAppId || '').trim();
  const appSecret = String(provider === 'instagram_login'
    ? businessCredentials.clientSecret
    : env.instagramAppSecret || env.metaAppSecret || '').trim();

  if (!appId || !appSecret) {
    const error = new Error('meta_instagram_credentials_missing');
    error.reason = 'meta_instagram_credentials_missing';
    throw error;
  }

  const url = new URL(provider === 'instagram_login'
    ? 'https://api.instagram.com/oauth/access_token'
    : `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/oauth/access_token`);
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const formData = new FormData();
  if (provider === 'instagram_login') {
    formData.set('client_id', appId);
    formData.set('client_secret', appSecret);
    formData.set('grant_type', 'authorization_code');
    formData.set('redirect_uri', redirectUri);
    formData.set('code', code);
  } else {
    for (const [key, value] of params) url.searchParams.set(key, value);
  }

  logInstagramOAuthCodeTelemetry('TOKEN_EXCHANGE', code, {
    requestId,
    correlationId: codeTelemetryId
  });

  logInfo('instagram_oauth_exchange_started', {
    requestId,
    redirectUri
  });

  const response = await fetch(url.toString(), {
    method: provider === 'instagram_login' ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json'
    },
    ...(provider === 'instagram_login' ? { body: formData } : {})
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json || !json.access_token) {
    logWarn('instagram_oauth_token_exchange_failed', summarizeInstagramOAuthExchangeFailure({
      response,
      json,
      requestId
    }));
    const error = new Error((json && json.error && json.error.message) || 'instagram_oauth_exchange_failed');
    error.reason = 'instagram_oauth_exchange_failed';
    error.status = response.status;
    error.body = json;
    throw error;
  }

  return {
    accessToken: String(json.access_token).trim(),
    tokenType: String(json.token_type || '').trim() || null,
    expiresIn: Number.isFinite(Number(json.expires_in)) ? Number(json.expires_in) : null,
    userId: String(json.user_id || '').trim() || null,
    provider,
    raw: json
  };
}

async function fetchInstagramBusinessAssets({ accessToken, userId = null, providerOverride = null, requestId = null }) {
  if (getInstagramOauthProvider(providerOverride) === 'instagram_login') {
    const url = new URL(`https://graph.instagram.com/${DEFAULT_GRAPH_VERSION}/me`);
    url.searchParams.set('fields', 'id,username');
    url.searchParams.set('access_token', accessToken);
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    const json = await response.json().catch(() => null);
    const instagramUserId = String((json && (json.user_id || json.id)) || userId || '').trim();
    if (!response.ok || !instagramUserId) {
      const error = new Error((json && json.error && json.error.message) || 'instagram_business_account_not_found');
      error.reason = response.ok ? 'instagram_business_account_not_found' : 'instagram_profile_lookup_failed';
      error.status = response.status;
      throw error;
    }
    return [{
      pageId: instagramUserId,
      pageName: String(json && json.username ? json.username : '').trim() || null,
      pageAccessToken: accessToken,
      instagramBusinessAccountId: instagramUserId,
      instagramUsername: String(json && json.username ? json.username : '').trim() || null
    }];
  }
  const result = await graphClient.request('GET', '/me/accounts', {
    accessToken,
    requestId,
    apiVersion: DEFAULT_GRAPH_VERSION,
    query: {
      fields: 'id,name,access_token,instagram_business_account{id,username,name}'
    }
  });

  if (!result.ok) {
    throw buildOAuthError(result, 'instagram_pages_lookup_failed');
  }

  const pages = Array.isArray(result.data && result.data.data) ? result.data.data : [];
  const normalizedPages = pages
    .map((page) => {
      const instagramBusinessAccount =
        page && page.instagram_business_account && typeof page.instagram_business_account === 'object'
          ? page.instagram_business_account
          : null;

      return {
        pageId: String(page && page.id ? page.id : '').trim() || null,
        pageName: String(page && page.name ? page.name : '').trim() || null,
        pageAccessToken: String(page && page.access_token ? page.access_token : '').trim() || null,
        instagramBusinessAccountId:
          String(
            instagramBusinessAccount && instagramBusinessAccount.id ? instagramBusinessAccount.id : ''
          ).trim() || null,
        instagramUsername:
          String(
            instagramBusinessAccount &&
            (instagramBusinessAccount.username || instagramBusinessAccount.name)
              ? instagramBusinessAccount.username || instagramBusinessAccount.name
              : ''
          ).trim() || null
      };
    })
    .filter((page) => page.pageId && page.pageAccessToken && page.instagramBusinessAccountId);

  if (!normalizedPages.length) {
    const error = new Error('instagram_business_account_not_found');
    error.reason = 'instagram_business_account_not_found';
    throw error;
  }

  return normalizedPages;
}

async function subscribePageToWebhook({ pageId, accessToken, providerOverride = null, requestId = null }) {
  if (getInstagramOauthProvider(providerOverride) === 'instagram_login') {
    const url = new URL(`https://graph.instagram.com/${DEFAULT_GRAPH_VERSION}/${pageId}/subscribed_apps`);
    url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks');
    url.searchParams.set('access_token', accessToken);
    const response = await fetch(url.toString(), { method: 'POST', headers: { Accept: 'application/json' } });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((json && json.error && json.error.message) || 'instagram_page_subscription_failed');
      error.reason = 'instagram_page_subscription_failed';
      error.status = response.status;
      throw error;
    }
    return { ok: true, response: json };
  }
  const result = await graphClient.request('POST', `/${pageId}/subscribed_apps`, {
    accessToken,
    requestId,
    apiVersion: DEFAULT_GRAPH_VERSION,
    body: {
      subscribed_fields: 'messages,messaging_postbacks'
    }
  });

  if (!result.ok) {
    logWarn('instagram_page_subscription_failed', {
      requestId,
      pageId,
      status: result.status || null,
      body: result.data || null
    });
    throw buildOAuthError(result, 'instagram_page_subscription_failed');
  }

  return {
    ok: true,
    response: result.data || null
  };
}

function resolveInstagramMessagingHost(channel) {
  const metadata = channel && channel.connectionMetadata && typeof channel.connectionMetadata === 'object'
    ? channel.connectionMetadata
    : {};
  if (metadata.oauthProvider === 'instagram_login') return 'graph.instagram.com';
  if (metadata.oauthProvider === 'facebook_login') return 'graph.facebook.com';

  // Connections created by Instagram Login use the Instagram account itself as
  // both the external/page identity. Existing Facebook Login channels retain a
  // distinct Page id and continue using graph.facebook.com.
  return String(channel && channel.externalPageId || '').trim() &&
    String(channel && channel.externalPageId || '').trim() !== String(channel && channel.instagramUserId || '').trim()
    ? 'graph.facebook.com'
    : 'graph.instagram.com';
}

async function sendInstagramTextMessage({ channel, recipientId, text, requestId = null, fetchImpl = fetch }) {
  const accessToken = String(channel && channel.accessToken || '').trim();
  const senderId = String(channel && (channel.instagramUserId || channel.externalId) || '').trim();
  const safeRecipientId = String(recipientId || '').trim();
  const safeText = String(text || '').trim();
  if (!accessToken) throw Object.assign(new Error('instagram_channel_missing_credentials'), { reason: 'instagram_channel_missing_credentials' });
  if (!senderId || !safeRecipientId || !safeText) throw Object.assign(new Error('instagram_message_invalid_input'), { reason: 'instagram_message_invalid_input' });

  const host = resolveInstagramMessagingHost(channel);
  const url = new URL(`https://${host}/${DEFAULT_GRAPH_VERSION}/${senderId}/messages`);
  const providerEndpoint = `https://${host}/${DEFAULT_GRAPH_VERSION}/:instagramAccountId/messages`;
  url.searchParams.set('access_token', accessToken);
  const body = JSON.stringify({ recipient: { id: safeRecipientId }, message: { text: safeText } });
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body
      });
      const json = await response.json().catch(() => null);
      const messageId = String(json && (json.message_id || json.id) || '').trim();
      if (response.ok && messageId) return { messageId, raw: json };

      if (!response.ok) {
        logWarn('instagram_message_send_provider_error', summarizeInstagramMessageSendFailure({
          response,
          json,
          requestId,
          channelId: channel && channel.id ? channel.id : null,
          recipientId: safeRecipientId,
          providerEndpoint
        }));
      }

      const reason = String(json && json.error && json.error.message || 'instagram_message_send_failed');
      const error = Object.assign(new Error(reason), {
        reason: 'instagram_message_send_failed',
        status: response.status,
        graphCode: json && json.error ? json.error.code || null : null
      });
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      if (error && error.reason === 'instagram_message_send_failed' && error.status && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
  }

  logWarn('instagram_message_send_failed', {
    requestId,
    channelId: channel && channel.id ? channel.id : null,
    status: lastError && lastError.status ? lastError.status : null,
    graphCode: lastError && lastError.graphCode ? lastError.graphCode : null
  });
  throw lastError || Object.assign(new Error('instagram_message_send_failed'), { reason: 'instagram_message_send_failed' });
}

module.exports = {
  getInstagramOauthProvider,
  resolveInstagramBusinessLoginCredentials,
  logInstagramOAuthCodeTelemetry,
  exchangeOAuthCodeForAccessToken,
  fetchInstagramBusinessAssets,
  subscribePageToWebhook,
  resolveInstagramMessagingHost,
  sendInstagramTextMessage
};
