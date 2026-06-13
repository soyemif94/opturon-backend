const assert = require('assert');
const crypto = require('crypto');
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

const dbState = {
  queries: [],
  rowsByPhoneNumberId: new Map(),
  rowsByChannelId: new Map(),
  sessionRow: null
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function fakeQuery(text, params) {
  const sql = String(text || '').replace(/\s+/g, ' ').trim();
  dbState.queries.push({ sql, params: clone(params || []) });

  if (sql.includes('FROM channels') && sql.includes('"phoneNumberId" = $1') && sql.includes("provider = 'whatsapp_cloud'")) {
    return { rows: dbState.rowsByPhoneNumberId.has(params[0]) ? [clone(dbState.rowsByPhoneNumberId.get(params[0]))] : [] };
  }

  if (sql.includes('FROM channels') && sql.includes('WHERE id = $1') && sql.includes('"clinicId" = $2')) {
    return { rows: dbState.rowsByChannelId.has(params[0]) ? [clone(dbState.rowsByChannelId.get(params[0]))] : [] };
  }

  if (sql.startsWith('INSERT INTO channels')) {
    const row = {
      id: 'channel-new',
      clinicId: params[0],
      provider: 'whatsapp_cloud',
      phoneNumberId: params[1],
      wabaId: params[2],
      accessToken: params[3],
      displayPhoneNumber: params[4],
      verifiedName: params[5],
      status: params[6],
      connectionSource: params[7],
      connectionMetadata: params[8],
      updatedAt: '2026-06-13T00:00:00.000Z',
      createdAt: '2026-06-13T00:00:00.000Z'
    };
    dbState.rowsByPhoneNumberId.set(row.phoneNumberId, row);
    dbState.rowsByChannelId.set(row.id, row);
    return { rows: [clone(row)] };
  }

  if (sql.startsWith('UPDATE channels') && sql.includes('WHERE id = $1')) {
    const row = {
      id: params[0],
      clinicId: params[1],
      provider: 'whatsapp_cloud',
      phoneNumberId: 'phone-existing',
      wabaId: params[2],
      accessToken: params[3],
      displayPhoneNumber: params[4],
      verifiedName: params[5],
      status: params[6],
      connectionSource: params[7],
      connectionMetadata: params[8],
      updatedAt: '2026-06-13T00:00:00.000Z',
      createdAt: '2026-06-10T00:00:00.000Z'
    };
    dbState.rowsByChannelId.set(row.id, row);
    return { rows: [clone(row)] };
  }

  if (sql.includes('FROM channel_onboarding_sessions') && sql.includes('"stateToken" = $1')) {
    return { rows: dbState.sessionRow ? [clone(dbState.sessionRow)] : [] };
  }

  if (sql.startsWith('UPDATE channel_onboarding_sessions') && sql.includes("status = 'pending_meta'")) {
    dbState.sessionRow = {
      id: params[0],
      status: 'pending_meta',
      metaCode: params[1],
      metaAccessToken: params[2],
      metaTokenType: params[3],
      metaTokenExpiresAt: params[4],
      metaBusinessId: params[5],
      wabaId: params[6],
      phoneNumberId: params[7],
      displayPhoneNumber: params[8],
      verifiedName: params[9],
      errorCode: params[10],
      errorMessage: params[11],
      metadata: params[12]
    };
    return { rows: [clone(dbState.sessionRow)] };
  }

  if (sql.startsWith('UPDATE channel_onboarding_sessions') && sql.includes("status = 'completed'")) {
    dbState.sessionRow = {
      id: params[0],
      status: 'completed',
      metaCode: null,
      metaAccessToken: null,
      metaTokenType: null,
      metaTokenExpiresAt: null,
      metaBusinessId: params[5],
      wabaId: params[6],
      phoneNumberId: params[7],
      displayPhoneNumber: params[8],
      verifiedName: params[9],
      channelId: params[10],
      metadata: params[11]
    };
    return { rows: [clone(dbState.sessionRow)] };
  }

  throw new Error(`Unexpected query: ${sql}`);
}

mockModule('src/db/client.js', {
  query: fakeQuery,
  withTransaction: async (fn) => fn({ query: fakeQuery })
});

function loadRepositories() {
  clearModule('src/utils/secret-crypto.js');
  clearModule('src/repositories/tenant.repository.js');
  clearModule('src/repositories/whatsapp-onboarding.repository.js');
  return {
    cryptoUtils: require(modulePath('src/utils/secret-crypto.js')),
    tenantRepository: require(modulePath('src/repositories/tenant.repository.js')),
    onboardingRepository: require(modulePath('src/repositories/whatsapp-onboarding.repository.js'))
  };
}

function resetState() {
  dbState.queries = [];
  dbState.rowsByPhoneNumberId = new Map();
  dbState.rowsByChannelId = new Map();
  dbState.sessionRow = null;
}

async function testLegacyChannelReadCompatibility() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  resetState();
  dbState.rowsByPhoneNumberId.set('phone-legacy', {
    id: 'channel-legacy',
    clinicId: 'clinic-1',
    provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-legacy',
    wabaId: 'waba-1',
    accessToken: 'legacy-plain-token',
    status: 'active'
  });
  dbState.rowsByChannelId.set('channel-legacy', dbState.rowsByPhoneNumberId.get('phone-legacy'));

  const { tenantRepository } = loadRepositories();
  const channel = await tenantRepository.findChannelByPhoneNumberId('phone-legacy');
  const sameChannel = await tenantRepository.findChannelByIdAndClinicId('channel-legacy', 'clinic-1');

  assert.strictEqual(channel.accessToken, 'legacy-plain-token');
  assert.strictEqual(sameChannel.accessToken, 'legacy-plain-token');
}

