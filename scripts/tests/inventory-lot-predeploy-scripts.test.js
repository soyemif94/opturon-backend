const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

const reportScript = fs.readFileSync(path.join(root, 'scripts/report-inventory-lot-consistency.js'), 'utf8');
const backfillScript = fs.readFileSync(path.join(root, 'scripts/backfill-inventory-lot-locations.js'), 'utf8');
const migration069 = fs.readFileSync(path.join(root, 'db/migrations/069_inventory_lot_operation_idempotency.sql'), 'utf8');

assert.match(reportScript, /SET TRANSACTION READ ONLY/);
for (const token of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'ALTER TABLE', 'CREATE TABLE', 'DROP TABLE']) {
  assert.strictEqual(reportScript.includes(token), false, `consistency report must not include ${token}`);
}
for (const field of [
  'location_tenant_mismatch',
  'missing_normalized_lot_number',
  'product_stock_divergent',
  'lot_based_with_base_balance',
  'cancelled_fefo_eligible',
  'expired_used_recently',
  'invalid_allocations',
  'movement_tenant_mismatch',
  'allocation_tenant_mismatch'
]) {
  assert.match(reportScript, new RegExp(field));
}

assert.match(backfillScript, /classification: 'already_assigned'/);
assert.match(backfillScript, /classification = 'exact_match'/);
assert.match(backfillScript, /classification = 'ambiguous_match'/);
assert.match(backfillScript, /classification = 'tenant_mismatch'/);
assert.match(backfillScript, /classification = 'inactive_location'/);
assert.match(backfillScript, /proposal\.classification !== 'exact_match'/);
assert.match(backfillScript, /SET TRANSACTION READ ONLY/);

assert.match(migration069, /chk_inventory_lot_operations_operation_type_non_empty/);
assert.match(migration069, /chk_inventory_lot_operations_idempotency_key_non_empty/);

console.log('inventory-lot-predeploy-scripts.test.js passed');
