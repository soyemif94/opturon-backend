const test = require('node:test');
const assert = require('node:assert/strict');

test('transition provider preflight uses only read-only Graph GETs and returns sanitized readiness facts', async (t) => {
  const envPath = require.resolve('../../src/config/env');
  const graphPath = require.resolve('../../src/whatsapp/whatsapp-graph.client');
  const readerPath = require.resolve('../../src/whatsapp/whatsapp-transition-provider-readiness');
  const oldEnv = require.cache[envPath];
  const oldGraph = require.cache[graphPath];
  const oldReader = require.cache[readerPath];
  const secret = 'DO_NOT_RETURN_APP_SECRET';
  const calls = [];
  const required = ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'];
  require.cache[envPath] = {
    id: envPath, filename: envPath, loaded: true,
    exports: {
      whatsappAppId: 'controlled-app', metaAppSecret: secret,
      opturonApiPublicUrl: 'https://api.example.test', getWhatsAppGraphVersion: () => 'v25.0'
    }
  };
  require.cache[graphPath] = {
    id: graphPath, filename: graphPath, loaded: true,
    exports: {
      request: async (method, path, options) => {
        calls.push({ method, path, hasAccessToken: Boolean(options && options.accessToken) });
        if (path === '/waba-controlled/phone_numbers') return {
          ok: true, status: 200, data: { data: [{ id: 'phone-old', display_phone_number: '+54 9 11 8888 8810' }] }
        };
        if (path === '/phone-old') return {
          ok: true, status: 200, data: { is_on_biz_app: false, platform_type: 'CLOUD_API' }
        };
        if (path === '/waba-controlled/subscribed_apps') return {
          ok: true, status: 200, data: { data: [{ whatsapp_business_api_data: { id: 'controlled-app' } }] }
        };
        if (path === '/controlled-app/subscriptions') return {
          ok: true, status: 200, data: { data: [{
            object: 'whatsapp_business_account', active: true,
            callback_url: 'https://api.example.test/webhook', fields: required
          }] }
        };
        return { ok: false, status: 404, data: null };
      }
    }
  };
  delete require.cache[readerPath];
  t.after(() => {
    if (oldEnv) require.cache[envPath] = oldEnv;
    else delete require.cache[envPath];
    if (oldGraph) require.cache[graphPath] = oldGraph;
    else delete require.cache[graphPath];
    if (oldReader) require.cache[readerPath] = oldReader;
    else delete require.cache[readerPath];
  });

  const { readWhatsAppTransitionProviderEvidence } = require(readerPath);
  const evidence = await readWhatsAppTransitionProviderEvidence({
    wabaId: 'waba-controlled', phoneNumberId: 'phone-old', accessToken: 'DO_NOT_RETURN_ACCESS_TOKEN'
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.ready, true);
  assert.equal(evidence.appSubscribed, true);
  assert.equal(evidence.callbackUrlMatches, true);
  assert.deepEqual(evidence.missingWebhookFields, []);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.equal(calls.length, 4);
  assert.ok(!JSON.stringify(evidence).includes(secret));
  assert.ok(!JSON.stringify(evidence).includes('DO_NOT_RETURN_ACCESS_TOKEN'));
  assert.ok(calls.every((call) => call.hasAccessToken));
  assert.ok(!JSON.stringify(calls).includes(secret));
});

console.log('whatsapp-transition-provider-readiness.test.js passed');
