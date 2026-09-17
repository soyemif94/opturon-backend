const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const servicePath = 'src/services/portal-whatsapp-embedded-signup.service.js';
const graphPath = 'src/whatsapp/whatsapp-graph.client.js';
const token = 'test-registration-token+/sensitive';
const pin = '042731';

function mockModule(relativePath, exportsValue) {
  const filename = path.join(rootDir, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue };
}

function clearModule(relativePath) {
  delete require.cache[path.join(rootDir, relativePath)];
}

function mockLogger(logs) {
  mockModule('src/utils/logger.js', Object.fromEntries(
    ['logInfo', 'logWarn', 'logError'].map((level) => [level, (event, data) => logs.push({ level, event, ...data })])
  ));
}

function assertNoSecrets(value) {
  const serialized = JSON.stringify(value, (_key, item) => item instanceof Error ? { message: item.message, stack: item.stack } : item);
  for (const secret of [pin, token, encodeURIComponent(token), `Bearer ${token}`]) {
    assert.ok(!serialized.includes(secret), 'registration credentials must not appear in output, logs or stored metadata');
  }
}

async function testGraphRegistration({ status = 200, body = { success: true }, networkError = false, expectedOk = true } = {}) {
  clearModule(graphPath);
  mockModule('src/config/env.js', {
    getWhatsAppGraphVersion: () => 'v25.0',
    whatsappAccessToken: 'unrelated-global-token',
    whatsappPhoneNumberId: 'unrelated-global-phone'
  });
  const logs = [];
  mockLogger(logs);
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    assert.strictEqual(url, 'https://graph.facebook.com/v25.0/123456789/register');
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(options.headers.Authorization, `Bearer ${token}`);
    assert.strictEqual(options.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(options.body), { messaging_product: 'whatsapp', pin });
    assert.ok(options.signal instanceof AbortSignal);
    if (networkError) {
      throw new Error(`Registration failed with pin=${pin} and Authorization=Bearer ${token}: ${options.body}`);
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'x-reflected-secret': `${pin}:${token}`, 'retry-after': '0' }),
      text: async () => typeof body === 'string' ? body : JSON.stringify(body)
    };
  };
  try {
    const graph = require(path.join(rootDir, graphPath));
    const result = await graph.registerWhatsAppPhoneNumber({ phoneNumberId: '123456789', accessToken: token, pin, requestId: 'registration-test' });
    assert.strictEqual(result.ok, expectedOk);
    assert.strictEqual(requests.length, 1, 'registration retries must be deliberate and reuse the saved PIN');
    if (expectedOk) {
      assert.deepStrictEqual(result, { ok: true });
    } else {
      assert.strictEqual(result.reason, 'meta_phone_registration_failed');
      assert.strictEqual(result.graphStatus, networkError ? null : status);
    }
    assertNoSecrets({ result, logs });
  } finally {
    global.fetch = originalFetch;
  }
}

