const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repository = fs.readFileSync(path.join(__dirname, '../../src/repositories/inventory.repository.js'), 'utf8');
const nextRoute = fs.readFileSync(path.join(__dirname, '../../opturon-web-publish/app/api/app/inventory/lots/route.ts'), 'utf8');

for (const token of ['expirationStatus', 'daysUntilExpirationMin', 'daysUntilExpirationMax', 'hasStock', 'warehouse', 'location', 'categoryId', 'productId']) {
  assert(repository.includes(token), `repository must support ${token}`);
  assert(nextRoute.includes(token), `Next route must pass ${token}`);
}
assert(repository.includes('"availableQuantity" DESC'), 'repository must prioritize greater available stock');

console.log('inventory-expiration-filters.test.js passed');
