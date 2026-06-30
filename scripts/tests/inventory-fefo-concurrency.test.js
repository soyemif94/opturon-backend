const assert = require('assert');
const { readFileSync } = require('fs');

const repo = readFileSync('src/repositories/inventory.repository.js', 'utf8');
const service = readFileSync('src/services/portal-orders.service.js', 'utf8');

assert.match(service, /withTransaction\(async \(client\)/);
assert.match(repo, /FOR UPDATE OF l/);
assert.match(service, /const available = lots\.reduce/);
assert.match(service, /inventory_insufficient_lot_stock/);
assert.match(service, /return buildInsufficientLotStockError\(context, product\.id, requested, available\)/);
assert.match(service, /await createInventoryLotAllocation/);
assert.match(service, /await insertInventoryMovement/);

console.log('inventory-fefo-concurrency.test.js passed');
