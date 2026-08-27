const assert = require('assert');
const path = require('path');

const env = require(path.resolve(__dirname, '..', '..', 'src/config/env.js'));
const modulePath = path.resolve(__dirname, '..', '..', 'src/services/instagram-direct-exchange-diagnostic.service.js');
const instagramServicePath = path.resolve(__dirname, '..', '..', 'src/integrations/instagram/instagram.service.js');

const originalFetch = global.fetch;
const originalClientId = env.instagramBusinessAppId;
const originalClientSecret = env.instagramBusinessAppSecret;
const originalInstagramAppSecret = env.instagramAppSecret;

async function run() {
  env.instagramBusinessAppId = '1349038906605969';
  env.instagramBusinessAppSecret = 'diagnostic-test-secret';
  delete require.cache[modulePath];
  const diagnostic = require(modulePath);

  let request = null;
  global.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'provider-token-never-returned', user_id: '28349497618013118' })
    };
  };

  const success = await diagnostic.runInstagramDirectExchangeDiagnostic({ code: 'fresh-test-code' });
  assert.equal(success.httpStatus, 200);
  assert.equal(success.tokenExchange, 'PASS');
  assert.equal(success.userIdPresent, true);
  assert.equal(success.accessTokenPresent, true);
  assert.equal(Object.prototype.hasOwnProperty.call(success, 'access_token'), false);
  assert.equal(request.url, 'https://api.instagram.com/oauth/access_token');
  assert.equal(request.init.method, 'POST');
  assert.ok(request.init.body instanceof FormData);
  assert.equal(request.init.body.get('client_id'), '1349038906605969');
  assert.equal(request.init.body.get('client_secret'), 'diagnostic-test-secret');
  assert.equal(request.init.body.get('grant_type'), 'authorization_code');
  assert.equal(request.init.body.get('redirect_uri'), diagnostic.DIAGNOSTIC_REDIRECT_URI);
  assert.equal(request.init.body.get('code'), 'fresh-test-code');

  const instagramService = require(instagramServicePath);
  const savedBusinessSecret = env.instagramBusinessAppSecret;
  env.instagramBusinessAppSecret = '';
  env.instagramAppSecret = 'production-fallback-test-secret';
  assert.equal(instagramService.resolveInstagramBusinessLoginCredentials().clientSecret, 'production-fallback-test-secret');
  env.instagramBusinessAppSecret = savedBusinessSecret;
  env.instagramAppSecret = '';

  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { type: 'OAuthException', code: 400, message: 'code=fresh-test-code secret=diagnostic-test-secret' } })
  });
  const failure = await diagnostic.runInstagramDirectExchangeDiagnostic({ code: 'fresh-test-code' });
  assert.equal(failure.tokenExchange, 'FAIL');
  assert.equal(failure.providerErrorType, 'OAuthException');
  assert.equal(failure.providerErrorCode, '400');
  assert.doesNotMatch(failure.providerErrorMessage, /fresh-test-code|diagnostic-test-secret/);

  global.fetch = async () => { throw new Error('fetch must not run'); };
  const noCode = await diagnostic.runInstagramDirectExchangeDiagnostic({});
  assert.equal(noCode.tokenExchange, 'FAIL');
  assert.equal(noCode.providerErrorMessage, 'missing_authorization_code');

  const source = require('fs').readFileSync(modulePath, 'utf8');
  const instagramSource = require('fs').readFileSync(instagramServicePath, 'utf8');
  const routeSource = require('fs').readFileSync(path.resolve(__dirname, '..', '..', 'src/routes/portal.routes.js'), 'utf8');
  assert.match(source, /resolveInstagramBusinessLoginCredentials/);
  assert.match(instagramSource, /instagramBusinessAppSecret \|\| env\.instagramAppSecret/);
  assert.doesNotMatch(source, /exchangeOAuthCodeForAccessToken|require\(['"].*repository|logInfo|logWarn|INSERT|UPDATE|DELETE/);
  assert.match(routeSource, /router\.post\('\/instagram\/debug-direct-exchange', requirePortalInternalAuth, postPortalInstagramDirectExchangeDiagnostic\)/);
  console.log('instagram-direct-exchange-diagnostic.test.js: ok');
}

run().finally(() => {
  global.fetch = originalFetch;
  env.instagramBusinessAppId = originalClientId;
  env.instagramBusinessAppSecret = originalClientSecret;
  env.instagramAppSecret = originalInstagramAppSecret;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