async function testGraphRequiresExplicitCredentials() {
  clearModule(graphPath);
  const logs = [];
  mockLogger(logs);
  mockModule('src/config/env.js', {
    getWhatsAppGraphVersion: () => 'v25.0',
    whatsappAccessToken: 'unrelated-global-token',
    whatsappPhoneNumberId: 'unrelated-global-phone'
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('unexpected_network'); };
  try {
    const graph = require(path.join(rootDir, graphPath));
    for (const args of [
      { phoneNumberId: '', accessToken: token, pin },
      { phoneNumberId: '123456789', accessToken: '', pin },
      { phoneNumberId: '123456789', accessToken: token, pin: '12345' },
      { phoneNumberId: '123456789', accessToken: token, pin: 42731 }
    ]) {
      const result = await graph.registerWhatsAppPhoneNumber(args);
      assert.strictEqual(result.ok, false);
      assertNoSecrets({ result, logs });
    }
    assert.strictEqual(calls, 0, 'registration may never fall back to global credentials');
  } finally {
    global.fetch = originalFetch;
  }
}

function setupRecovery({ contextOverrides = {}, scopedChannelOverrides = {}, noScopedChannel = false, noCredentials = false, registered = false, failFirstRegistration = false, throwRegistration = false, failPinStorage = false, failMarkerStorage = false } = {}) {
  clearModule(servicePath);
  const logs = [];
  const audit = [];
  const graphCalls = [];
  const scopedLookups = [];
  const pinLookups = [];
  const markers = [];
  const contextCalls = [];
  let registeredAt = registered ? new Date().toISOString() : null;
  const selectedChannel = {
    id: 'channel-a', clinicId: 'clinic-a', phoneNumberId: 'phone-a', provider: 'whatsapp_cloud', status: 'active'
  };
  const context = {
    ok: true, tenantId: 'tenant-a', clinic: { id: 'clinic-a' }, channel: selectedChannel,
    channelSelection: { reason: 'resolved', strategy: 'single_active' },
    ...contextOverrides
  };
  mockModule('src/config/env.js', {
    whatsappAppId: 'test-app', metaAppSecret: 'test-secret',
    whatsappAccessToken: 'unrelated-global-token', whatsappPhoneNumberId: 'unrelated-global-phone',
    getWhatsAppGraphVersion: () => 'v25.0'
  });
  mockLogger(logs);
  mockModule('src/services/portal-context.service.js', {
    resolvePortalTenantContext: async (tenantId) => { contextCalls.push(tenantId); return context; }
  });
  mockModule('src/services/portal-whatsapp-assets.service.js', {
    extractGraphErrorMeta: () => ({}), inferMetaDomainReason: () => 'meta_error', buildMetaGraphDetail: () => 'meta_error'
  });
  mockModule('src/repositories/portal-user-audit.repository.js', {
    createPortalUserAuditEvent: async (event) => { audit.push(event); return null; }
  });
  mockModule('src/repositories/whatsapp-onboarding.repository.js', {
    findWhatsAppChannelByPhoneNumberId: async () => { throw new Error('unscoped_channel_lookup_forbidden'); },
    findWhatsAppChannelByClinicAndPhoneNumberId: async (clinicId, phoneNumberId) => {
      scopedLookups.push({ clinicId, phoneNumberId });
      return noScopedChannel ? null : {
        ...selectedChannel, accessToken: noCredentials ? '' : token, ...scopedChannelOverrides
      };
    },
    getOrCreateRegistrationPin: async (input) => {
      pinLookups.push(input);
      if (failPinStorage) throw new Error(`Storage failed with ${pin} and ${token}`);
      return { pin, registeredAt };
    },
    markWhatsAppPhoneRegistered: async (clinicId, phoneNumberId) => {
      markers.push({ clinicId, phoneNumberId });
      if (failMarkerStorage) throw new Error(`Storage failed with ${pin} and ${token}`);
      registeredAt = new Date().toISOString();
      return { registeredAt };
    }
  });
  mockModule(graphPath, {
    request: async () => { throw new Error('unexpected_generic_graph_request'); },
    registerWhatsAppPhoneNumber: async (options) => {
      graphCalls.push(options);
      if (throwRegistration) throw new Error(`Network failure with ${pin} and ${token}`);
      if (failFirstRegistration && graphCalls.length === 1) {
        return { ok: false, reason: 'meta_phone_registration_failed', graphStatus: null };
      }
      return { ok: true };
    }
  });
  const service = require(path.join(rootDir, servicePath));
  return { service, logs, audit, graphCalls, scopedLookups, pinLookups, markers, contextCalls };
}

async function testRecoveryUsesSelectedTenantAndSavedPin() {
  const state = setupRecovery({ failFirstRegistration: true });
  const options = {
    requestId: 'recovery-request', actorUserId: '11111111-1111-4111-8111-111111111111',
    // Even an internal caller cannot override the channel selected by tenant context.
    clinicId: 'clinic-foreign', phoneNumberId: 'phone-foreign', accessToken: 'foreign-token', pin: '987654'
  };
  const failed = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', options);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.reason, 'meta_phone_registration_failed');
  assert.strictEqual(state.markers.length, 0, 'timeout is not proof that Meta completed registration');
  const completed = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', options);
  assert.deepStrictEqual(completed, { ok: true, registered: true });
  assert.strictEqual(state.graphCalls.length, 2);
  for (const call of state.graphCalls) {
    assert.strictEqual(call.phoneNumberId, 'phone-a');
    assert.strictEqual(call.accessToken, token);
    assert.strictEqual(call.pin, pin, 'retry must reuse the original PIN after an uncertain timeout');
    assert.strictEqual(call.requestId, 'recovery-request');
  }
  assert.deepStrictEqual(state.scopedLookups, Array(2).fill({ clinicId: 'clinic-a', phoneNumberId: 'phone-a' }));
  assert.deepStrictEqual(state.pinLookups, Array(2).fill({ clinicId: 'clinic-a', phoneNumberId: 'phone-a' }));
  assert.deepStrictEqual(state.markers, [{ clinicId: 'clinic-a', phoneNumberId: 'phone-a' }]);
  assert.deepStrictEqual(state.contextCalls, ['tenant-a', 'tenant-a']);
  const repeated = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', options);
  assert.deepStrictEqual(repeated, { ok: true, registered: true });
  assert.strictEqual(state.graphCalls.length, 2, 'durable successful marker makes a repeat request idempotent');
  assertNoSecrets({ failed, completed, repeated, logs: state.logs, audit: state.audit });
}

async function testRecoveryPriorSuccessAvoidsGraph() {
  const state = setupRecovery({ registered: true });
  const result = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', {});
  assert.deepStrictEqual(result, { ok: true, registered: true });
  assert.strictEqual(state.graphCalls.length, 0);
  assert.strictEqual(state.markers.length, 0);
  assertNoSecrets({ result, logs: state.logs, audit: state.audit });
}

async function testRecoveryFailsBeforeGraph(options, expectedReason) {
  const state = setupRecovery(options);
  const result = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', {});
  assert.strictEqual(result.ok, false);
  if (expectedReason) assert.strictEqual(result.reason, expectedReason);
  assert.strictEqual(state.graphCalls.length, 0, 'unavailable, ambiguous or foreign channels must never reach Meta');
  assert.strictEqual(state.markers.length, 0);
  assertNoSecrets({ result, logs: state.logs, audit: state.audit });
}

async function testRecoveryFailuresAreSanitized(options, expectedReason) {
  const state = setupRecovery(options);
  const result = await state.service.registerPortalWhatsAppPhoneNumber('tenant-a', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, expectedReason);
  assertNoSecrets({ result, logs: state.logs, audit: state.audit });
}

async function run() {
  await testGraphRegistration();
  await testGraphRegistration({ body: { success: 'true', reflectedPin: pin, access_token: token } });
  await testGraphRegistration({ body: { success: false, reflectedPin: pin, access_token: token }, expectedOk: false });
  await testGraphRegistration({ body: { success: 1 }, expectedOk: false });
  await testGraphRegistration({ body: `Malformed upstream body: ${pin} ${token}`, expectedOk: false });
  await testGraphRegistration({ status: 400, expectedOk: false, body: {
    error: {
      type: token, code: 100, error_subcode: 33, fbtrace_id: pin,
      message: `Already registered: pin=${pin}, access_token=${token}`,
      error_data: { pin, authorization: `Bearer ${token}` }
    }
  } });
  await testGraphRegistration({ status: 503, body: { error: { message: `${pin} ${token}` } }, expectedOk: false });
  await testGraphRegistration({ networkError: true, expectedOk: false });
  await testGraphRequiresExplicitCredentials();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('real_network_forbidden_in_service_tests'); };
  try {
    await testRecoveryUsesSelectedTenantAndSavedPin();
    await testRecoveryPriorSuccessAvoidsGraph();
    await testRecoveryFailsBeforeGraph({ contextOverrides: { ok: false, reason: 'tenant_mapping_not_found' } });
    await testRecoveryFailsBeforeGraph({ contextOverrides: { channel: null } }, 'whatsapp_registration_channel_unavailable');
    await testRecoveryFailsBeforeGraph({ contextOverrides: { channel: null, channelSelection: { reason: 'multiple_whatsapp_channels_configured' } } }, 'whatsapp_registration_channel_unavailable');
    await testRecoveryFailsBeforeGraph({ contextOverrides: { channel: { id: 'foreign', clinicId: 'clinic-foreign', phoneNumberId: 'phone-foreign' } } });
    await testRecoveryFailsBeforeGraph({ noScopedChannel: true });
    await testRecoveryFailsBeforeGraph({ scopedChannelOverrides: { clinicId: 'clinic-foreign' } });
    await testRecoveryFailsBeforeGraph({ scopedChannelOverrides: { phoneNumberId: 'phone-foreign' } });
    await testRecoveryFailsBeforeGraph({ noCredentials: true }, 'whatsapp_registration_credentials_missing');
    await testRecoveryFailuresAreSanitized({ failPinStorage: true }, 'whatsapp_registration_storage_failed');
    await testRecoveryFailuresAreSanitized({ failMarkerStorage: true }, 'whatsapp_registration_storage_failed');
    await testRecoveryFailuresAreSanitized({ throwRegistration: true }, 'meta_phone_registration_failed');
  } finally {
    global.fetch = originalFetch;
  }
  console.log('whatsapp-phone-registration.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
