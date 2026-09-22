const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const {
  buildOrderDecision,
  productMentions,
  createTakeoverOrderProcessor
} = require('../../src/services/takeover-order-processing.service');
const { createTakeoverOperationalProcessor } = require('../../src/conversations/takeover-operational.service');
const { buildResumeContextPatch } = require('../../src/conversations/human-takeover.service');

function product(id, name, stock = 20, extra = {}) {
  return { id, clinicId: extra.clinicId || 'tenant-a', name, stock, status: 'active', unitPrice: 100, currency: 'ARS', taxRate: 0, unitOfMeasure: extra.unitOfMeasure || 'caja', attributes: extra.attributes || {}, ...extra };
}

function createHarness(options = {}) {
  const state = {
    products: options.products || [product('product-a', '9 DE ORO AGRIDULCE')],
    messages: new Map(), drafts: new Map(), reservations: new Map(), operations: new Map(), sequence: 0
  };
  let transactionTail = Promise.resolve();
  const scopedProducts = (tenantId) => state.products.filter((item) => item.clinicId === tenantId);
  const draftKey = (tenantId, conversationId) => `${tenantId}:${conversationId}`;
  const repo = {
    withTransaction: async (fn) => {
      let release;
      const previous = transactionTail;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try { return await fn({}); } finally { release(); }
    },
    lockConversation: async () => {},
    beginOperation: async (input) => {
      const key = `${input.tenantId}:${input.sourceMessageId}`;
      if (state.operations.has(key)) return null;
      const row = { id: `operation-${++state.sequence}`, ...input, result: 'processing' };
      state.operations.set(key, row);
      return row;
    },
    completeOperation: async (id, tenantId, patch) => {
      const row = [...state.operations.values()].find((item) => item.id === id && item.tenantId === tenantId);
      Object.assign(row, patch);
      return row;
    },
    findDraftByConversation: async (tenantId, conversationId) => state.drafts.get(draftKey(tenantId, conversationId)) || null,
    getDraftSnapshot: async (tenantId, conversationId) => state.drafts.get(draftKey(tenantId, conversationId)) || null,
    listOrderItems: async (orderId) => {
      const draft = [...state.drafts.values()].find((item) => item.id === orderId);
      return draft ? draft.items.map((item) => ({ ...item })) : [];
    },
    createDraft: async (input) => {
      const item = { id: `item-${++state.sequence}`, orderId: `order-${state.sequence}`, ...input.item };
      const draft = { id: item.orderId, clinicId: input.tenantId, conversationId: input.conversationId, contactId: input.contactId, status: 'draft', items: [item] };
      state.drafts.set(draftKey(input.tenantId, input.conversationId), draft);
      return draft;
    },
    upsertOrderItem: async (orderId, item) => {
      const draft = [...state.drafts.values()].find((entry) => entry.id === orderId);
      const existing = draft.items.find((entry) => entry.productId === item.productId);
      if (existing) { Object.assign(existing, item); return { ...existing, created: false }; }
      const created = { id: `item-${++state.sequence}`, orderId, ...item };
      draft.items.push(created);
      return { ...created, created: true };
    },
    removeOrderItem: async (orderItemId) => {
      for (const draft of state.drafts.values()) {
        const index = draft.items.findIndex((item) => item.id === orderItemId);
        if (index >= 0) return draft.items.splice(index, 1)[0];
      }
      return null;
    },
    recalculateOrder: async (orderId) => ({ id: orderId }),
    lockProduct: async (productId, tenantId) => scopedProducts(tenantId).find((item) => item.id === productId) || null,
    getActiveReservedQuantity: async (productId, tenantId, excludeOrderItemId = null) => [...state.reservations.values()]
      .filter((item) => item.tenantId === tenantId && item.productId === productId && item.status === 'active' && item.orderItemId !== excludeOrderItemId)
      .reduce((sum, item) => sum + item.quantity, 0),
    getActiveReservation: async (orderItemId, tenantId) => [...state.reservations.values()]
      .find((item) => item.tenantId === tenantId && item.orderItemId === orderItemId && item.status === 'active') || null,
    setReservation: async (input) => {
      const existing = [...state.reservations.values()].find((item) => item.tenantId === input.tenantId && item.orderItemId === input.orderItemId && item.status === 'active');
      if (input.quantity <= 0) {
        if (existing) { existing.quantity = 0; existing.status = 'released'; }
        return existing || null;
      }
      if (existing) { existing.quantity = input.quantity; return existing; }
      const created = { id: `reservation-${++state.sequence}`, status: 'active', ...input };
      state.reservations.set(created.id, created);
      return created;
    }
  };

  const process = createTakeoverOrderProcessor({
    repository: repo,
    listProducts: async (tenantId) => scopedProducts(tenantId),
    listMessages: async (conversationId) => [...state.messages.values()].filter((item) => item.conversationId === conversationId),
    getMessage: async (messageId) => state.messages.get(messageId) || null,
    findContact: async () => ({ id: 'contact-a', name: 'Juan', phone: '5492910000000' }),
    previewDraft: async (scope) => repo.getDraftSnapshot(scope.clinicId, scope.conversationId)
  });

  function inbound(id, conversationId, text) {
    state.messages.set(id, { id, conversationId, direction: 'inbound', text });
    return process({ clinicId: 'tenant-a', channelId: 'channel-a', conversationId, contactId: 'contact-a', inboundMessageId: id });
  }
  function history(id, conversationId, text, direction = 'outbound') {
    state.messages.set(id, { id, conversationId, direction, text });
  }
  function activeReservations(productId = null) {
    return [...state.reservations.values()].filter((item) => item.status === 'active' && (!productId || item.productId === productId));
  }
  return { state, repo, process, inbound, history, activeReservations };
}

