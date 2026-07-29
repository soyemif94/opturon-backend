const assert = require('assert');

const {
  summarizeProductStockDivergence
} = require('../lib/inventory-lot-stock-divergence');

const summary = summarizeProductStockDivergence(
  {
    tenant_id: 'tenant-1',
    product_id: 'product-1',
    product_stock: 60,
    product_status: 'active',
    tracking_mode: 'lot_based',
    timezone: 'America/Argentina/Buenos_Aires',
    deleted_at: null,
    updated_at: '2026-07-01T00:00:00.000Z'
  },
  [
    {
      id: 'lot-1',
      status: 'active',
      available_quantity: 20,
      committed_quantity: 0,
      expires_at: '2026-07-06',
      last_movement_at: '2026-06-30T00:00:00.000Z'
    },
    {
      id: 'lot-2',
      status: 'active',
      available_quantity: 40,
      committed_quantity: 0,
      expires_at: '2026-07-20',
      last_movement_at: '2026-06-30T00:00:00.000Z'
    }
  ],
  [
    { id: 'm1', lot_id: 'lot-1', movement_type: 'purchase_receipt', quantity_after: 20, created_at: '2026-06-30T00:00:00.000Z' },
    { id: 'm2', lot_id: 'lot-2', movement_type: 'purchase_receipt', quantity_after: 40, created_at: '2026-06-30T00:00:00.000Z' }
  ],
  [],
  { todayISO: '2026-07-29', timezone: 'America/Argentina/Buenos_Aires' }
);

assert.strictEqual(summary.productStock, 60);
assert.strictEqual(summary.physicalTotal, 60);
assert.strictEqual(summary.expectedProductStock, 0);
assert.strictEqual(summary.commercialAvailableTotal, 0);
assert.strictEqual(summary.diffExpected, 60);
assert.strictEqual(summary.rootCauseCode, 'stock_semantics_changed');
assert.strictEqual(summary.sourceOfTruth, 'LOTS');
assert.strictEqual(summary.repairSafe, true);
assert.strictEqual(summary.ledgerConsistency.status, 'consistent');

const unresolved = summarizeProductStockDivergence(
  {
    tenant_id: 'tenant-1',
    product_id: 'product-2',
    product_stock: 10,
    product_status: 'active',
    tracking_mode: 'lot_based',
    timezone: 'America/Argentina/Buenos_Aires',
    deleted_at: null,
    updated_at: '2026-07-01T00:00:00.000Z'
  },
  [
    {
      id: 'lot-3',
      status: 'active',
      available_quantity: 5,
      committed_quantity: 0,
      expires_at: null,
      last_movement_at: '2026-06-30T00:00:00.000Z'
    }
  ],
  [
    { id: 'm3', lot_id: 'lot-3', movement_type: 'purchase_receipt', quantity_after: 8, created_at: '2026-06-30T00:00:00.000Z' }
  ],
  [],
  { todayISO: '2026-07-29', timezone: 'America/Argentina/Buenos_Aires' }
);

assert.strictEqual(unresolved.ledgerConsistency.status, 'inconsistent');
assert.strictEqual(unresolved.rootCauseCode, 'lot_quantity_inconsistent');
assert.strictEqual(unresolved.sourceOfTruth, 'UNRESOLVED');

console.log('inventory-lot-stock-divergence.test.js passed');
