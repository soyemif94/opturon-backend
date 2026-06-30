const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'db/migrations/059_inventory_lots_phase1.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/inventory-lots.service.js'), 'utf8');

for (const type of ['initial_stock', 'purchase_receipt', 'manual_adjustment_in', 'manual_adjustment_out', 'expired_writeoff', 'cancellation']) {
  assert(migration.includes(`'${type}'`), `migration must allow movement type ${type}`);
  assert(service.includes(type), `service must handle movement type ${type}`);
}

assert(service.includes('quantityBefore'), 'movements must persist quantityBefore');
assert(service.includes('quantityAfter'), 'movements must persist quantityAfter');
assert(service.includes('insufficient_lot_quantity'), 'outbound movements must reject negative stock');

console.log('inventory-movements.test.js passed');
