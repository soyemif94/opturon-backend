const assert = require('assert');

const env = require('../../src/config/env');
const {
  buildExpectedSignature,
  getMetaAppSecrets,
  isSignatureValid
} = require('../../src/middlewares/verify-meta-signature.middleware');
const {
  exchangeOAuthCodeForAccessToken,
  fetchInstagramBusinessAssets
} = require('../../src/integrations/instagram/instagram.service');
const graphClient = require('../../src/whatsapp/whatsapp-graph.client');

async function testWebhookMultiSecret() {
  const previous = {
    whatsappAppSecret: env.whatsappAppSecret,
    metaAppSecret: env.metaAppSecret,
    instagramAppSecret: env.instagramAppSecret,
    instagramBusinessAppSecret: env.instagramBusinessAppSecret
  };
  env.whatsappAppSecret = '';
  env.metaAppSecret = 'whatsapp-secret';
  env.instagramAppSecret = 'instagram-secret';
  env.instagramBusinessAppSecret = 'instagram-business-secret';

  try {
    const body = Buffer.from('{"object":"instagram"}');
    const secrets = getMetaAppSecrets();
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'whatsapp-secret'), secrets), true);
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'instagram-secret'), secrets), true);
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'instagram-business-secret'), secrets), true);
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'invalid-secret'), secrets), false);

    env.whatsappAppSecret = 'whatsapp-secret';
    assert.deepEqual(getMetaAppSecrets(), ['whatsapp-secret', 'instagram-secret', 'instagram-business-secret']);
  } finally {
    Object.assign(env, previous);
  }
}

