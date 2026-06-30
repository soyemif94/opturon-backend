const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/catalog-imports.service.js', 'utf8');
const inventoryRepo = readFileSync('src/repositories/inventory.repository.js', 'utf8');

assert.match(service, /tenantId: context\.clinic\.id/);
assert.match(service, /productId: product\.id/);
assert.match(service, /findExistingLotByNumber\(context\.clinic\.id, product\.id/);
assert.match(inventoryRepo, /l\."tenantId" = \$1::uuid/);
assert.match(inventoryRepo, /l\."productId" = \$\$\{params\.length\}::uuid/);
assert.match(inventoryRepo, /p\."clinicId" = l\."tenantId"/);

console.log('catalog-import-lot-tenant-isolation.test.js passed');
