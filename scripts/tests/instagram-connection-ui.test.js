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

const state = {
  tenantId: 'tenant-1',
  clinicId: 'clinic-1',
  assets: [],
  upserted: [],
  subscribed: [],
  longLivedExchanges: [],
  identityTokens: [],
  failLongLivedExchange: false
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetState() {
  state.assets = [];
  state.upserted = [];
  state.subscribed = [];
  state.longLivedExchanges = [];
  state.identityTokens = [];
  state.failLongLivedExchange = false;
}

function buildAsset(overrides = {}) {
  return {
    pageId: 'page-1',
    pageName: 'Opturon Page',
    pageAccessToken: 'PAGE_TOKEN_SECRET',
    instagramBusinessAccountId: 'ig-1',
    instagramUsername: 'opturon.qa',
    ...overrides
  };
}

mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => ({
    ok: true,
    tenantId,
    clinic: {
      id: state.clinicId,
      name: 'Clinic QA'
    },
    channel: null,
    reason: 'resolved'
  })
});

mockModule('src/repositories/tenant.repository.js', {
  listInstagramChannelsByClinicId: async () => [],
  upsertInstagramChannel: async (input) => {
    state.upserted.push(clone(input));
    return {
      id: `channel-${state.upserted.length}`,
      clinicId: input.clinicId,
      type: 'instagram',
      provider: 'instagram_graph',
      externalId: input.externalId,
      externalPageId: input.externalPageId,
      externalPageName: input.externalPageName,
      instagramUserId: input.instagramUserId,
      instagramUsername: input.instagramUsername,
      status: input.status,
      updatedAt: '2026-07-10T00:00:00.000Z'
    };
  }
});

mockModule('src/integrations/instagram/instagram.service.js', {
  logInstagramOAuthCodeTelemetry: () => {},
  exchangeOAuthCodeForAccessToken: async ({ providerOverride }) => ({
    provider: providerOverride || 'facebook_login',
    accessToken: 'USER_TOKEN_SECRET',
    tokenType: 'bearer',
    expiresIn: 3600
  }),
  exchangeInstagramLongLivedToken: async ({ shortLivedAccessToken }) => {
    state.longLivedExchanges.push(shortLivedAccessToken);
    if (state.failLongLivedExchange) {
      const error = new Error('instagram_long_lived_exchange_failed');
      error.reason = 'instagram_long_lived_exchange_failed';
      throw error;
    }
    return {
      provider: 'instagram_login',
      accessToken: 'LONG_LIVED_TOKEN_SECRET',
      tokenType: 'long_lived',
      providerTokenType: 'bearer',
      expiresIn: 5184000,
      obtainedAt: '2026-08-28T04:00:00.000Z',
      expiresAt: '2026-10-27T04:00:00.000Z'
    };
  },
  fetchInstagramBusinessAssets: async ({ accessToken }) => {
    state.identityTokens.push(accessToken);
    return clone(state.assets).map((asset) => accessToken === 'LONG_LIVED_TOKEN_SECRET'
      ? { ...asset, pageAccessToken: accessToken }
      : asset);
  },
  subscribePageToWebhook: async ({ pageId, accessToken, providerOverride }) => {
    state.subscribed.push({ pageId, accessToken, providerOverride });
    return { ok: true };
  }
});

mockModule('src/utils/logger.js', {
  logInfo: () => {},
  logWarn: () => {}
});

clearModule('src/services/portal-instagram.service.js');
const { connectPortalInstagramChannel } = require(modulePath('src/services/portal-instagram.service.js'));

async function testMultipleAssetsReturnsSafeCandidatesWithoutTokens() {
  resetState();
  state.assets = [
    buildAsset(),
    buildAsset({
      pageId: 'page-2',
      pageName: 'Second Page',
      pageAccessToken: 'SECOND_PAGE_TOKEN_SECRET',
      instagramBusinessAccountId: 'ig-2',
      instagramUsername: 'second.qa'
    })
  ];

  const result = await connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'instagram_multiple_assets_found');
  assert.equal(result.details.assetCount, 2);
  assert.ok(result.details.selectionToken);
  assert.equal(result.details.candidates.length, 2);
  assert.deepEqual(result.details.candidates[0], {
    pageId: 'page-1',
    pageName: 'Opturon Page',
    instagramUserId: 'ig-1',
    instagramUsername: 'opturon.qa'
  });
  assert.doesNotMatch(JSON.stringify(result.details), /TOKEN_SECRET/);
}

