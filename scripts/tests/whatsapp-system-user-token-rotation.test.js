const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ROTATION_TARGET,
  ROTATION_CONFIRMATION,
  validateMetaCredential,
  getSystemUserTokenRotationPreflight,
  rotateSystemUserToken
} = require('../../src/services/whatsapp-system-user-token-rotation.service');

function state(fingerprint = 'a'.repeat(64)) {
  return {
    canonical: {
      id: ROTATION_TARGET.channelId,
      clinicId: ROTATION_TARGET.clinicId,
      provider: ROTATION_TARGET.provider,
      wabaId: ROTATION_TARGET.wabaId,
      phoneNumberId: ROTATION_TARGET.phoneNumberId,
      status: 'active'
    },
    legacy: {
      id: ROTATION_TARGET.legacyChannelId,
      clinicId: ROTATION_TARGET.clinicId,
      provider: ROTATION_TARGET.provider,
      wabaId: 'legacy-waba',
      phoneNumberId: 'legacy-phone',
      status: 'inactive'
    },
    activeOwners: [{ id: ROTATION_TARGET.channelId, clinicId: ROTATION_TARGET.clinicId, status: 'active' }],
    credentialPresent: true,
    credentialFingerprint: fingerprint
  };
}

async function testMetaReadsOnly() {
  const calls = [];
  const result = await validateMetaCredential('new-secret-token', {
    graphRequest: async (method, graphPath, options) => {
      calls.push({ method, graphPath, token: options.accessToken });
      if (graphPath.endsWith('/phone_numbers')) {
        return { ok: true, status: 200, data: { data: [{ id: ROTATION_TARGET.phoneNumberId }] } };
      }
      if (graphPath.endsWith('/message_templates')) {
        return {
          ok: true,
          status: 200,
          data: { data: [{ name: 'inventory_lot_expiring_v1', language: 'es_AR', status: 'APPROVED', category: 'UTILITY' }] }
        };
      }
      return { ok: true, status: 200, data: { id: ROTATION_TARGET.wabaId } };
    }
  });
  assert.strictEqual(result.templateCount, 1);
  assert.strictEqual(calls.length, 3);
  assert(calls.every((call) => call.method === 'GET'));
  assert(calls.every((call) => call.token === 'new-secret-token'));
}

async function testPreflightAndRotation() {
  let persistedFingerprint = 'a'.repeat(64);
  let validationCount = 0;
  const repository = {
    readRotationState: async () => state(persistedFingerprint),
    assertTargetState: (value) => value,
    rotateCredentialOnly: async (_target, token, validator) => {
      const pre = state(persistedFingerprint);
      await validator(token);
      persistedFingerprint = require('crypto').createHash('sha256').update(token).digest('hex');
      return { pre, post: state(persistedFingerprint) };
    },
    readPersistedCredential: async () => ({
      channel: state(persistedFingerprint).canonical,
      accessToken: 'brand-new-system-user-token',
      credentialFingerprint: persistedFingerprint
    })
  };
  const preflight = await getSystemUserTokenRotationPreflight(ROTATION_TARGET.tenantId, { repository });
  assert.strictEqual(preflight.ownershipConfirmed, true);
  await assert.rejects(
    rotateSystemUserToken(ROTATION_TARGET.tenantId, { confirmation: 'yes', accessToken: 'secret' }, { repository }),
    /rotation_confirmation_invalid/
  );
  const result = await rotateSystemUserToken(
    ROTATION_TARGET.tenantId,
    { confirmation: ROTATION_CONFIRMATION, accessToken: 'brand-new-system-user-token' },
    {
      repository,
      validateMetaCredential: async (token) => {
        validationCount += 1;
        assert.strictEqual(token, 'brand-new-system-user-token');
        return { wabaHttp: 200, phoneNumbersHttp: 200, templatesHttp: 200, templateCount: 1, templates: [] };
      }
    }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.immutableIdentityPreserved, true);
  assert.notStrictEqual(result.preCredentialFingerprint, result.postCredentialFingerprint);
  assert.strictEqual(validationCount, 2);
}

function testStaticSafety() {
  const root = path.resolve(__dirname, '../..');
  const repositorySource = fs.readFileSync(
    path.join(root, 'src/repositories/whatsapp-system-user-token-rotation.repository.js'),
    'utf8'
  );
  const update = repositorySource.match(/UPDATE channels[\s\S]*?RETURNING id,/);
  assert(update, 'credential-only UPDATE must exist');
  assert(update[0].includes('SET "accessToken" = $2'));
  const setClause = update[0].split(/\bWHERE\b/)[0];
  for (const forbidden of ['"wabaId" =', '"phoneNumberId" =', '"clinicId" =', 'status =', '"updatedAt" =']) {
    assert(!setClause.includes(forbidden), `rotation SET must not contain ${forbidden}`);
  }
  const script = fs.readFileSync(
    path.join(root, 'scripts/ops/whatsapp-production-system-user-token-rotate.ps1'),
    'utf8'
  );
  assert(script.includes("-AsSecureString"));
  assert(script.includes(ROTATION_CONFIRMATION));
  assert(!script.includes('/whatsapp/manual-connect'));
  assert(!script.includes('subscribed_apps'));
  assert(!/accessToken\s*=\s*\$token[^\r\n]*Write-(Host|Output)/i.test(script));
}

async function run() {
  await testMetaReadsOnly();
  await testPreflightAndRotation();
  testStaticSafety();
  process.stdout.write('whatsapp-system-user-token-rotation tests: PASS\n');
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
