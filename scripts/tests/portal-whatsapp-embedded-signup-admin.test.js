const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

function clearModule(relativePath) {
  delete require.cache[modulePath(relativePath)];
}

function setupCommonMocks(repositoryOverrides = {}, contextOverrides = {}, envOverrides = {}) {
  clearModule('src/services/portal-whatsapp-embedded-signup.service.js');
  mockModule('src/config/env.js', {
    whatsappAppId: '3388083341350043',
    metaAppSecret: 'app-secret',
    getWhatsAppGraphVersion: () => 'v25.0',
    whatsappCoexistenceOnboardingEnabled: false,
    whatsappCoexistenceOnboardingClinicIds: [],
    ...envOverrides
  });
  mockModule('src/utils/logger.js', {
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {}
  });
  mockModule('src/services/portal-context.service.js', {
    resolvePortalTenantContext: async (tenantId) => ({
      ok: true,
      tenantId,
      clinic: { id: 'clinic-1' },
      reason: 'tenant_context_loaded',
      ...contextOverrides
    })
  });
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    request: async () => ({ ok: true, status: 200, data: { data: [] } }),
    registerWhatsAppPhoneNumber: async () => ({ ok: true })
  });
  mockModule('src/services/portal-whatsapp-assets.service.js', {
    extractGraphErrorMeta: () => ({}),
    inferMetaDomainReason: () => 'meta_error',
    buildMetaGraphDetail: () => 'meta_error'
  });
  mockModule('src/repositories/portal-user-audit.repository.js', {
    createPortalUserAuditEvent: async () => null
  });
  mockModule('src/repositories/whatsapp-onboarding.repository.js', {
    createOnboardingSession: async () => null,
    expirePreviousPendingSessions: async () => {},
    findOnboardingSessionByStateToken: async () => null,
    findLatestOnboardingSessionByClinicId: async () => null,
    markOnboardingSessionFailed: async () => null,
    markOnboardingSessionCancelled: async () => null,
    markOnboardingSessionExpired: async () => null,
    markOnboardingSessionProcessing: async () => null,
    markOnboardingSessionPending: async () => null,
    markOnboardingSessionCompleted: async () => null,
    findWhatsAppChannelByPhoneNumberId: async () => null,
    findWhatsAppChannelByClinicAndPhoneNumberId: async () => null,
    getOrCreateRegistrationPin: async () => ({ pin: '042731', registeredAt: null }),
    markWhatsAppPhoneRegistered: async () => ({ registeredAt: new Date().toISOString() }),
    upsertWhatsAppChannel: async () => null,
    deactivateOtherClinicWhatsAppChannels: async () => {},
    withOnboardingTransaction: async (fn) => fn({}),
    ...repositoryOverrides
  });
}

async function testFinalizeRejectsTenantMismatch() {
  setupCommonMocks({
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-1',
      status: 'awaiting_callback',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-a',
      redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
    })
  });

  const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await finalizePortalWhatsAppSignup({
    expectedTenantId: 'tenant-b',
    stateToken: 'state-1',
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'embedded_signup_session_tenant_mismatch');
}

async function testFinalizeRejectsConsumedState() {
  setupCommonMocks({
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-1',
      status: 'completed',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-a',
      channelId: 'channel-1',
      redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
    })
  });

  const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await finalizePortalWhatsAppSignup({
    expectedTenantId: 'tenant-a',
    stateToken: 'state-1',
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'embedded_signup_state_already_consumed');
}

