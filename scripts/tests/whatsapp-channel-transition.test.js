const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const clinicA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clinicB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const channelA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const channelB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const conversationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const externalTenantId = 'tenant-transition-test';
const testNumber = '+5491188888810';
const secret = 'DO_NOT_PERSIST_OR_RETURN_TEST_ACCESS_TOKEN';
process.env.TOKENS_ENCRYPTION_KEY ||= 'a'.repeat(64);
const requiredWebhookFields = ['messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'];

async function makeDatabase(t) {
  const db = new PGlite();
  for (const file of [
    '../../src/repositories/whatsapp-channel-transition.repository',
    '../../src/repositories/whatsapp-coexistence.repository',
    '../../src/repositories/tenant.repository',
    '../../src/services/whatsapp-channel-transition.service',
    '../../src/whatsapp/whatsapp-transition-provider-readiness'
  ]) delete require.cache[require.resolve(file)];
  await db.exec(`
    CREATE TABLE clinics (
      id uuid PRIMARY KEY, name text NOT NULL, "externalTenantId" text,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE channels (
      id uuid PRIMARY KEY, "clinicId" uuid NOT NULL REFERENCES clinics(id), type text,
      provider text NOT NULL, "phoneNumberId" text NOT NULL UNIQUE, "wabaId" text,
      "externalId" text, "externalPageId" text, "externalPageName" text,
      "instagramUserId" text, "instagramUsername" text,
      "accessToken" text, "displayPhoneNumber" text, "verifiedName" text,
      "connectionMode" text, status text NOT NULL DEFAULT 'active', "connectionSource" text,
      "connectionMetadata" jsonb, "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE conversations (
      id uuid PRIMARY KEY, "clinicId" uuid NOT NULL REFERENCES clinics(id),
      "channelId" uuid NOT NULL REFERENCES channels(id), "contactId" uuid,
      status text NOT NULL DEFAULT 'open'
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" uuid NOT NULL,
      "channelId" uuid NOT NULL, type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
      "maxAttempts" integer NOT NULL DEFAULT 10, "runAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.exec(fs.readFileSync(path.join(root, 'db/migrations/094_whatsapp_coexistence.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(root, 'db/migrations/095_whatsapp_channel_transition.sql'), 'utf8'));
  await db.query('INSERT INTO clinics(id, name, "externalTenantId", settings) VALUES ($1, $2, $3, $4::jsonb), ($5, $6, $7, $8::jsonb)', [
    clinicA, 'Controlled tenant', externalTenantId, JSON.stringify({ botActive: true }),
    clinicB, 'Other tenant', 'tenant-other', JSON.stringify({ botActive: false })
  ]);
  await db.query(`INSERT INTO channels
    (id, "clinicId", type, provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "verifiedName", "connectionMode", status, "connectionSource", "connectionMetadata")
    VALUES ($1, $2, 'whatsapp', 'whatsapp_cloud', 'phone-old', 'waba-controlled', $3, $4, 'Controlled', 'API_ONLY', 'active', 'embedded_signup', $5::jsonb)`, [
    channelA, clinicA, secret, testNumber, JSON.stringify({ onboardingProvider: 'meta_embedded_signup', subscriptionOk: true })
  ]);
  await db.query(`INSERT INTO channels
    (id, "clinicId", type, provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "connectionMode", status)
    VALUES ($1, $2, 'whatsapp', 'whatsapp_cloud', 'phone-owned-by-other', 'waba-other', 'opaque', '+5491199999999', 'API_ONLY', 'active')`, [channelB, clinicB]);
  await db.query('INSERT INTO conversations(id, "clinicId", "channelId") VALUES ($1, $2, $3)', [conversationId, clinicA, channelA]);

  const dbPath = require.resolve('../../src/db/client');
  const oldDbModule = require.cache[dbPath];
  const client = {
    query: (sql, params) => String(sql).includes('CREATE TABLE IF NOT EXISTS whatsapp_channel_transitions')
      ? db.exec(sql).then(() => ({ rows: [] }))
      : db.query(sql, params)
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      query: client.query,
      withTransaction: (fn) => fn(client)
    }
  };
  const readinessPath = require.resolve('../../src/whatsapp/whatsapp-transition-provider-readiness');
  const oldReadiness = require.cache[readinessPath];
  require.cache[readinessPath] = {
    id: readinessPath, filename: readinessPath, loaded: true,
    exports: {
      REQUIRED_WEBHOOK_FIELDS: requiredWebhookFields,
      readWhatsAppTransitionProviderEvidence: async ({ wabaId, phoneNumberId }) => ({
        ok: true, ready: true, wabaId, phoneNumberId, displayPhoneNumber: testNumber,
        platformType: 'CLOUD_API', isOnBizApp: false, appId: 'test-app', appSubscribed: true,
        webhookActive: true, callbackUrlMatches: true, subscribedFields: requiredWebhookFields
      })
    }
  };
  t.after(async () => {
    if (oldDbModule) require.cache[dbPath] = oldDbModule;
    else delete require.cache[dbPath];
    if (oldReadiness) require.cache[readinessPath] = oldReadiness;
    else delete require.cache[readinessPath];
    for (const file of [
      '../../src/repositories/whatsapp-channel-transition.repository',
      '../../src/repositories/whatsapp-coexistence.repository',
      '../../src/repositories/tenant.repository',
      '../../src/services/whatsapp-channel-transition.service',
      '../../src/whatsapp/whatsapp-transition-provider-readiness'
    ]) {
      delete require.cache[require.resolve(file)];
    }
    await db.close();
  });
  return db;
}

async function prepare(db, externalId = externalTenantId) {
  const service = require('../../src/services/whatsapp-channel-transition.service');
  const result = await service.prepareWhatsAppChannelTransition(externalId, 'admin-user-id');
  assert.equal(result.ok, true);
  return { service, result };
}

async function advanceToOnboarding(service, transitionId) {
  for (const status of ['cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding']) {
    const result = await service.advanceWhatsAppChannelTransition(transitionId, status);
    assert.equal(result.ok, true, `stage ${status} should be accepted`);
  }
}

test('095 migration provides durable transition snapshots and expiring identity aliases', async (t) => {
  const db = await makeDatabase(t);
  const schema = await db.query(`
    SELECT to_regclass('whatsapp_channel_transitions') IS NOT NULL AS transitions,
           to_regclass('whatsapp_channel_phone_aliases') IS NOT NULL AS aliases
  `);
  assert.equal(schema.rows[0].transitions, true);
  assert.equal(schema.rows[0].aliases, true);
  const ensured = await require('../../src/db/ensure-whatsapp-channel-transition')
    .ensureWhatsAppChannelTransitionSchema();
  assert.equal(ensured.migration, '095_whatsapp_channel_transition.sql');
  assert.equal(Number(ensured.schema.transitionColumns), 18);
  const recorded = await db.query('SELECT name FROM schema_migrations WHERE name = $1', ['095_whatsapp_channel_transition.sql']);
  assert.equal(recorded.rows.length, 1);
  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(server, /ensureWhatsAppChannelTransitionSchema\(\)/);
});

test('prepare is idempotent and stores only curated non-secret channel state', async (t) => {
  const db = await makeDatabase(t);
  const { result } = await prepare(db);
  const retry = await require('../../src/services/whatsapp-channel-transition.service')
    .prepareWhatsAppChannelTransition(externalTenantId, 'another-admin');
  assert.equal(result.rollbackReady, true);
  assert.equal(retry.transitionId, result.transitionId);
  assert.equal(retry.replayed, true);
  assert.equal(result.phoneNumberMasked, '+54••••8810');
  const saved = await db.query('SELECT snapshot::text AS snapshot, status FROM whatsapp_channel_transitions WHERE id = $1', [result.transitionId]);
  assert.equal(saved.rows[0].status, 'prepared');
  assert.ok(!saved.rows[0].snapshot.includes(secret));
  assert.ok(!saved.rows[0].snapshot.toLowerCase().includes('token'));
  assert.equal(JSON.parse(saved.rows[0].snapshot).botActive, true);
  assert.equal(JSON.parse(saved.rows[0].snapshot).webhookAssociation.channelId, channelA);
  const token = await db.query('SELECT "accessToken" FROM channels WHERE id = $1', [channelA]);
  assert.equal(token.rows[0].accessToken, secret, 'prepare must not alter the working channel credential');
});

test('same phone ID API_ONLY to Coexistence keeps one channel and linked conversation', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  const transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  const completed = await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition,
    provider: {
      phoneNumberId: 'phone-old', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    },
    accessToken: 'new-opaque-test-token'
  });
  assert.equal(completed.ok, true);
  const channel = await db.query('SELECT id, "phoneNumberId", "connectionMode", status FROM channels WHERE "clinicId" = $1', [clinicA]);
  const conversation = await db.query('SELECT "channelId" FROM conversations WHERE id = $1', [conversationId]);
  assert.equal(channel.rows.length, 1);
  assert.equal(channel.rows[0].id, channelA);
  assert.equal(channel.rows[0].phoneNumberId, 'phone-old');
  assert.equal(channel.rows[0].connectionMode, 'COEXISTENCE');
  assert.equal(channel.rows[0].status, 'active');
  assert.equal(conversation.rows[0].channelId, channelA);
});

test('new phone ID for the exact same E.164 rebinds the same channel and old webhook alias', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  const transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  const completed = await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition,
    provider: {
      phoneNumberId: 'phone-new', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    },
    accessToken: 'new-opaque-test-token'
  });
  assert.equal(completed.ok, true);
  const channel = await db.query('SELECT id, "phoneNumberId", "connectionMode" FROM channels WHERE "clinicId" = $1', [clinicA]);
  const alias = await db.query('SELECT "channelId", "clinicId", "wabaId" FROM whatsapp_channel_phone_aliases WHERE "phoneNumberId" = $1', ['phone-old']);
  const conversation = await db.query('SELECT "channelId" FROM conversations WHERE id = $1', [conversationId]);
  assert.deepEqual(channel.rows[0], { id: channelA, phoneNumberId: 'phone-new', connectionMode: 'COEXISTENCE' });
  assert.equal(alias.rows.length, 1);
  assert.equal(alias.rows[0].channelId, channelA);
  assert.equal(alias.rows[0].clinicId, clinicA);
  assert.equal(alias.rows[0].wabaId, 'waba-controlled');
  assert.equal(conversation.rows[0].channelId, channelA);

  const tenantRepository = require('../../src/repositories/tenant.repository');
  const resolved = await tenantRepository.findChannelByPhoneNumberId('phone-old');
  assert.equal(resolved.id, channelA);
  const coexistence = require('../../src/repositories/whatsapp-coexistence.repository');
  const channels = await coexistence.resolveChannelsForEvent({ field: 'history', phoneNumberId: 'phone-old', wabaId: 'waba-controlled' });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, channelA);
});

test('number and WABA mismatches fail closed without updating channel identity', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  const transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  const base = { platformType: 'CLOUD_API', isOnBizApp: true, phoneNumberId: 'phone-new' };
  const numberMismatch = await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition, provider: { ...base, wabaId: 'waba-controlled', displayPhoneNumber: '+5491199999999' }, accessToken: 'x'
  });
  const wabaMismatch = await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition, provider: { ...base, wabaId: 'waba-unexpected', displayPhoneNumber: testNumber }, accessToken: 'x'
  });
  assert.equal(numberMismatch.reason, 'transition_phone_number_mismatch');
  assert.equal(wabaMismatch.reason, 'transition_waba_mismatch');
  const saved = await db.query('SELECT "phoneNumberId", "connectionMode" FROM channels WHERE id = $1', [channelA]);
  assert.equal(saved.rows[0].phoneNumberId, 'phone-old');
  assert.equal(saved.rows[0].connectionMode, 'API_ONLY');
});

test('phone ID already owned by another tenant cannot be rebound', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  const transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  const rejected = await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition,
    provider: {
      phoneNumberId: 'phone-owned-by-other', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    },
    accessToken: 'x'
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'phone_number_id_owned_by_another_channel');
  const channel = await db.query('SELECT "phoneNumberId", "connectionMode" FROM channels WHERE id = $1', [channelA]);
  assert.equal(channel.rows[0].phoneNumberId, 'phone-old');
  assert.equal(channel.rows[0].connectionMode, 'API_ONLY');
});

test('durable transition survives repository reload and duplicate callback is idempotent', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  const repoPath = require.resolve('../../src/repositories/whatsapp-channel-transition.repository');
  delete require.cache[repoPath];
  const reloaded = require(repoPath);
  const transition = await reloaded.findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  assert.equal(transition.id, result.transitionId);
  assert.equal(transition.status, 'coexistence_onboarding');
  const input = {
    transition,
    provider: {
      phoneNumberId: 'phone-new', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    },
    accessToken: 'new-opaque-test-token'
  };
  assert.equal((await service.validateAndCompleteWhatsAppCoexistenceTransition(input)).ok, true);
  const completedTransition = await reloaded.findWhatsAppChannelTransitionById(result.transitionId);
  const duplicate = await service.validateAndCompleteWhatsAppCoexistenceTransition({ ...input, transition: completedTransition });
  assert.equal(duplicate.ok, true);
  const counts = await db.query('SELECT count(*)::int AS channels FROM channels WHERE "clinicId" = $1', [clinicA]);
  const transitions = await db.query('SELECT count(*)::int AS transitions FROM whatsapp_channel_transitions WHERE "channelId" = $1', [channelA]);
  assert.equal(counts.rows[0].channels, 1);
  assert.equal(transitions.rows[0].transitions, 1);
});

test('rollback dry-run accepts original or new phone ID only after verified Cloud API state', async () => {
  const service = require('../../src/services/whatsapp-channel-transition.service');
  const transition = {
    id: 'transition-id', channelId: channelA, originalWabaId: 'waba-controlled',
    originalNormalizedPhone: testNumber, status: 'rollback_pending'
  };
  for (const phoneNumberId of ['phone-old', 'phone-recovered-new']) {
    const dryRun = service.simulateRollbackDryRun({
      transition,
      provider: {
        phoneNumberId, wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
        platformType: 'CLOUD_API', isOnBizApp: false
      }
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.channelId, channelA);
    assert.equal(dryRun.dataPreserved, true);
  }
  const wrongState = service.simulateRollbackDryRun({
    transition,
    provider: {
      phoneNumberId: 'phone-old', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    }
  });
  assert.equal(wrongState.ok, false);
});

test('successful simulated recovery restores API_ONLY on the same channel without deleting tenant data', async (t) => {
  const db = await makeDatabase(t);
  const { service, result } = await prepare(db);
  await advanceToOnboarding(service, result.transitionId);
  let transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findActiveWhatsAppChannelTransitionByClinicId(clinicA);
  await service.validateAndCompleteWhatsAppCoexistenceTransition({
    transition,
    provider: {
      phoneNumberId: 'phone-new', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: true
    },
    accessToken: 'new-opaque-test-token'
  });
  transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findWhatsAppChannelTransitionById(result.transitionId);
  await require('../../src/repositories/whatsapp-channel-transition.repository')
    .advanceWhatsAppChannelTransition({
      transitionId: result.transitionId, expectedStatuses: ['completed'], nextStatus: 'rollback_pending'
    });
  transition = await require('../../src/repositories/whatsapp-channel-transition.repository')
    .findWhatsAppChannelTransitionById(result.transitionId);
  const restored = await service.finalizeWhatsAppTransitionRollback({
    transition,
    provider: {
      phoneNumberId: 'phone-new', wabaId: 'waba-controlled', displayPhoneNumber: testNumber,
      platformType: 'CLOUD_API', isOnBizApp: false
    },
    accessToken: 'recovered-token'
  });
  assert.equal(restored.ok, true);
  const channel = await db.query('SELECT id, "phoneNumberId", "connectionMode", status FROM channels WHERE "clinicId" = $1', [clinicA]);
  const conversation = await db.query('SELECT "channelId" FROM conversations WHERE id = $1', [conversationId]);
  assert.equal(channel.rows[0].id, channelA);
  assert.equal(channel.rows[0].phoneNumberId, 'phone-new');
  assert.equal(channel.rows[0].connectionMode, 'API_ONLY');
  assert.equal(channel.rows[0].status, 'active');
  assert.equal(conversation.rows[0].channelId, channelA);
});

console.log('whatsapp-channel-transition.test.js passed');
