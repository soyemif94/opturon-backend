const assert = require('assert');

const env = require('../../src/config/env');
const {
  buildExpectedSignature,
  getMetaAppSecrets,
  isSignatureValid
} = require('../../src/middlewares/verify-meta-signature.middleware');
const { exchangeOAuthCodeForAccessToken } = require('../../src/integrations/instagram/instagram.service');

async function testWebhookMultiSecret() {
  const previous = {
    whatsappAppSecret: env.whatsappAppSecret,
    metaAppSecret: env.metaAppSecret,
    instagramAppSecret: env.instagramAppSecret
  };
  env.whatsappAppSecret = '';
  env.metaAppSecret = 'whatsapp-secret';
  env.instagramAppSecret = 'instagram-secret';

  try {
    const body = Buffer.from('{"object":"instagram"}');
    const secrets = getMetaAppSecrets();
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'whatsapp-secret'), secrets), true);
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'instagram-secret'), secrets), true);
    assert.equal(isSignatureValid(body, buildExpectedSignature(body, 'invalid-secret'), secrets), false);

    env.whatsappAppSecret = 'whatsapp-secret';
    assert.deepEqual(getMetaAppSecrets(), ['whatsapp-secret', 'instagram-secret']);
  } finally {
    Object.assign(env, previous);
  }
}

async function testInstagramExchangeCredentials() {
  const previousEnv = {
    instagramAppId: env.instagramAppId,
    instagramAppSecret: env.instagramAppSecret,
    metaAppId: env.metaAppId,
    metaAppSecret: env.metaAppSecret,
    whatsappAppId: env.whatsappAppId
  };
  const previousFetch = global.fetch;
  let requestedUrl = null;
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
    assert.equal(requestedUrl.searchParams.get('client_id'), 'instagram-app-id');
    assert.equal(requestedUrl.searchParams.get('client_secret'), 'instagram-app-secret');
  } finally {
    global.fetch = previousFetch;
    Object.assign(env, previousEnv);
  }
}

async function run() {
  await testWebhookMultiSecret();
  await testInstagramExchangeCredentials();
  console.log('meta-multi-app.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
