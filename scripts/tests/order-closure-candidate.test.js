const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createOrderClosureService, CLOSURE_GRACE_WINDOW_MS, detectClosure } = require('../../src/services/order-closure.service');
const { buildOrderCustomerNotificationSnapshot } = require('../../src/services/order-customer-notifications.service');
const { formatOrderCustomerSummary } = require('../../src/services/order-customer-summary-formatter.service');
const { evaluateCustomerServiceWindow } = require('../../src/services/whatsapp-customer-service-window.service');
const closureRepository = require('../../src/repositories/order-closure.repository');

function fixture(options = {}) {
  let now = Date.parse('2026-09-21T20:00:00.000Z');
  const order = {
    id: 'order-a', clinicId: 'tenant-a', conversationId: 'conversation-a', contactId: 'contact-a',
    status: 'draft', source: 'human_takeover', updatedAt: '2026-09-21T19:59:00.000Z',
    currency: 'ARS', subtotalAmount: 300, taxAmount: 0, totalAmount: 300,
    paymentStatus: 'pending', items: [{ id: 'item-a', productId: 'product-a', quantity: 3,
      unitPrice: 100, taxRate: 0, subtotalAmount: 300, totalAmount: 300,
      descriptionSnapshot: 'Producto A', currencySnapshot: 'ARS', variant: 'caja' }]
  };
  const conversation = { id: 'conversation-a', clinicId: 'tenant-a', channelId: 'channel-a',
    connectionMode: options.connectionMode || 'API_ONLY', context: { portalBotEnabled: false } };
  const messages = [
    { id: 'inbound-a', direction: 'inbound', text: 'Mandame tres cajas de Producto A', raw: {} },
    { id: 'human-a', direction: 'outbound', text: options.humanText || 'Dale Juan, te envío las tres cajas.', raw: { actor: 'HUMAN' } }
  ];
  const reservations = [{ id: 'reservation-a', orderItemId: 'item-a', productId: 'product-a', quantity: 3, status: 'active' }];
  const products = { 'product-a': { id: 'product-a', stock: 10, status: 'active', metadata: { catalog: { unitOfMeasure: 'caja', inventoryTrackingMode: options.inventoryTrackingMode || 'legacy' } } } };
  const candidates = new Map();
  const state = { order, conversation, messages, reservations, products, candidates, jobs: [], confirmations: 0, stockCommits: 0, lotCommits: 0, notifications: [], blockingOperation: false, operation: { result: 'applied' } };
  const repo = {
    withTransaction: async (fn) => fn({}),
    listReviewScopes: async () => order.status === 'draft' && ![...candidates.values()].some((candidate) => candidate.sourceMessageId === messages.at(-1).id)
      ? [{ tenantId: 'tenant-a', channelId: 'channel-a', conversationId: 'conversation-a', orderId: 'order-a', sourceMessageId: messages.at(-1).id }] : [],
    lockConversation: async (tenantId, id) => tenantId === 'tenant-a' && id === conversation.id ? conversation : null,
    getOrder: async (tenantId, id) => tenantId === 'tenant-a' && id === order.id ? order : null,
    getLatestRelevantMessage: async () => messages.at(-1),
    listRelevantMessages: async () => messages,
    listReservations: async () => reservations.filter((row) => row.status === 'active'),
    getLastOperation: async () => state.operation,
    hasBlockingOperationSince: async () => state.blockingOperation,
    createCandidate: async (input) => {
      if ([...candidates.values()].some((candidate) => candidate.sourceMessageId === input.sourceMessageId)) return null;
      const candidate = { id: `candidate-${candidates.size + 1}`, status: 'pending', createdAt: new Date(now).toISOString(), ...input };
      candidates.set(candidate.id, candidate);
      return candidate;
    },
    enqueueCandidate: async (candidate) => { state.jobs.push({ candidateId: candidate.id, runAt: candidate.executeAfter }); },
    getCandidate: async (tenantId, id) => tenantId === 'tenant-a' ? candidates.get(id) : null,
    lockCandidate: async (tenantId, id) => tenantId === 'tenant-a' ? candidates.get(id) : null,
    setCandidateStatus: async (tenantId, id, status, reason) => {
      const candidate = candidates.get(id);
      if (tenantId !== 'tenant-a' || candidate.status !== 'pending') return null;
      Object.assign(candidate, { status, reason }); return candidate;
    },
    invalidatePendingForMessage: async (tenantId, conversationId, messageId) => {
      let count = 0;
      for (const candidate of candidates.values()) {
        if (tenantId === 'tenant-a' && conversationId === 'conversation-a' && candidate.status === 'pending' && candidate.sourceMessageId !== messageId) {
          candidate.status = 'stale'; count += 1;
        }
      }
      return count;
    },
    commitLegacyStock: async (tenantId, productId, quantity) => {
      if (tenantId !== 'tenant-a' || products[productId].stock < quantity) return null;
      products[productId].stock -= quantity; state.stockCommits += 1; return products[productId];
    },
    commitReservation: async (tenantId, id) => {
      const row = reservations.find((entry) => entry.id === id && entry.status === 'active');
      if (tenantId !== 'tenant-a' || !row) return null;
      row.status = 'committed'; return row;
    }
  };
  const service = createOrderClosureService({
    repository: repo,
    lockProduct: async (productId, tenantId) => tenantId === 'tenant-a' ? products[productId] : null,
    getActiveReservedQuantity: async (productId) => reservations.filter((row) => row.productId === productId && row.status === 'active').reduce((sum, row) => sum + row.quantity, 0),
    listEligibleLotsForFefo: async () => [{ availableQuantity: 10 }],
    consumeLotBasedOrderItem: async () => { state.lotCommits += 1; return { ok: true }; },
    now: () => new Date(now),
    updateOrderStatus: async () => { order.status = 'confirmed'; order.updatedAt = new Date(now).toISOString(); state.confirmations += 1; return order; },
    prepareOrderCustomerNotification: async ({ order: confirmedOrder }) => {
      const snapshot = buildOrderCustomerNotificationSnapshot({ ...confirmedOrder, finalizedAt: new Date(now).toISOString(), finalizationVersion: 1 });
      state.notifications.push(snapshot); return { notification: { id: 'notification-a', snapshot } };
    }
  });
  const scope = { tenantId: 'tenant-a', channelId: 'channel-a', conversationId: 'conversation-a', orderId: 'order-a', sourceMessageId: 'human-a' };
  return { state, service, scope, advance: (ms) => { now += ms; }, addMessage: (message) => { messages.push(message); } };
}

