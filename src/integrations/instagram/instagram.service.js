const env = require('../../config/env');
const graphClient = require('../../whatsapp/whatsapp-graph.client');
const { logInfo, logWarn } = require('../../utils/logger');

const DEFAULT_GRAPH_VERSION = String(env.getWhatsAppGraphVersion()).trim();

function buildOAuthError(result, fallbackReason) {
  const error = new Error(
    (result && result.data && result.data.error && result.data.error.message) || fallbackReason
  );
  error.reason = fallbackReason;
  error.graphStatus = result && result.status ? result.status : null;
  error.body = result && result.data ? result.data : null;
  return error;
}

async function exchangeOAuthCodeForAccessToken({ code, redirectUri, requestId = null }) {
  const appId = String(env.whatsappAppId || '').trim();
  const appSecret = String(env.metaAppSecret || '').trim();

  if (!appId || !appSecret) {
    const error = new Error('meta_instagram_credentials_missing');
    error.reason = 'meta_instagram_credentials_missing';
    throw error;
  }

  const url = new URL(`https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  logInfo('instagram_oauth_exchange_started', {
    requestId,
    redirectUri
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' }
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
    raw: json
  };
}

async function fetchInstagramBusinessAssets({ accessToken, requestId = null }) {
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

async function subscribePageToWebhook({ pageId, accessToken, requestId = null }) {
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
  exchangeOAuthCodeForAccessToken,
  fetchInstagramBusinessAssets,
  subscribePageToWebhook
};
