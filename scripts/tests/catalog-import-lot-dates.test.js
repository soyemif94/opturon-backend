const assert = require('assert');
const { parseDateOnlyValue } = require('../../src/services/catalog-imports.service');

assert.strictEqual(parseDateOnlyValue('2026-07-06'), '2026-07-06');
assert.strictEqual(parseDateOnlyValue('06/07/2026'), '2026-07-06');
assert.strictEqual(parseDateOnlyValue('06-07-2026'), '2026-07-06');
assert.strictEqual(parseDateOnlyValue(46209), '2026-07-06');
assert.strictEqual(parseDateOnlyValue('2026-02-31'), '__invalid__');
assert.strictEqual(parseDateOnlyValue('31/02/2026'), '__invalid__');

console.log('catalog-import-lot-dates.test.js passed');