async function testSelectedAssetConnectsExpectedChannel() {
  resetState();
  state.assets = [
    buildAsset(),
    buildAsset({
      pageId: 'page-2',
      pageName: 'Second Page',
      pageAccessToken: 'SECOND_PAGE_TOKEN_SECRET',
      instagramBusinessAccountId: 'ig-2',
      instagramUsername: 'second.qa'
    })
  ];

  const multiple = await connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback'
  });

  const connected = await connectPortalInstagramChannel(state.tenantId, {
    selectionToken: multiple.details.selectionToken,
    selectedPageId: 'page-2',
    selectedInstagramUserId: 'ig-2'
  });

  assert.equal(connected.ok, true);
  assert.equal(connected.channel.externalPageId, 'page-2');
  assert.equal(connected.channel.instagramUserId, 'ig-2');
  assert.equal(state.subscribed.length, 1);
  assert.deepEqual(state.subscribed[0], {
    pageId: 'page-2',
    accessToken: 'SECOND_PAGE_TOKEN_SECRET',
    providerOverride: 'facebook_login'
  });
  assert.equal(state.upserted.length, 1);
  assert.equal(state.upserted[0].externalId, 'ig-2');
  assert.equal(state.upserted[0].externalPageId, 'page-2');
}

async function testOauthProviderOverridePropagatesAcrossExchangeAndSubscription() {
  resetState();
  state.assets = [buildAsset()];

  const connected = await connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback',
    oauthProvider: 'instagram_login'
  });

  assert.equal(connected.ok, true);
  assert.deepEqual(state.longLivedExchanges, ['USER_TOKEN_SECRET']);
  assert.deepEqual(state.identityTokens, ['LONG_LIVED_TOKEN_SECRET']);
  assert.equal(state.subscribed.length, 1);
  assert.equal(state.subscribed[0].providerOverride, 'instagram_login');
  assert.equal(state.subscribed[0].accessToken, 'LONG_LIVED_TOKEN_SECRET');
  assert.equal(state.upserted[0].accessToken, 'LONG_LIVED_TOKEN_SECRET');
  assert.equal(state.upserted[0].connectionMetadata.oauthTokenType, 'long_lived');
  assert.equal(state.upserted[0].connectionMetadata.oauthProviderTokenType, 'bearer');
  assert.equal(state.upserted[0].connectionMetadata.oauthExpiresIn, 5184000);
  assert.equal(state.upserted[0].connectionMetadata.oauthTokenObtainedAt, '2026-08-28T04:00:00.000Z');
  assert.equal(state.upserted[0].connectionMetadata.oauthTokenExpiresAt, '2026-10-27T04:00:00.000Z');
}

async function testLongLivedExchangeFailurePersistsNothing() {
  resetState();
  state.assets = [buildAsset()];
  state.failLongLivedExchange = true;

  await assert.rejects(() => connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback',
    oauthProvider: 'instagram_login'
  }), (error) => error && error.reason === 'instagram_long_lived_exchange_failed');

  assert.deepEqual(state.longLivedExchanges, ['USER_TOKEN_SECRET']);
  assert.equal(state.identityTokens.length, 0);
  assert.equal(state.subscribed.length, 0);
  assert.equal(state.upserted.length, 0);
}

async function testUnknownOauthProviderRejected() {
  resetState();
  state.assets = [buildAsset()];

  const result = await connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback',
    oauthProvider: 'evil_provider'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_instagram_oauth_provider');
  assert.equal(state.subscribed.length, 0);
}

async function testSelectionTokenCannotBeReused() {
  resetState();
  state.assets = [buildAsset(), buildAsset({ pageId: 'page-2', instagramBusinessAccountId: 'ig-2' })];
  const multiple = await connectPortalInstagramChannel(state.tenantId, {
    code: 'oauth-code',
    redirectUri: 'https://www.opturon.com/api/app/integrations/instagram/callback'
  });

  await connectPortalInstagramChannel(state.tenantId, {
    selectionToken: multiple.details.selectionToken,
    selectedPageId: 'page-1'
  });
  const reused = await connectPortalInstagramChannel(state.tenantId, {
    selectionToken: multiple.details.selectionToken,
    selectedPageId: 'page-2'
  });

  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'instagram_asset_selection_expired');
}

async function run() {
  await testMultipleAssetsReturnsSafeCandidatesWithoutTokens();
  await testSelectedAssetConnectsExpectedChannel();
  await testOauthProviderOverridePropagatesAcrossExchangeAndSubscription();
  await testLongLivedExchangeFailurePersistsNothing();
  await testUnknownOauthProviderRejected();
  await testSelectionTokenCannotBeReused();
  console.log('instagram-connection-ui.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