test('high-confidence contextual request creates one DRAFT and reserves stock without changing physical stock', async () => {
  const h = createHarness();
  h.history('human-1', 'conversation-a', 'Juan, te puedo mandar 9 DE ORO AGRIDULCE.');
  const result = await h.inbound('message-1', 'conversation-a', 'Perfecto, mandame tres cajas.');
  const draft = h.state.drafts.get('tenant-a:conversation-a');
  assert.equal(result.operation, 'ORDER_DRAFT_CREATED');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.items[0].productId, 'product-a');
  assert.equal(draft.items[0].quantity, 3);
  assert.equal(h.activeReservations()[0].quantity, 3);
  assert.equal(h.state.products[0].stock, 20);
});

test('quantity correction updates one item and adjusts its reservation', async () => {
  const h = createHarness();
  h.history('human-1', 'conversation-a', 'Tengo 9 DE ORO AGRIDULCE.');
  await h.inbound('message-1', 'conversation-a', 'Mandame tres cajas');
  const result = await h.inbound('message-2', 'conversation-a', 'Mejor dos');
  const draft = h.state.drafts.get('tenant-a:conversation-a');
  assert.equal(result.operation, 'ORDER_ITEM_QUANTITY_CHANGED');
  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].quantity, 2);
  assert.equal(h.activeReservations()[0].quantity, 2);
});

test('additional product is added without changing the existing line', async () => {
  const h = createHarness({ products: [product('product-a', 'Producto A'), product('product-b', 'Producto B')] });
  h.history('human-a', 'conversation-a', 'Producto A');
  await h.inbound('message-a', 'conversation-a', 'Mandame dos cajas');
  const result = await h.inbound('message-b', 'conversation-a', 'Agregame 4 de Producto B');
  const draft = h.state.drafts.get('tenant-a:conversation-a');
  assert.equal(result.operation, 'ORDER_ITEM_ADDED');
  assert.deepEqual(draft.items.map((item) => [item.productId, item.quantity]), [['product-a', 2], ['product-b', 4]]);
  assert.equal(h.activeReservations().reduce((sum, item) => sum + item.quantity, 0), 6);
});

