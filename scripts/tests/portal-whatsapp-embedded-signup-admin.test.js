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

async function run() {
  await testFinalizeRejectsTenantMismatch();
  await testFinalizeRejectsConsumedState();
  await testRefreshCancelsAwaitingCallbackSession();
  await testRefreshExpiresOldSession();
  await testCancelDoesNotModifyCompletedSession();
  await testCancelDoesNotPreemptProcessingSession();
  console.log('portal-whatsapp-embedded-signup-admin.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
