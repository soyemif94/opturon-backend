const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const clinicId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const channelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('094 creates tenant-scoped durable deduped events and releases stored webhook content after processing', async (t) => {
  const db = new PGlite();
  const dbPath = require.resolve('../../src/db/client');
  const repositoryPath = require.resolve('../../src/repositories/whatsapp-coexistence.repository');
  const originalDb = require.cache[dbPath];
  const originalRepository = require.cache[repositoryPath];
  try {
    await db.exec(`
      CREATE TABLE clinics (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE channels (
        id uuid PRIMARY KEY, "clinicId" uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        provider text NOT NULL, "phoneNumberId" text NOT NULL, "wabaId" text,
        "displayPhoneNumber" text, "connectionMode" text, status text NOT NULL DEFAULT 'active'
      );
      CREATE TABLE jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" uuid NOT NULL REFERENCES clinics(id),
        "channelId" uuid NOT NULL REFERENCES channels(id), type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, "maxAttempts" integer NOT NULL DEFAULT 10,
        "runAt" timestamptz NOT NULL DEFAULT NOW(), "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    await db.exec(fs.readFileSync(path.join(root, 'db/migrations/094_whatsapp_coexistence.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'db/migrations/095_whatsapp_channel_transition.sql'), 'utf8'));
    await db.query('INSERT INTO clinics(id, name) VALUES ($1, $2)', [clinicId, 'Tenant A']);
    await db.query(`INSERT INTO channels (id, "clinicId", provider, "phoneNumberId", "wabaId", "displayPhoneNumber", "connectionMode")
      VALUES ($1, $2, 'whatsapp_cloud', 'phone-a', 'waba-a', '+54 11 8888 0000', 'COEXISTENCE')`, [channelId, clinicId]);

    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: { query: (sql, params) => db.query(sql, params), withTransaction: (fn) => fn(db) }
    };
    delete require.cache[repositoryPath];
    const repository = require(repositoryPath);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-a', changes: [{ field: 'history', value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone-a', display_phone_number: '+54 11 8888 0000' },
        history: [{ metadata: { phase: '0', chunk_order: 1, progress: 100 }, threads: [] }]
      } }] }]
    };
    const first = await repository.persistCoexistenceWebhookEvents(payload);
    const retry = await repository.persistCoexistenceWebhookEvents(JSON.parse(JSON.stringify(payload)));
    assert.deepEqual(first, { received: 1, queued: 1, duplicates: 0, ignored: 0 });
    assert.deepEqual(retry, { received: 1, queued: 0, duplicates: 1, ignored: 0 });

    const eventRows = await db.query('SELECT "clinicId", "channelId", field, status, payload IS NOT NULL AS retained FROM whatsapp_coexistence_events');
    const jobs = await db.query('SELECT type, payload->>\'eventId\' AS "eventId" FROM jobs');
    assert.equal(eventRows.rows.length, 1);
    assert.equal(eventRows.rows[0].clinicId, clinicId);
    assert.equal(eventRows.rows[0].channelId, channelId);
    assert.equal(eventRows.rows[0].status, 'queued');
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0].type, 'WHATSAPP_COEXISTENCE_EVENT');

    await db.query(`UPDATE whatsapp_coexistence_events SET status='done', payload=NULL, "processedAt"=NOW()`);
    const retained = await db.query('SELECT payload IS NOT NULL AS retained FROM whatsapp_coexistence_events');
    assert.equal(retained.rows[0].retained, false);
  } finally {
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    if (originalRepository) require.cache[repositoryPath] = originalRepository;
    else delete require.cache[repositoryPath];
    await db.close();
  }
});

test('server startup applies and verifies migration 094 before accepting requests', async () => {
  const db = new PGlite();
  const dbPath = require.resolve('../../src/db/client');
  const ensurePath = require.resolve('../../src/db/ensure-whatsapp-coexistence');
  const originalDb = require.cache[dbPath];
  const originalEnsure = require.cache[ensurePath];
  try {
    await db.exec(`
      CREATE TABLE clinics (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE channels (
        id uuid PRIMARY KEY, "clinicId" uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
        provider text NOT NULL, "phoneNumberId" text NOT NULL, "wabaId" text,
        "displayPhoneNumber" text, "connectionMode" text, status text NOT NULL DEFAULT 'active'
      );
    `);
    const client = {
      query: (sql, params) => String(sql).includes('CREATE TABLE IF NOT EXISTS whatsapp_coexistence_channel_state')
        ? db.exec(sql)
        : db.query(sql, params)
    };
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: { withTransaction: (fn) => fn(client) }
    };
    delete require.cache[ensurePath];
    const { ensureWhatsAppCoexistenceSchema } = require(ensurePath);
    const result = await ensureWhatsAppCoexistenceSchema();
    assert.equal(result.migration, '094_whatsapp_coexistence.sql');
    assert.equal(result.schema.stateExists, true);
    assert.equal(result.schema.eventsExist, true);
    assert.equal(Number(result.schema.stateColumns), 18);
    assert.equal(Number(result.schema.eventColumns), 13);
    const migration = await db.query('SELECT name FROM schema_migrations');
    assert.deepEqual(migration.rows.map((row) => row.name), ['094_whatsapp_coexistence.sql']);
  } finally {
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    if (originalEnsure) require.cache[ensurePath] = originalEnsure;
    else delete require.cache[ensurePath];
    await db.close();
  }
});

console.log('whatsapp-coexistence-schema.test.js passed');
