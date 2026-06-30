const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/portal-orders.service.js', 'utf8');
const repo = readFileSync('src/repositories/inventory.repository.js', 'utf8');
const migration = readFileSync('db/migrations/060_inventory_fefo_allocations.sql', 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS inventory_lot_allocations/);
assert.match(migration, /"orderItemId" UUID NOT NULL REFERENCES order_items/);
assert.match(migration, /CHECK \("movementType" IN \([\s\S]*'sale'/);
assert.match(repo, /function listEligibleLotsForFefo/);
assert.match(repo, /AND \(l\."expiresAt" IS NULL OR l\."expiresAt" >= CURRENT_DATE\)/);
assert.match(service, /consumeLotBasedOrderItem/);
assert.doesNotMatch(service, /order_item_lot_based_not_supported[\s\S]*Lot allocation is not enabled/);
assert.match(service, /movementType: 'sale'/);
assert.match(service, /auditAction: 'inventory_fefo_allocated'/);

console.log('inventory-fefo-allocation.test.js passed');
