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
  let debugStored = 0;
  let inboundProcessed = 0;
  const logs = [];
  mockModule('src/db/client.js', { withTransaction: async (fn) => fn({}) });
  mockModule('src/config/env.js', { verifySignature: false });
  mockModule('src/repositories/webhook-event.repository.js', {
    insertWebhookEvent: async () => { persisted += 1; }
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
    processSmbMessageEchoes: async () => { throw new Error('unexpected_echo_processing'); }
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
    assert.deepStrictEqual(responseBody.acknowledged, [field]);
  }

  assert.strictEqual(persisted, 0, 'deferred payload must not be persisted');
  assert.strictEqual(debugStored, 0, 'deferred payload must not enter the debug raw store');
  assert.strictEqual(inboundProcessed, 0, 'deferred payload must not reach bot/inbound processing');
  assert.strictEqual(
    logs.filter((entry) => entry.event === 'meta_coexistence_deferred_event_acknowledged').length,
    2
  );
  console.log('whatsapp-coexistence-safe-ack.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