test('a phrase with upsell question cannot become a closure candidate', async () => {
  const h = fixture({ humanText: 'Dale Juan, te envío las tres cajas. ¿Querés que agregue B?' });
  assert.equal((await h.service.createCandidateForScope(h.scope)).created, false);
  assert.equal(h.state.order.status, 'draft');
  assert.equal(detectClosure({ messages: h.state.messages, order: h.state.order, lastOperation: h.state.operation }).status, 'CLOSURE_BLOCKED');
});

test('an isolated farewell and an unanswered prior human question do not close', async () => {
  const isolated = fixture();
  isolated.state.messages.splice(0, 1);
  assert.equal((await isolated.service.createCandidateForScope(isolated.scope)).created, false);
  const unanswered = fixture();
  unanswered.state.messages.splice(1, 0, { id: 'human-question', direction: 'outbound',
    text: '¿Pago por transferencia?', raw: { actor: 'HUMAN' } });
  assert.equal((await unanswered.service.createCandidateForScope(unanswered.scope)).created, false);
});

test('human quantity must agree with the structured draft', async () => {
  const h = fixture({ humanText: 'Dale Juan, te envío dos cajas.' });
  const result = await h.service.createCandidateForScope(h.scope);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'closure_quantity_disagrees_with_order');
});

test('a complete draft creates a durable candidate and remains draft during grace', async () => {
  const h = fixture();
  const result = await h.service.createCandidateForScope(h.scope);
  assert.equal(result.created, true);
  assert.equal(h.state.order.status, 'draft');
  assert.equal(Date.parse(result.executeAfter) - Date.parse('2026-09-21T20:00:00.000Z'), CLOSURE_GRACE_WINDOW_MS);
  assert.equal(h.state.jobs.length, 1);
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', candidateId: result.candidateId, conversationId: 'conversation-a', orderId: 'order-a' })).reason, 'grace_not_elapsed');
});

