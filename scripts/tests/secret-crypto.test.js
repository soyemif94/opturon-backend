const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const utilPath = path.join(rootDir, 'src', 'utils', 'secret-crypto.js');
const loggerPath = path.join(rootDir, 'src', 'utils', 'logger.js');

function reloadModules() {
  delete require.cache[utilPath];
  delete require.cache[loggerPath];
  return {
    cryptoUtils: require(utilPath),
    logger: require(loggerPath)
  };
}

async function testRoundtripAndRandomizedCiphertext() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const { cryptoUtils } = reloadModules();
  const secret = 'EAA-example-token';

  const encryptedA = cryptoUtils.encryptSecret(secret);
  const encryptedB = cryptoUtils.encryptSecret(secret);

  assert.ok(encryptedA.startsWith(cryptoUtils.ENCRYPTED_SECRET_PREFIX));
  assert.ok(encryptedB.startsWith(cryptoUtils.ENCRYPTED_SECRET_PREFIX));
  assert.notStrictEqual(encryptedA, encryptedB);
  assert.strictEqual(cryptoUtils.decryptSecret(encryptedA), secret);
  assert.strictEqual(cryptoUtils.decryptSecret(encryptedB), secret);
}

async function testTamperAndWrongKeyFailures() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  let { cryptoUtils } = reloadModules();
  const encrypted = cryptoUtils.encryptSecret('token-to-tamper');

  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => cryptoUtils.decryptSecret(tampered), /encrypted_secret_decrypt_failed/);

  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  ({ cryptoUtils } = reloadModules());
  assert.throws(() => cryptoUtils.decryptSecret(encrypted), /encrypted_secret_decrypt_failed/);
}

async function testLoggerRedaction() {
  process.env.TOKENS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const { logger } = reloadModules();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const output = [];

  console.log = (message) => output.push(String(message));
  console.warn = (message) => output.push(String(message));
  console.error = (message) => output.push(String(message));

  try {
    logger.logInfo('test_info', {
      accessToken: 'plain-secret',
      nested: {
        metaAccessToken: 'nested-secret',
        metaCode: 'sensitive-code',
        safe: 'keep-me'
      }
    });
    logger.logWarn('test_warn', { pageAccessToken: 'page-secret' });
    logger.logError('test_error', { token: 'generic-secret' });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  const serialized = output.join('\n');
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(serialized.includes('keep-me'));
  assert.ok(!serialized.includes('plain-secret'));
  assert.ok(!serialized.includes('nested-secret'));
  assert.ok(!serialized.includes('sensitive-code'));
  assert.ok(!serialized.includes('page-secret'));
  assert.ok(!serialized.includes('generic-secret'));
}

async function run() {
  await testRoundtripAndRandomizedCiphertext();
  await testTamperAndWrongKeyFailures();
  await testLoggerRedaction();
  console.log('secret-crypto.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
