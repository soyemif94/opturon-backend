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

function setupCommonMocks(repositoryOverrides = {}, contextOverrides = {}) {
  clearModule('src/services/portal-whatsapp-embedded-signup.service.js');
  mockModule('src/config/env.js', {
    whatsappAppId: '3388083341350043',
    metaAppSecret: 'app-secret',
    getWhatsAppGraphVersion: () => 'v25.0'
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
    request: async () => ({ ok: true, status: 200, data: { data: [] } })
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
    upsertWhatsAppChannel: async () => null,
    deactivateOtherClinicWhatsAppChannels: async () => {},
    withOnboardingTransaction: async (fn) => fn({}),
    ...repositoryOverrides
  });
}

function setupRealPortalContextReadback(channels) {
  const clinicQueries = [];
  const channelQueries = [];
  const clinics = [
    { id: 'clinic-1', externalTenantId: 'tenant-a', settings: {} },
    { id: 'clinic-2', externalTenantId: 'tenant-b', settings: {} }
  ];
  for (const file of [
    'src/repositories/tenant.repository.js',
    'src/services/portal-context.service.js',
    'src/services/portal-whatsapp-status.service.js'
  ]) clearModule(file);
  // Keep the tenant lookup, channel query and context/status mapping real. Only
  // the database boundary and unrelated product/bot data are simulated.
  mockModule('src/db/client.js', {
    query: async (sql, parameters) => {
      assert.match(sql.trim(), /^SELECT\b/, 'readback must not write to the database');
      if (/FROM clinics\s+WHERE "externalTenantId" = \$1/.test(sql)) {
        clinicQueries.push(parameters[0]);
        return { rows: clinics.filter((clinic) => clinic.externalTenantId === parameters[0]) };
      }
      if (/FROM channels\b/.test(sql)) {
        assert.match(sql, /WHERE "clinicId" = \$1/);
        assert.match(sql, /AND provider = 'whatsapp_cloud'/);
        channelQueries.push(parameters[0]);
        const columns = sql.match(/SELECT ([\s\S]+?)\s+FROM channels/)[1]
          .split(',').map((column) => column.trim().replaceAll('"', ''));
        return {
          rows: channels
            .filter((channel) => channel.clinicId === parameters[0] && channel.provider === 'whatsapp_cloud')
            .map((channel) => Object.fromEntries(columns.map((column) => [column, channel[column] ?? null])))
        };
      }
      return { rows: [] };
    }
  });
  mockModule('src/repositories/products.repository.js', { listProductsByClinicId: async () => [] });
  mockModule('src/repositories/automations.repository.js', { listAutomationsByClinicId: async () => [] });
  mockModule('src/services/tenant-policy.service.js', { buildTenantPolicyFromSettings: () => ({}) });
  mockModule('src/utils/bot-config.js', { DEFAULT_BOT_CONFIG: {}, normalizeBotConfig: () => ({}) });
  return {
    ...require(modulePath('src/services/portal-context.service.js')),
    ...require(modulePath('src/services/portal-whatsapp-status.service.js')),
    clinicQueries,
    channelQueries
  };
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

async function testCancelDoesNotPreemptProcessingSession() {
  let cancelledCalled = false;

  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-4',
      status: 'discovering_assets',
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

async function testFinalizeSuccessPersistsConnection({ withFinishPayload, failCompletion = false }) {
  const redirectUri = 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback';
  const steps = [];
  const context = { channel: null };
  let session = {
    id: 'session-success',
    status: 'awaiting_callback',
    externalTenantId: 'tenant-a',
    clinicId: 'clinic-1',
    stateToken: 'state-success',
    redirectUri,
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
    upsertWhatsAppChannel: async (data, client) => {
      assert.strictEqual(typeof client.query, 'function');
      assert.strictEqual(data.status, 'active');
      assert.strictEqual(data.clinicId, 'clinic-1');
      assert.strictEqual(data.wabaId, 'waba-success');
      assert.strictEqual(data.phoneNumberId, 'phone-success');
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
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    request: async (method, endpoint, options) => {
      assert.strictEqual(options.accessToken, 'test-access-token', 'exchange token must reach asset discovery and subscription');
      if (method === 'GET' && endpoint === '/waba-success/phone_numbers') {
        steps.push('phone_discovered');
        return { ok: true, status: 200, data: { data: [{ id: 'phone-success', display_phone_number: '+10000000000', verified_name: 'Test' }] } };
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
      metaPayload: withFinishPayload ? { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'waba-success', phone_number_id: 'phone-success' } } : null
    });
    if (failCompletion) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'completion_write_failed');
      assert.strictEqual(context.channel, null, 'completion failure must roll back the channel');
      assert.strictEqual(session.status, 'failed');
      assert.ok(!steps.includes('commit'));
      const failedStatus = await getPortalWhatsAppSignupStatus('tenant-a');
      assert.strictEqual(failedStatus.onboardingState, 'error');
      assert.strictEqual(failedStatus.session.channelId, null);
      return;
    }
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.status, 'connected');
    assert.strictEqual(result.channel.status, 'active');
    assert.strictEqual(result.session.status, 'completed');
    assert.ok(result.session.completedAt);
    assert.deepStrictEqual(steps, ['exchanging_code', 'code_exchanged', 'discovering_assets', 'phone_discovered', 'subscribing_app', 'webhook_subscribed', 'persisting_channel', 'channel_active', 'session_completed', 'commit']);
    const signupStatus = await getPortalWhatsAppSignupStatus('tenant-a');
    assert.strictEqual(signupStatus.onboardingState, 'connected');
    assert.strictEqual(signupStatus.session.channelId, 'channel-success');

    const readback = setupRealPortalContextReadback([context.channel]);
    const loadedContext = await readback.resolvePortalTenantContext('tenant-a');
    assert.strictEqual(loadedContext.onboarding.hasChannel, true);
    assert.strictEqual(loadedContext.channel.id, result.channel.id);
    assert.strictEqual(loadedContext.channel.provider, 'whatsapp_cloud');
    assert.strictEqual(loadedContext.channel.phoneNumberId, result.channel.phoneNumberId);
    assert.strictEqual(loadedContext.channel.wabaId, result.channel.wabaId);
    for (let reload = 0; reload < 2; reload += 1) {
      const status = await readback.getPortalWhatsAppStatus('tenant-a');
      assert.strictEqual(status.channel.connected, true);
      assert.strictEqual(status.channel.status, 'active');
      assert.strictEqual(status.channel.channelId, 'channel-success');
      assert.strictEqual(status.channel.phoneNumberId, result.channel.phoneNumberId);
      assert.strictEqual(status.channel.wabaId, result.channel.wabaId);
    }
    const otherTenant = await readback.getPortalWhatsAppStatus('tenant-b');
    assert.strictEqual(otherTenant.channel.connected, false);
    assert.strictEqual(otherTenant.channel.channelId, null);
    assert.deepStrictEqual(readback.clinicQueries, ['tenant-a', 'tenant-a', 'tenant-a', 'tenant-b']);
    assert.deepStrictEqual(readback.channelQueries, ['clinic-1', 'clinic-1', 'clinic-1', 'clinic-2']);

    context.channel.status = 'inactive';
    const inactive = await readback.getPortalWhatsAppStatus('tenant-a');
    assert.strictEqual(inactive.channel.connected, false);
    assert.strictEqual(inactive.channel.status, 'inactive');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testTerminalSessionWithoutChannelDoesNotConnect(status) {
  setupCommonMocks({
    findLatestOnboardingSessionByClinicId: async () => ({
      id: 'session-terminal', status, externalTenantId: 'tenant-a', clinicId: 'clinic-1',
      createdAt: new Date().toISOString()
    })
  });
  const readback = setupRealPortalContextReadback([]);
  const { getPortalWhatsAppSignupStatus } = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  const signup = await getPortalWhatsAppSignupStatus('tenant-a');
  assert.strictEqual(signup.session.status, status);
  assert.strictEqual(signup.onboardingState, status === 'failed' ? 'error' : 'idle');
  const context = await readback.resolvePortalTenantContext('tenant-a');
  assert.strictEqual(context.onboarding.hasChannel, false);
  const connection = await readback.getPortalWhatsAppStatus('tenant-a');
  assert.strictEqual(connection.channel.connected, false);
  assert.strictEqual(connection.channel.channelId, null);
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
  await testFinalizeRejectsTenantMismatch();
  await testFinalizeRejectsConsumedState();
  await testRefreshCancelsAwaitingCallbackSession();
  await testRefreshExpiresOldSession();
  await testCancelDoesNotModifyCompletedSession();
  await testCancelDoesNotPreemptProcessingSession();
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: false });
  await testFinalizeSuccessPersistsConnection({ withFinishPayload: true, failCompletion: true });
  await testTerminalSessionWithoutChannelDoesNotConnect('cancelled');
  await testTerminalSessionWithoutChannelDoesNotConnect('failed');
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