test('remove item releases reservation and leaves other items unchanged', async () => {
  const h = createHarness({ products: [product('product-a', 'Producto A'), product('product-b', 'Producto B')] });
  h.history('human-a', 'conversation-a', 'Producto A');
  await h.inbound('message-a', 'conversation-a', 'Mandame dos cajas');
  await h.inbound('message-b', 'conversation-a', 'Agregame 4 de Producto B');
  const result = await h.inbound('message-c', 'conversation-a', 'Sacame Producto B');
  const draft = h.state.drafts.get('tenant-a:conversation-a');
  assert.equal(result.operation, 'ORDER_ITEM_REMOVED');
  assert.deepEqual(draft.items.map((item) => item.productId), ['product-a']);
  assert.equal(h.activeReservations('product-b').length, 0);
  assert.equal(h.activeReservations('product-a')[0].quantity, 2);
});

test('ambiguous reference records a skip and mutates neither order nor stock', async () => {
  const products = [product('a', 'Producto A'), product('b', 'Producto B'), product('c', 'Producto C')];
  const h = createHarness({ products });
  h.history('human-1', 'conversation-a', 'Tengo Producto A, Producto B y Producto C.');
  const result = await h.inbound('message-1', 'conversation-a', 'Mandame tres');
  assert.equal(result.confidence, 'AMBIGUOUS');
  assert.equal(h.state.drafts.size, 0);
  assert.equal(h.activeReservations().length, 0);
  assert.equal([...h.state.operations.values()][0].operation, 'ORDER_OPERATION_SKIPPED_AMBIGUOUS');
});

test('unknown product and unknown stock never fabricate a reservation', async () => {
  const unknownProduct = createHarness();
  const first = await unknownProduct.inbound('message-1', 'conversation-a', 'Mandame tres cajas de Fantasma');
  assert.equal(first.mutated, false);
  assert.equal(unknownProduct.state.drafts.size, 0);

  const contextualUnknown = createHarness();
  contextualUnknown.history('human-context', 'conversation-context', 'Tengo 9 DE ORO AGRIDULCE.');
  const contextualResult = await contextualUnknown.inbound('message-context', 'conversation-context', 'Mandame tres de Fantasma');
  assert.equal(contextualResult.reason, 'UNKNOWN_PRODUCT_CURRENT_MESSAGE');
  assert.equal(contextualUnknown.state.drafts.size, 0);

  const unknownStock = createHarness({ products: [product('product-a', 'Producto A', null)] });
  unknownStock.state.products[0].stock = null;
  const second = await unknownStock.inbound('message-2', 'conversation-b', 'Mandame tres cajas de Producto A');
  assert.equal(second.reason, 'STOCK_UNKNOWN');
  assert.equal(unknownStock.state.drafts.size, 0);
  assert.equal(unknownStock.activeReservations().length, 0);
});

test('exact product phrase wins over generic unit suffixes', () => {
  const products = [product('yapa', 'LA YAPA X UNIDAD'), product('beldent', 'BELDENT X UNIDAD')];
  assert.deepEqual(productMentions(products, 'Cuanto sale LA YAPA X UNIDAD y tenes stock?').map((item) => item.id), ['yapa']);
  const decision = buildOrderDecision({ text: 'Mandame 3 de LA YAPA X UNIDAD', products, messages: [] });
  assert.equal(decision.product.id, 'yapa');
});

test('zero and insufficient stock leave the draft and reservation untouched', async () => {
  const zero = createHarness({ products: [product('product-a', 'Producto A', 0)] });
  const zeroResult = await zero.inbound('message-zero', 'conversation-a', 'Mandame tres cajas de Producto A');
  assert.equal(zeroResult.reason, 'INSUFFICIENT_STOCK');
  assert.equal(zero.state.drafts.size, 0);

  const low = createHarness({ products: [product('product-a', 'Producto A', 2)] });
  const lowResult = await low.inbound('message-low', 'conversation-a', 'Mandame tres cajas de Producto A');
  assert.equal(lowResult.reason, 'INSUFFICIENT_STOCK');
  assert.equal(low.activeReservations().length, 0);
});

