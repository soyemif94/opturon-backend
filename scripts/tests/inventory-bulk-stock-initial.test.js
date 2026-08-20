const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const CLINIC_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_ID = '10000000-0000-4000-8000-000000000002';
const OPERATION_ID = '10000000-0000-4000-8000-000000000003';

function uuidFor(index) {
  return `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

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

function makeProduct(id, options = {}) {
  return {
    id,
    clinicId: options.clinicId || CLINIC_ID,
    name: `Producto ${id.slice(-4)}`,
    stock: options.stock || 0,
    status: options.status || 'active',
    internalCode: options.internalCode || `A-${id.slice(-4)}`,
    inventoryTrackingMode: options.inventoryTrackingMode || 'legacy',
    deletedAt: options.deletedAt || null
  };
}

function createHarness(products, options = {}) {
  const touched = [];
  const state = {
    products: new Map(products.map((product) => [product.id, product])),
    stocks: new Map(products.map((product) => [product.id, Number(product.stock || 0)])),
    balanceProductIds: new Set(
      Array.isArray(options.balanceProductIds)
        ? options.balanceProductIds
        : products.map((product) => product.id)
    ),
    movements: [],
    audits: [],
    applyCalls: [],
    advisoryCalls: 0,
    transactionCalls: 0,
    rollbackCalls: 0,
    primaryLocationReads: 0,
    primaryLocationCreates: 0,
    balanceLockReads: 0,
    failProductId: null,
    advisoryQueue: Promise.resolve()
  };

  touched.push(
    mockModule('src/db/client.js', {
      withTransaction: async (work) => {
        state.transactionCalls += 1;
        let snapshot = null;
        let releaseOperationLock = null;
        const client = {
          query: async (sql) => {
            assert.match(String(sql), /pg_advisory_xact_lock/);
            state.advisoryCalls += 1;
            const previous = state.advisoryQueue;
            let release;
            const current = new Promise((resolve) => { release = resolve; });
            state.advisoryQueue = previous.then(() => current);
            await previous;
            releaseOperationLock = release;
            snapshot = {
              stocks: new Map(state.stocks),
              movementsLength: state.movements.length,
              auditsLength: state.audits.length
            };
            return { rows: [{}] };
          }
        };
        try {
          return await work(client);
        } catch (error) {
          state.rollbackCalls += 1;
          if (snapshot) {
            state.stocks = snapshot.stocks;
            state.movements.length = snapshot.movementsLength;
            state.audits.length = snapshot.auditsLength;
          }
          throw error;
        } finally {
          if (releaseOperationLock) releaseOperationLock();
        }
      }
    })
  );

  touched.push(
    mockModule('src/services/portal-context.service.js', {
      resolvePortalTenantContext: async (tenantId) => ({
        ok: true,
        tenantId,
        clinic: { id: CLINIC_ID, name: 'QA' }
      })
    })
  );

  touched.push(
    mockModule('src/repositories/products.repository.js', {
      findProductsByIds: async (clinicId, productIds) => productIds
        .map((productId) => state.products.get(productId))
        .filter((product) => product && product.clinicId === clinicId)
    })
  );

  touched.push(
    mockModule('src/repositories/portal-user-audit.repository.js', {
      findLatestPortalUserAuditEventByIdempotencyKey: async (clinicId, action, idempotencyKey) => {
        return [...state.audits].reverse().find((audit) => (
          audit.clinicId === clinicId &&
          audit.action === action &&
          audit.payload &&
          audit.payload.idempotencyKey === idempotencyKey
        )) || null;
      },
      createPortalUserAuditEvent: async (entry) => {
        const audit = { id: uuidFor(900000 + state.audits.length), ...entry };
        state.audits.push(audit);
        return audit;
      }
    })
  );

  const location = {
    id: '30000000-0000-4000-8000-000000000001',
    tenantId: CLINIC_ID,
    code: 'main',
    name: 'Principal',
    isPrimary: true,
    active: true
  };
  touched.push(
    mockModule('src/repositories/inventory-base.repository.js', {
      findPrimaryInventoryLocation: async () => {
        state.primaryLocationReads += 1;
        return location;
      },
      lockInventoryBalancesByProductIds: async (clinicId, productIds, locationId) => {
        assert.equal(clinicId, CLINIC_ID);
        assert.equal(locationId, location.id);
        state.balanceLockReads += 1;
        return productIds
          .filter((productId) => state.balanceProductIds.has(productId))
          .map((productId) => ({
            id: uuidFor(700000 + Number(productId.slice(-6))),
            tenantId: clinicId,
            productId,
            locationId,
            quantity: state.stocks.get(productId)
          }));
      },
      ensurePrimaryInventoryLocation: async () => {
        state.primaryLocationCreates += 1;
        return location;
      }
    })
  );

  touched.push(
    mockModule('src/services/inventory-base.service.js', {
      applyInventoryMovementWithClient: async (clinicId, productId, payload, actor, client, options) => {
        state.applyCalls.push({ clinicId, productId, payload, actor, client, options });
        if (state.failProductId === productId) {
          return { ok: false, reason: 'forced_bulk_failure', details: { productId } };
        }
        const existing = state.movements.find((movement) => movement.idempotencyKey === payload.idempotencyKey);
        if (existing) {
          return {
            ok: true,
            idempotent: true,
            product: state.products.get(productId),
            location,
            balance: { id: uuidFor(800000), quantity: state.stocks.get(productId) },
            movement: existing,
            internalCode: state.products.get(productId).internalCode
          };
        }
        const currentQuantity = state.stocks.get(productId);
        if (currentQuantity !== payload.expectedCurrentQuantity) {
          return {
            ok: false,
            reason: 'inventory_changed',
            details: { productId, expectedCurrentQuantity: payload.expectedCurrentQuantity, currentQuantity }
          };
        }
        if (currentQuantity === payload.countedStock) {
          return {
            ok: true,
            idempotent: false,
            unchanged: true,
            product: state.products.get(productId),
            location,
            balance: { id: uuidFor(800000), quantity: currentQuantity },
            movement: null,
            internalCode: state.products.get(productId).internalCode,
            previousBalance: currentQuantity,
            resultingBalance: currentQuantity
          };
        }
        const movement = {
          id: uuidFor(500000 + state.movements.length),
          tenantId: clinicId,
          productId,
          movementType: 'correction',
          quantity: Math.abs(payload.countedStock - currentQuantity),
          quantityBefore: currentQuantity,
          quantityAfter: payload.countedStock,
          reason: payload.reason,
          metadata: payload.metadata,
          createdBy: actor.actorId,
          idempotencyKey: payload.idempotencyKey
        };
        state.movements.push(movement);
        state.stocks.set(productId, payload.countedStock);
        return {
          ok: true,
          idempotent: false,
          unchanged: false,
          product: state.products.get(productId),
          location,
          balance: { id: uuidFor(800000), quantity: payload.countedStock },
          movement,
          internalCode: state.products.get(productId).internalCode,
          previousBalance: currentQuantity,
          resultingBalance: payload.countedStock
        };
      }
    })
  );

  clearModule('src/services/inventory-bulk-stock.service.js');
  const service = require(path.join(root, 'src/services/inventory-bulk-stock.service.js'));

  return {
    state,
    service,
    cleanup() {
      clearModule('src/services/inventory-bulk-stock.service.js');
      for (const resolved of touched) delete require.cache[resolved];
    }
  };
}

function publicResult(result) {
  return {
    operationId: result.operationId,
    reason: result.reason,
    note: result.note,
    location: result.location,
    summary: result.summary,
    items: result.items
  };
}

async function testLargeAtomicWorkflow() {
  const products = Array.from({ length: 505 }, (_, index) => makeProduct(uuidFor(index + 1)));
  products[0].stock = 10;
  products[1].stock = 5;
  const harness = createHarness(products);
  try {
    const items = products.map((product, index) => ({
      productId: product.id,
      expectedCurrentQuantity: index === 0 ? 10 : index === 1 ? 5 : 0,
      targetQuantity: index === 0 ? 0 : index === 1 ? 9 : index === 2 ? 0 : 1
    }));
    const payload = {
      idempotencyKey: OPERATION_ID.toUpperCase(),
      reason: 'physical_count',
      note: 'Conteo QA',
      items: [...items].reverse()
    };

    const first = await harness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      payload,
      { actorId: ACTOR_ID }
    );
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(first.operationId, OPERATION_ID);
    assert.equal(first.reason, 'physical_count');
    assert.equal(first.note, 'Conteo QA');
    assert.deepStrictEqual(first.summary, {
      submittedItems: 505,
      changedItems: 504,
      unchangedItems: 1,
      increases: 503,
      reductions: 1,
      unitsAdded: 506,
      unitsRemoved: 10
    });
    assert.equal(first.items.length, 505);
    assert.equal(harness.state.movements.length, 504);
    assert.equal(harness.state.audits.filter((audit) => audit.action === 'inventory_correction_created').length, 504);
    assert.equal(harness.state.audits.filter((audit) => audit.action === 'inventory_bulk_stock_adjusted').length, 1);
    assert.equal(harness.state.applyCalls.length, 504);
    assert.equal(harness.state.primaryLocationReads, 1);
    assert.equal(harness.state.primaryLocationCreates, 0);
    assert.equal(harness.state.advisoryCalls, 1);
    assert.deepStrictEqual(
      harness.state.applyCalls.map((call) => call.productId),
      [...items].filter((item) => item.targetQuantity !== item.expectedCurrentQuantity).map((item) => item.productId).sort(),
      'items must be applied in deterministic product order to avoid lock-order deadlocks'
    );
    assert.ok(harness.state.applyCalls.every((call) => call.options.location.code === 'main'));
    assert.ok(harness.state.applyCalls.every((call) => call.payload.movementType === 'correction'));
    assert.ok(harness.state.applyCalls.every((call) => call.payload.metadata.bulkOperationId === OPERATION_ID));
    assert.ok(harness.state.applyCalls.every((call) => call.payload.idempotencyKey.endsWith(call.productId)));
    assert.ok(harness.state.applyCalls.every((call) => call.payload.referenceId === OPERATION_ID));

    const replay = await harness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      { ...payload, items },
      { actorId: ACTOR_ID }
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.deepStrictEqual(publicResult(replay), publicResult(first), 'exact replay must return the persisted public result');
    assert.equal(harness.state.movements.length, 504);
    assert.equal(harness.state.audits.length, 505);
    assert.equal(harness.state.applyCalls.length, 504, 'replay must be read-only after the operation lock');

    const mismatch = await harness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      { ...payload, note: 'Payload distinto', items },
      { actorId: ACTOR_ID }
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'inventory_bulk_idempotency_payload_mismatch');
    assert.equal(harness.state.movements.length, 504);
    assert.equal(harness.state.audits.length, 505);
  } finally {
    harness.cleanup();
  }
}

async function testValidationIsolationAndRollback() {
  const productA = makeProduct(uuidFor(6001), { stock: 2 });
  const productB = makeProduct(uuidFor(6002), { stock: 4 });
  const deleted = makeProduct(uuidFor(6003), { deletedAt: new Date().toISOString() });
  const lotBased = makeProduct(uuidFor(6004), { inventoryTrackingMode: 'lot_based' });
  const foreign = makeProduct(uuidFor(6005), { clinicId: uuidFor(7000) });
  const harness = createHarness([productA, productB, deleted, lotBased, foreign]);
  try {
    const call = (idempotencyKey, items, overrides = {}, actor = { actorId: ACTOR_ID }) => (
      harness.service.createPortalInventoryBulkAdjustment(
        'tenant-qa',
        { idempotencyKey, reason: 'inventory_correction', note: null, items, ...overrides },
        actor
      )
    );

    for (const invalidValue of [-1, 1.5, true, '2', [], {}, Number.MAX_SAFE_INTEGER]) {
      const invalid = await call(uuidFor(7100 + harness.state.transactionCalls), [{
        productId: productA.id,
        expectedCurrentQuantity: 2,
        targetQuantity: invalidValue
      }]);
      assert.equal(invalid.ok, false);
      assert.equal(invalid.reason, 'invalid_inventory_bulk_target_quantity');
    }
    assert.equal(harness.state.transactionCalls, 0, 'schema validation must fail before opening a transaction');

    const missingActor = await call(uuidFor(7200), [{ productId: productA.id, expectedCurrentQuantity: 2, targetQuantity: 3 }], {}, {});
    assert.equal(missingActor.reason, 'inventory_bulk_actor_required');

    const duplicate = await call(uuidFor(7201), [
      { productId: productA.id.toUpperCase(), expectedCurrentQuantity: 2, targetQuantity: 3 },
      { productId: productA.id, expectedCurrentQuantity: 2, targetQuantity: 4 }
    ]);
    assert.equal(duplicate.reason, 'duplicate_inventory_bulk_product');

    const missing = await call(uuidFor(7202), [{ productId: uuidFor(7999), expectedCurrentQuantity: 0, targetQuantity: 1 }]);
    assert.equal(missing.reason, 'product_not_found');
    const crossTenant = await call(uuidFor(7203), [{ productId: foreign.id, expectedCurrentQuantity: 0, targetQuantity: 1 }]);
    assert.equal(crossTenant.reason, 'product_not_found');
    const deletedResult = await call(uuidFor(7204), [{ productId: deleted.id, expectedCurrentQuantity: 0, targetQuantity: 1 }]);
    assert.equal(deletedResult.reason, 'product_deleted_cannot_receive_inventory_movements');
    const lotResult = await call(uuidFor(7205), [{ productId: lotBased.id, expectedCurrentQuantity: 0, targetQuantity: 1 }]);
    assert.equal(lotResult.reason, 'inventory_base_not_supported_for_lot_based_product');

    const beforeMovements = harness.state.movements.length;
    const beforeAudits = harness.state.audits.length;
    harness.state.failProductId = productB.id;
    const rolledBack = await call(uuidFor(7206), [
      { productId: productA.id, expectedCurrentQuantity: 2, targetQuantity: 8 },
      { productId: productB.id, expectedCurrentQuantity: 4, targetQuantity: 9 }
    ]);
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.reason, 'forced_bulk_failure');
    assert.equal(harness.state.rollbackCalls >= 1, true);
    assert.equal(harness.state.stocks.get(productA.id), 2, 'first item must roll back when a later item fails');
    assert.equal(harness.state.stocks.get(productB.id), 4);
    assert.equal(harness.state.movements.length, beforeMovements);
    assert.equal(harness.state.audits.length, beforeAudits);
  } finally {
    harness.cleanup();
  }
}

async function testConcurrentIdempotency() {
  const product = makeProduct(uuidFor(8101), { stock: 0 });
  const exactHarness = createHarness([product]);
  try {
    const payload = {
      idempotencyKey: uuidFor(8102),
      reason: 'initial_stock',
      note: 'Concurrente exacto',
      items: [{ productId: product.id, expectedCurrentQuantity: 0, targetQuantity: 12 }]
    };
    const [first, second] = await Promise.all([
      exactHarness.service.createPortalInventoryBulkAdjustment('tenant-qa', payload, { actorId: ACTOR_ID }),
      exactHarness.service.createPortalInventoryBulkAdjustment('tenant-qa', payload, { actorId: ACTOR_ID })
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepStrictEqual([first.idempotent, second.idempotent].sort(), [false, true]);
    assert.deepStrictEqual(publicResult(first), publicResult(second));
    assert.equal(exactHarness.state.movements.length, 1);
    assert.equal(exactHarness.state.audits.filter((audit) => audit.action === 'inventory_bulk_stock_adjusted').length, 1);
  } finally {
    exactHarness.cleanup();
  }

  const mismatchHarness = createHarness([product]);
  try {
    const basePayload = {
      idempotencyKey: uuidFor(8103),
      reason: 'initial_stock',
      note: 'Primero',
      items: [{ productId: product.id, expectedCurrentQuantity: 0, targetQuantity: 12 }]
    };
    const [first, mismatch] = await Promise.all([
      mismatchHarness.service.createPortalInventoryBulkAdjustment('tenant-qa', basePayload, { actorId: ACTOR_ID }),
      mismatchHarness.service.createPortalInventoryBulkAdjustment(
        'tenant-qa',
        { ...basePayload, note: 'Distinto' },
        { actorId: ACTOR_ID }
      )
    ]);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'inventory_bulk_idempotency_payload_mismatch');
    assert.equal(mismatchHarness.state.movements.length, 1);
    assert.equal(mismatchHarness.state.audits.filter((audit) => audit.action === 'inventory_bulk_stock_adjusted').length, 1);
  } finally {
    mismatchHarness.cleanup();
  }
}

async function testAllNoopIsZeroWrite() {
  const product = makeProduct(uuidFor(8201), { stock: 7, internalCode: null });
  product.internalCode = null;
  const harness = createHarness([product], { balanceProductIds: [] });
  try {
    const payload = {
      idempotencyKey: uuidFor(8202),
      reason: 'physical_count',
      note: 'Sin cambios',
      items: [{ productId: product.id, expectedCurrentQuantity: 7, targetQuantity: 7 }]
    };
    const first = await harness.service.createPortalInventoryBulkAdjustment('tenant-qa', payload, { actorId: ACTOR_ID });
    assert.equal(first.ok, true);
    assert.equal(first.location, null);
    assert.equal(first.summary.changedItems, 0);
    assert.equal(first.summary.unchangedItems, 1);
    assert.equal(harness.state.primaryLocationReads, 1);
    assert.equal(harness.state.primaryLocationCreates, 0);
    assert.equal(harness.state.balanceLockReads, 1);
    assert.equal(harness.state.applyCalls.length, 0);
    assert.equal(harness.state.movements.length, 0);
    assert.equal(harness.state.audits.length, 0);
    assert.equal(harness.state.stocks.get(product.id), 7);
    assert.equal(harness.state.products.get(product.id).internalCode, null);

    const replay = await harness.service.createPortalInventoryBulkAdjustment('tenant-qa', payload, { actorId: ACTOR_ID });
    assert.deepStrictEqual(publicResult(replay), publicResult(first));
    assert.equal(harness.state.primaryLocationReads, 2);
    assert.equal(harness.state.applyCalls.length, 0);
    assert.equal(harness.state.audits.length, 0);
  } finally {
    harness.cleanup();
  }
}

async function testStaleNoopIsRejectedWithoutWrites() {
  const product = makeProduct(uuidFor(8301), { stock: 7, internalCode: null });
  product.internalCode = null;
  const harness = createHarness([product]);
  try {
    harness.state.stocks.set(product.id, 5);
    const result = await harness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      {
        idempotencyKey: uuidFor(8302),
        reason: 'physical_count',
        note: 'No-op desactualizado',
        items: [{ productId: product.id, expectedCurrentQuantity: 7, targetQuantity: 7 }]
      },
      { actorId: ACTOR_ID }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'inventory_changed');
    assert.deepStrictEqual(result.details, {
      productId: product.id,
      expectedCurrentQuantity: 7,
      currentQuantity: 5,
      conflicts: [{ productId: product.id, expectedCurrentQuantity: 7, currentQuantity: 5 }]
    });
    assert.equal(harness.state.rollbackCalls, 1);
    assert.equal(harness.state.primaryLocationReads, 1);
    assert.equal(harness.state.primaryLocationCreates, 0);
    assert.equal(harness.state.applyCalls.length, 0);
    assert.equal(harness.state.movements.length, 0);
    assert.equal(harness.state.audits.length, 0);
    assert.equal(harness.state.stocks.get(product.id), 5);
    assert.equal(harness.state.products.get(product.id).internalCode, null);
  } finally {
    harness.cleanup();
  }

  const changedProduct = makeProduct(uuidFor(8311), { stock: 2 });
  const staleNoopProduct = makeProduct(uuidFor(8312), { stock: 4 });
  const mixedHarness = createHarness([changedProduct, staleNoopProduct]);
  try {
    mixedHarness.state.stocks.set(staleNoopProduct.id, 3);
    const result = await mixedHarness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      {
        idempotencyKey: uuidFor(8313),
        reason: 'inventory_correction',
        note: null,
        items: [
          { productId: changedProduct.id, expectedCurrentQuantity: 2, targetQuantity: 8 },
          { productId: staleNoopProduct.id, expectedCurrentQuantity: 4, targetQuantity: 4 }
        ]
      },
      { actorId: ACTOR_ID }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'inventory_changed');
    assert.equal(result.details.productId, staleNoopProduct.id);
    assert.equal(mixedHarness.state.applyCalls.length, 0, 'all optimistic checks must finish before the first write');
    assert.equal(mixedHarness.state.primaryLocationCreates, 0);
    assert.equal(mixedHarness.state.movements.length, 0);
    assert.equal(mixedHarness.state.audits.length, 0);
    assert.equal(mixedHarness.state.stocks.get(changedProduct.id), 2);
    assert.equal(mixedHarness.state.stocks.get(staleNoopProduct.id), 3);
  } finally {
    mixedHarness.cleanup();
  }

  const firstStale = makeProduct(uuidFor(8321), { stock: 10 });
  const secondStale = makeProduct(uuidFor(8322), { stock: 20 });
  const multiHarness = createHarness([firstStale, secondStale]);
  try {
    multiHarness.state.stocks.set(firstStale.id, 9);
    multiHarness.state.stocks.set(secondStale.id, 18);
    const result = await multiHarness.service.createPortalInventoryBulkAdjustment(
      'tenant-qa',
      {
        idempotencyKey: uuidFor(8323),
        reason: 'physical_count',
        items: [
          { productId: firstStale.id, expectedCurrentQuantity: 10, targetQuantity: 12 },
          { productId: secondStale.id, expectedCurrentQuantity: 20, targetQuantity: 22 }
        ]
      },
      { actorId: ACTOR_ID }
    );
    assert.equal(result.reason, 'inventory_changed');
    assert.deepStrictEqual(result.details.conflicts, [
      { productId: firstStale.id, expectedCurrentQuantity: 10, currentQuantity: 9 },
      { productId: secondStale.id, expectedCurrentQuantity: 20, currentQuantity: 18 }
    ]);
    assert.equal(multiHarness.state.applyCalls.length, 0);
    assert.equal(multiHarness.state.movements.length, 0);
    assert.equal(multiHarness.state.audits.length, 0);
  } finally {
    multiHarness.cleanup();
  }
}

async function testSensitiveInventoryRoleMatrix() {
  const touched = [];
  let hasInternalAuth = true;
  let actor = null;
  try {
    touched.push(
      mockModule('src/services/portal-active-tenant.service.js', {
        hasPortalInternalAuth: () => hasInternalAuth,
        findPortalActorContext: async () => actor
      })
    );
    clearModule('src/middlewares/portal-inventory-authorization.middleware.js');
    const { requireSensitiveInventoryRole } = require(
      path.join(root, 'src/middlewares/portal-inventory-authorization.middleware.js')
    );
    const middleware = requireSensitiveInventoryRole();

    async function runCase({ role = 'owner', tenantId = 'tenant-qa', isAdmin = false, internalAuth = true }) {
      hasInternalAuth = internalAuth;
      actor = { id: ACTOR_ID, role, tenantId, isAdmin };
      const response = {
        statusCode: null,
        payload: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return payload;
        }
      };
      let nextCalls = 0;
      await middleware(
        {
          params: { tenantId: 'tenant-qa' },
          get: (header) => (String(header).toLowerCase() === 'x-portal-actor-id' ? ACTOR_ID : '')
        },
        response,
        () => { nextCalls += 1; }
      );
      return { response, nextCalls };
    }

    for (const role of ['owner', 'manager']) {
      const allowed = await runCase({ role });
      assert.equal(allowed.nextCalls, 1, `${role} must pass the sensitive inventory gate`);
      assert.equal(allowed.response.statusCode, null);
    }
    for (const deniedCase of [
      { role: 'seller' },
      { role: 'viewer' },
      { role: 'owner', internalAuth: false },
      { role: 'owner', isAdmin: true },
      { role: 'owner', tenantId: 'another-tenant' }
    ]) {
      const denied = await runCase(deniedCase);
      assert.equal(denied.nextCalls, 0);
      assert.equal(denied.response.statusCode, 403);
      assert.equal(denied.response.payload.error, 'portal_inventory_role_forbidden');
    }
  } finally {
    clearModule('src/middlewares/portal-inventory-authorization.middleware.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

function testStaticSecurityAndConcurrencyContracts() {
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'src/services/inventory-bulk-stock.service.js'), 'utf8');
  const baseService = fs.readFileSync(path.join(root, 'src/services/inventory-base.service.js'), 'utf8');

  assert.match(
    routes,
    /router\.post\('\/tenants\/:tenantId\/inventory\/bulk-adjust', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryBulkAdjustmentController\)/,
    'bulk endpoint must enforce internal auth, inventory capability and owner/manager role server-side'
  );
  assert.match(service, /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/);
  assert.match(service, /createHash\('sha256'\)/);
  assert.match(service, /throw createDomainError\(applied\.reason, applied\.details\)/);
  assert.match(service, /sort\(\(left, right\) => left\.productId\.localeCompare\(right\.productId\)\)/);
  assert.match(baseService, /const persistedAfterLock = await findInventoryMovementByIdempotencyKey/);
  assert.match(baseService, /reason: 'inventory_changed'/);
  assert.doesNotMatch(service, /allowZeroDelta/);
}

function testBulkItemBoundaryValidation() {
  const harness = createHarness([]);
  try {
    const validateCount = (count) => harness.service.validateBulkDraft(harness.service.normalizeBulkDraft({
      idempotencyKey: uuidFor(9901),
      reason: 'physical_count',
      items: Array.from({ length: count }, (_, index) => ({
        productId: uuidFor(10000 + index),
        expectedCurrentQuantity: 0,
        targetQuantity: 1
      }))
    }));
    assert.equal(validateCount(1999), null);
    assert.equal(validateCount(2000), null);
    assert.equal(validateCount(2001), 'inventory_bulk_too_many_items');
  } finally {
    harness.cleanup();
  }
}

async function main() {
  await testLargeAtomicWorkflow();
  await testValidationIsolationAndRollback();
  await testConcurrentIdempotency();
  await testAllNoopIsZeroWrite();
  await testStaleNoopIsRejectedWithoutWrites();
  await testSensitiveInventoryRoleMatrix();
  testBulkItemBoundaryValidation();
  testStaticSecurityAndConcurrencyContracts();
  console.log('inventory-bulk-stock-initial.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
