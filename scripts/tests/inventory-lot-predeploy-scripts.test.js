const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

const reportScript = fs.readFileSync(path.join(root, 'scripts/report-inventory-lot-consistency.js'), 'utf8');
const backfillScript = fs.readFileSync(path.join(root, 'scripts/backfill-inventory-lot-locations.js'), 'utf8');
const preflightLib = fs.readFileSync(path.join(root, 'scripts/lib/inventory-lot-preflight.js'), 'utf8');
const postgresCli = fs.readFileSync(path.join(root, 'scripts/lib/postgres-cli.js'), 'utf8');
const migration069 = fs.readFileSync(path.join(root, 'db/migrations/069_inventory_lot_operation_idempotency.sql'), 'utf8');

assert.match(reportScript, /runInventoryLotConsistencyReport/);
assert.match(backfillScript, /runInventoryLotLocationBackfill/);
assert.match(preflightLib, /SET TRANSACTION READ ONLY/);
assert.match(preflightLib, /inventory_lot_location_column_missing/);
assert.match(preflightLib, /skipped_schema_not_available/);
assert.match(preflightLib, /approximate_duplicate_physical_identity_pre067/);
assert.match(preflightLib, /missing_location_id/);
assert.match(preflightLib, /duplicate_lot_operations/);
assert.match(postgresCli, /read_only_query_contains_write/);
for (const token of ['INSERT INTO', 'DELETE FROM', 'ALTER TABLE', 'CREATE TABLE', 'DROP TABLE', 'TRUNCATE']) {
  assert.strictEqual(reportScript.includes(token), false, `consistency report entrypoint must not include ${token}`);
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
  assert.match(preflightLib, new RegExp(field));
}

assert.match(preflightLib, /classification: 'already_assigned'/);
assert.match(preflightLib, /classification = 'exact_match'/);
assert.match(preflightLib, /classification = 'ambiguous_match'/);
assert.match(preflightLib, /classification = 'tenant_mismatch'/);
assert.match(preflightLib, /classification = 'inactive_location'/);
assert.match(preflightLib, /proposal\.classification !== 'exact_match'/);
assert.match(preflightLib, /SET TRANSACTION READ ONLY/);

assert.match(migration069, /chk_inventory_lot_operations_operation_type_non_empty/);
assert.match(migration069, /chk_inventory_lot_operations_idempotency_key_non_empty/);

console.log('inventory-lot-predeploy-scripts.test.js passed');
