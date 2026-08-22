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

const state = {
  persistedChannel: null,
  upsertPayload: null,
  cutoverPayload: null
};

mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => ({
    ok: true,
    tenantId,
    clinic: {
      id: 'clinic-1',
      name: 'Clinic 1'
    },
    channel: tenantId === 'tenant-cutover' ? {
      id: 'channel-existing',
      clinicId: 'clinic-1',
      phoneNumberId: 'phone-old',
      wabaId: 'waba-old'
    } : null
  })
});

mockModule('src/repositories/whatsapp-onboarding.repository.js', {
  findWhatsAppChannelByPhoneNumberId: async () => null,
  upsertWhatsAppChannel: async (payload) => {
    state.upsertPayload = payload;
    state.persistedChannel = {
      id: 'channel-1',
      clinicId: payload.clinicId,
      provider: 'whatsapp_cloud',
      phoneNumberId: payload.phoneNumberId,
      wabaId: payload.wabaId,
      accessToken: 'decrypted-runtime-token',
      displayPhoneNumber: payload.displayPhoneNumber,
      verifiedName: payload.verifiedName,
      status: payload.status,
      connectionSource: payload.connectionSource,
      connectionMetadata: payload.connectionMetadata,
      updatedAt: '2026-06-13T00:00:00.000Z',
      createdAt: '2026-06-12T00:00:00.000Z'
    };
    return state.persistedChannel;
  },
  updateWhatsAppChannelAssetCredentials: async (channelId, clinicId, payload) => {
    state.cutoverPayload = { channelId, clinicId, payload };
    return {
      id: channelId,
      clinicId,
      provider: 'whatsapp_cloud',
      phoneNumberId: payload.phoneNumberId,
      wabaId: payload.wabaId,
      accessToken: 'decrypted-runtime-token',
      displayPhoneNumber: payload.displayPhoneNumber,
      verifiedName: payload.verifiedName,
      status: payload.status,
      connectionSource: payload.connectionSource,
      connectionMetadata: payload.connectionMetadata
    };
  },
  reassignWhatsAppChannelToClinic: async () => null,
  deactivateOtherClinicWhatsAppChannels: async () => null,
  withOnboardingTransaction: async (fn) => fn({})
});

mockModule('src/services/portal-whatsapp-assets.service.js', {
  normalizeString: (value) => String(value || '').trim(),
  buildReason: (reason, detail, extra = null) => ({ ok: false, reason, detail, ...(extra || {}) }),
  extractGraphErrorMeta: () => ({}),
  inferMetaDomainReason: () => 'meta_graph_failed',
  buildMetaGraphDetail: () => 'meta_graph_failed',
  listWhatsAppAssetsForWaba: async () => ({
    ok: true,
    items: [
      {
        phoneNumberId: 'phone-1',
        displayPhoneNumber: '+54 9 291 123 4567',
        verifiedName: 'Opturon',
        wabaName: 'WABA Test'
      }
    ]
  })
});

mockModule('src/whatsapp/whatsapp-graph.client.js', {
  request: async () => ({ ok: true, data: { success: true } })
});

mockModule('src/utils/logger.js', {
  logInfo: () => {},
  logWarn: () => {}
});

const { connectPortalWhatsAppManual } = require(modulePath('src/services/portal-whatsapp-manual-onboarding.service.js'));

async function run() {
  const result = await connectPortalWhatsAppManual('tenant-1', {
    wabaId: 'waba-1',
    phoneNumberId: 'phone-1',
    accessToken: 'plain-meta-token',
    channelName: 'Secure Channel'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.channel.phoneNumberId, 'phone-1');
  assert.strictEqual(result.channel.wabaId, 'waba-1');
  assert.ok(!Object.prototype.hasOwnProperty.call(result.channel, 'accessToken'));
  assert.strictEqual(state.upsertPayload.accessToken, 'plain-meta-token');

  state.upsertPayload = null;
  const cutover = await connectPortalWhatsAppManual('tenant-cutover', {
    wabaId: 'waba-1',
    phoneNumberId: 'phone-1',
    accessToken: 'rotated-meta-token',
    channelName: 'Production Channel'
  });
  assert.strictEqual(cutover.ok, true);
  assert.strictEqual(cutover.channelAction, 'cutover');
  assert.strictEqual(cutover.channel.id, 'channel-existing');
  assert.strictEqual(state.upsertPayload, null);
  assert.deepStrictEqual(
    { channelId: state.cutoverPayload.channelId, clinicId: state.cutoverPayload.clinicId },
    { channelId: 'channel-existing', clinicId: 'clinic-1' }
  );
  assert.strictEqual(state.cutoverPayload.payload.accessToken, 'rotated-meta-token');

  const source = require('fs').readFileSync(modulePath('src/services/portal-whatsapp-manual-onboarding.service.js'), 'utf8');
  assert.doesNotMatch(source, /slice\(0, 4\).*slice\(-4\)/s);
  assert.match(source, /fingerprint/);
  console.log('portal-whatsapp-manual-onboarding.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