async function testInstagramExchangeCredentials() {
  const previousEnv = {
    instagramOauthProvider: env.instagramOauthProvider,
    instagramBusinessAppId: env.instagramBusinessAppId,
    instagramBusinessAppSecret: env.instagramBusinessAppSecret,
    instagramOauthAppId: env.instagramOauthAppId,
    instagramAppId: env.instagramAppId,
    instagramAppSecret: env.instagramAppSecret,
    metaAppId: env.metaAppId,
    metaAppSecret: env.metaAppSecret,
    whatsappAppId: env.whatsappAppId
  };
  const previousFetch = global.fetch;
  let requestedUrl = null;
  env.instagramOauthAppId = 'instagram-oauth-app-id';
  env.instagramOauthProvider = 'facebook_login';
  env.instagramAppId = 'instagram-app-id';
  env.instagramAppSecret = 'instagram-app-secret';
  env.metaAppId = 'legacy-app-id';
  env.metaAppSecret = 'legacy-app-secret';
  env.whatsappAppId = 'whatsapp-app-id';
  global.fetch = async (url) => {
    requestedUrl = new URL(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'safe-token' }) };
  };

  try {
    await exchangeOAuthCodeForAccessToken({ code: 'oauth-code', redirectUri: 'https://example.com/callback' });
    assert.equal(requestedUrl.searchParams.get('client_id'), 'instagram-oauth-app-id');
    assert.equal(requestedUrl.searchParams.get('client_secret'), 'instagram-app-secret');

    env.instagramOauthAppId = '';
    await exchangeOAuthCodeForAccessToken({ code: 'oauth-code', redirectUri: 'https://example.com/callback' });
    assert.equal(requestedUrl.searchParams.get('client_id'), 'instagram-app-id');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function testInstagramExchangeProviderOverride() {
  const previousEnv = {
    instagramOauthProvider: env.instagramOauthProvider,
    instagramBusinessAppId: env.instagramBusinessAppId,
    instagramBusinessAppSecret: env.instagramBusinessAppSecret,
    instagramOauthAppId: env.instagramOauthAppId,
    instagramAppSecret: env.instagramAppSecret
  };
  const previousFetch = global.fetch;
  const requests = [];
  env.instagramOauthProvider = 'facebook_login';
  env.instagramBusinessAppId = 'instagram-business-app-id';
  env.instagramBusinessAppSecret = 'instagram-business-app-secret';
  env.instagramOauthAppId = 'legacy-facebook-app-id';
  env.instagramAppSecret = 'legacy-instagram-app-secret';
  global.fetch = async (url, options) => {
    requests.push({ url: new URL(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(requests.length === 1
        ? { access_token: 'initial-token', user_id: 'ig-user-id' }
        : { access_token: 'long-lived-token', expires_in: 5184000, token_type: 'bearer' }),
      json: async () => (requests.length === 1
        ? { access_token: 'initial-token', user_id: 'ig-user-id' }
        : { access_token: 'long-lived-token', expires_in: 5184000, token_type: 'bearer' })
    };
  };

  try {
    const token = await exchangeOAuthCodeForAccessToken({
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback',
      providerOverride: 'instagram_login'
    });
    const body = new URLSearchParams(requests[0].options.body);
    assert.equal(requests[0].url.origin, 'https://api.instagram.com');
    assert.equal(body.get('client_id'), 'instagram-business-app-id');
    assert.equal(token.provider, 'instagram_login');
    assert.equal(token.accessToken, 'long-lived-token');
    assert.equal(requests[1].url.origin, 'https://graph.instagram.com');
    assert.equal(requests[1].url.pathname, '/access_token');
    assert.equal(requests[1].url.searchParams.get('grant_type'), 'ig_exchange_token');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function testInstagramLoginExchangeCredentials() {
  const previousEnv = {
    instagramOauthProvider: env.instagramOauthProvider,
    instagramBusinessAppId: env.instagramBusinessAppId,
    instagramBusinessAppSecret: env.instagramBusinessAppSecret,
    instagramAppSecret: env.instagramAppSecret
  };
  const previousFetch = global.fetch;
  const requests = [];
  env.instagramOauthProvider = 'instagram_login';
  env.instagramBusinessAppId = 'instagram-business-app-id';
  env.instagramBusinessAppSecret = 'instagram-business-app-secret';
  env.instagramAppSecret = 'legacy-instagram-secret';
  global.fetch = async (url, options) => {
    requests.push({ url: new URL(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(requests.length === 1
        ? { access_token: 'initial-token', user_id: 'ig-user-id' }
        : { access_token: 'long-lived-token', expires_in: 5184000, token_type: 'bearer' }),
      json: async () => (requests.length === 1
        ? { access_token: 'initial-token', user_id: 'ig-user-id' }
        : { access_token: 'long-lived-token', expires_in: 5184000, token_type: 'bearer' })
    };
  };

  try {
    const token = await exchangeOAuthCodeForAccessToken({
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback'
    });
    const body = new URLSearchParams(requests[0].options.body);
    assert.equal(requests[0].url.origin, 'https://api.instagram.com');
    assert.equal(requests[0].url.pathname, '/oauth/access_token');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(body.get('client_id'), 'instagram-business-app-id');
    assert.equal(body.get('client_secret'), 'instagram-business-app-secret');
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(requests[1].url.origin, 'https://graph.instagram.com');
    assert.equal(requests[1].url.pathname, '/access_token');
    assert.equal(requests[1].url.searchParams.get('grant_type'), 'ig_exchange_token');
    assert.equal(requests[1].url.searchParams.get('access_token'), 'initial-token');
    assert.equal(token.accessToken, 'long-lived-token');
    assert.equal(token.userId, 'ig-user-id');
    assert.equal(token.provider, 'instagram_login');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function testInstagramExchangeRejectsUnknownProviderOverride() {
  const previousEnv = {
    instagramOauthProvider: env.instagramOauthProvider
  };

  try {
    env.instagramOauthProvider = 'facebook_login';
    await assert.rejects(
      () => exchangeOAuthCodeForAccessToken({
        code: 'oauth-code',
        redirectUri: 'https://example.com/callback',
        providerOverride: 'evil_provider'
      }),
      (error) => error && error.reason === 'invalid_instagram_oauth_provider'
    );
  } finally {
    Object.assign(env, previousEnv);
  }
}

async function testInstagramLoginDiscoveryUsesWebhookUserId() {
  const previousEnv = {
    instagramOauthProvider: env.instagramOauthProvider
  };
  const previousFetch = global.fetch;
  let requestUrl = null;
  env.instagramOauthProvider = 'instagram_login';
  global.fetch = async (url) => {
    requestUrl = new URL(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'graph-id', user_id: 'webhook-user-id', username: 'opturon.agency' })
    };
  };

  try {
    const assets = await fetchInstagramBusinessAssets({
      accessToken: 'safe-token',
      providerOverride: 'instagram_login'
    });
    assert.equal(requestUrl.origin, 'https://graph.instagram.com');
    assert.equal(requestUrl.searchParams.get('fields'), 'id,user_id,username');
    assert.equal(assets.length, 1);
    assert.equal(assets[0].pageId, 'webhook-user-id');
    assert.equal(assets[0].instagramBusinessAccountId, 'webhook-user-id');
    assert.equal(assets[0].instagramUsername, 'opturon.agency');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function testInstagramLoginDiscoveryFallsBackToOauthUserId() {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'graph-id', username: 'opturon.agency' })
  });

  try {
    const assets = await fetchInstagramBusinessAssets({
      accessToken: 'safe-token',
      userId: 'oauth-user-id',
      providerOverride: 'instagram_login'
    });
    assert.equal(assets[0].pageId, 'oauth-user-id');
    assert.equal(assets[0].instagramBusinessAccountId, 'oauth-user-id');
  } finally {
    global.fetch = previousFetch;
  }
}

async function testInstagramLoginDiscoveryFallsBackToGraphId() {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'graph-id', username: 'opturon.agency' })
  });

  try {
    const assets = await fetchInstagramBusinessAssets({
      accessToken: 'safe-token',
      providerOverride: 'instagram_login'
    });
    assert.equal(assets[0].pageId, 'graph-id');
    assert.equal(assets[0].instagramBusinessAccountId, 'graph-id');
  } finally {
    global.fetch = previousFetch;
  }
}

async function testFacebookLoginDiscoveryRegression() {
  const previousRequest = graphClient.request;
  let request = null;
  graphClient.request = async (method, path, options) => {
    request = { method, path, options };
    return {
      ok: true,
      data: {
        data: [{
          id: 'facebook-page-id',
          name: 'Opturon Page',
          access_token: 'page-token',
          instagram_business_account: { id: 'instagram-business-id', username: 'opturon.agency' }
        }]
      }
    };
  };

  try {
    const assets = await fetchInstagramBusinessAssets({
      accessToken: 'safe-token',
      providerOverride: 'facebook_login'
    });
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/me/accounts');
    assert.equal(request.options.query.fields, 'id,name,access_token,instagram_business_account{id,username,name}');
    assert.equal(assets[0].pageId, 'facebook-page-id');
    assert.equal(assets[0].instagramBusinessAccountId, 'instagram-business-id');
  } finally {
    graphClient.request = previousRequest;
  }
}

async function run() {
  await testWebhookMultiSecret();
  await testInstagramExchangeCredentials();
  await testInstagramExchangeProviderOverride();
  await testInstagramLoginExchangeCredentials();
  await testInstagramExchangeRejectsUnknownProviderOverride();
  await testInstagramLoginDiscoveryUsesWebhookUserId();
  await testInstagramLoginDiscoveryFallsBackToOauthUserId();
  await testInstagramLoginDiscoveryFallsBackToGraphId();
  await testFacebookLoginDiscoveryRegression();
  console.log('meta-multi-app.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
