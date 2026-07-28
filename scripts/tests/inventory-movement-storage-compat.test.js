const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function clearModule(relativePath) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
}

async function main() {
  const touched = [];
  const queuedResponses = [];
  const capturedMovementTypes = [];

  try {
    touched.push(
      mockModule('src/db/client.js', {
        query: async (_text, params) => {
          if (params[4]) capturedMovementTypes.push(params[4]);
          return { rows: queuedResponses.shift() || [] };
        }
      })
    );

    const repositoryPath = path.join(root, 'src/repositories/inventory.repository.js');
    delete require.cache[require.resolve(repositoryPath)];
    const { insertInventoryMovement, listInventoryMovementsForLot } = require(repositoryPath);

    queuedResponses.push([
      {
        id: 'mov-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: null,
        locationId: '33333333-3333-3333-3333-333333333333',
        movementType: 'opening_balance',
        quantity: 8,
        quantityBefore: 0,
        quantityAfter: 8,
        referenceType: null,
        referenceId: null,
        reason: 'Carga inicial',
        metadata: {},
        createdBy: null,
        idempotencyKey: 'key-1',
        unit: 'unit',
        status: 'posted'
      }
    ]);
    queuedResponses.push([
      {
        id: 'mov-2',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: null,
        locationId: '33333333-3333-3333-3333-333333333333',
        movementType: 'manual_increase',
        quantity: 5,
        quantityBefore: 8,
        quantityAfter: 13,
        referenceType: null,
        referenceId: null,
        reason: 'Ingreso',
        metadata: {},
        createdBy: null,
        idempotencyKey: 'key-2',
        unit: 'unit',
        status: 'posted'
      }
    ]);
    queuedResponses.push([
      {
        id: 'mov-3',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: null,
        locationId: '33333333-3333-3333-3333-333333333333',
        movementType: 'correction',
        quantity: 2,
        quantityBefore: 10,
        quantityAfter: 8,
        referenceType: null,
        referenceId: null,
        reason: 'Conteo',
        metadata: {},
        createdBy: null,
        idempotencyKey: 'key-3',
        unit: 'unit',
        status: 'posted'
      }
    ]);

    const opening = await insertInventoryMovement({
      tenantId: '11111111-1111-1111-1111-111111111111',
      productId: '22222222-2222-2222-2222-222222222222',
      locationId: '33333333-3333-3333-3333-333333333333',
      movementType: 'opening_balance',
      quantity: 8,
      quantityBefore: 0,
      quantityAfter: 8,
      metadata: { inventoryBase: true }
    });
    const increase = await insertInventoryMovement({
      tenantId: '11111111-1111-1111-1111-111111111111',
      productId: '22222222-2222-2222-2222-222222222222',
      locationId: '33333333-3333-3333-3333-333333333333',
      movementType: 'manual_increase',
      quantity: 5,
      quantityBefore: 8,
      quantityAfter: 13,
      metadata: { inventoryBase: true }
    });
    const correction = await insertInventoryMovement({
      tenantId: '11111111-1111-1111-1111-111111111111',
      productId: '22222222-2222-2222-2222-222222222222',
      locationId: '33333333-3333-3333-3333-333333333333',
      movementType: 'correction',
      quantity: 2,
      quantityBefore: 10,
      quantityAfter: 8,
      metadata: { inventoryBase: true }
    });

    assert.deepStrictEqual(capturedMovementTypes, ['opening_balance', 'manual_increase', 'correction']);
    assert.equal(opening.movementType, 'opening_balance');
    assert.equal(increase.movementType, 'manual_increase');
    assert.equal(correction.movementType, 'correction');

    queuedResponses.push([
      {
        id: 'hist-1',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: '44444444-4444-4444-4444-444444444444',
        locationId: '33333333-3333-3333-3333-333333333333',
        locationName: 'Principal',
        movementType: 'initial_stock',
        quantity: 8,
        quantityBefore: 0,
        quantityAfter: 8,
        referenceType: null,
        referenceId: null,
        reason: 'Legacy',
        metadata: {},
        createdBy: null,
        createdAt: '2026-07-28T00:00:00.000Z',
        idempotencyKey: null,
        unit: 'unit',
        status: 'posted'
      },
      {
        id: 'hist-2',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: '44444444-4444-4444-4444-444444444444',
        locationId: '33333333-3333-3333-3333-333333333333',
        locationName: 'Principal',
        movementType: 'manual_adjustment_in',
        quantity: 5,
        quantityBefore: 8,
        quantityAfter: 13,
        referenceType: null,
        referenceId: null,
        reason: 'Legacy in',
        metadata: {},
        createdBy: null,
        createdAt: '2026-07-28T00:01:00.000Z',
        idempotencyKey: null,
        unit: 'unit',
        status: 'posted'
      },
      {
        id: 'hist-3',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: '44444444-4444-4444-4444-444444444444',
        locationId: '33333333-3333-3333-3333-333333333333',
        locationName: 'Principal',
        movementType: 'manual_adjustment_out',
        quantity: 2,
        quantityBefore: 13,
        quantityAfter: 11,
        referenceType: null,
        referenceId: null,
        reason: 'Legacy out',
        metadata: {},
        createdBy: null,
        createdAt: '2026-07-28T00:02:00.000Z',
        idempotencyKey: null,
        unit: 'unit',
        status: 'posted'
      },
      {
        id: 'hist-4',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: '44444444-4444-4444-4444-444444444444',
        locationId: '33333333-3333-3333-3333-333333333333',
        locationName: 'Principal',
        movementType: 'correction',
        quantity: 3,
        quantityBefore: 11,
        quantityAfter: 8,
        referenceType: null,
        referenceId: null,
        reason: 'Canonical correction',
        metadata: {},
        createdBy: null,
        createdAt: '2026-07-28T00:03:00.000Z',
        idempotencyKey: null,
        unit: 'unit',
        status: 'posted'
      },
      {
        id: 'hist-5',
        tenantId: '11111111-1111-1111-1111-111111111111',
        productId: '22222222-2222-2222-2222-222222222222',
        lotId: '44444444-4444-4444-4444-444444444444',
        locationId: '33333333-3333-3333-3333-333333333333',
        locationName: 'Principal',
        movementType: 'expired_writeoff',
        quantity: 1,
        quantityBefore: 8,
        quantityAfter: 7,
        referenceType: null,
        referenceId: null,
        reason: 'Writeoff',
        metadata: {},
        createdBy: null,
        createdAt: '2026-07-28T00:04:00.000Z',
        idempotencyKey: null,
        unit: 'unit',
        status: 'posted'
      }
    ]);

    const history = await listInventoryMovementsForLot(
      '44444444-4444-4444-4444-444444444444',
      '11111111-1111-1111-1111-111111111111'
    );

    assert.deepStrictEqual(
      history.map((movement) => movement.movementType),
      ['opening_balance', 'manual_increase', 'manual_decrease', 'correction', 'expired_writeoff']
    );

    console.log('inventory-movement-storage-compat.test.js passed');
  } finally {
    clearModule('src/repositories/inventory.repository.js');
    for (const resolved of touched) {
      delete require.cache[resolved];
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
