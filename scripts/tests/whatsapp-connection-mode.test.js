const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '../..');
const clinicA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clinicB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('WhatsApp connection mode migration and repository stay safe by default', async (t) => {
  const db = new PGlite();
  const previousKey = process.env.TOKENS_ENCRYPTION_KEY;
  const dbModulePath = path.join(root, 'src/db/client.js');
  const repositoryPath = path.join(root, 'src/repositories/whatsapp-onboarding.repository.js');
  const originalDbModule = require.cache[dbModulePath];
  const originalRepositoryModule = require.cache[repositoryPath];
  process.env.TOKENS_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('hex');

  try {
    await db.exec(`
      CREATE TABLE clinics(id uuid PRIMARY KEY, "externalTenantId" text, name text);
      CREATE TABLE channels (
        id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
        "clinicId" uuid NOT NULL REFERENCES clinics(id),
        provider text NOT NULL DEFAULT 'whatsapp_cloud',
        "phoneNumberId" text UNIQUE,
        "wabaId" text,
        "accessToken" text,
        "displayPhoneNumber" text,
        "verifiedName" text,
        status text NOT NULL DEFAULT 'active',
        "connectionSource" text,
        "connectionMetadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE channel_onboarding_sessions (
        id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
        "clinicId" uuid NOT NULL REFERENCES clinics(id),
        "externalTenantId" text NOT NULL,
        provider text NOT NULL DEFAULT 'whatsapp_embedded_signup',
        status text NOT NULL DEFAULT 'launching',
        "stateToken" text NOT NULL UNIQUE,
        nonce text NOT NULL,
        "createdByUserId" uuid,
        "redirectUri" text NOT NULL,
        "graphVersion" text,
        "metaCode" text,
        "metaAccessToken" text,
        metadata jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.query('INSERT INTO clinics(id, "externalTenantId", name) VALUES ($1, $3, $4), ($2, $5, $4)',
      [clinicA, clinicB, 'tenant-a', 'Same visible name', 'tenant-b']);
    await db.query(`INSERT INTO channels ("clinicId", "phoneNumberId", "displayPhoneNumber")
                    VALUES ($1, 'phone-a', '+5400008810')`, [clinicA]);
    await db.query(`INSERT INTO channels ("clinicId", provider, "phoneNumberId")
                    VALUES ($1, 'instagram_graph', NULL)`, [clinicA]);

    const migration080 = fs.readFileSync(path.join(root, 'db/migrations/080_whatsapp_connection_mode.sql'), 'utf8');
    await db.exec(migration080);
    await db.exec(migration080);

    const modesAfter080 = await db.query(
      `SELECT provider, "connectionMode" FROM channels ORDER BY provider`
    );
    assert.deepEqual(modesAfter080.rows, [
      { provider: 'instagram_graph', connectionMode: 'API_ONLY' },
      { provider: 'whatsapp_cloud', connectionMode: 'API_ONLY' }
    ]);

    const migration081 = fs.readFileSync(
      path.join(root, 'db/migrations/081_whatsapp_connection_mode_provider_invariant.sql'),
      'utf8'
    );
    await db.exec(migration081);
    await db.exec(migration081);

    require.cache[dbModulePath] = {
      id: dbModulePath,
      filename: dbModulePath,
      loaded: true,
      exports: {
        query: (sql, params) => db.query(sql, params),
        withTransaction: async (fn) => fn({ query: (sql, params) => db.query(sql, params) })
      }
    };
    delete require.cache[repositoryPath];
    const repository = require(repositoryPath);
    const {
      WHATSAPP_CONNECTION_MODE,
      assertWhatsAppConnectionMode,
      resolveChannelWhatsAppConnectionMode,
      resolveStoredWhatsAppConnectionMode,
      shouldRegisterWhatsAppPhone
    } = require(path.join(root, 'src/whatsapp/whatsapp-connection-mode.js'));

    await t.test('legacy records and sessions default to API_ONLY', async () => {
      const legacy = await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicA, 'phone-a');
      assert.equal(legacy.connectionMode, WHATSAPP_CONNECTION_MODE.API_ONLY);
      assert.equal(resolveStoredWhatsAppConnectionMode(undefined), WHATSAPP_CONNECTION_MODE.API_ONLY);
      assert.equal(resolveStoredWhatsAppConnectionMode(null), WHATSAPP_CONNECTION_MODE.API_ONLY);
      assert.equal(
        resolveChannelWhatsAppConnectionMode('whatsapp_cloud', null),
        WHATSAPP_CONNECTION_MODE.API_ONLY
      );

      const session = await repository.createOnboardingSession({
        clinicId: clinicA,
        externalTenantId: 'tenant-a',
        stateToken: 'state-standard',
        nonce: 'nonce-standard',
        redirectUri: 'https://opturon.test/callback'
      });
      assert.equal(session.requestedConnectionMode, WHATSAPP_CONNECTION_MODE.API_ONLY);
    });

    await t.test('provider invariant keeps WhatsApp modes out of non-WhatsApp channels', async () => {
      const instagram = await db.query(
        `SELECT "connectionMode" FROM channels WHERE provider = 'instagram_graph' LIMIT 1`
      );
      assert.equal(instagram.rows[0].connectionMode, null);
      assert.equal(resolveChannelWhatsAppConnectionMode('instagram_graph', null), null);
      assert.throws(
        () => resolveChannelWhatsAppConnectionMode('instagram_graph', WHATSAPP_CONNECTION_MODE.API_ONLY),
        { code: 'invalid_whatsapp_connection_mode' }
      );

      await assert.rejects(
        db.query(
          `INSERT INTO channels ("clinicId", provider, "phoneNumberId", "connectionMode")
           VALUES ($1, 'instagram_graph', NULL, 'API_ONLY')`,
          [clinicA]
        ),
        { code: '23514' }
      );
      await assert.rejects(
        db.query(
          `INSERT INTO channels ("clinicId", provider, "phoneNumberId")
           VALUES ($1, 'whatsapp_cloud', 'missing-mode')`,
          [clinicA]
        ),
        { code: '23514' }
      );
    });

    await t.test('standard WhatsApp upsert writes API_ONLY explicitly', async () => {
      const inserted = await repository.upsertWhatsAppChannel({
        clinicId: clinicA,
        phoneNumberId: 'phone-standard',
        wabaId: 'waba-standard',
        accessToken: 'token-standard'
      });
      assert.equal(inserted.connectionMode, WHATSAPP_CONNECTION_MODE.API_ONLY);
    });

    await t.test('registration contract is mode specific', () => {
      assert.equal(shouldRegisterWhatsAppPhone(WHATSAPP_CONNECTION_MODE.API_ONLY), true);
      assert.equal(shouldRegisterWhatsAppPhone(WHATSAPP_CONNECTION_MODE.COEXISTENCE), false);
    });

    await t.test('explicit invalid modes fail closed in code and storage', async () => {
      for (const value of ['UNKNOWN', 'COEXIST', 'BUSINESS_APP', 'WHATSAPP_APP', '', 'random']) {
        assert.throws(() => assertWhatsAppConnectionMode(value), { code: 'invalid_whatsapp_connection_mode' });
        await assert.rejects(repository.upsertWhatsAppChannel({
          clinicId: clinicA, phoneNumberId: `invalid-${value || 'empty'}`, connectionMode: value
        }), { code: 'invalid_whatsapp_connection_mode' });
      }
      await assert.rejects(
        db.query('UPDATE channels SET "connectionMode" = $1 WHERE "phoneNumberId" = $2', ['UNKNOWN', 'phone-a']),
        { code: '23514' }
      );
    });

    await t.test('upsert preserves COEXISTENCE unless a future explicit operation changes it', async () => {
      await db.query('UPDATE channels SET "connectionMode" = $1 WHERE "phoneNumberId" = $2',
        [WHATSAPP_CONNECTION_MODE.COEXISTENCE, 'phone-a']);
      const updated = await repository.upsertWhatsAppChannel({
        clinicId: clinicA,
        phoneNumberId: 'phone-a',
        wabaId: 'waba-a',
        accessToken: 'token-a',
        status: 'active'
      });
      assert.equal(updated.connectionMode, WHATSAPP_CONNECTION_MODE.COEXISTENCE);
    });

    await t.test('mode reads and upserts remain scoped to clinic plus channel identity', async () => {
      const channelB = await repository.upsertWhatsAppChannel({
        clinicId: clinicB,
        phoneNumberId: 'phone-b',
        wabaId: 'waba-b',
        accessToken: 'token-b',
        connectionMode: WHATSAPP_CONNECTION_MODE.COEXISTENCE,
        displayPhoneNumber: '+5400008810'
      });
      assert.equal(channelB.connectionMode, WHATSAPP_CONNECTION_MODE.COEXISTENCE);
      assert.equal(await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicA, 'phone-b'), null);

      const crossTenantUpdate = await repository.upsertWhatsAppChannel({
        clinicId: clinicA,
        phoneNumberId: 'phone-b',
        accessToken: 'attacker-token'
      });
      assert.equal(crossTenantUpdate, null);
      const unchanged = await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicB, 'phone-b');
      assert.equal(unchanged.connectionMode, WHATSAPP_CONNECTION_MODE.COEXISTENCE);
      assert.equal(unchanged.clinicId, clinicB);
    });
  } finally {
    await db.close();
    if (previousKey === undefined) delete process.env.TOKENS_ENCRYPTION_KEY;
    else process.env.TOKENS_ENCRYPTION_KEY = previousKey;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
    if (originalRepositoryModule) require.cache[repositoryPath] = originalRepositoryModule;
    else delete require.cache[repositoryPath];
  }
});