async function testEncryptedWritesAndReads() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  resetState();
  const { cryptoUtils, onboardingRepository } = loadRepositories();

  const channel = await onboardingRepository.upsertWhatsAppChannel({
    clinicId: 'clinic-2',
    phoneNumberId: 'phone-encrypted',
    wabaId: 'waba-2',
    accessToken: 'fresh-meta-token',
    displayPhoneNumber: '+54 9 291 000 0000',
    verifiedName: 'Opturon Secure',
    status: 'active',
    connectionSource: 'embedded_signup',
    connectionMetadata: { source: 'test' }
  });

  const insertQuery = dbState.queries.find((entry) => entry.sql.startsWith('INSERT INTO channels'));
  assert.ok(insertQuery);
  assert.notStrictEqual(insertQuery.params[3], 'fresh-meta-token');
  assert.ok(cryptoUtils.isEncryptedSecret(insertQuery.params[3]));
  assert.strictEqual(channel.accessToken, 'fresh-meta-token');
}

async function testPendingSessionEncryptionAndCompletedCleanup() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  resetState();
  const { cryptoUtils, onboardingRepository } = loadRepositories();

  const pending = await onboardingRepository.markOnboardingSessionPending('session-1', {
    metaCode: 'oauth-code-secret',
    metaAccessToken: 'meta-access-token-secret',
    metaTokenType: 'bearer',
    metaBusinessId: 'business-1',
    wabaId: 'waba-1',
    phoneNumberId: 'phone-1'
  });
  const pendingQuery = dbState.queries.find((entry) => entry.sql.includes("status = 'pending_meta'"));
  assert.ok(pendingQuery);
  assert.ok(cryptoUtils.isEncryptedSecret(pendingQuery.params[1]));
  assert.ok(cryptoUtils.isEncryptedSecret(pendingQuery.params[2]));
  assert.strictEqual(pending.metaCode, 'oauth-code-secret');
  assert.strictEqual(pending.metaAccessToken, 'meta-access-token-secret');

  const completed = await onboardingRepository.markOnboardingSessionCompleted('session-1', {
    metaBusinessId: 'business-1',
    wabaId: 'waba-1',
    phoneNumberId: 'phone-1',
    channelId: 'channel-1'
  });
  const completedQuery = dbState.queries.find((entry) => entry.sql.includes("status = 'completed'"));
  assert.ok(completedQuery);
  assert.strictEqual(completedQuery.params[1], null);
  assert.strictEqual(completedQuery.params[2], null);
  assert.strictEqual(completed.metaCode, null);
  assert.strictEqual(completed.metaAccessToken, null);
}

async function run() {
  await testLegacyChannelReadCompatibility();
  await testEncryptedWritesAndReads();
  await testPendingSessionEncryptionAndCompletedCleanup();
  console.log('token-persistence-crypto.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
