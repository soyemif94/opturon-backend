const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const {
  AMENDMENT_CONTEXT_WINDOW_MS, isExplicitNewOrder, snapshotOrder,
  decideAmendment, applyDecision, calculateDelta
} = require('../../src/services/order-amendment-model');
const { closureForAmendment } = require('../../src/services/order-amendment.service');
const { formatOrderCustomerSummary } = require('../../src/services/order-customer-summary-formatter.service');
const { buildOrderCustomerNotificationSnapshot } = require('../../src/services/order-customer-notifications.service');
const amendmentRepository = require('../../src/repositories/order-amendment.repository');
const { __private__: portalOrderPrivate } = require('../../src/services/portal-orders.service');

test('portal cancellation releases or blocks a pending amendment as designed', () => {
  assert.equal(portalOrderPrivate.shouldCancelActiveAmendment('cancelled', 'pending'), true);
});

test('portal payment transition releases or blocks a pending amendment as designed', () => {
  assert.equal(portalOrderPrivate.shouldCancelActiveAmendment('confirmed', 'paid'), true);
  assert.equal(portalOrderPrivate.shouldCancelActiveAmendment('pending_payment', 'unpaid'), false);
});

const products = [
  { id: 'a', name: 'Producto A', unitPrice: 100, taxRate: 0, currency: 'ARS', status: 'active',
    unitOfMeasure: 'unidad', attributes: {}, metadata: { catalog: { unitOfMeasure: 'unidad', attributes: {} } } },
  { id: 'b', name: 'Producto B', unitPrice: 200, taxRate: 0, currency: 'ARS', status: 'active',
    unitOfMeasure: 'unidad', attributes: {}, metadata: { catalog: { unitOfMeasure: 'unidad', attributes: {} } } },
  { id: 'c', name: 'Producto C', unitPrice: 300, taxRate: 0, currency: 'ARS', status: 'active',
    unitOfMeasure: 'unidad', attributes: {}, metadata: { catalog: { unitOfMeasure: 'unidad', attributes: {} } } }
];

function baseline() {
  return snapshotOrder({ id: 'order-a', finalizedAt: '2026-09-21T20:00:00Z',
    finalizationVersion: 1, updatedAt: '2026-09-21T20:00:00Z', currency: 'ARS',
    subtotalAmount: 300, taxAmount: 0, totalAmount: 300,
    items: [{ id: 'item-a', productId: 'a', descriptionSnapshot: 'Producto A', quantity: 3,
      unitPrice: 100, taxRate: 0, subtotalAmount: 300, totalAmount: 300, currencySnapshot: 'ARS' }] });
}

function decide(text, proposed = baseline(), messages = []) {
  return decideAmendment({ text, products, messages, proposed });
}

test('add reserves only the positive delta and preserves the confirmed baseline', () => {
  const before = baseline();
  const change = applyDecision(before, decide('Agregame dos Producto B'));
  assert.equal(change.ok, true);
  const delta = calculateDelta(before, change.proposed, products);
  assert.deepEqual(delta.delta.changes.map((line) => [line.productId, line.stockDelta]), [['b', 2]]);
  assert.deepEqual(before.items.map((line) => [line.productId, line.quantity]), [['a', 3]]);
  assert.equal(change.proposed.totalAmount, 700);
});

test('increase, decrease and remove produce differential stock changes', () => {
  const before = baseline();
  products[0].unitPrice = 150;
  const raised = applyDecision(before, decide('Sumame dos Producto A'));
  assert.equal(raised.proposed.items[0].unitPrice, 100);
  assert.equal(raised.proposed.totalAmount, 500);
  products[0].unitPrice = 100;
  assert.equal(calculateDelta(before, raised.proposed, products).delta.changes[0].stockDelta, 2);
  const lowered = applyDecision(before, decide('Mejor dejame dos Producto A'));
  assert.equal(calculateDelta(before, lowered.proposed, products).delta.changes[0].stockDelta, -1);
  const withB = applyDecision(before, decide('Agregame dos Producto B')).proposed;
  const removed = applyDecision(withB, decide('Sacame Producto B', withB));
  assert.equal(removed.ok, true);
  assert.equal(calculateDelta(before, removed.proposed, products).delta.changes.length, 0);
});

test('replace is one proposal with a negative and a positive delta', () => {
  const before = baseline();
  const decision = decide('Cambiame Producto A por tres Producto B');
  assert.equal(decision.kind, 'replace');
  const result = applyDecision(before, decision);
  assert.equal(result.ok, true);
  assert.deepEqual(calculateDelta(before, result.proposed, products).delta.changes.map((line) =>
    [line.productId, line.stockDelta]), [['a', -3], ['b', 3]]);
});