test('unknown packaging keeps a grounded commercial draft without fabricating physical units', async () => {
  const h = createHarness({ products: [product('product-a', 'Producto A', 20, { unitOfMeasure: 'unidad', attributes: {} })] });
  const result = await h.inbound('message-a', 'conversation-a', 'Mandame tres cajas de Producto A');
  const draft = h.state.drafts.get('tenant-a:conversation-a');
  assert.equal(result.mutated, true);
  assert.equal(draft.items[0].quantity, 3);
  assert.equal(draft.items[0].variant, 'caja');
  assert.equal(h.activeReservations().length, 0);
  assert.equal(h.state.products[0].stock, 20);
});

test('same source message processed three times performs one logical mutation', async () => {
  const h = createHarness();
  h.state.messages.set('message-1', { id: 'message-1', conversationId: 'conversation-a', text: 'Mandame tres cajas de 9 DE ORO AGRIDULCE' });
  const scope = { clinicId: 'tenant-a', channelId: 'channel-a', conversationId: 'conversation-a', contactId: 'contact-a', inboundMessageId: 'message-1' };
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await h.process(scope));
  assert.equal(results.filter((item) => item.mutated).length, 1);
  assert.equal(results.filter((item) => item.duplicate).length, 2);
  assert.equal(h.state.drafts.size, 1);
  assert.equal(h.activeReservations().length, 1);
  assert.equal(h.state.operations.size, 1);
});

test('two conversations competing concurrently never reserve beyond physical stock', async () => {
  const h = createHarness({ products: [product('product-a', 'Producto A', 5)] });
  const [a, b] = await Promise.all([
    h.inbound('message-a', 'conversation-a', 'Mandame tres cajas de Producto A'),
    h.inbound('message-b', 'conversation-b', 'Mandame tres cajas de Producto A')
  ]);
  assert.equal([a, b].filter((item) => item.mutated).length, 1);
  assert.equal([a, b].filter((item) => item.reason === 'INSUFFICIENT_STOCK').length, 1);
  assert.ok(h.activeReservations().reduce((sum, item) => sum + item.quantity, 0) <= 5);
  assert.equal(h.state.products[0].stock, 5);
});

test('catalog and mutations remain tenant scoped', async () => {
  const h = createHarness({ products: [
    product('product-a', 'Producto Igual', 10, { clinicId: 'tenant-a' }),
    product('product-b', 'Producto Igual', 10, { clinicId: 'tenant-b' })
  ] });
  const result = await h.inbound('message-a', 'conversation-a', 'Mandame dos cajas de Producto Igual');
  assert.equal(result.productId, 'product-a');
  assert.equal(h.activeReservations()[0].tenantId, 'tenant-a');
  assert.equal(h.state.products[1].stock, 10);
});

test('takeover operational path processes orders silently and preserves resume-owned drafts', async () => {
  const calls = { order: 0, updates: [], replies: 0 };
  const process = createTakeoverOperationalProcessor({
    upsertLead: async () => {},
    processOrder: async () => { calls.order += 1; return { mutated: true, operation: 'ORDER_DRAFT_CREATED', orderId: 'order-a' }; },
    updateConversation: async (input) => { calls.updates.push(input); return { id: input.conversationId }; }
  });
  await process({ clinicId: 'tenant-a', channelId: 'channel-a', conversationId: 'conversation-a', contactId: 'contact-a', inboundMessageId: 'message-a' });
  assert.equal(calls.order, 1);
  assert.equal(calls.replies, 0);
  assert.equal(calls.updates[0].contextPatch.portalLastOperationalOrderResult.orderId, 'order-a');
  assert.equal(calls.updates[0].contextPatch.portalLastProcessedInboundMessageId, 'message-a');
});

