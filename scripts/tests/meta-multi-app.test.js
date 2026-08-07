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
  let request = null;
  env.instagramOauthProvider = 'facebook_login';
  env.instagramBusinessAppId = 'instagram-business-app-id';
  env.instagramBusinessAppSecret = 'instagram-business-app-secret';
  env.instagramOauthAppId = 'legacy-facebook-app-id';
  env.instagramAppSecret = 'legacy-instagram-app-secret';
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'safe-token', user_id: 'ig-user-id' })
    };
  };

  try {
    const token = await exchangeOAuthCodeForAccessToken({
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback',
      providerOverride: 'instagram_login'
    });
    const body = new URLSearchParams(request.options.body);
    assert.equal(request.url.origin, 'https://api.instagram.com');
    assert.equal(body.get('client_id'), 'instagram-business-app-id');
    assert.equal(token.provider, 'instagram_login');
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
  let request = null;
  env.instagramOauthProvider = 'instagram_login';
  env.instagramBusinessAppId = 'instagram-business-app-id';
  env.instagramBusinessAppSecret = 'instagram-business-app-secret';
  env.instagramAppSecret = 'legacy-instagram-secret';
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'safe-token', user_id: 'ig-user-id' })
    };
  };

  try {
    const token = await exchangeOAuthCodeForAccessToken({
      code: 'oauth-code',
      redirectUri: 'https://example.com/callback'
    });
    const body = new URLSearchParams(request.options.body);
    assert.equal(request.url.origin, 'https://api.instagram.com');
    assert.equal(request.url.pathname, '/oauth/access_token');
    assert.equal(request.options.method, 'POST');
    assert.equal(body.get('client_id'), 'instagram-business-app-id');
    assert.equal(body.get('client_secret'), 'instagram-business-app-secret');
    assert.equal(body.get('grant_type'), 'authorization_code');
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

async function testInstagramLoginDiscoveryRequestsIdField() {
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
      json: async () => ({ id: 'ig-user-id', username: 'opturon.agency' })
    };
  };

  try {
    const assets = await fetchInstagramBusinessAssets({
      accessToken: 'safe-token',
      providerOverride: 'instagram_login'
    });
    assert.equal(requestUrl.origin, 'https://graph.instagram.com');
    assert.equal(requestUrl.searchParams.get('fields'), 'id,username');
    assert.equal(assets.length, 1);
    assert.equal(assets[0].instagramBusinessAccountId, 'ig-user-id');
    assert.equal(assets[0].instagramUsername, 'opturon.agency');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function run() {
  await testWebhookMultiSecret();
  await testInstagramExchangeCredentials();
  await testInstagramExchangeProviderOverride();
  await testInstagramLoginExchangeCredentials();
  await testInstagramExchangeRejectsUnknownProviderOverride();
  await testInstagramLoginDiscoveryRequestsIdField();
  console.log('meta-multi-app.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
