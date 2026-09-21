const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '../..');
const clinicA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clinicB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('registration migration and repository preserve an encrypted PIN across retries and races', async (t) => {
  const db = new PGlite();
  const previousKey = process.env.TOKENS_ENCRYPTION_KEY;
  const previousRandomInt = crypto.randomInt;
  const dbModulePath = path.join(root, 'src/db/client.js');
  const repositoryPath = path.join(root, 'src/repositories/whatsapp-onboarding.repository.js');
  const originalDbModule = require.cache[dbModulePath];
  const originalRepositoryModule = require.cache[repositoryPath];
  const calls = [];
  process.env.TOKENS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('hex');
  let nextPin = 42;
  crypto.randomInt = (min, max) => {
    assert.equal(min, 0);
    assert.equal(max, 1000000);
    return nextPin++;
  };
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return db.query(sql, params);
      },
      withTransaction: () => { throw new Error('PIN persistence must not depend on an onboarding transaction'); }
    }
  };
  delete require.cache[repositoryPath];
  const repository = require(repositoryPath);
  const { decryptSecret, encryptSecret } = require(path.join(root, 'src/utils/secret-crypto.js'));

  try {
    await db.exec(`CREATE TABLE clinics(id uuid PRIMARY KEY);
      CREATE TABLE channels (
        id uuid PRIMARY KEY, "clinicId" uuid NOT NULL REFERENCES clinics(id),
        provider text NOT NULL, "phoneNumberId" text UNIQUE NOT NULL, "wabaId" text,
        "accessToken" text, "displayPhoneNumber" text, "verifiedName" text, status text,
        "connectionSource" text, "connectionMetadata" jsonb,
        "connectionMode" text NOT NULL DEFAULT 'API_ONLY'
      );`);
    await db.query('INSERT INTO clinics(id) VALUES ($1), ($2)', [clinicA, clinicB]);
    const migration = fs.readFileSync(path.join(root, 'db/migrations/079_whatsapp_phone_registrations.sql'), 'utf8');

    await t.test('migration applies twice and enforces tenant and encryption constraints', async () => {
      await db.exec(migration);
      await db.exec(migration);
      await assert.rejects(
        db.query('INSERT INTO whatsapp_phone_registrations ("phoneNumberId", "clinicId", "encryptedPin") VALUES ($1, $2, $3)',
          ['plain-pin', clinicA, '123456']),
        { code: '23514' }
      );
      await assert.rejects(
        db.query('INSERT INTO whatsapp_phone_registrations ("phoneNumberId", "clinicId", "encryptedPin") VALUES ($1, $2, $3)',
          ['unknown-tenant', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', encryptSecret('123456')]),
        { code: '23503' }
      );
    });

    await t.test('same-tenant concurrent calls return the persisted winner, including leading zeroes', async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () =>
        repository.getOrCreateRegistrationPin({ clinicId: clinicA, phoneNumberId: 'phone-concurrent' })));
      assert.equal(results[0].pin, '000042');
      assert.ok(results.every((result) => result.pin === results[0].pin && result.registeredAt === null));
      const stored = await db.query('SELECT * FROM whatsapp_phone_registrations WHERE "phoneNumberId" = $1', ['phone-concurrent']);
      assert.equal(stored.rows.length, 1);
      assert.match(stored.rows[0].encryptedPin, /^enc:v1:gcm:/);
      assert.equal(decryptSecret(stored.rows[0].encryptedPin, { allowLegacy: false }), results[0].pin);
      for (const call of calls.filter((call) => call.sql.includes('INSERT INTO whatsapp_phone_registrations'))) {
        assert.match(call.params[2], /^enc:v1:gcm:/);
        assert.notEqual(call.params[2], results[0].pin);
      }
    });

    await t.test('failed external attempts and a module reload reuse the committed PIN unchanged', async () => {
      const input = { clinicId: clinicA, phoneNumberId: 'phone-retry' };
      const first = await repository.getOrCreateRegistrationPin(input);
      const before = await db.query('SELECT "encryptedPin" FROM whatsapp_phone_registrations WHERE "phoneNumberId" = $1', [input.phoneNumberId]);
      await assert.rejects(async () => { throw new Error('simulated remote timeout after PIN commit'); });
      delete require.cache[repositoryPath];
      const reloadedRepository = require(repositoryPath);
      const retry = await reloadedRepository.getOrCreateRegistrationPin(input);
      const after = await db.query('SELECT "encryptedPin" FROM whatsapp_phone_registrations WHERE "phoneNumberId" = $1', [input.phoneNumberId]);
      assert.equal(retry.pin, first.pin);
      assert.equal(after.rows[0].encryptedPin, before.rows[0].encryptedPin);
    });

    await t.test('two tenants cannot claim or read the same phone registration', async () => {
      const results = await Promise.allSettled([clinicA, clinicB].map((clinicId) =>
        repository.getOrCreateRegistrationPin({ clinicId, phoneNumberId: 'phone-tenant-race' })));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.equal(rejected.reason.code, 'whatsapp_registration_ownership_conflict');
      const loser = results[0].status === 'rejected' ? clinicA : clinicB;
      assert.equal(await repository.findWhatsAppPhoneRegistration(loser, 'phone-tenant-race'), null);
      assert.equal(await repository.markWhatsAppPhoneRegistered(loser, 'phone-tenant-race'), null);
      await assert.rejects(repository.getOrCreateRegistrationPin({ clinicId: loser, phoneNumberId: 'phone-tenant-race' }),
        { code: 'whatsapp_registration_ownership_conflict' });
    });

    await t.test('registration markers are scoped, idempotent, and omit secrets', async () => {
      const before = await repository.findWhatsAppPhoneRegistration(clinicA, 'phone-retry');
      assert.deepEqual(Object.keys(before).sort(), ['phoneNumberId', 'registeredAt']);
      assert.equal(before.registeredAt, null);
      const first = await repository.markWhatsAppPhoneRegistered(clinicA, 'phone-retry');
      const second = await repository.markWhatsAppPhoneRegistered(clinicA, 'phone-retry');
      assert.ok(first.registeredAt);
      assert.equal(String(first.registeredAt), String(second.registeredAt));
      assert.deepEqual(Object.keys(first).sort(), ['phoneNumberId', 'registeredAt']);
      const pin = await repository.getOrCreateRegistrationPin({ clinicId: clinicA, phoneNumberId: 'phone-retry' });
      assert.equal(String(pin.registeredAt), String(first.registeredAt));
    });

    await t.test('channel lookup requires both the clinic and WhatsApp provider', async () => {
      const token = 'test-channel-token';
      await db.query(`INSERT INTO channels (id, "clinicId", provider, "phoneNumberId", "accessToken")
        VALUES ($1, $2, 'whatsapp_cloud', $3, $4), ($5, $2, 'instagram', $6, $4)`,
      ['11111111-1111-4111-8111-111111111111', clinicA, 'channel-phone', encryptSecret(token),
        '22222222-2222-4222-8222-222222222222', 'instagram-phone']);
      const channel = await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicA, 'channel-phone');
      assert.equal(channel.accessToken, token);
      assert.equal(channel.clinicId, clinicA);
      assert.equal(await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicB, 'channel-phone'), null);
      assert.equal(await repository.findWhatsAppChannelByClinicAndPhoneNumberId(clinicA, 'instagram-phone'), null);
    });

    await t.test('missing encryption configuration fails before inserting a registration', async () => {
      delete process.env.TOKENS_ENCRYPTION_KEY;
      await assert.rejects(repository.getOrCreateRegistrationPin({ clinicId: clinicA, phoneNumberId: 'phone-no-key' }),
        { code: 'TOKENS_ENCRYPTION_KEY_MISSING' });
      const result = await db.query('SELECT "phoneNumberId" FROM whatsapp_phone_registrations WHERE "phoneNumberId" = $1', ['phone-no-key']);
      assert.equal(result.rows.length, 0);
    });
  } finally {
    await db.close();
    crypto.randomInt = previousRandomInt;
    if (previousKey === undefined) delete process.env.TOKENS_ENCRYPTION_KEY;
    else process.env.TOKENS_ENCRYPTION_KEY = previousKey;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
    if (originalRepositoryModule) require.cache[repositoryPath] = originalRepositoryModule;
    else delete require.cache[repositoryPath];
  }
});
