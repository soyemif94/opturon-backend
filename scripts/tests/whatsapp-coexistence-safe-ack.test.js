const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const modulePath = (relativePath) => path.join(rootDir, relativePath);
const mockModule = (relativePath, exportsValue) => {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsValue };
};

async function run() {
  let persisted = 0;
  let persistedInput = null;
  let debugStored = 0;
  let inboundProcessed = 0;
  let echoResult = { failed: 1 };
  const logs = [];
  mockModule('src/db/client.js', { withTransaction: async (fn) => fn({}) });
  mockModule('src/config/env.js', { verifySignature: false });
  mockModule('src/repositories/webhook-event.repository.js', {
    insertWebhookEvent: async (input) => { persisted += 1; persistedInput = input; return { id: 'webhook-1', eventType: input.eventType }; }
  });
  mockModule('src/conversations/conversation.service.js', {
    processInboundMessages: async () => { inboundProcessed += 1; return {}; }
  });
  mockModule('src/debug/webhook-store.js', {
    pushWebhookEvent: () => { debugStored += 1; }
  });
  mockModule('src/debug/inbox-store.js', { pushInboxItem: () => {} });
  mockModule('src/utils/logger.js', {
    logInfo: (event, data) => logs.push({ event, data }),
    logWarn: () => {},
    logError: () => {}
  });
  mockModule('src/conversations/smb-message-echo.service.js', {
    processSmbMessageEchoes: async () => echoResult
  });
  mockModule('src/services/order-customer-notification-status.service.js', {
    reconcileOrderCustomerNotificationStatuses: async () => { throw new Error('unexpected_status_processing'); }
  });

  const { handleWebhook } = require(modulePath('src/controllers/webhook.controller.js'));
  for (const field of ['history', 'smb_app_state_sync']) {
    let statusCode = null;
    let responseBody = null;
    const req = {
      requestId: `request-${field}`,
      body: {
        object: 'whatsapp_business_account',
        entry: [{ id: 'waba-safe', changes: [{ field, value: { ignored: true } }] }]
      },
      get: () => null
    };
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return body; }
    };
    await handleWebhook(req, res);
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(responseBody.ignored, 1, 'unsigned coexistence payloads are acknowledged but not persisted');
    assert.strictEqual(responseBody.enqueued, 0);
  }

  assert.strictEqual(persisted, 0, 'deferred payload must not be persisted');
  assert.strictEqual(debugStored, 0, 'deferred payload must not enter the debug raw store');
  assert.strictEqual(inboundProcessed, 0, 'deferred payload must not reach bot/inbound processing');
  assert.strictEqual(
    logs.filter((entry) => entry.event === 'whatsapp_coexistence_webhook_acknowledged').length,
    2
  );

  let echoStatusCode = null;
  let echoResponse = null;
  const privateBody = 'PRIVATE_ECHO_BODY_MUST_NOT_BE_RETAINED';
  const echoPayload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-a', changes: [{ field: 'smb_message_echoes', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-a', display_phone_number: '+54 11 8888 0000' },
      message_echoes: [{ id: 'wamid.echo-failed', timestamp: '1789990000', from: '541188880000', to: '5492911111111', type: 'text', text: { body: privateBody } }]
    } }] }]
  };
  await handleWebhook({
    requestId: 'request-echo-failed',
    body: echoPayload,
    metaSignatureValid: true,
    get: () => null
  }, {
    status(code) { echoStatusCode = code; return this; },
    json(body) { echoResponse = body; return body; }
  });
  assert.strictEqual(echoStatusCode, 503, 'failed echo persistence must ask Meta to retry');
  assert.strictEqual(echoResponse.error, 'whatsapp_echo_persist_failed');
  assert.strictEqual(persisted, 1);
  assert.ok(!JSON.stringify(persistedInput.raw).includes(privateBody), 'generic webhook diagnostics must not retain echo text');
  assert.ok(!JSON.stringify(persistedInput.raw).includes('message_echoes'), 'generic webhook diagnostics must omit echo payloads');
  assert.strictEqual(inboundProcessed, 0, 'failed echo request must not be processed as customer inbound');
  assert.equal(echoResult.failed, 1);
  console.log('whatsapp-coexistence-safe-ack.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