test('customer continuation and human question invalidate the old candidate', async () => {
  for (const message of [
    { id: 'inbound-b', direction: 'inbound', text: 'Agregame dos B también', raw: {} },
    { id: 'human-b', direction: 'outbound', text: '¿No querés agregar B?', raw: { actor: 'HUMAN' } }
  ]) {
    const h = fixture();
    const created = await h.service.createCandidateForScope(h.scope);
    h.addMessage(message);
    await h.service.invalidateForMessage('tenant-a', 'conversation-a', message.id);
    h.advance(CLOSURE_GRACE_WINDOW_MS);
    const result = await h.service.confirmCandidate({ tenantId: 'tenant-a', candidateId: created.candidateId, conversationId: 'conversation-a', orderId: 'order-a' });
    assert.equal(result.confirmed, false);
    assert.equal(h.state.order.status, 'draft');
    assert.equal(h.state.confirmations, 0);
  }
});

test('valid job confirms once and commits stock once; duplicate job is a no-op', async () => {
  const h = fixture();
  const created = await h.service.createCandidateForScope(h.scope);
  h.advance(CLOSURE_GRACE_WINDOW_MS);
  const input = { tenantId: 'tenant-a', candidateId: created.candidateId, conversationId: 'conversation-a', orderId: 'order-a' };
  assert.equal((await h.service.confirmCandidate(input)).confirmed, true);
  assert.equal((await h.service.confirmCandidate(input)).confirmed, false);
  assert.equal(h.state.order.status, 'confirmed');
  assert.equal(h.state.products['product-a'].stock, 7);
  assert.equal(h.state.reservations[0].status, 'committed');
  assert.equal(h.state.confirmations, 1);
  assert.equal(h.state.stockCommits, 1);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.conversation.context.portalBotEnabled, false);
});

test('order revision, reservation mismatch, ambiguity and cross-tenant job fail closed', async () => {
  for (const variant of ['revision', 'reservation', 'ambiguity', 'tenant']) {
    const h = fixture();
    const created = await h.service.createCandidateForScope(h.scope);
    h.advance(CLOSURE_GRACE_WINDOW_MS);
    if (variant === 'revision') h.state.order.updatedAt = '2026-09-21T20:00:01.000Z';
    if (variant === 'reservation') h.state.reservations[0].quantity = 2;
    if (variant === 'ambiguity') h.state.blockingOperation = true;
    const input = { tenantId: variant === 'tenant' ? 'tenant-b' : 'tenant-a', candidateId: created.candidateId, conversationId: 'conversation-a', orderId: 'order-a' };
    assert.equal((await h.service.confirmCandidate(input)).confirmed, false);
    assert.equal(h.state.stockCommits, 0);
    assert.equal(h.state.order.status, 'draft');
  }
});

test('API_ONLY and COEXISTENCE fixtures use the same closure rules', async () => {
  for (const connectionMode of ['API_ONLY', 'COEXISTENCE']) {
    const h = fixture({ connectionMode });
    const created = await h.service.createCandidateForScope(h.scope);
    h.advance(CLOSURE_GRACE_WINDOW_MS);
    assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', candidateId: created.candidateId,
      conversationId: 'conversation-a', orderId: 'order-a' })).confirmed, true);
  }
});

test('lot inventory uses the existing FEFO commit path once', async () => {
  const h = fixture({ inventoryTrackingMode: 'lot_based' });
  const created = await h.service.createCandidateForScope(h.scope);
  h.advance(CLOSURE_GRACE_WINDOW_MS);
  const input = { tenantId: 'tenant-a', channelId: 'channel-a', candidateId: created.candidateId,
    conversationId: 'conversation-a', orderId: 'order-a' };
  assert.equal((await h.service.confirmCandidate(input)).confirmed, true);
  assert.equal((await h.service.confirmCandidate(input)).confirmed, false);
  assert.equal(h.state.lotCommits, 1);
  assert.equal(h.state.stockCommits, 0);
});

test('a stock conflict at wake time blocks confirmation without stock commit', async () => {
  const h = fixture();
  const created = await h.service.createCandidateForScope(h.scope);
  h.state.products['product-a'].stock = 2;
  h.advance(CLOSURE_GRACE_WINDOW_MS);
  const result = await h.service.confirmCandidate({ tenantId: 'tenant-a', candidateId: created.candidateId,
    conversationId: 'conversation-a', orderId: 'order-a' });
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'stock_conflict');
  assert.equal(h.state.stockCommits, 0);
  assert.equal(h.state.order.status, 'draft');
});

