const assert = require('assert');

const {
  deriveInventoryLotSchemaCapabilities
} = require('../../src/utils/inventory-lot-schema-capabilities');

const preD3 = deriveInventoryLotSchemaCapabilities({
  columns: [
    { table_name: 'inventory_locations', column_name: 'id' },
    { table_name: 'inventory_locations', column_name: 'tenantId' },
    { table_name: 'inventory_locations', column_name: 'code' },
    { table_name: 'inventory_locations', column_name: 'name' },
    { table_name: 'inventory_locations', column_name: 'isPrimary' },
    { table_name: 'inventory_locations', column_name: 'active' }
  ],
  tables: [{ table_name: 'inventory_locations' }],
  constraints: [{ constraint_name: 'uniq_inventory_locations_id_tenant' }]
});

assert.strictEqual(preD3.schemaPhase, 'pre_d3');
assert.strictEqual(preD3.hasLocationId, false);
assert.strictEqual(preD3.hasLotOperations, false);

const partialD3 = deriveInventoryLotSchemaCapabilities({
  columns: [
    { table_name: 'inventory_lots', column_name: 'locationId' },
    { table_name: 'inventory_lots', column_name: 'normalizedLotNumber' }
  ],
  tables: [{ table_name: 'inventory_locations' }],
  constraints: [{ constraint_name: 'fk_inventory_lots_location_tenant' }]
});

assert.strictEqual(partialD3.schemaPhase, 'partial_d3');
assert.strictEqual(partialD3.hasLocationId, true);
assert.strictEqual(partialD3.hasOperationalStatus, false);

const fullD3 = deriveInventoryLotSchemaCapabilities({
  columns: [
    { table_name: 'inventory_lots', column_name: 'locationId' },
    { table_name: 'inventory_lots', column_name: 'normalizedLotNumber' },
    { table_name: 'inventory_lots', column_name: 'operationalStatus' },
    { table_name: 'inventory_lots', column_name: 'blockedAt' },
    { table_name: 'inventory_lots', column_name: 'blockedBy' },
    { table_name: 'inventory_lots', column_name: 'blockReason' },
    { table_name: 'inventory_lots', column_name: 'writtenOffAt' },
    { table_name: 'inventory_lots', column_name: 'writtenOffBy' },
    { table_name: 'inventory_lots', column_name: 'writeoffReason' }
  ],
  tables: [{ table_name: 'inventory_lot_operations' }],
  constraints: [
    { constraint_name: 'fk_inventory_lots_location_tenant' },
    { constraint_name: 'chk_inventory_lots_operational_status' },
    { constraint_name: 'chk_inventory_lot_operations_status' }
  ]
});

assert.strictEqual(fullD3.schemaPhase, 'full_d3');
assert.strictEqual(fullD3.hasLocationId, true);
assert.strictEqual(fullD3.hasNormalizedLotNumber, true);
assert.strictEqual(fullD3.hasOperationalStatus, true);
assert.strictEqual(fullD3.hasBlockingMetadata, true);
assert.strictEqual(fullD3.hasWriteoffMetadata, true);
assert.strictEqual(fullD3.hasLotOperations, true);

console.log('inventory-lot-schema-capabilities.test.js passed');