test('new order, cancellation and ordinary courtesy have separate routing', () => {
  assert.equal(isExplicitNewOrder('Aparte haceme otro pedido para mañana de Producto B'), true);
  assert.equal(decide('Aparte haceme otro pedido para mañana de Producto B').kind, 'new_order');
  assert.equal(decide('Dejalo como estaba').kind, 'cancel');
  assert.equal(decide('Gracias').kind, 'none');
  assert.equal(AMENDMENT_CONTEXT_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test('amendment closure requires a human commitment and no open question', () => {
  const before = baseline();
  const proposed = applyDecision(before, decide('Agregame dos Producto B')).proposed;
  const amendment = { createdAt: '2026-09-21T20:01:01Z', sourceMessageIds: ['customer'], proposed };
  const messages = [
    { id: 'customer', createdAt: '2026-09-21T20:01:00Z', direction: 'inbound', text: 'Agregame dos Producto B' },
    { id: 'human', createdAt: '2026-09-21T20:02:00Z', direction: 'outbound', text: 'Te envío el pedido actualizado.', raw: { actor: 'HUMAN' } }
  ];
  assert.equal(closureForAmendment(messages, amendment, { result: 'applied' }).status, 'CLOSURE_POSSIBLE');
  messages[1].text = 'Te envío el pedido actualizado. ¿Querés algo más?';
  assert.equal(closureForAmendment(messages, amendment, { result: 'applied' }).status, 'CLOSURE_BLOCKED');
});

test('versioned transactional summary is visibly updated', () => {
  const snapshot = buildOrderCustomerNotificationSnapshot({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clinicId: 'tenant-a', contactId: 'contact-a',
    status: 'confirmed', currency: 'ARS', finalizationVersion: 2,
    finalizedAt: '2026-09-21T20:00:00Z', paymentStatus: 'pending',
    subtotalAmount: 400, taxAmount: 0, totalAmount: 400,
    items: [{ productId: 'a', quantity: 4, descriptionSnapshot: 'Producto A',
      unitPrice: 100, taxRate: 0, subtotalAmount: 400, totalAmount: 400 }]
  });
  const summary = formatOrderCustomerSummary({ snapshot, settings: {} });
  assert.match(summary.text, /Pedido actualizado/);
  assert.match(summary.text, /Producto A/);
  assert.doesNotMatch(summary.text, /Producto B/);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.total, 400);
});

test('amendment migration enforces tenant scope, active uniqueness and durable positive reservation', async () => {
  const db = new PGlite();
  const ids = Array.from({ length: 9 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const [tenant, otherTenant, channel, conversation, contact, order, product, message, amendmentMessage] = ids;
  try {
    await db.exec(`CREATE TABLE clinics(id UUID PRIMARY KEY);
      CREATE TABLE channels(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL);
      CREATE TABLE conversations(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL);
      CREATE TABLE contacts(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL);
      CREATE TABLE orders(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL);
      CREATE TABLE products(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL);
      CREATE TABLE invoices(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL,"orderId" UUID);
      CREATE TABLE payments(id UUID PRIMARY KEY,"clinicId" UUID NOT NULL,status TEXT,metadata JSONB);
      CREATE TABLE conversation_messages(id UUID PRIMARY KEY,"conversationId" UUID NOT NULL);
      CREATE TABLE jobs(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),"clinicId" UUID,"channelId" UUID,
        type TEXT,payload JSONB,status TEXT,attempts INT,"maxAttempts" INT,"runAt" TIMESTAMPTZ,"updatedAt" TIMESTAMPTZ);
      CREATE UNIQUE INDEX uq_channels_id_clinic_id ON channels(id,"clinicId");
      CREATE UNIQUE INDEX uq_conversations_id_clinic_id ON conversations(id,"clinicId");
      CREATE UNIQUE INDEX uq_contacts_id_clinic_id ON contacts(id,"clinicId");
      CREATE UNIQUE INDEX uq_orders_id_clinic_id ON orders(id,"clinicId");
      CREATE UNIQUE INDEX uq_products_id_clinic_id ON products(id,"clinicId");`);
    const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/084_order_post_confirmation_amendments.sql'), 'utf8')
      .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/i, '');
    await db.exec(migration);
    await db.query('INSERT INTO clinics VALUES ($1),($2)', [tenant, otherTenant]);
    await db.query('INSERT INTO channels VALUES ($1,$2)', [channel, tenant]);
    await db.query('INSERT INTO conversations VALUES ($1,$2)', [conversation, tenant]);
    await db.query('INSERT INTO contacts VALUES ($1,$2)', [contact, tenant]);
    await db.query('INSERT INTO orders VALUES ($1,$2)', [order, tenant]);
    await db.query('INSERT INTO products VALUES ($1,$2)', [product, tenant]);
    await db.query('INSERT INTO conversation_messages VALUES ($1,$2),($3,$2)', [message, conversation, amendmentMessage]);
    const input = { tenantId: tenant, channelId: channel, conversationId: conversation, contactId: contact,
      orderId: order, baseVersion: 1, baseline: { items: [] }, proposed: { items: [] }, delta: { changes: [] },
      sourceMessageId: message, baseOrderUpdatedAt: '2026-09-21T20:00:00Z' };
    const amendment = await amendmentRepository.createAmendment(input, db);
    assert.ok(amendment.id);
    assert.equal(await amendmentRepository.hasFinancialCoupling(tenant, order, db), false);
    await db.query('INSERT INTO payments VALUES ($1,$2,$3,$4::jsonb)', [
      '00000000-0000-4000-8000-000000000010', tenant, 'recorded', JSON.stringify({ orderId: order })]);
    assert.equal(await amendmentRepository.hasFinancialCoupling(tenant, order, db), true);
    await assert.rejects(() => amendmentRepository.createAmendment({ ...input, sourceMessageId: amendmentMessage }, db));
    await assert.rejects(() => amendmentRepository.createAmendment({ ...input, tenantId: otherTenant }, db));
    const row = await amendmentRepository.setReservation(tenant, amendment.id, product, 2, db);
    assert.equal(Number(row.quantity), 2);
    assert.equal((await amendmentRepository.listReservations(tenant, amendment.id, db)).length, 1);
    await assert.rejects(() => amendmentRepository.setReservation(otherTenant, amendment.id, product, 1, db));
    assert.equal(await amendmentRepository.releaseReservations(tenant, amendment.id, db), 1);
    await amendmentRepository.setStatus(tenant, amendment.id, 'cancelled', 'CUSTOMER_CANCELLED', db);
    const retry = await amendmentRepository.createAmendment({ ...input, sourceMessageId: amendmentMessage }, db);
    assert.ok(retry.id);
    await db.exec(`ALTER TABLE conversations ADD COLUMN "channelId" UUID;
      ALTER TABLE conversations ADD COLUMN "contactId" UUID;
      ALTER TABLE conversations ADD COLUMN context JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE orders ADD COLUMN "conversationId" UUID;
      ALTER TABLE orders ADD COLUMN "contactId" UUID;
      ALTER TABLE orders ADD COLUMN source TEXT;
      ALTER TABLE orders ADD COLUMN status TEXT;
      ALTER TABLE orders ADD COLUMN "paymentStatus" TEXT;
      ALTER TABLE orders ADD COLUMN "orderStatus" TEXT;
      ALTER TABLE orders ADD COLUMN "finalizationVersion" INT;
      ALTER TABLE orders ADD COLUMN "updatedAt" TIMESTAMPTZ;
      ALTER TABLE conversation_messages ADD COLUMN direction TEXT;
      ALTER TABLE conversation_messages ADD COLUMN raw JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE conversation_messages ADD COLUMN "createdAt" TIMESTAMPTZ DEFAULT NOW();`);
    await db.query(`UPDATE conversations SET "channelId"=$2,"contactId"=$3,context='{"portalBotEnabled":false}'::jsonb WHERE id=$1`,
      [conversation, channel, contact]);
    await db.query(`UPDATE orders SET "conversationId"=$2,"contactId"=$3,source='human_takeover',
      status='confirmed',"paymentStatus"='pending',"orderStatus"='pending_payment',
      "finalizationVersion"=1,"updatedAt"=$4 WHERE id=$1`,
    [order, conversation, contact, '2026-09-21T20:00:00Z']);
    await db.query("UPDATE conversation_messages SET direction='inbound'");
    const humanMessage = '00000000-0000-4000-8000-000000000011';
    await db.query(`INSERT INTO conversation_messages(id,"conversationId",direction,raw,"createdAt")
      VALUES ($1,$2,'outbound','{"actor":"HUMAN"}'::jsonb,NOW() + INTERVAL '1 minute')`,
    [humanMessage, conversation]);
    const scopes = await amendmentRepository.listCandidateScopes(10, db);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].amendmentId, retry.id);
    assert.equal((await amendmentRepository.listInvalidatedActiveScopes(10, db)).length, 0);
    await db.query("UPDATE orders SET status='cancelled' WHERE id=$1", [order]);
    assert.equal((await amendmentRepository.listInvalidatedActiveScopes(10, db)).length, 1);
    await amendmentRepository.setReservation(tenant, retry.id, product, 1, db);
    assert.equal((await amendmentRepository.lockActiveForOrder(tenant, order, db)).length, 1);
    assert.equal(await amendmentRepository.cancelActiveForOrder(tenant, order, 'ORDER_CANCELLED', db), 1);
    assert.equal((await amendmentRepository.listReservations(tenant, retry.id, db)).length, 0);
    const active = await db.query(`SELECT status FROM order_amendments WHERE id=$1`, [retry.id]);
    assert.equal(active.rows[0].status, 'cancelled');
  } finally { await db.close(); }
});
