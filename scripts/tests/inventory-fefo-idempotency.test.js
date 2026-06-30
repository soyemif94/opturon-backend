const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/portal-orders.service.js', 'utf8');
const migration = readFileSync('db/migrations/060_inventory_fefo_allocations.sql', 'utf8');

assert.match(migration, /uniq_inventory_lot_allocations_active_order_item_lot/);
assert.match(migration, /WHERE status IN \('allocated', 'consumed'\)/);
assert.match(service, /currentOrder\.status !== 'cancelled'/);
assert.match(service, /if \(!activeAllocations\.length\) \{\s*return \{ ok: true, restored: 0, idempotent: true \};\s*\}/);
assert.match(service, /allocation\.status === 'allocated' \|\| allocation\.status === 'consumed'/);

console.log('inventory-fefo-idempotency.test.js passed');
