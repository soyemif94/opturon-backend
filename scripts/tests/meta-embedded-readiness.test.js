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

const originalEnv = { ...process.env };

function resetProcessEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function baseEnv() {
  return {
    whatsappAppId: '3388083341350043',
    metaAppSecret: 'configured-secret',
    tokensEncryptionKey: 'configured-encryption-key',
    metaVerifyToken: 'verify-token',
    databaseUrl: 'postgres://example',
    opturonPublicAppUrl: 'https://www.opturon.com',
    opturonApiPublicUrl: 'https://opturon-api.onrender.com',
    getWhatsAppGraphVersion: () => 'v25.0'
  };
}

function loadService({
  envOverride = {},
  tablePresent = true,
  fetchImpl = async () => ({ status: 401 }),
  validateEncryptionKey = () => Buffer.alloc(32)
} = {}) {
  clearModule('src/services/meta-embedded-readiness.service.js');
  mockModule('src/config/env.js', { ...baseEnv(), ...envOverride });
  mockModule('src/db/client.js', {
    query: async () => ({ rows: [{ present: tablePresent }] })
  });
  mockModule('src/utils/secret-crypto.js', {
    validateConfiguredTokensEncryptionKey: validateEncryptionKey
  });
  mockModule('src/services/portal-whatsapp-embedded-signup.service.js', { stub: true });
  mockModule('src/repositories/whatsapp-onboarding.repository.js', { stub: true });
  mockModule('src/repositories/tenant.repository.js', { stub: true });
  return require(modulePath('src/services/meta-embedded-readiness.service.js'));
}

async function testMissingAppIdBlocks() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  process.env.META_APP_ID = 'legacy-meta-app-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    envOverride: { whatsappAppId: '' }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, false);
  assert.ok(result.blockingChecks.includes('appId'));
  assert.deepStrictEqual(result.checks.frontendLaunchPayload.missingConfig, ['WHATSAPP_APP_ID']);
}

async function testMissingAppSecretBlocks() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    envOverride: { metaAppSecret: '' }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, false);
  assert.ok(result.blockingChecks.includes('appSecret'));
}

async function testMissingConfigIdBlocks() {
  delete process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
  const { getMetaEmbeddedSignupReadiness } = loadService();
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, false);
  assert.ok(result.blockingChecks.includes('configId'));
}

async function testHttpUrlBlocks() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    envOverride: { opturonPublicAppUrl: 'http://www.opturon.com' }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, false);
  assert.ok(result.blockingChecks.includes('publicAppUrl'));
  assert.ok(result.blockingChecks.includes('redirectUri'));
}

async function testMissingEncryptionKeyBlocks() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    envOverride: { tokensEncryptionKey: '' },
    validateEncryptionKey: () => {
      throw new Error('TOKENS_ENCRYPTION_KEY invalid');
    }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, false);
  assert.ok(result.blockingChecks.includes('tokenEncryption'));
}

async function testInvalidEncryptionKeyStaysBlocking() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    validateEncryptionKey: () => {
      throw new Error('TOKENS_ENCRYPTION_KEY invalid');
    }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.checks.tokenEncryption.configured, true);
  assert.strictEqual(result.checks.tokenEncryption.valid, false);
  assert.ok(result.blockingChecks.includes('tokenEncryption'));
}

async function testAllTechnicalChecksReady() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  let fetchCalls = 0;
  const { getMetaEmbeddedSignupReadiness } = loadService();
  const result = await getMetaEmbeddedSignupReadiness({
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      assert.strictEqual(init.method, 'GET');
      return { status: 401 };
    }
  });
  assert.strictEqual(result.readyForTest, true);
  assert.strictEqual(result.status, 'ready_for_test');
  assert.strictEqual(fetchCalls, 1);
  assert.strictEqual(result.checks.frontendLaunchPayload.blocking, false);
  assert.deepStrictEqual(result.checks.frontendLaunchPayload.missingConfig, []);
}

async function testManualChecksKeepProductionFalse() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService();
  const result = await getMetaEmbeddedSignupReadiness();
  assert.strictEqual(result.readyForTest, true);
  assert.strictEqual(result.readyForProduction, false);
  assert.ok(result.manualChecks.includes('appPublished'));
}

async function testResponseDoesNotExposeSecrets() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService({
    envOverride: {
      metaAppSecret: 'super-secret-value',
      metaVerifyToken: 'verify-secret-value',
      tokensEncryptionKey: 'encryption-secret-value'
    }
  });
  const result = await getMetaEmbeddedSignupReadiness();
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('verify-secret-value'));
  assert.ok(!serialized.includes('encryption-secret-value'));
}

async function testPayloadFrontendBlocksWithoutConfigId() {
  delete process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
  const { getMetaEmbeddedSignupReadiness } = loadService();
  const result = await getMetaEmbeddedSignupReadiness();
  assert.ok(result.blockingChecks.includes('configId'));
  assert.ok(result.blockingChecks.includes('frontendLaunchPayload'));
  assert.deepStrictEqual(result.checks.frontendLaunchPayload.missingConfig, ['META_EMBEDDED_SIGNUP_CONFIG_ID']);
  assert.ok(!JSON.stringify(result).includes('configured-secret'));
}

async function testExternalFailureDoesNotThrow() {
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = 'config-id';
  const { getMetaEmbeddedSignupReadiness } = loadService();
  const result = await getMetaEmbeddedSignupReadiness({
    fetchImpl: async () => {
      throw new Error('network_down');
    }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.checks.webhookCallback.reachable, false);
  assert.ok(result.blockingChecks.includes('webhookCallback'));
}

async function run() {
  resetProcessEnv();
  await testMissingAppIdBlocks();
  resetProcessEnv();
  await testMissingAppSecretBlocks();
  resetProcessEnv();
  await testMissingConfigIdBlocks();
  resetProcessEnv();
  await testHttpUrlBlocks();
  resetProcessEnv();
  await testMissingEncryptionKeyBlocks();
  resetProcessEnv();
  await testInvalidEncryptionKeyStaysBlocking();
  resetProcessEnv();
  await testAllTechnicalChecksReady();
  resetProcessEnv();
  await testManualChecksKeepProductionFalse();
  resetProcessEnv();
  await testResponseDoesNotExposeSecrets();
  resetProcessEnv();
  await testPayloadFrontendBlocksWithoutConfigId();
  resetProcessEnv();
  await testExternalFailureDoesNotThrow();
  console.log('meta-embedded-readiness.test.js: ok');
}

run().catch((error) => {
  resetProcessEnv();
  console.error(error);
  process.exit(1);
});
