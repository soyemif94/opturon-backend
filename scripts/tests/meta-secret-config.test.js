const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Meta app secret remains environment-only and is never fingerprinted in startup logs', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/server.js'), 'utf8');
  assert.doesNotMatch(source, /expectedMetaAppSecret|runtimeFingerprint|expectedFingerprint|metaAppSecretMatchesExpected/);
  assert.match(source, /configured: Boolean\(env\.metaAppSecret\)/);
});
