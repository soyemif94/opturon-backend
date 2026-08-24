const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const clinicId = '11111111-1111-1111-1111-111111111111';
const contactId = '22222222-2222-2222-2222-222222222222';

function modulePath(relativePath) {
  return require.resolve(path.join(root, relativePath));
}

function mockModule(relativePath, exportsValue) {
  const resolved = modulePath(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function clearModule(relativePath) {
  delete require.cache[modulePath(relativePath)];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildOrder(id, overrides = {}) {
  return {
    id,
    clinicId,
    contactId,
    customerName: 'Cliente de prueba',
    customerPhone: '********1234',
    customerType: 'registered_contact',
    source: 'automation',
    sellerUserId: null,
    sellerNameSnapshot: null,
    paymentDestinationId: null,
    paymentDestinationNameSnapshot: null,
    paymentDestinationTypeSnapshot: null,
    status: 'draft',
    orderStatus: 'new',
    paymentStatus: 'pending',
    currency: 'ARS',
    notes: null,
    conversationId: null,
    subtotalAmount: 100,
    taxAmount: 21,
    totalAmount: 121,
    finalizedAt: null,
    finalizationVersion: 0,
    items: [
      {
        id: `${id}-item`,
        productId: null,
        descriptionSnapshot: 'Producto original',
        skuSnapshot: 'SKU-1',
        variant: 'Azul',
        quantity: 1,
        unitPrice: 100,
        taxRate: 21,
        subtotalAmount: 100,
        totalAmount: 121
      }
    ],
    ...overrides
  };
}

function assertMigrationContract() {
  const migration = fs.readFileSync(
    path.join(root, 'db/migrations/072_order_customer_notifications_foundation.sql'),
    'utf8'
  );
  const ordersRepository = fs.readFileSync(path.join(root, 'src/repositories/orders.repository.js'), 'utf8');
  const ordersService = fs.readFileSync(path.join(root, 'src/services/portal-orders.service.js'), 'utf8');
  const notificationRepository = fs.readFileSync(
    path.join(root, 'src/repositories/order-customer-notifications.repository.js'),
    'utf8'
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS order_customer_notifications/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "finalizedAt" TIMESTAMPTZ NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "finalizationVersion" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /UNIQUE \("idempotencyKey"\)/);
  assert.match(migration, /uniq_order_customer_notifications_finalization/);
  assert.match(migration, /'skipped_no_contact'/);
  assert.match(migration, /"leaseExpiresAt" TIMESTAMPTZ NULL/);
  assert.match(migration, /prevent_order_customer_notification_snapshot_change/);
  assert.match(migration, /chk_orders_finalization_metadata_consistent/);
  assert.match(migration, /identity and snapshot are immutable/);
  assert.match(migration, /idx_order_customer_notifications_provider_message/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /INSERT INTO order_customer_notifications\s+SELECT/i);
  assert.doesNotMatch(migration, /UPDATE orders\s+SET\s+"finalizedAt"/i);

  assert.match(ordersRepository, /FOR UPDATE OF o/);
  assert.match(ordersRepository, /AND "finalizationVersion" = \$5/);
  assert.match(ordersService, /\{ forUpdate: true \}/);
  assert.match(ordersService, /directConfirmedCreation: true/);
  assert.match(notificationRepository, /ON CONFLICT \("idempotencyKey"\) DO NOTHING/);
}

async function testRepositoryIdempotentInsert() {
  const touched = [];
  const statements = [];
  const existing = {
    id: '33333333-3333-3333-3333-333333333333',
    clinicId,
    orderId: '44444444-4444-4444-4444-444444444444',
    contactId,
    conversationId: null,
    channelId: null,
    notificationType: 'order_summary',
    finalizationVersion: 1,
    idempotencyKey: `order_summary:${clinicId}:44444444-4444-4444-4444-444444444444:v1`,
    status: 'pending',
    snapshot: { orderId: '44444444-4444-4444-4444-444444444444' },
    attemptCount: 0,
    availableAt: '2026-08-09T12:00:00.000Z',
    errorMetadata: {},
    createdAt: '2026-08-09T12:00:00.000Z',
    updatedAt: '2026-08-09T12:00:00.000Z'
  };

  try {
    touched.push(mockModule('src/db/client.js', { query: async () => ({ rows: [] }) }));
    clearModule('src/repositories/order-customer-notifications.repository.js');
    const repository = require(path.join(root, 'src/repositories/order-customer-notifications.repository.js'));
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (/^\s*INSERT INTO order_customer_notifications/.test(sql)) return { rows: [] };
        return { rows: [existing] };
      }
    };

    const result = await repository.insertOrderCustomerNotification(
      {
        ...existing,
        availableAt: existing.availableAt
      },
      client
    );

    assert.strictEqual(result.inserted, false);
    assert.strictEqual(result.notification.id, existing.id);
    assert.strictEqual(statements.length, 2);
    assert.match(statements[0], /ON CONFLICT \("idempotencyKey"\) DO NOTHING/);
    assert.match(statements[1], /WHERE "idempotencyKey" = \$1/);
  } finally {
    clearModule('src/repositories/order-customer-notifications.repository.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

async function testTransactionalFinalizationScenarios() {
  const touched = [];
  const database = {
    orders: new Map(),
    notifications: new Map()
  };
  let orderSequence = 10;
  let notificationSequence = 10;
  let failNotificationInsert = false;
  let productLookup = null;
  let lockTail = Promise.resolve();
  let lockCount = 0;

  function ensureTransactionState(client) {
    if (!client.state) {
      client.state = {
        orders: new Map(Array.from(database.orders, ([key, value]) => [key, clone(value)])),
        notifications: new Map(Array.from(database.notifications, ([key, value]) => [key, clone(value)]))
      };
    }
    return client.state;
  }

  async function acquireOrderLock(client) {
    if (client.releaseOrderLock) return;
    const previous = lockTail;
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    lockTail = previous.then(() => current);
    await previous;
    client.releaseOrderLock = release;
    lockCount += 1;
  }

  const dbClient = {
    query: async () => ({ rows: [] }),
    withTransaction: async (work) => {
      const client = {
        query: async () => ({ rows: [] })
      };
      try {
        const result = await work(client);
        if (client.state) {
          database.orders = client.state.orders;
          database.notifications = client.state.notifications;
        }
        return result;
      } finally {
        if (client.releaseOrderLock) client.releaseOrderLock();
      }
    }
  };

  const ordersRepository = {
    listOrdersByClinicId: async () => [],
    findOrderById: async (orderId, requestedClinicId, client, options = {}) => {
      if (options.forUpdate) await acquireOrderLock(client);
      const state = ensureTransactionState(client);
      const order = state.orders.get(orderId);
      return order && order.clinicId === requestedClinicId ? clone(order) : null;
    },
    createOrder: async (input, client) => {
      const state = ensureTransactionState(client);
      orderSequence += 1;
      const id = `00000000-0000-0000-0000-${String(orderSequence).padStart(12, '0')}`;
      const order = buildOrder(id, {
        ...input,
        id,
        finalizedAt: null,
        finalizationVersion: 0,
        items: (input.items || []).map((item, index) => ({
          id: `00000000-0000-0000-1000-${String(index + 1).padStart(12, '0')}`,
          ...item
        }))
      });
      state.orders.set(id, clone(order));
      return clone(order);
    },
    updateOrderStatus: async (orderId, requestedClinicId, payload, client) => {
      const state = ensureTransactionState(client);
      const order = state.orders.get(orderId);
      if (!order || order.clinicId !== requestedClinicId) return null;
      Object.assign(order, {
        status: payload.status,
        orderStatus: payload.orderStatus,
        paymentStatus: payload.paymentStatus || order.paymentStatus
      });
      return clone(order);
    },
    markOrderFinalized: async (orderId, requestedClinicId, payload, client) => {
      const state = ensureTransactionState(client);
      const order = state.orders.get(orderId);
      if (
        !order ||
        order.clinicId !== requestedClinicId ||
        order.status !== 'confirmed' ||
        order.finalizationVersion !== payload.previousFinalizationVersion
      ) {
        return null;
      }
      order.finalizedAt = payload.finalizedAt;
      order.finalizationVersion = payload.finalizationVersion;
      return clone(order);
    },
    updateOrder: async (orderId, requestedClinicId, patch, client) => {
      const state = ensureTransactionState(client);
      const order = state.orders.get(orderId);
      if (!order || order.clinicId !== requestedClinicId) return null;
      Object.assign(order, patch);
      return clone(order);
    },
    updateOrderPortalVisibility: async () => null
  };

  const notificationRepository = {
    insertOrderCustomerNotification: async (input, client) => {
      if (failNotificationInsert) throw new Error('simulated_notification_insert_failure');
      const state = ensureTransactionState(client);
      const existing = state.notifications.get(input.idempotencyKey);
      if (existing) return { notification: clone(existing), inserted: false };
      notificationSequence += 1;
      const notification = {
        id: `00000000-0000-0000-2000-${String(notificationSequence).padStart(12, '0')}`,
        ...clone(input)
      };
      state.notifications.set(input.idempotencyKey, notification);
      return { notification: clone(notification), inserted: true };
    }
  };

  try {
    touched.push(
      mockModule('src/db/client.js', dbClient),
      mockModule('src/services/portal-context.service.js', {
        resolvePortalTenantContext: async (tenantId) => ({ ok: true, tenantId, clinic: { id: clinicId } })
      }),
      mockModule('src/utils/logger.js', { logError: () => {} }),
      mockModule('src/repositories/orders.repository.js', ordersRepository),
      mockModule('src/repositories/order-customer-notifications.repository.js', notificationRepository),
      mockModule('src/repositories/contact.repository.js', {
        findContactByIdAndClinicId: async (id) => id === contactId
          ? { id, name: 'Cliente de prueba', phone: '********1234' }
          : null
      }),
      mockModule('src/repositories/portal-users.repository.js', {
        findPortalUserByIdAndClinicId: async () => null
      }),
      mockModule('src/repositories/payment-destinations.repository.js', {
        findPaymentDestinationById: async () => null
      }),
      mockModule('src/repositories/invoices.repository.js', {
        findInvoiceByOrderId: async () => null,
        createInvoice: async () => null
      }),
      mockModule('src/repositories/payments.repository.js', {
        createPayment: async () => null,
        listPaymentsByClinicId: async () => []
      }),
      mockModule('src/repositories/payment-allocations.repository.js', {
        sumRecordedAllocatedAmountsByInvoiceIds: async () => new Map()
      }),
      mockModule('src/repositories/products.repository.js', {
        findProductById: async () => productLookup,
        updateProduct: async () => null
      }),
      mockModule('src/repositories/inventory.repository.js', {}),
      mockModule('src/repositories/tenant.repository.js', {
        getClinicBusinessProfileById: async () => null
      }),
      mockModule('src/repositories/conversation.repository.js', {
        findConversationById: async () => null,
        updateConversationStage: async () => null
      }),
      mockModule('src/conversations/conversation.repo.js', {}),
      mockModule('src/services/portal-inbox.service.js', {
        sendPortalMessage: async () => null
      })
    );

    clearModule('src/services/order-customer-notifications.service.js');
    clearModule('src/services/portal-orders.service.js');
    const finalizationService = require(path.join(root, 'src/services/order-customer-notifications.service.js'));
    const ordersService = require(path.join(root, 'src/services/portal-orders.service.js'));

    productLookup = {
      id: '33333333-3333-3333-3333-333333333333',
      clinicId,
      name: 'Producto sin precio',
      unitPrice: null,
      price: null,
      currency: 'ARS',
      vatRate: 0,
      stock: 5,
      status: 'active',
      inventoryTrackingMode: 'legacy'
    };
    const invalidPriceOrder = await ordersService.createOrderForClinic(clinicId, {
      contactId,
      source: 'automation',
      status: 'draft',
      items: [{ productId: productLookup.id, quantity: 1 }]
    });
    assert.strictEqual(invalidPriceOrder.ok, false);
    assert.strictEqual(invalidPriceOrder.reason, 'order_item_product_price_invalid');
    productLookup = null;

    const firstOrderId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    database.orders.set(firstOrderId, buildOrder(firstOrderId));
    const first = await ordersService.patchOrderStatusForClinic(clinicId, firstOrderId, { status: 'confirmed' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.order.finalizationVersion, 1);
    assert.ok(first.order.finalizedAt);
    assert.strictEqual(database.notifications.size, 1);
    assert.strictEqual(Array.from(database.notifications.values())[0].status, 'pending');

    const retry = await ordersService.patchOrderStatusForClinic(clinicId, firstOrderId, { status: 'confirmed' });
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(database.notifications.size, 1);

    const concurrentOrderId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    database.orders.set(concurrentOrderId, buildOrder(concurrentOrderId));
    const [concurrentA, concurrentB] = await Promise.all([
      ordersService.patchOrderStatusForClinic(clinicId, concurrentOrderId, { status: 'confirmed' }),
      ordersService.patchOrderStatusForClinic(clinicId, concurrentOrderId, { status: 'confirmed' })
    ]);
    assert.strictEqual(concurrentA.ok, true);
    assert.strictEqual(concurrentB.ok, true);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === concurrentOrderId).length,
      1
    );
    assert.ok(lockCount >= 4, 'every status request must lock its order row');

    const directConfirmed = await ordersService.createOrderForClinic(clinicId, {
      contactId,
      source: 'automation',
      status: 'confirmed',
      items: [{ descriptionSnapshot: 'Alta directa', quantity: 1, unitPrice: 50, taxRate: 0 }]
    });
    assert.strictEqual(directConfirmed.ok, true);
    assert.strictEqual(directConfirmed.order.finalizationVersion, 1);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === directConfirmed.order.id).length,
      1
    );

    const draftCreation = await ordersService.createOrderForClinic(clinicId, {
      contactId,
      source: 'automation',
      status: 'draft',
      items: [{ descriptionSnapshot: 'Borrador', quantity: 1, unitPrice: 25, taxRate: 0 }]
    });
    assert.strictEqual(draftCreation.ok, true);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === draftCreation.order.id).length,
      0
    );

    const cancelledCreation = await ordersService.createOrderForClinic(clinicId, {
      contactId,
      source: 'automation',
      status: 'cancelled',
      items: [{ descriptionSnapshot: 'Cancelado', quantity: 1, unitPrice: 25, taxRate: 0 }]
    });
    assert.strictEqual(cancelledCreation.ok, true);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === cancelledCreation.order.id).length,
      0
    );

    const noContact = await ordersService.createOrderForClinic(clinicId, {
      customerType: 'final_consumer',
      source: 'automation',
      status: 'confirmed',
      items: [{ descriptionSnapshot: 'Consumidor final', quantity: 1, unitPrice: 10, taxRate: 0 }]
    });
    const skipped = Array.from(database.notifications.values()).find((row) => row.orderId === noContact.order.id);
    assert.strictEqual(noContact.ok, true);
    assert.strictEqual(skipped.status, 'skipped_no_contact');

    const reopenedOrderId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    database.orders.set(reopenedOrderId, buildOrder(reopenedOrderId, {
      status: 'draft',
      finalizationVersion: 1,
      finalizedAt: '2026-08-09T10:00:00.000Z'
    }));
    const reopened = await ordersService.patchOrderStatusForClinic(clinicId, reopenedOrderId, { status: 'confirmed' });
    assert.strictEqual(reopened.ok, true);
    assert.strictEqual(reopened.order.finalizationVersion, 1);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === reopenedOrderId).length,
      0
    );

    const rollbackOrderId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    database.orders.set(rollbackOrderId, buildOrder(rollbackOrderId));
    failNotificationInsert = true;
    await assert.rejects(
      ordersService.patchOrderStatusForClinic(clinicId, rollbackOrderId, { status: 'confirmed' }),
      /simulated_notification_insert_failure/
    );
    failNotificationInsert = false;
    assert.strictEqual(database.orders.get(rollbackOrderId).status, 'draft');
    assert.strictEqual(database.orders.get(rollbackOrderId).finalizationVersion, 0);
    assert.strictEqual(
      Array.from(database.notifications.values()).filter((row) => row.orderId === rollbackOrderId).length,
      0
    );

    const immutableNotification = Array.from(database.notifications.values()).find((row) => row.orderId === firstOrderId);
    database.orders.get(firstOrderId).items[0].descriptionSnapshot = 'Producto modificado después';
    database.orders.get(firstOrderId).totalAmount = 999;
    assert.strictEqual(immutableNotification.snapshot.items[0].description, 'Producto original');
    assert.strictEqual(immutableNotification.snapshot.total, 121);

    assert.deepStrictEqual(
      finalizationService.detectNewOrderFinalization({
        previousOrder: buildOrder('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', { status: 'cancelled' }),
        order: buildOrder('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', { status: 'cancelled' })
      }),
      { isNewFinalization: false, reason: 'order_not_confirmed' }
    );
  } finally {
    clearModule('src/services/portal-orders.service.js');
    clearModule('src/services/order-customer-notifications.service.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

Promise.resolve()
  .then(assertMigrationContract)
  .then(testRepositoryIdempotentInsert)
  .then(testTransactionalFinalizationScenarios)
  .then(() => {
    console.log('order-customer-notification-foundation.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
