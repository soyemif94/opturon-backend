const test = require('node:test');
const assert = require('node:assert/strict');

test('rollback requires explicit confirmation, verifies provider state, and only re-registers Cloud API', async (t) => {
  const repositoryPath = require.resolve('../../src/repositories/whatsapp-channel-transition.repository');
  const readinessPath = require.resolve('../../src/whatsapp/whatsapp-transition-provider-readiness');
  const embeddedPath = require.resolve('../../src/services/portal-whatsapp-embedded-signup.service');
  const servicePath = require.resolve('../../src/services/whatsapp-channel-transition.service');
  const oldRepository = require.cache[repositoryPath];
  const oldReadiness = require.cache[readinessPath];
  const oldEmbedded = require.cache[embeddedPath];
  const oldService = require.cache[servicePath];
  const transition = {
    id: 'transition-safe-id', clinicId: 'clinic-safe-id', channelId: 'channel-safe-id',
    status: 'rollback_pending', originalWabaId: 'waba-safe-id', originalNormalizedPhone: '+5491188888810',
    originalPhoneNumberId: 'phone-old', candidatePhoneNumberId: 'phone-new',
    accessToken: 'TEST_ONLY_TOKEN_NOT_FOR_OUTPUT'
  };
  const registrations = [];
  let providerReads = 0;
  require.cache[repositoryPath] = {
    id: repositoryPath, filename: repositoryPath, loaded: true,
    exports: {
      findWhatsAppChannelTransitionById: async () => transition,
      persistTransitionChannelRebind: async (input) => {
        assert.equal(input.phoneNumberId, 'phone-new');
        assert.equal(input.connectionMode, 'API_ONLY');
        assert.equal(input.terminalStatus, 'rolled_back');
        return { ok: true, replayed: false, channelId: transition.channelId };
      }
    }
  };
  require.cache[readinessPath] = {
    id: readinessPath, filename: readinessPath, loaded: true,
    exports: {
      REQUIRED_WEBHOOK_FIELDS: ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'],
      readWhatsAppTransitionProviderEvidence: async (input) => {
        providerReads += 1;
        assert.equal(input.phoneNumberId, 'phone-new');
        return {
          ok: true, ready: true, phoneNumberId: 'phone-new', wabaId: 'waba-safe-id',
          displayPhoneNumber: '+54 9 11 8888 8810', platformType: 'CLOUD_API', isOnBizApp: false
        };
      }
    }
  };
  require.cache[embeddedPath] = {
    id: embeddedPath, filename: embeddedPath, loaded: true,
    exports: {
      ensureWhatsAppPhoneRegistered: async (input) => {
        registrations.push({
          clinicId: input.clinicId, phoneNumberId: input.phoneNumberId,
          force: input.force, hasAccessToken: Boolean(input.accessToken)
        });
      }
    }
  };
  delete require.cache[servicePath];
  t.after(() => {
    if (oldRepository) require.cache[repositoryPath] = oldRepository; else delete require.cache[repositoryPath];
    if (oldReadiness) require.cache[readinessPath] = oldReadiness; else delete require.cache[readinessPath];
    if (oldEmbedded) require.cache[embeddedPath] = oldEmbedded; else delete require.cache[embeddedPath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath];
  });

  const service = require(servicePath);
  const unconfirmed = await service.executeWhatsAppTransitionRollback(transition.id, false);
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.reason, 'rollback_confirmation_required');
  assert.equal(providerReads, 0);
  assert.equal(registrations.length, 0);

  const result = await service.executeWhatsAppTransitionRollback(transition.id, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.channelId, transition.channelId);
  assert.equal(providerReads, 2, 'state is checked both before and after registration');
  assert.deepEqual(registrations, [{
    clinicId: transition.clinicId, phoneNumberId: 'phone-new', force: true, hasAccessToken: true
  }]);
  assert.ok(!JSON.stringify(result).includes('TEST_ONLY_TOKEN_NOT_FOR_OUTPUT'));
});

console.log('whatsapp-transition-rollback.test.js passed');