async function testRefreshCancelsAwaitingCallbackSession() {
  let cancelledPayload = null;

  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-1',
      status: 'awaiting_callback',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    markOnboardingSessionCancelled: async (_sessionId, payload) => {
      cancelledPayload = payload;
      return {
        id: 'session-1',
        status: 'cancelled',
        externalTenantId: 'tenant-a',
        clinicId: 'clinic-1',
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
  });

  const { refreshPortalWhatsAppSignupSession } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await refreshPortalWhatsAppSignupSession('tenant-a', {
    actorUserId: '11111111-1111-4111-8111-111111111111',
    reason: 'popup_closed_without_callback',
    source: 'test'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.session.status, 'cancelled');
  assert.strictEqual(cancelledPayload.errorCode, 'popup_closed_without_callback');
}

async function testRefreshExpiresOldSession() {
  const oldCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  let expiredCalled = false;

  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-2',
      status: 'launching',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-1',
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
      expiresAt: oldCreatedAt
    }),
    markOnboardingSessionExpired: async () => {
      expiredCalled = true;
      return {
        id: 'session-2',
        status: 'expired',
        externalTenantId: 'tenant-a',
        clinicId: 'clinic-1',
        createdAt: oldCreatedAt,
        updatedAt: new Date().toISOString()
      };
    }
  });

  const { getPortalWhatsAppSignupStatus } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await getPortalWhatsAppSignupStatus('tenant-a');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.session.status, 'expired');
  assert.strictEqual(expiredCalled, true);
}

async function testCancelDoesNotModifyCompletedSession() {
  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-3',
      status: 'completed',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  });

  const { cancelPortalWhatsAppSignupSession } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await cancelPortalWhatsAppSignupSession('tenant-a', {
    actorUserId: '11111111-1111-4111-8111-111111111111',
    source: 'test'
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'embedded_signup_session_already_completed');
}

async function testCancelDoesNotPreemptProcessingSession(status = 'discovering_assets') {
  let cancelledCalled = false;

  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-4',
      status,
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    markOnboardingSessionCancelled: async () => {
      cancelledCalled = true;
      return null;
    }
  });

  const { cancelPortalWhatsAppSignupSession } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await cancelPortalWhatsAppSignupSession('tenant-a', {
    actorUserId: '11111111-1111-4111-8111-111111111111',
    source: 'test'
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'embedded_signup_session_processing');
  assert.strictEqual(cancelledCalled, false);
}

