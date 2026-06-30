const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/portal-orders.service.js', 'utf8');
const repo = readFileSync('src/repositories/inventory.repository.js', 'utf8');

assert.match(service, /restoreOrderLotAllocations/);
assert.match(service, /listInventoryLotAllocationsByOrder\(context\.clinic\.id, order\.id, client, \{ forUpdate: true \}\)/);
assert.match(service, /movementType: 'cancellation'/);
assert.match(service, /auditAction: 'inventory_order_cancelled_stock_restored'/);
assert.match(service, /markInventoryLotAllocationsReleased/);
assert.match(repo, /status IN \('allocated', 'consumed'\)/);

console.log('inventory-fefo-cancellation.test.js passed');
