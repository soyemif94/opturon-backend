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

function loadService(overrides = {}) {
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
      reason: 'tenant_context_loaded'
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
  mockModule('src/repositories/whatsapp-onboarding.repository.js', {
    createOnboardingSession: async () => null,
    expirePreviousPendingSessions: async () => {},
    findOnboardingSessionByStateToken: async () => null,
    findLatestOnboardingSessionByClinicId: async () => null,
    markOnboardingSessionFailed: async () => null,
    markOnboardingSessionPending: async () => null,
    markOnboardingSessionCompleted: async () => null,
    findWhatsAppChannelByPhoneNumberId: async () => null,
    upsertWhatsAppChannel: async () => null,
    deactivateOtherClinicWhatsAppChannels: async () => {},
    withOnboardingTransaction: async (fn) => fn({})
  });

  const service = require(modulePath('src/services/portal-whatsapp-embedded-signup.service.js'));
  return { ...service, ...overrides };
}

async function testFinalizeRejectsTenantMismatch() {
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
      reason: 'tenant_context_loaded'
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
  mockModule('src/repositories/whatsapp-onboarding.repository.js', {
    createOnboardingSession: async () => null,
    expirePreviousPendingSessions: async () => {},
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-1',
      status: 'launching',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-a',
      redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
    }),
    findLatestOnboardingSessionByClinicId: async () => null,
    markOnboardingSessionFailed: async () => null,
    markOnboardingSessionPending: async () => null,
    markOnboardingSessionCompleted: async () => null,
    findWhatsAppChannelByPhoneNumberId: async () => null,
    upsertWhatsAppChannel: async () => null,
    deactivateOtherClinicWhatsAppChannels: async () => {},
    withOnboardingTransaction: async (fn) => fn({})
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
      reason: 'tenant_context_loaded'
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
  mockModule('src/repositories/whatsapp-onboarding.repository.js', {
    createOnboardingSession: async () => null,
    expirePreviousPendingSessions: async () => {},
    findOnboardingSessionByStateToken: async () => ({
      id: 'session-1',
      status: 'completed',
      externalTenantId: 'tenant-a',
      clinicId: 'clinic-a',
      channelId: 'channel-1',
      redirectUri: 'https://www.opturon.com/api/app/integrations/whatsapp/embedded-signup/callback'
    }),
    findLatestOnboardingSessionByClinicId: async () => null,
    markOnboardingSessionFailed: async () => null,
    markOnboardingSessionPending: async () => null,
    markOnboardingSessionCompleted: async () => null,
    findWhatsAppChannelByPhoneNumberId: async () => null,
    upsertWhatsAppChannel: async () => null,
    deactivateOtherClinicWhatsAppChannels: async () => {},
    withOnboardingTransaction: async (fn) => fn({})
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

async function run() {
  await testFinalizeRejectsTenantMismatch();
  await testFinalizeRejectsConsumedState();
  console.log('portal-whatsapp-embedded-signup-admin.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
