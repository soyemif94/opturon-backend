const env = require('../../config/env');
const graphClient = require('../../whatsapp/whatsapp-graph.client');
const { logInfo, logWarn } = require('../../utils/logger');

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

async function exchangeOAuthCodeForAccessToken({ code, redirectUri, providerOverride = null, requestId = null }) {
  const provider = getInstagramOauthProvider(providerOverride);
  const appId = String(provider === 'instagram_login'
    ? env.instagramBusinessAppId
    : env.instagramOauthAppId || env.instagramAppId || env.metaAppId || env.whatsappAppId || '').trim();
  const appSecret = String(provider === 'instagram_login'
    ? env.instagramBusinessAppSecret || env.instagramAppSecret
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
  if (provider === 'instagram_login') params.set('grant_type', 'authorization_code');
  else for (const [key, value] of params) url.searchParams.set(key, value);

  logInfo('instagram_oauth_exchange_started', {
    requestId,
    redirectUri
  });

  const response = await fetch(url.toString(), {
    method: provider === 'instagram_login' ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      ...(provider === 'instagram_login' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    },
    ...(provider === 'instagram_login' ? { body: params } : {})
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json || !json.access_token) {
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

module.exports = {
  getInstagramOauthProvider,
  exchangeOAuthCodeForAccessToken,
  fetchInstagramBusinessAssets,
  subscribePageToWebhook
};
