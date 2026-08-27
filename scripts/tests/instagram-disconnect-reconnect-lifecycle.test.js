const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const modulePath = (relativePath) => path.join(rootDir, relativePath);

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsValue };
}

const target = {
  tenantId: 'tenant_revisor_de_meta_msijugqq',
  clinicId: '7759e87c-cdfe-4339-aee9-cca3cdd392a9',
  channelId: 'f56dba0a-c082-4b2b-8bb4-fd0a3e755960',
  instagramUserId: '28349497618013118'
};

const history = {
  conversations: [{ id: 'conversation-existing' }],
  messages: [{ id: 'message-existing' }],
  contacts: [{ id: 'contact-existing' }]
};

let channel;

function resetChannel() {
  channel = {
    id: target.channelId,
    clinicId: target.clinicId,
    type: 'instagram',
    provider: 'instagram_graph',
    externalId: target.instagramUserId,
    externalPageId: '17841430256503922',
    instagramUserId: target.instagramUserId,
    instagramUsername: 'opturonads',
    accessToken: 'ENCRYPTED_CREDENTIAL',
    status: 'active',
    connectionMetadata: { instagramAccountAliases: ['17841430256503922'] }
  };
}

mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => ({
    ok: true,
    tenantId,
    clinic: { id: tenantId === target.tenantId ? target.clinicId : 'foreign-clinic' }
  })
});

mockModule('src/repositories/tenant.repository.js', {
  listInstagramChannelsByClinicId: async (clinicId) => channel && channel.clinicId === clinicId ? [{ ...channel }] : [],
  disconnectInstagramChannelByIdAndClinicId: async (channelId, clinicId) => {
    if (!channel || channel.id !== channelId || channel.clinicId !== clinicId || channel.status !== 'active') return null;
    channel.status = 'inactive';
    channel.accessToken = null;
    channel.connectionMetadata = { ...channel.connectionMetadata, disconnectedAt: '2026-08-27T00:00:00.000Z', credentialRetired: true };
    return { ...channel };
  },
  upsertInstagramChannel: async (input) => {
    if (channel && channel.externalId === input.externalId) {
      channel = { ...channel, ...input, id: channel.id, status: 'active' };
      return { ...channel };
    }
    channel = { id: 'duplicate-channel', ...input };
    return { ...channel };
  }
});

mockModule('src/integrations/instagram/instagram.service.js', {
  exchangeOAuthCodeForAccessToken: async () => ({ accessToken: 'NEW_USER_TOKEN', tokenType: 'bearer', expiresIn: 3600 }),
  logInstagramOAuthCodeTelemetry: () => {},
  fetchInstagramBusinessAssets: async () => [{
    pageId: '17841430256503922',
    pageName: 'Opturon Ads',
    pageAccessToken: 'NEW_ENCRYPTED_CREDENTIAL',
    instagramBusinessAccountId: target.instagramUserId,
    instagramUsername: 'opturonads'
  }],
  subscribePageToWebhook: async () => ({ ok: true })
});

mockModule('src/utils/logger.js', { logInfo: () => {}, logWarn: () => {} });

delete require.cache[modulePath('src/services/portal-instagram.service.js')];
const {
  connectPortalInstagramChannel,
  disconnectPortalInstagramChannel,
  getPortalInstagramConnectionStatus
} = require(modulePath('src/services/portal-instagram.service.js'));

async function run() {
  resetChannel();
  const historyBefore = JSON.stringify(history);

  const connected = await getPortalInstagramConnectionStatus(target.tenantId);
  assert.equal(connected.state, 'connected');

  const foreignAttempt = await disconnectPortalInstagramChannel('foreign-tenant', { channelId: target.channelId });
  assert.equal(foreignAttempt.ok, false);
  assert.equal(foreignAttempt.reason, 'instagram_channel_not_found_or_forbidden');
  assert.equal(channel.status, 'active');

  const disconnected = await disconnectPortalInstagramChannel(target.tenantId, { channelId: target.channelId });
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.state, 'not_connected');
  assert.equal(channel.status, 'inactive');
  assert.equal(channel.accessToken, null);
  assert.equal(JSON.stringify(history), historyBefore);

  const afterDisconnect = await getPortalInstagramConnectionStatus(target.tenantId);
  assert.equal(afterDisconnect.state, 'not_connected');
  assert.equal(afterDisconnect.channel, null);

  const reconnected = await connectPortalInstagramChannel(target.tenantId, {
    code: 'fresh-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback',
    oauthProvider: 'instagram_login'
  });
  assert.equal(reconnected.ok, true);
  assert.equal(reconnected.channel.id, target.channelId);
  assert.equal(channel.status, 'active');
  assert.equal(channel.accessToken, 'NEW_ENCRYPTED_CREDENTIAL');
  assert.equal(JSON.stringify(history), historyBefore);

  const repositorySource = fs.readFileSync(modulePath('src/repositories/tenant.repository.js'), 'utf8');
  assert.match(repositorySource, /"accessToken" = NULL/);
  assert.match(repositorySource, /type = 'instagram'/);
  assert.match(repositorySource, /provider = 'instagram_graph'/);
  assert.match(repositorySource, /AND "clinicId" = \$2/);
  assert.match(repositorySource, /'disconnectedAt', NOW\(\)/);
  assert.doesNotMatch(repositorySource, /DELETE FROM (?:conversations|messages|contacts)/);

  console.log('instagram-disconnect-reconnect-lifecycle.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