async function testFinalizeSuccessPersistsConnection({
  withFinishPayload,
  failCompletion = false,
  failRegistration = false,
  alreadyRegistered = false,
  foreignChannel = false,
  existingChannelMode = null,
  connectionMode = 'API_ONLY',
  includePhoneId = true,
  phoneCandidates = [{ id: 'phone-success', display_phone_number: '+10000000000', verified_name: 'Test' }],
  assetFailureReason = null
}) {
  const redirectUri = 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback';
  const steps = [];
  const logs = [];
  const context = { channel: null };
  let registeredAt = alreadyRegistered ? new Date().toISOString() : null;
  let registerCallCount = 0;
  let session = {
    id: 'session-success',
    status: 'awaiting_callback',
    externalTenantId: 'tenant-a',
    clinicId: 'clinic-1',
    stateToken: 'state-success',
    redirectUri,
    requestedConnectionMode: connectionMode,
    createdAt: new Date().toISOString()
  };

  // Exercise the production completion query as well as the service. PostgreSQL
  // cannot infer omitted parameter types when a query skips a positional binding.
  clearModule('src/repositories/whatsapp-onboarding.repository.js');
  mockModule('src/utils/secret-crypto.js', {
    maybeDecryptSecret: (value) => value,
    maybeEncryptSecret: (value) => value
  });
  const completionQuery = async (sql, parameters) => {
    assert.match(sql, /SET status = 'completed'/);
    const positions = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    assert.deepStrictEqual(positions, parameters.map((_, index) => index + 1), 'completion query must reference every supplied binding');
    for (const field of ['metaCode', 'metaAccessToken', 'metaTokenType', 'metaTokenExpiresAt']) {
      assert.ok(sql.includes(`"${field}" = NULL`), `${field} must be cleared on completion`);
    }
    const boundValue = (field) => {
      const match = sql.match(new RegExp(`"${field}" = COALESCE\\(\\$(\\d+)`));
      assert.ok(match, `${field} must be persisted by the completion query`);
      return parameters[Number(match[1]) - 1];
    };
    assert.strictEqual(parameters[0], session.id);
    assert.strictEqual(boundValue('wabaId'), 'waba-success');
    assert.strictEqual(boundValue('phoneNumberId'), 'phone-success');
    assert.strictEqual(boundValue('channelId'), 'channel-success');
    assert.ok(!parameters.includes('oauth-success'));
    assert.ok(!parameters.includes('test-access-token'));
    if (failCompletion) throw new Error('completion_write_failed');
    session = {
      ...session,
      status: 'completed',
      channelId: boundValue('channelId'),
      wabaId: boundValue('wabaId'),
      phoneNumberId: boundValue('phoneNumberId'),
      completedAt: new Date().toISOString()
    };
    steps.push('session_completed');
    return { rows: [session] };
  };
  mockModule('src/db/client.js', { query: completionQuery, withTransaction: async (fn) => fn({ query: completionQuery }) });
  const { markOnboardingSessionCompleted } = require(modulePath('src/repositories/whatsapp-onboarding.repository.js'));

  setupCommonMocks({
    findOnboardingSessionByStateToken: async (stateToken) => {
      assert.strictEqual(stateToken, 'state-success');
      return session;
    },
    findLatestOnboardingSessionByClinicId: async (clinicId) => {
      assert.strictEqual(clinicId, 'clinic-1');
      return session;
    },
    markOnboardingSessionProcessing: async (_sessionId, data) => {
      steps.push(data.status);
      session = { ...session, status: data.status };
      return session;
    },
    findWhatsAppChannelByPhoneNumberId: async () => foreignChannel
      ? { id: 'foreign-channel', clinicId: 'clinic-foreign', connectionMode }
      : existingChannelMode
        ? { id: 'existing-channel', clinicId: 'clinic-1', connectionMode: existingChannelMode }
        : null,
    getOrCreateRegistrationPin: async ({ clinicId, phoneNumberId }) => {
      assert.strictEqual(clinicId, 'clinic-1');
      assert.strictEqual(phoneNumberId, 'phone-success');
      steps.push('pin_loaded');
      return { pin: '042731', registeredAt };
    },
    markWhatsAppPhoneRegistered: async (clinicId, phoneNumberId) => {
      assert.strictEqual(clinicId, 'clinic-1');
      assert.strictEqual(phoneNumberId, 'phone-success');
      assert.ok(steps.includes('phone_registered'), 'persist success only after Meta confirms registration');
      registeredAt = new Date().toISOString();
      steps.push('registration_saved');
      return { registeredAt };
    },
    upsertWhatsAppChannel: async (data, client) => {
      assert.strictEqual(typeof client.query, 'function');
      assert.strictEqual(data.status, 'active');
      assert.strictEqual(data.clinicId, 'clinic-1');
      assert.strictEqual(data.wabaId, 'waba-success');
      assert.strictEqual(data.phoneNumberId, 'phone-success');
      assert.strictEqual(data.connectionMode, connectionMode);
      steps.push('channel_active');
      context.channel = { ...data, id: 'channel-success', provider: 'whatsapp_cloud' };
      return context.channel;
    },
    deactivateOtherClinicWhatsAppChannels: async (clinicId, channelId) => {
      assert.strictEqual(clinicId, 'clinic-1');
      assert.strictEqual(channelId, 'channel-success');
    },
    markOnboardingSessionCompleted,
    markOnboardingSessionFailed: async (_sessionId, data) => {
      session = { ...session, ...data, status: 'failed' };
      return session;
    },
    withOnboardingTransaction: async (fn) => {
      const before = { session: { ...session }, channel: context.channel };
      try {
        const result = await fn({ query: completionQuery });
        steps.push('commit');
        return result;
      } catch (error) {
        session = before.session;
        context.channel = before.channel;
        throw error;
      }
    }
  }, context);
  mockModule('src/utils/logger.js', {
    logInfo: (event, data) => logs.push({ event, ...data }),
    logWarn: (event, data) => logs.push({ event, ...data }),
    logError: (event, data) => logs.push({ event, ...data })
  });
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    registerWhatsAppPhoneNumber: async (options) => {
      registerCallCount += 1;
      assert.strictEqual(options.phoneNumberId, 'phone-success');
      assert.strictEqual(options.accessToken, 'test-access-token');
      assert.strictEqual(options.pin, '042731');
      assert.ok(steps.includes('webhook_subscribed'), 'subscribe the WABA before registering the phone');
      assert.ok(!steps.includes('channel_active'), 'registration must finish before channel activation');
      if (failRegistration) {
        steps.push('registration_failed');
        return { ok: false, reason: 'meta_phone_registration_failed', graphStatus: 400, graphCode: 100 };
      }
      steps.push('phone_registered');
      return { ok: true };
    },
    request: async (method, endpoint, options) => {
      assert.strictEqual(options.accessToken, 'test-access-token', 'exchange token must reach asset discovery and subscription');
      if (method === 'GET' && endpoint === '/waba-success/phone_numbers') {
        steps.push('phone_discovered');
        return { ok: true, status: 200, data: { data: phoneCandidates } };
      }
      assert.strictEqual(method, 'POST');
      assert.strictEqual(endpoint, '/waba-success/subscribed_apps');
      steps.push('webhook_subscribed');
      return { ok: true, status: 200, data: { success: true } };
    }
  });

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname.endsWith('/oauth/access_token')) {
      assert.strictEqual(requestUrl.searchParams.get('code'), 'oauth-success');
      assert.strictEqual(requestUrl.origin, 'https://graph.facebook.com');
      assert.strictEqual(requestUrl.pathname, '/v25.0/oauth/access_token');
      assert.strictEqual(options.method, 'GET');
      assert.strictEqual(options.headers.Accept, 'application/json');
      assert.strictEqual(requestUrl.searchParams.get('client_id'), '3388083341350043');
      assert.strictEqual(requestUrl.searchParams.get('client_secret'), 'app-secret');
      // Meta's Embedded Signup SDK exchange uses only these three parameters.
      // https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/
      assert.deepStrictEqual([...requestUrl.searchParams.keys()].sort(), ['client_id', 'client_secret', 'code']);
      steps.push('code_exchanged');
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'test-access-token', token_type: 'bearer' }) };
    }
    assert.strictEqual(withFinishPayload, false);
    assert.ok(requestUrl.pathname.endsWith('/debug_token'));
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-success'] }] } }) };
  };
  try {
    const { finalizePortalWhatsAppSignup, getPortalWhatsAppSignupStatus } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
    const result = await finalizePortalWhatsAppSignup({
      expectedTenantId: 'tenant-a',
      stateToken: 'state-success',
      code: 'oauth-success',
      redirectUri,
      metaPayload: withFinishPayload ? {
        type: 'WA_EMBEDDED_SIGNUP',
        event: connectionMode === 'COEXISTENCE' ? 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' : 'FINISH',
        data: {
          waba_id: 'waba-success',
          ...(includePhoneId ? { phone_number_id: 'phone-success' } : {})
        }
      } : null
    });
    if (assetFailureReason) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, assetFailureReason);
      assert.strictEqual(context.channel, null);
      assert.strictEqual(session.status, 'failed');
      assert.ok(!steps.includes('webhook_subscribed'));
      assert.ok(!steps.includes('phone_registered'));
      return;
    }
    if (foreignChannel || existingChannelMode || failRegistration) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(
        result.reason,
        foreignChannel
          ? 'channel_belongs_to_another_workspace'
          : existingChannelMode
            ? 'existing_channel_connection_mode_mismatch'
            : 'meta_phone_registration_failed'
      );
      assert.strictEqual(context.channel, null, 'failed registration must not create an active channel');
      assert.strictEqual(session.status, 'failed');
      assert.ok(!steps.includes('channel_active'));
      assert.ok(!steps.includes('session_completed'));
      assert.ok(!steps.includes('registration_saved'));
      if (foreignChannel || existingChannelMode) {
        assert.ok(!steps.includes('pin_loaded'), 'foreign channels must not get a registration PIN');
        assert.ok(!steps.includes('webhook_subscribed'), 'foreign channels must not cause Meta mutations');
      }
      const safeOutput = JSON.stringify({ logs, result, session });
      assert.ok(!safeOutput.includes('042731'), 'registration PIN must stay out of logs and session payloads');
      assert.ok(!safeOutput.includes('test-access-token'), 'registration token must stay out of logs and failure payloads');
      return;
    }
    if (failCompletion) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'completion_write_failed');
      assert.strictEqual(context.channel, null, 'completion failure must roll back the channel');
      assert.strictEqual(session.status, 'failed');
      assert.ok(!steps.includes('commit'));
      assert.ok(registeredAt, 'successful Meta registration remains recorded after completion rollback');
      const failedStatus = await getPortalWhatsAppSignupStatus('tenant-a');
      assert.strictEqual(failedStatus.onboardingState, 'error');
      assert.strictEqual(failedStatus.session.channelId, null);
      return;
    }
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.status, 'connected');
    assert.strictEqual(result.channel.status, 'active');
    assert.strictEqual(result.channel.connectionMode, connectionMode);
    assert.strictEqual(result.session.status, 'completed');
    assert.strictEqual(result.session.requestedConnectionMode, connectionMode);
    assert.ok(result.session.completedAt);
    assert.deepStrictEqual(steps, [
      'exchanging_code', 'code_exchanged', 'discovering_assets', 'phone_discovered',
      'subscribing_app', 'webhook_subscribed',
      ...(connectionMode === 'API_ONLY'
        ? ['registering_phone', 'pin_loaded', ...(alreadyRegistered ? [] : ['phone_registered', 'registration_saved'])]
        : []),
      'persisting_channel', 'channel_active', 'session_completed', 'commit'
    ]);
    assert.strictEqual(registerCallCount, connectionMode === 'API_ONLY' && !alreadyRegistered ? 1 : 0);
    assert.ok(!JSON.stringify({ result, logs }).includes('042731'), 'successful signup must not expose the PIN');
    const signupStatus = await getPortalWhatsAppSignupStatus('tenant-a');
    assert.strictEqual(signupStatus.onboardingState, 'connected');
    assert.strictEqual(signupStatus.session.channelId, 'channel-success');

    clearModule('src/services/portal-whatsapp-status.service.js');
    mockModule('src/db/client.js', { query: async () => ({ rows: [] }) });
    mockModule('src/utils/bot-config.js', { DEFAULT_BOT_CONFIG: {}, normalizeBotConfig: () => ({}) });
    const { getPortalWhatsAppStatus } = require(modulePath('src/services/portal-whatsapp-status.service.js'));
    const status = await getPortalWhatsAppStatus('tenant-a');
    assert.strictEqual(status.channel.connected, true);
    assert.strictEqual(status.channel.channelId, 'channel-success');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testStandardSignupDefaultsApiOnly() {
  let persistedInput = null;
  setupCommonMocks({
    createOnboardingSession: async (input) => {
      persistedInput = input;
      return {
        id: 'session-standard',
        ...input,
        createdAt: new Date().toISOString()
      };
    }
  });

  const { createPortalWhatsAppSignupSession } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await createPortalWhatsAppSignupSession({
    tenantId: 'tenant-a',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(persistedInput.requestedConnectionMode, 'API_ONLY');
  assert.strictEqual(result.session.requestedConnectionMode, 'API_ONLY');
}

async function testCoexistenceSessionRequiresServerPilotAuthorization() {
  let persistedInput = null;
  setupCommonMocks({
    createOnboardingSession: async (input) => {
      persistedInput = input;
      return { id: 'session-coexistence', ...input, createdAt: new Date().toISOString() };
    }
  });
  let service = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const denied = await service.createPortalWhatsAppSignupSession({
    tenantId: 'tenant-a',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback',
    requestedConnectionMode: 'COEXISTENCE'
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'whatsapp_coexistence_onboarding_not_authorized');
  assert.strictEqual(persistedInput, null);

  setupCommonMocks({
    createOnboardingSession: async (input) => {
      persistedInput = input;
      return { id: 'session-coexistence', ...input, createdAt: new Date().toISOString() };
    }
  }, {}, {
    whatsappCoexistenceOnboardingEnabled: true,
    whatsappCoexistenceOnboardingClinicIds: ['clinic-1']
  });
  service = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const allowed = await service.createPortalWhatsAppSignupSession({
    tenantId: 'tenant-a',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback',
    requestedConnectionMode: 'COEXISTENCE',
    stateToken: 'a'.repeat(48)
  });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(persistedInput.requestedConnectionMode, 'COEXISTENCE');
  assert.strictEqual(persistedInput.stateToken, 'a'.repeat(48));
  assert.strictEqual(allowed.session.requestedConnectionMode, 'COEXISTENCE');

  persistedInput = null;
  setupCommonMocks({
    createOnboardingSession: async (input) => { persistedInput = input; return input; }
  }, {
    channel: { id: 'api-channel', clinicId: 'clinic-1', connectionMode: 'API_ONLY', status: 'active' }
  }, {
    whatsappCoexistenceOnboardingEnabled: true,
    whatsappCoexistenceOnboardingClinicIds: ['clinic-1']
  });
  service = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const conversionDenied = await service.createPortalWhatsAppSignupSession({
    tenantId: 'tenant-a',
    redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback',
    requestedConnectionMode: 'COEXISTENCE'
  });
  assert.strictEqual(conversionDenied.ok, false);
  assert.strictEqual(conversionDenied.reason, 'existing_channel_connection_mode_mismatch');
  assert.strictEqual(persistedInput, null);
}

async function testDirectRegistrationSkipsCoexistence() {
  let registerCallCount = 0;
  const selected = {
    id: 'channel-coexistence', clinicId: 'clinic-1', provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-coexistence', connectionMode: 'COEXISTENCE'
  };
  setupCommonMocks({
    findWhatsAppChannelByClinicAndPhoneNumberId: async () => ({ ...selected, accessToken: 'test-token' })
  }, { channel: selected });
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    request: async () => ({ ok: true, status: 200, data: {} }),
    registerWhatsAppPhoneNumber: async () => { registerCallCount += 1; return { ok: true }; }
  });

  const { registerPortalWhatsAppPhoneNumber } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const result = await registerPortalWhatsAppPhoneNumber('tenant-a');
  assert.deepStrictEqual(result, {
    ok: true, registered: false, skipped: true, connectionMode: 'COEXISTENCE'
  });
  assert.strictEqual(registerCallCount, 0);
}

async function testInvalidSessionModeFailsBeforeGraphWrites() {
  const redirectUri = 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback';
  let graphCalls = 0;
  let failedPayload = null;
  setupCommonMocks({
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-invalid-mode', status: 'awaiting_callback', externalTenantId: 'tenant-a',
      clinicId: 'clinic-1', redirectUri, requestedConnectionMode: 'UNKNOWN', createdAt: new Date().toISOString()
    }),
    markOnboardingSessionFailed: async (_id, payload) => { failedPayload = payload; return payload; }
  });
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    request: async () => { graphCalls += 1; return { ok: true }; },
    registerWhatsAppPhoneNumber: async () => { graphCalls += 1; return { ok: true }; }
  });
  const originalFetch = global.fetch;
  global.fetch = async () => { graphCalls += 1; throw new Error('unexpected_graph_call'); };
  try {
    const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
    const result = await finalizePortalWhatsAppSignup({
      expectedTenantId: 'tenant-a', stateToken: 'state-invalid', code: 'code-invalid', redirectUri
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'invalid_whatsapp_connection_mode');
    assert.strictEqual(failedPayload.errorCode, 'invalid_whatsapp_connection_mode');
    assert.strictEqual(graphCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCompletionEventMustMatchServerSessionMode() {
  const redirectUri = 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback';
  for (const fixture of [
    { mode: 'API_ONLY', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' },
    { mode: 'COEXISTENCE', event: 'FINISH' },
    { mode: 'COEXISTENCE', event: null }
  ]) {
    let graphCalls = 0;
    let failedPayload = null;
    setupCommonMocks({
      findOnboardingSessionByStateToken: async () => ({
        id: `session-${fixture.mode}`, status: 'awaiting_callback', externalTenantId: 'tenant-a',
        clinicId: 'clinic-1', redirectUri, requestedConnectionMode: fixture.mode,
        createdAt: new Date().toISOString()
      }),
      markOnboardingSessionFailed: async (_id, payload) => {
        failedPayload = payload;
        return { id: `session-${fixture.mode}`, status: 'failed', ...payload };
      }
    });
    mockModule('src/whatsapp/whatsapp-graph.client.js', {
      request: async () => { graphCalls += 1; return { ok: true }; },
      registerWhatsAppPhoneNumber: async () => { graphCalls += 1; return { ok: true }; }
    });
    const originalFetch = global.fetch;
    global.fetch = async () => { graphCalls += 1; throw new Error('unexpected_graph_call'); };
    try {
      const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
      const result = await finalizePortalWhatsAppSignup({
        expectedTenantId: 'tenant-a', stateToken: 'state-mode', code: 'code-mode', redirectUri,
        connectionMode: fixture.mode === 'API_ONLY' ? 'COEXISTENCE' : 'API_ONLY',
        metaPayload: fixture.event ? { event: fixture.event, data: { waba_id: 'waba-a' } } : null
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'embedded_signup_completion_event_mismatch');
      assert.strictEqual(failedPayload.errorCode, 'embedded_signup_completion_event_mismatch');
      assert.strictEqual(graphCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  }
}

async function testOAuthExchangeErrorIsSanitized({ invalidBody = false, networkError = false } = {}) {
  const code = 'dummy-code-sensitive+/value';
  const secret = 'dummy-secret-sensitive+/value';
  const token = 'dummy-token-sensitive';
  const redirectUri = 'https://opturon.test/api/app/integrations/whatsapp/embedded-signup/callback';
  const logs = [];
  let failedSession = null;
  let fetchCount = 0;
  setupCommonMocks({
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-oauth', status: 'awaiting_callback', externalTenantId: 'tenant-a',
      clinicId: 'clinic-1', redirectUri, createdAt: new Date().toISOString()
    }),
    markOnboardingSessionFailed: async (_id, data) => { failedSession = data; return data; }
  });
  mockModule('src/config/env.js', {
    whatsappAppId: 'test-whatsapp-app', metaAppSecret: secret,
    // Deliberately different credentials: this test documents the current source,
    // without presuming that real runtime values belong to any particular app.
    whatsappAppSecret: 'unused-dedicated-secret', instagramAppSecret: 'unused-instagram-secret',
    getWhatsAppGraphVersion: () => 'v25.0'
  });
  mockModule('src/utils/logger.js', {
    logInfo: (event, data) => logs.push({ event, ...data }),
    logWarn: (event, data) => logs.push({ event, ...data }),
    logError: (event, data) => logs.push({ event, ...data })
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    fetchCount += 1;
    if (networkError) throw new Error(`Request failed: ${url}`);
    return {
      ok: false, status: 400,
      text: async () => invalidBody ? '<html>Upstream failure</html>' : JSON.stringify({
        access_token: token,
        error: {
          type: 'OAuthException', code: 100, error_subcode: 36008, fbtrace_id: 'trace-test',
          message: `Verification rejected: ${code}; ${encodeURIComponent(code)}; ${secret}; access_token=${token}`,
          client_secret: secret, code_echo: code, access_token: token,
          error_data: { authorization: `Bearer ${token}` }
        }
      })
    };
  };
  try {
    const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
    const result = await finalizePortalWhatsAppSignup({
      expectedTenantId: 'tenant-a', stateToken: 'state-oauth', code, redirectUri
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'meta_oauth_exchange_failed');
    assert.strictEqual(failedSession.errorCode, 'meta_oauth_exchange_failed');
    assert.strictEqual(fetchCount, 1, 'never retry a single-use authorization code');
    const safeOutput = JSON.stringify({ logs, result, failedSession });
    for (const value of [code, encodeURIComponent(code), secret, encodeURIComponent(secret), token]) {
      assert.ok(!safeOutput.includes(value), 'OAuth credentials must not appear in logs, response or failed-session metadata');
    }
    const exchangeFailure = logs.find((log) => log.event === 'portal_whatsapp_embedded_signup_exchange_failed');
    assert.ok(exchangeFailure);
    if (!invalidBody && !networkError) {
      assert.strictEqual(exchangeFailure.status, 400);
      assert.deepStrictEqual(exchangeFailure.body.error, {
        type: 'OAuthException', code: 100, error_subcode: 36008, fbtrace_id: 'trace-test',
        message: 'Verification rejected: [REDACTED]; [REDACTED]; [REDACTED]; access_token=[REDACTED]'
      });
      assert.deepStrictEqual(failedSession.metadata.body, exchangeFailure.body);
    }
  } finally {
    global.fetch = originalFetch;
  }
}

async function testSessionRedirectMustStillMatchExactly() {
  const redirectUri = 'https://opturon.test/api/app/integrations/whatsapp/embedded-signup/callback';
  setupCommonMocks({
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-redirect', status: 'awaiting_callback', externalTenantId: 'tenant-a',
      clinicId: 'clinic-1', redirectUri, createdAt: new Date().toISOString()
    })
  });
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => { fetchCount += 1; throw new Error('unexpected_network'); };
  try {
    const { finalizePortalWhatsAppSignup } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
    const result = await finalizePortalWhatsAppSignup({
      expectedTenantId: 'tenant-a', stateToken: 'state-redirect', code: 'test-code', redirectUri: `${redirectUri}/`
    });
    assert.strictEqual(result.reason, 'embedded_signup_redirect_uri_mismatch');
    assert.strictEqual(fetchCount, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await testStandardSignupDefaultsApiOnly();
  await testCoexistenceSessionRequiresServerPilotAuthorization();
  await testDirectRegistrationSkipsCoexistence();
  await testInvalidSessionModeFailsBeforeGraphWrites();
  await testCompletionEventMustMatchServerSessionMode();
  await testFinalizeRejectsTenantMismatch();
  await testFinalizeRejectsConsumedState();
  await testRefreshCancelsAwaitingCallbackSession();
  await testRefreshExpiresOldSession();
  await testCancelDoesNotModifyCompletedSession();
  await testCancelDoesNotPreemptProcessingSession();
  await testCancelDoesNotPreemptProcessingSession('registering_phone');
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: false });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, failCompletion: true });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, failRegistration: true });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, alreadyRegistered: true });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, foreignChannel: true });
  await testFinalizeSuccessPersistsConnection({
    withFinishPayload: true,
    connectionMode: 'COEXISTENCE',
    existingChannelMode: 'API_ONLY'
  });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, connectionMode: 'COEXISTENCE' });
  await testFinalizeSuccessPersistsConnection({
    withFinishPayload: true,
    connectionMode: 'COEXISTENCE',
    includePhoneId: false
  });
  await testFinalizeSuccessPersistsConnection({
    withFinishPayload: true,
    connectionMode: 'COEXISTENCE',
    includePhoneId: false,
    phoneCandidates: [
      { id: 'phone-a', display_phone_number: '+10000000001' },
      { id: 'phone-b', display_phone_number: '+10000000002' }
    ],
    assetFailureReason: 'meta_phone_number_id_missing'
  });
  await testOAuthExchangeErrorIsSanitized();
  await testOAuthExchangeErrorIsSanitized({ invalidBody: true });
  await testOAuthExchangeErrorIsSanitized({ networkError: true });
  await testSessionRedirectMustStillMatchExactly();
  console.log('portal-whatsapp-embedded-signup-admin.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