test('structured notification contains only persisted items and respects the service window', async () => {
  const h = fixture();
  const created = await h.service.createCandidateForScope(h.scope);
  h.advance(CLOSURE_GRACE_WINDOW_MS);
  await h.service.confirmCandidate({ tenantId: 'tenant-a', candidateId: created.candidateId, conversationId: 'conversation-a', orderId: 'order-a' });
  const snapshot = h.state.notifications[0];
  assert.deepEqual(snapshot.items.map((item) => [item.productId, item.quantity, item.unitPrice]), [['product-a', 3, 100]]);
  assert.equal(snapshot.total, 300);
  assert.equal(snapshot.items.some((item) => item.productId === 'product-b'), false);
  const summary = formatOrderCustomerSummary({ snapshot, customerName: 'Juan', settings: {} });
  assert.match(summary.text, /Producto A/);
  assert.equal(evaluateCustomerServiceWindow({ lastInboundAt: '2026-09-21T19:00:00.000Z', now: new Date('2026-09-21T20:00:00.000Z') }).allowed, true);
  assert.equal(evaluateCustomerServiceWindow({ lastInboundAt: '2026-09-19T19:00:00.000Z', now: new Date('2026-09-21T20:00:00.000Z') }).allowed, false);
});

test('candidate migration has durable scope, uniqueness and due-job storage', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE clinics (id UUID PRIMARY KEY); CREATE TABLE channels (id UUID PRIMARY KEY);
    CREATE TABLE conversations (id UUID PRIMARY KEY); CREATE TABLE orders (id UUID PRIMARY KEY);
    CREATE TABLE conversation_messages (id UUID PRIMARY KEY, "conversationId" UUID NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL);
    CREATE TABLE jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" UUID NOT NULL,
      "channelId" UUID NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
      attempts INT NOT NULL, "maxAttempts" INT NOT NULL, "runAt" TIMESTAMPTZ NOT NULL,
      "updatedAt" TIMESTAMPTZ NOT NULL);`);
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/083_order_closure_candidates.sql'), 'utf8')
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/i, '');
  await db.exec(migration);
  const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_closure_candidates'");
  assert.equal(tables.rows.length, 1);
  const ids = [1, 2, 3, 4, 5, 6].map((value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`);
  await db.query('INSERT INTO clinics VALUES ($1)', [ids[0]]);
  await db.query('INSERT INTO channels VALUES ($1)', [ids[1]]);
  await db.query('INSERT INTO conversations VALUES ($1)', [ids[2]]);
  await db.query('INSERT INTO orders VALUES ($1)', [ids[3]]);
  await db.query('INSERT INTO conversation_messages VALUES ($1,$2,$3)', [ids[4], ids[2], '2026-09-21T20:00:00Z']);
  const input = { tenantId: ids[0], channelId: ids[1], conversationId: ids[2], orderId: ids[3],
    sourceMessageId: ids[4], orderRevision: '2026-09-21T19:59:00Z',
    conversationRevision: ids[4], orderFingerprint: 'fingerprint', executeAfter: '2026-09-21T20:00:30Z' };
  const candidate = await closureRepository.createCandidate(input, db);
  assert.ok(candidate?.id);
  await db.query('UPDATE order_closure_candidates SET "createdAt"=$2 WHERE id=$1', [candidate.id, '2026-09-21T20:00:00Z']);
  assert.equal(await closureRepository.createCandidate(input, db), null);
  await closureRepository.enqueueCandidate(candidate, db);
  const queued = await db.query('SELECT type, "runAt", payload FROM jobs');
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.rows[0].type, 'order_closure_confirm');
  assert.equal(queued.rows[0].payload.candidateId, candidate.id);
  assert.equal(new Date(queued.rows[0].runAt).toISOString(), '2026-09-21T20:00:30.000Z');
  await db.query('INSERT INTO conversation_messages VALUES ($1,$2,$3)', [ids[5], ids[2], '2026-09-21T20:01:00Z']);
  assert.equal(await closureRepository.invalidatePendingForMessage(ids[0], ids[2], ids[5], db), 1);
  const after = await db.query('SELECT status FROM order_closure_candidates WHERE id=$1', [candidate.id]);
  assert.equal(after.rows[0].status, 'stale');
  await db.close();
});
