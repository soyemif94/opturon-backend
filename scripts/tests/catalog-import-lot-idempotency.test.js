const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/catalog-imports.service.js', 'utf8');

assert.match(service, /findCatalogImportJobById\(importId, context\.clinic\.id, client, \{ forUpdate: true \}\)/);
assert.match(service, /importJob\.status === 'completed' \|\| importJob\.status === 'completed_with_errors'/);
assert.match(service, /idempotent: true/);
assert.match(service, /lotDuplicatePolicy/);
assert.match(service, /duplicate_lot_existing/);

console.log('catalog-import-lot-idempotency.test.js passed');
