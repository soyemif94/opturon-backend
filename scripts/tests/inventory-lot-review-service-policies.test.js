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

async function testWriteoffConflictAndConcurrentBlock() {
  const touched = [];
  const state = {
    blockCompleted: false,
    blockMutations: 0,
    blockAudits: 0,
    operationFailures: []
  };
  let releaseBlockWaiter;
  const blockWaiter = new Promise((resolve) => {
    releaseBlockWaiter = resolve;
  });

  try {
    touched.push(
      mockModule('src/db/client.js', {
        withTransaction: async (work) => work({})
      }),
      mockModule('src/services/portal-context.service.js', {
        resolvePortalTenantContext: async (tenantId) => ({ ok: true, tenantId, clinic: { id: 'clinic-1' } })
      }),
      mockModule('src/repositories/tenant.repository.js', {
        getClinicInventorySettingsById: async () => ({ settings: {} }),
        updateClinicInventorySettingsById: async () => ({ settings: {} })
      }),
      mockModule('src/repositories/products.repository.js', {
        findProductById: async () => ({ id: 'prod-1', inventoryTrackingMode: 'lot_based' })
      }),
      mockModule('src/repositories/portal-user-audit.repository.js', {
        createPortalUserAuditEvent: async () => {
          state.blockAudits += 1;
        }
      }),
      mockModule('src/repositories/inventory.repository.js', {
        LOT_STATUSES: ['active', 'depleted', 'expired', 'quarantined', 'cancelled'],
        MOVEMENT_TYPES: ['purchase_receipt', 'manual_adjustment_out', 'expired_writeoff', 'cancellation'],
        listInventoryLots: async () => [],
        getInventoryExpirationSummary: async () => ({}),
        listInventoryMovementsForLot: async () => [],
        listInventoryLotHistory: async () => [],
        listInventoryLocations: async () => [],
        findInventoryLocationById: async () => ({ id: 'loc-1', active: true, isPrimary: true, metadata: {} }),
        createInventoryLocation: async () => null,
        updateInventoryLocation: async () => null,
        getInventoryLocationUsageSummary: async () => ({ activeLots: 0, activeBalances: 0 }),
        findPhysicalInventoryLot: async () => null,
        findConflictingInventoryLot: async () => null,
        createInventoryLot: async () => null,
        incrementInventoryLot: async () => null,
        insertInventoryMovement: async () => {
          state.blockMutations += 1;
          return { id: 'mov-1' };
        },
        syncProductStockFromLots: async () => 0,
        setProductInventoryTrackingMode: async () => true,
        findInventoryLotById: async (lotId) => {
          if (lotId === 'lot-writeoff') {
            return {
              id: lotId,
              productId: 'prod-1',
              availableQuantity: 20,
              committedQuantity: 5,
              legacyStatus: 'active',
              operationalStatus: 'active'
            };
          }
          return {
            id: lotId,
            productId: 'prod-1',
            availableQuantity: 20,
            committedQuantity: 0,
            legacyStatus: 'active',
            operationalStatus: state.blockCompleted ? 'blocked' : 'active'
          };
        },
        updateInventoryLotState: async () => {
          state.blockMutations += 1;
          state.blockCompleted = true;
          releaseBlockWaiter();
          return {
            id: 'lot-block',
            productId: 'prod-1',
            availableQuantity: 20,
            committedQuantity: 0,
            legacyStatus: 'active',
            operationalStatus: 'blocked'
          };
        }
      }),
      mockModule('src/repositories/inventory-lot-operations.repository.js', {
        findInventoryLotOperationByIdempotencyKey: async () => null,
        createInventoryLotOperation: async (input) => {
          if (input.operationType === 'writeoff') {
            return { id: 'op-writeoff', lotId: input.lotId, wasCreated: true };
          }
          if (!state.blockStarted) {
            state.blockStarted = true;
            return { id: 'op-block', lotId: input.lotId, wasCreated: true };
          }
          if (!state.blockCompleted) {
            await blockWaiter;
          }
          return { id: 'op-block', lotId: input.lotId, wasCreated: false, status: 'completed' };
        },
        updateInventoryLotOperation: async (_id, _tenantId, patch) => {
          if (patch.failureCode) state.operationFailures.push(patch.failureCode);
          if (patch.status === 'completed') state.blockCompleted = true;
          return { id: 'op-block', lotId: 'lot-block', status: patch.status || 'completed' };
        }
      }),
      mockModule('src/utils/inventory-expiration.js', {
        DEFAULT_EXPIRATION_ALERT_THRESHOLDS: { criticalDays: 3, urgentDays: 7, warningDays: 15, upcomingDays: 30 },
        calculateInventoryExpirationStatus: () => ({ status: 'expired', daysUntilExpiration: -1 }),
        getTenantTodayISO: () => '2026-07-29',
        normalizeExpirationAlertThresholds: (value) => value,
        resolveTenantTimezone: () => 'America/Buenos_Aires'
      })
    );

    clearModule('src/services/inventory-lots.service.js');
    const service = require(path.join(root, 'src/services/inventory-lots.service.js'));

    const writeoff = await service.adjustPortalInventoryLot(
      'tenant-1',
      'lot-writeoff',
      { movementType: 'expired_writeoff', quantity: 16, idempotencyKey: 'writeoff-1', reason: 'expired' },
      { actorId: '11111111-1111-1111-1111-111111111111' }
    );
    assert.strictEqual(writeoff.ok, false);
    assert.strictEqual(writeoff.reason, 'inventory_lot_writeoff_conflicts_with_committed_stock');
    assert.deepStrictEqual(state.operationFailures, ['inventory_lot_writeoff_conflicts_with_committed_stock']);

    const [first, second] = await Promise.all([
      service.blockPortalInventoryLot(
        'tenant-1',
        'lot-block',
        { reason: 'qa block', idempotencyKey: 'block-1' },
        { actorId: '11111111-1111-1111-1111-111111111111' }
      ),
      service.blockPortalInventoryLot(
        'tenant-1',
        'lot-block',
        { reason: 'qa block', idempotencyKey: 'block-1' },
        { actorId: '11111111-1111-1111-1111-111111111111' }
      )
    ]);

    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.idempotent, true);
    assert.strictEqual(state.blockMutations, 1);
    assert.strictEqual(state.blockAudits, 1);
  } finally {
    clearModule('src/services/inventory-lots.service.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

async function testCancellationRestorePolicies() {
  const touched = [];
  const updates = [];

  try {
    touched.push(
      mockModule('src/db/client.js', {
        query: async () => ({ rows: [] }),
        withTransaction: async (work) => work({})
      }),
      mockModule('src/services/portal-context.service.js', {
        resolvePortalTenantContext: async (tenantId) => ({ ok: true, tenantId, clinic: { id: 'clinic-1' } })
      }),
      mockModule('src/utils/logger.js', { logError: () => {} }),
      mockModule('src/repositories/orders.repository.js', {}),
      mockModule('src/repositories/contact.repository.js', {}),
      mockModule('src/repositories/portal-users.repository.js', { findPortalUserByIdAndClinicId: async () => null }),
      mockModule('src/repositories/payment-destinations.repository.js', {}),
      mockModule('src/repositories/invoices.repository.js', {}),
      mockModule('src/repositories/payments.repository.js', {}),
      mockModule('src/repositories/payment-allocations.repository.js', {}),
      mockModule('src/repositories/products.repository.js', { findProductById: async () => null, updateProduct: async () => null }),
      mockModule('src/repositories/tenant.repository.js', { getClinicBusinessProfileById: async () => null }),
      mockModule('src/repositories/conversation.repository.js', { findConversationById: async () => null, updateConversationStage: async () => null }),
      mockModule('src/conversations/conversation.repo.js', {}),
      mockModule('src/services/portal-inbox.service.js', { sendPortalMessage: async () => null }),
      mockModule('src/utils/money.js', {
        calculateLineAmounts: () => null,
        quantizeDecimal: (value) => value,
        sumQuantized: (values) => values.reduce((sum, value) => sum + Number(value || 0), 0)
      }),
      mockModule('src/utils/portal-users.js', { isOperationalPortalAssigneeRole: () => true }),
      mockModule('src/repositories/inventory.repository.js', {
        listEligibleLotsForFefo: async () => [],
        updateInventoryLotQuantity: async () => null,
        createInventoryLotAllocation: async () => null,
        listInventoryLotAllocationsByOrder: async (_tenantId, orderId) =>
          orderId === 'order-blocked'
            ? [{ id: 'alloc-1', orderItemId: 'item-1', lotId: 'lot-blocked', productId: 'prod-1', quantity: 3, status: 'consumed' }]
            : [{ id: 'alloc-2', orderItemId: 'item-2', lotId: 'lot-writtenoff', productId: 'prod-1', quantity: 2, status: 'consumed' }],
        markInventoryLotAllocationsReleased: async () => [],
        insertInventoryMovement: async () => ({}),
        syncProductStockFromLots: async () => 0,
        findInventoryLotById: async (lotId) =>
          lotId === 'lot-blocked'
            ? {
                id: lotId,
                availableQuantity: 4,
                committedQuantity: 0,
                legacyStatus: 'quarantined',
                operationalStatus: 'blocked',
                status: 'blocked'
              }
            : {
                id: lotId,
                availableQuantity: 0,
                committedQuantity: 0,
                legacyStatus: 'depleted',
                operationalStatus: 'written_off',
                status: 'written_off'
              },
        updateInventoryLotState: async (_lotId, _tenantId, patch) => {
          updates.push(patch);
          return patch;
        }
      })
    );

    clearModule('src/services/portal-orders.service.js');
    const ordersService = require(path.join(root, 'src/services/portal-orders.service.js'));

    const blocked = await ordersService.__private__.restoreOrderLotAllocations(
      { tenantId: 'tenant-1', clinic: { id: 'clinic-1' }, actorId: 'actor-1', actorName: 'QA' },
      { id: 'order-blocked' },
      {}
    );
    assert.strictEqual(blocked.ok, true);
    assert.strictEqual(updates[0].availableQuantity, 7);
    assert.strictEqual(updates[0].status, 'quarantined');

    const writtenOff = await ordersService.__private__.restoreOrderLotAllocations(
      { tenantId: 'tenant-1', clinic: { id: 'clinic-1' }, actorId: 'actor-1', actorName: 'QA' },
      { id: 'order-writtenoff' },
      {}
    );
    assert.strictEqual(writtenOff.ok, false);
    assert.strictEqual(writtenOff.reason, 'inventory_lot_restore_requires_manual_review');
  } finally {
    clearModule('src/services/portal-orders.service.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

Promise.resolve()
  .then(testWriteoffConflictAndConcurrentBlock)
  .then(testCancellationRestorePolicies)
  .then(() => {
    console.log('inventory-lot-review-service-policies.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
