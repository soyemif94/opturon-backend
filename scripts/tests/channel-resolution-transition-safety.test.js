const test = require('node:test');
const assert = require('node:assert/strict');

test('configured-channel sync cannot reactivate or rewrite a channel during transition', async (t) => {
  const envPath = require.resolve('../../src/config/env');
  const dbPath = require.resolve('../../src/db/client');
  const tenantPath = require.resolve('../../src/repositories/tenant.repository');
  const servicePath = require.resolve('../../src/services/channel-resolution.service');
  const oldEnv = require.cache[envPath];
  const oldDb = require.cache[dbPath];
  const oldTenant = require.cache[tenantPath];
  const oldService = require.cache[servicePath];
  let lookupCalled = false;
  const channel = {
    id: 'channel-safe', clinicId: 'clinic-safe', provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-transition', wabaId: 'waba-safe', connectionMode: 'API_ONLY',
    status: 'transitioning', updatedAt: new Date(), createdAt: new Date()
  };
  require.cache[envPath] = {
    id: envPath, filename: envPath, loaded: true,
    exports: { whatsappPhoneNumberId: 'phone-transition', whatsappWabaId: 'waba-safe', whatsappAccessToken: 'secret' }
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async () => ({ rows: [channel] }) }
  };
  require.cache[tenantPath] = {
    id: tenantPath, filename: tenantPath, loaded: true,
    exports: {
      findChannelByPhoneNumberId: async () => { lookupCalled = true; return null; },
      findWhatsAppChannelByPhoneNumberIdIncludingInactive: async () => null
    }
  };
  delete require.cache[servicePath];
  t.after(() => {
    if (oldEnv) require.cache[envPath] = oldEnv; else delete require.cache[envPath];
    if (oldDb) require.cache[dbPath] = oldDb; else delete require.cache[dbPath];
    if (oldTenant) require.cache[tenantPath] = oldTenant; else delete require.cache[tenantPath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath];
  });

  const { getConfiguredChannelStatus } = require(servicePath);
  const result = await getConfiguredChannelStatus({ autoCreate: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'whatsapp_channel_transition_in_progress');
  assert.equal(result.channel.status, 'transitioning');
  assert.equal(lookupCalled, false, 'transitioning channels must not enter auto-reactivation or auto-create logic');
});

test('configured-channel sync refuses an old phone ID that is only a transition alias', async (t) => {
  const envPath = require.resolve('../../src/config/env');
  const dbPath = require.resolve('../../src/db/client');
  const tenantPath = require.resolve('../../src/repositories/tenant.repository');
  const servicePath = require.resolve('../../src/services/channel-resolution.service');
  const oldEnv = require.cache[envPath];
  const oldDb = require.cache[dbPath];
  const oldTenant = require.cache[tenantPath];
  const oldService = require.cache[servicePath];
  let directLookupCalled = false;
  const currentChannel = {
    id: 'channel-safe', clinicId: 'clinic-safe', provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-current', wabaId: 'waba-safe', status: 'active'
  };
  require.cache[envPath] = {
    id: envPath, filename: envPath, loaded: true,
    exports: { whatsappPhoneNumberId: 'phone-old', whatsappWabaId: 'waba-safe', whatsappAccessToken: 'secret' }
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async () => ({ rows: [currentChannel] }) }
  };
  require.cache[tenantPath] = {
    id: tenantPath, filename: tenantPath, loaded: true,
    exports: {
      findWhatsAppChannelByPhoneNumberIdIncludingInactive: async () => ({ ...currentChannel, matchedViaAlias: true }),
      findChannelByPhoneNumberId: async () => { directLookupCalled = true; return currentChannel; }
    }
  };
  delete require.cache[servicePath];
  t.after(() => {
    if (oldEnv) require.cache[envPath] = oldEnv; else delete require.cache[envPath];
    if (oldDb) require.cache[dbPath] = oldDb; else delete require.cache[dbPath];
    if (oldTenant) require.cache[tenantPath] = oldTenant; else delete require.cache[tenantPath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath];
  });

  const { getConfiguredChannelStatus } = require(servicePath);
  const result = await getConfiguredChannelStatus({ autoCreate: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configured_phone_id_is_transition_alias');
  assert.equal(result.channel.id, 'channel-safe');
  assert.equal(directLookupCalled, false, 'an old alias must not enter active-channel metadata sync');
});

console.log('channel-resolution-transition-safety.test.js passed');