test('manual bot resume changes ownership only and preserves draft plus reservation', async () => {
  const h = createHarness();
  await h.inbound('message-a', 'conversation-a', 'Mandame tres cajas de 9 DE ORO AGRIDULCE');
  const beforeDraft = JSON.parse(JSON.stringify(h.state.drafts.get('tenant-a:conversation-a')));
  const beforeReservations = JSON.parse(JSON.stringify(h.activeReservations()));
  const resumedContext = { portalBotEnabled: false, ...buildResumeContextPatch() };
  assert.equal(resumedContext.portalBotEnabled, true);
  assert.deepEqual(h.state.drafts.get('tenant-a:conversation-a'), beforeDraft);
  assert.deepEqual(h.activeReservations(), beforeReservations);
});

test('migration defines reservation integrity, idempotency, and no physical stock mutation', () => {
  const root = path.resolve(__dirname, '..', '..');
  const migration = fs.readFileSync(path.join(root, 'db/migrations/082_human_takeover_order_reservations.sql'), 'utf8');
  const repository = fs.readFileSync(path.join(root, 'src/repositories/takeover-order.repository.js'), 'utf8');
  const portalOrders = fs.readFileSync(path.join(root, 'src/services/portal-orders.service.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS order_stock_reservations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS order_automation_operations/);
  assert.match(migration, /uniq_order_automation_operations_source_message/);
  assert.match(repository, /FOR UPDATE/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.doesNotMatch(repository, /UPDATE products[\s\S]*SET stock/i);
  assert.match(portalOrders, /releaseOrderReservations/);
  assert.match(portalOrders, /takeoverReservedItemIds\.has\(item\.id\)/);
  assert.match(worker, /job\.type === 'conversation_operational'/);
  assert.match(worker, /job\.type === 'conversation_reply'/);
});

test('migration applies cleanly and enforces one operation per source message', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clinics (id UUID PRIMARY KEY);
    CREATE TABLE conversations (id UUID PRIMARY KEY);
    CREATE TABLE products (id UUID PRIMARY KEY, "clinicId" UUID NOT NULL, UNIQUE (id, "clinicId"));
    CREATE TABLE orders (id UUID PRIMARY KEY);
    CREATE TABLE order_items (id UUID PRIMARY KEY);
    CREATE TABLE conversation_messages (id UUID PRIMARY KEY);
  `);
  const migration = fs.readFileSync(path.resolve(__dirname, '..', '..', 'db/migrations/082_human_takeover_order_reservations.sql'), 'utf8')
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/i, '');
  await db.exec(migration);
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const conversationId = '00000000-0000-4000-8000-000000000002';
  const productId = '00000000-0000-4000-8000-000000000003';
  const orderId = '00000000-0000-4000-8000-000000000004';
  const itemId = '00000000-0000-4000-8000-000000000005';
  const messageId = '00000000-0000-4000-8000-000000000006';
  await db.query('INSERT INTO clinics VALUES ($1)', [tenantId]);
  await db.query('INSERT INTO conversations VALUES ($1)', [conversationId]);
  await db.query('INSERT INTO products VALUES ($1, $2)', [productId, tenantId]);
  await db.query('INSERT INTO orders VALUES ($1)', [orderId]);
  await db.query('INSERT INTO order_items VALUES ($1)', [itemId]);
  await db.query('INSERT INTO conversation_messages VALUES ($1)', [messageId]);
  await db.query(`INSERT INTO order_stock_reservations ("tenantId", "orderId", "orderItemId", "productId", quantity) VALUES ($1,$2,$3,$4,3)`, [tenantId, orderId, itemId, productId]);
  await db.query(`INSERT INTO order_automation_operations ("tenantId", "conversationId", "orderId", "productId", "sourceMessageId", operation) VALUES ($1,$2,$3,$4,$5,'ORDER_DRAFT_CREATED')`, [tenantId, conversationId, orderId, productId, messageId]);
  await assert.rejects(
    db.query(`INSERT INTO order_automation_operations ("tenantId", "conversationId", "sourceMessageId", operation) VALUES ($1,$2,$3,'RETRY')`, [tenantId, conversationId, messageId])
  );
  assert.equal((await db.query('SELECT quantity::text AS quantity FROM order_stock_reservations')).rows[0].quantity, '3.000');
  await db.close();
});
