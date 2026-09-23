const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderAmendmentService } = require('../../src/services/order-amendment.service');

function product(id, name, stock = 20) {
  return { id, name, status: 'active', stock, unitPrice: 100, taxRate: 0,
    unitOfMeasure: 'unidad', currency: 'ARS', metadata: { catalog: { unitOfMeasure: 'unidad', attributes: {} } } };
}

function fixture({ stockB = 20, connectionMode = 'API_ONLY', invoice = false, lotBasedA = false } = {}) {
  let now = Date.parse('2026-09-21T20:02:00Z');
  let sequence = 0;
  const products = { a: product('a', 'Producto A', 17), b: product('b', 'Producto B', stockB) };
  if (lotBasedA) products.a.metadata.catalog.inventoryTrackingMode = 'lot_based';
  const order = { id: 'order-a', clinicId: 'tenant-a', conversationId: 'conversation-a', contactId: 'contact-a',
    status: 'confirmed', source: 'human_takeover', orderStatus: 'pending_payment', paymentStatus: 'pending',
    finalizedAt: '2026-09-21T20:00:00Z', finalizationVersion: 1, updatedAt: '2026-09-21T20:00:00Z',
    currency: 'ARS', subtotalAmount: 300, taxAmount: 0, totalAmount: 300,
    items: [{ id: 'item-a', productId: 'a', descriptionSnapshot: 'Producto A', quantity: 3,
      unitPrice: 100, taxRate: 0, subtotalAmount: 300, totalAmount: 300, currencySnapshot: 'ARS' }] };
  const conversation = { id: 'conversation-a', channelId: 'channel-a', contactId: 'contact-a',
    connectionMode, context: { portalBotEnabled: false } };
  const state = { order, conversation, products, amendments: [], reservations: [], baselineReservations: [
    { id: 'baseline-a', orderItemId: 'item-a', productId: 'a', quantity: 3, status: 'committed' }
  ], operations: new Map(), messages: [], jobs: [], notifications: [], invoice,
  lots: [{ id: 'lot-a', productId: 'a', availableQuantity: 17, status: 'active',
    legacyStatus: 'active', operationalStatus: 'active' }],
  allocations: lotBasedA ? [{ id: 'allocation-a', orderItemId: 'item-a', productId: 'a', lotId: 'lot-a',
    quantity: 3, status: 'consumed' }] : [], movements: [] };
  let transactionTail = Promise.resolve();
  const repository = {
    withTransaction: async (fn) => {
      let release;
      const previous = transactionTail;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try { return await fn({}); } finally { release(); }
    },
    findActive: async (tenant, conversationId, contactId) => tenant === 'tenant-a' &&
      conversationId === 'conversation-a' && contactId === 'contact-a'
      ? state.amendments.filter((a) => ['in_progress', 'candidate', 'blocked'].includes(a.status)) : [],
    findRecentConfirmedTargets: async (tenant, conversationId, contactId) => tenant === 'tenant-a' &&
      conversationId === 'conversation-a' && contactId === 'contact-a' ? [{ id: order.id }] : [],
    lockOrder: async (tenant, id) => tenant === 'tenant-a' && id === order.id ? order : null,
    hasFinancialCoupling: async () => state.invoice,
    createAmendment: async (input) => {
      const row = { id: `amendment-${++sequence}`, status: 'in_progress', revision: 1,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        baseOrderUpdatedAt: input.baseOrderUpdatedAt, baseVersion: input.baseVersion,
        targetVersion: input.baseVersion + 1, lastSourceMessageId: input.sourceMessageId,
        ...input };
      state.amendments.push(row); return row;
    },
    updateProposal: async (_, id, input) => {
      const row = state.amendments.find((a) => a.id === id);
      Object.assign(row, input, { revision: row.revision + 1, status: 'in_progress',
        lastSourceMessageId: input.sourceMessageId, candidateFingerprint: null });
      return row;
    },
    listReservations: async (_, id) => state.reservations.filter((row) => row.amendmentId === id && row.status === 'active'),
    setReservation: async (_, id, productId, quantity) => {
      const existing = state.reservations.find((row) => row.amendmentId === id && row.productId === productId && row.status === 'active');
      if (quantity <= 0) { if (existing) existing.status = 'released'; return null; }
      if (existing) { existing.quantity = quantity; return existing; }
      const row = { id: `reservation-${++sequence}`, amendmentId: id, productId, quantity, status: 'active' };
      state.reservations.push(row); return row;
    },
    releaseReservations: async (_, id) => {
      const active = state.reservations.filter((row) => row.amendmentId === id && row.status === 'active');
      active.forEach((row) => { row.status = 'released'; }); return active.length;
    },
    setStatus: async (_, id, status, reason) => {
      const row = state.amendments.find((a) => a.id === id);
      Object.assign(row, { status, reason }); return row;
    },
    lockAmendment: async (_, id) => state.amendments.find((a) => a.id === id),
    listCandidateScopes: async () => state.amendments.filter((a) => a.status === 'in_progress').map((a) => ({
      tenantId: a.tenantId, channelId: a.channelId, conversationId: a.conversationId,
      contactId: a.contactId, orderId: a.orderId, amendmentId: a.id, messageId: state.messages.at(-1).id
    })),
    listInvalidatedActiveScopes: async (_limit, _client, expireBefore) => state.amendments
      .filter((a) => ['in_progress', 'candidate', 'blocked'].includes(a.status) &&
        new Date(a.updatedAt).getTime() < new Date(expireBefore).getTime())
      .map((a) => ({ tenantId: a.tenantId, conversationId: a.conversationId,
        contactId: a.contactId, orderId: a.orderId, amendmentId: a.id })),
    setCandidate: async (input) => {
      const row = state.amendments.find((a) => a.id === input.amendmentId);
      Object.assign(row, { status: 'candidate', candidateConversationRevision: input.messageId,
        candidateFingerprint: input.fingerprint, executeAfter: input.executeAfter }); return row;
    },
    enqueueCandidate: async (candidate) => { state.jobs.push({ amendmentId: candidate.id, revision: candidate.revision }); },
    adjustLegacyStock: async (_, id, delta) => {
      const p = products[id]; if (!p || p.stock - delta < 0) return null;
      p.stock -= delta; return p;
    },
    updateCommittedBaselineReservation: async (_, itemId, quantity) => {
      const row = state.baselineReservations.find((r) => r.orderItemId === itemId && r.status === 'committed');
      if (!row) return null;
      row.quantity = quantity; if (!quantity) row.status = 'cancelled'; return row;
    },
    getCommittedBaselineReservation: async (_, itemId) => state.baselineReservations.find((r) =>
      r.orderItemId === itemId && r.status === 'committed') || null,
    adjustLotAllocation: async (_, id, quantity) => {
      const row = state.allocations.find((a) => a.id === id && a.status === 'consumed');
      if (!row) return null;
      if (quantity > 0) row.quantity = quantity;
      else row.status = 'released';
      return row;
    },
    findConsumedLotAllocation: async (_, itemId, lotId) => state.allocations.find((a) =>
      a.orderItemId === itemId && a.lotId === lotId && a.status === 'consumed') || null,
    addLotAllocationQuantity: async (_, id, quantity) => {
      const row = state.allocations.find((a) => a.id === id && a.status === 'consumed');
      if (!row) return null; row.quantity += quantity; return row;
    },
    insertCommittedReservation: async (input) => {
      const row = { id: `baseline-${++sequence}`, orderItemId: input.orderItemId,
        productId: input.productId, quantity: input.quantity, status: 'committed' };
      state.baselineReservations.push(row); return row;
    },
    commitReservation: async (_, id) => {
      const row = state.reservations.find((r) => r.id === id && r.status === 'active');
      if (!row) return null; row.status = 'committed'; return row;
    },
    markConfirmed: async (input) => {
      const row = state.amendments.find((a) => a.id === input.amendmentId);
      if (row.status !== 'candidate' || row.revision !== input.revision) return null;
      row.status = 'confirmed'; row.confirmedSnapshot = input.confirmedSnapshot; return row;
    }
  };
  const takeover = {
    lockConversation: async () => {},
    beginOperation: async (input) => {
      if (state.operations.has(input.sourceMessageId)) return null;
      const row = { id: `operation-${++sequence}`, ...input };
      state.operations.set(input.sourceMessageId, row); return row;
    },
    completeOperation: async (id, _, patch) => {
      const row = [...state.operations.values()].find((op) => op.id === id);
      Object.assign(row, patch); return row;
    },
    lockProduct: async (id, tenant) => tenant === 'tenant-a' ? products[id] : null,
    getActiveReservedQuantity: async (id) => state.reservations.filter((row) => row.productId === id && row.status === 'active')
      .reduce((sum, row) => sum + row.quantity, 0),
    upsertOrderItem: async (_, item) => {
      const existing = order.items.find((row) => row.productId === item.productId);
      if (existing) { Object.assign(existing, item); return existing; }
      const row = { ...item, id: `item-${++sequence}` }; order.items.push(row); return row;
    },
    removeOrderItem: async (id) => {
      const index = order.items.findIndex((row) => row.id === id);
      if (index < 0) return null; return order.items.splice(index, 1)[0];
    },
    recalculateOrder: async () => {
      order.subtotalAmount = order.items.reduce((sum, item) => sum + item.subtotalAmount, 0);
      order.totalAmount = order.items.reduce((sum, item) => sum + item.totalAmount, 0);
      order.taxAmount = order.totalAmount - order.subtotalAmount;
      order.updatedAt = new Date(now).toISOString(); return order;
    }
  };
  const closure = {
    lockConversation: async (tenant, id) => tenant === 'tenant-a' && id === conversation.id ? conversation : null,
    getLatestRelevantMessage: async () => state.messages.at(-1),
    listRelevantMessages: async () => state.messages,
    getLastOperation: async () => [...state.operations.values()].at(-1)
  };
  const inventory = {
    listInventoryLotAllocationsByOrder: async () => state.allocations,
    listEligibleLotsForFefo: async (_, productId) => state.lots.filter((lot) =>
      lot.productId === productId && lot.availableQuantity > 0),
    findInventoryLotById: async (id) => state.lots.find((lot) => lot.id === id) || null,
    updateInventoryLotState: async (id, _, input) => {
      const lot = state.lots.find((row) => row.id === id); Object.assign(lot, input); return lot;
    },
    updateInventoryLotQuantity: async (id, _, productId, availableQuantity, status) => {
      const lot = state.lots.find((row) => row.id === id && row.productId === productId);
      if (!lot) return null; Object.assign(lot, { availableQuantity, status }); return lot;
    },
    insertInventoryMovement: async (input) => { state.movements.push(input); return input; },
    createInventoryLotAllocation: async (input) => {
      const row = { id: `allocation-${++sequence}`, ...input };
      state.allocations.push(row); return row;
    },
    syncProductStockFromLots: async (productId) => {
      products[productId].stock = state.lots.filter((lot) => lot.productId === productId)
        .reduce((sum, lot) => sum + lot.availableQuantity, 0);
      return products[productId].stock;
    }
  };
  const service = createOrderAmendmentService({ repository, takeover, closure, inventory,
    listProducts: async () => Object.values(products), now: () => new Date(now),
    prepareNotification: async () => {
      order.finalizationVersion += 1; order.finalizedAt = new Date(now).toISOString();
      state.notifications.push({ version: order.finalizationVersion, items: order.items.map((item) => ({ ...item })) });
      return { order, notification: { id: `notification-${order.finalizationVersion}` } };
    } });
  function inbound(id, text) {
    const message = { id, direction: 'inbound', text, createdAt: new Date(now).toISOString() };
    state.messages.push(message);
    return service.processInbound({ clinicId: 'tenant-a', channelId: 'channel-a',
      conversationId: 'conversation-a', contactId: 'contact-a', inboundMessageId: id },
    message, Object.values(products), state.messages.slice(0, -1));
  }
  function human(id, text) { state.messages.push({ id, direction: 'outbound', text,
    raw: { actor: 'HUMAN' }, createdAt: new Date(now).toISOString() }); }
  function advance(ms) { now += ms; }
  return { state, service, inbound, human, advance };
}

test('add after confirmation reserves only delta; grace and finalization preserve one order', async () => {
  const h = fixture();
  const first = await h.inbound('message-add', 'Agregame dos Producto B');
  assert.equal(first.operation, 'ORDER_AMENDMENT_PROPOSED');
  assert.deepEqual(h.state.order.items.map((item) => item.productId), ['a']);
  assert.equal(h.state.products.b.stock, 20);
  assert.equal(h.state.reservations[0].quantity, 2);
  h.advance(1000);
  h.human('human-confirm', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  const job = h.state.jobs[0];
  const args = { tenantId: 'tenant-a', channelId: 'channel-a', amendmentId: job.amendmentId,
    conversationId: 'conversation-a', orderId: 'order-a', revision: job.revision };
  assert.equal((await h.service.confirmCandidate(args)).reason, 'grace_not_elapsed');
  h.advance(30000);
  assert.equal((await h.service.confirmCandidate(args)).confirmed, true);
  assert.equal((await h.service.confirmCandidate(args)).confirmed, false);
  assert.equal(h.state.products.b.stock, 18);
  assert.equal(h.state.order.finalizationVersion, 2);
  assert.equal(h.state.order.items.length, 2);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.conversation.context.portalBotEnabled, false);
});

test('insufficient additional stock and paid order do not mutate baseline', async () => {
  const low = fixture({ stockB: 1 });
  assert.equal((await low.inbound('message-low', 'Agregame dos Producto B')).reason, 'INSUFFICIENT_STOCK');
  assert.equal(low.state.amendments.length, 0);
  assert.equal(low.state.order.items.length, 1);
  const paid = fixture(); paid.state.order.paymentStatus = 'paid';
  assert.equal((await paid.inbound('message-paid', 'Agregame dos Producto B')).reason, 'ORDER_NOT_AMENDABLE');
  assert.equal(paid.state.amendments.length, 0);
  const invoiced = fixture({ invoice: true });
  assert.equal((await invoiced.inbound('message-invoiced', 'Agregame dos Producto B')).reason, 'PAYMENT_OR_INVOICE_LOCK');
  assert.equal(invoiced.state.amendments.length, 0);
  const fulfilled = fixture(); fulfilled.state.order.orderStatus = 'delivered';
  assert.equal((await fulfilled.inbound('message-fulfilled', 'Agregame dos Producto B')).reason, 'ORDER_NOT_AMENDABLE');
  assert.equal(fulfilled.state.amendments.length, 0);
});

test('retry is idempotent; cancel releases delta and leaves confirmed stock unchanged', async () => {
  const h = fixture({ connectionMode: 'COEXISTENCE' });
  await h.inbound('message-add', 'Agregame dos Producto B');
  assert.equal((await h.inbound('message-add', 'Agregame dos Producto B')).duplicate, true);
  assert.equal(h.state.reservations.length, 1);
  assert.equal((await h.inbound('message-cancel', 'Dejalo como estaba')).operation, 'ORDER_AMENDMENT_CANCELLED');
  assert.equal(h.state.reservations[0].status, 'released');
  assert.equal(h.state.products.b.stock, 20);
  assert.equal(h.state.order.finalizationVersion, 1);
  h.advance(1000);
  assert.equal((await h.inbound('message-retry', 'Agregame uno Producto B')).operation, 'ORDER_AMENDMENT_PROPOSED');
  assert.equal(h.state.amendments.length, 2);
});

test('decrease restores only at confirmation and a later amendment can reach version three', async () => {
  const h = fixture();
  await h.inbound('message-decrease', 'Mejor dejame dos Producto A');
  assert.equal(h.state.products.a.stock, 17);
  assert.equal(h.state.reservations.length, 0);
  h.advance(1000); h.human('human-decrease', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  const first = h.state.jobs[0];
  h.advance(30000);
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: first.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: first.revision })).confirmed, true);
  assert.equal(h.state.products.a.stock, 18);
  assert.equal(h.state.order.items[0].quantity, 2);
  assert.equal(h.state.baselineReservations[0].quantity, 2);
  h.advance(1000);
  await h.inbound('message-increase', 'Sumale uno Producto A');
  assert.equal(h.state.reservations.at(-1).quantity, 1);
  h.advance(1000); h.human('human-increase', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  const second = h.state.jobs[1];
  h.advance(30000);
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: second.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: second.revision })).confirmed, true);
  assert.equal(h.state.products.a.stock, 17);
  assert.equal(h.state.order.finalizationVersion, 3);
  assert.equal(h.state.amendments.length, 2);
  assert.equal(h.state.notifications.length, 2);
});

test('a newer amendment message makes an old confirmation job stale', async () => {
  const h = fixture();
  await h.inbound('message-first', 'Agregame dos Producto B');
  h.advance(1000); h.human('human-first', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  const first = h.state.jobs[0];
  h.advance(1000);
  await h.inbound('message-second', 'Sumale uno Producto B');
  h.advance(30000);
  const result = await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: first.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: first.revision });
  assert.equal(result.reason, 'stale_candidate');
  assert.equal(h.state.products.b.stock, 20);
  assert.equal(h.state.order.finalizationVersion, 1);
  assert.equal(h.state.reservations[0].quantity, 3);
});

test('open human question blocks candidate and cross-tenant attempt is rejected', async () => {
  const h = fixture();
  await h.inbound('message-add', 'Agregame dos Producto B');
  h.advance(1000); h.human('human-question', '¿Querés agregar Producto C?');
  assert.equal((await h.service.scanCandidates()).created, 0);
  const wrong = await h.service.processInbound({ clinicId: 'tenant-b', channelId: 'channel-a',
    conversationId: 'conversation-a', contactId: 'contact-a', inboundMessageId: 'wrong-message' },
  { id: 'wrong-message', text: 'Agregame dos Producto B', createdAt: new Date('2026-09-21T20:03:00Z') },
  Object.values(h.state.products), []);
  assert.equal(wrong.reason, 'TAKEOVER_SCOPE_INACTIVE');
  assert.equal(h.state.amendments.length, 1);
  assert.equal(h.state.jobs.length, 0);
});

test('a separate order utterance does not silently leave an active amendment to close', async () => {
  const h = fixture();
  assert.equal((await h.inbound('new-without-active', 'Aparte haceme otro pedido de dos Producto B')).handled, false);
  await h.inbound('pending-change', 'Agregame dos Producto B');
  const separate = await h.inbound('new-with-active', 'Aparte haceme otro pedido de dos Producto B');
  assert.equal(separate.reason, 'ACTIVE_AMENDMENT_REQUIRES_REVIEW');
  assert.equal(h.state.amendments.length, 1);
  assert.equal(h.state.order.finalizationVersion, 1);
});

test('concurrent additions reserve no more than physical additional stock', async () => {
  const h = fixture({ stockB: 3 });
  const results = await Promise.all([
    h.inbound('message-one', 'Agregame dos Producto B'),
    h.inbound('message-two', 'Agregame dos Producto B')
  ]);
  assert.equal(results.filter((result) => result.mutated).length, 1);
  assert.equal(results.filter((result) => result.reason === 'INSUFFICIENT_STOCK').length, 1);
  assert.equal(h.state.reservations.filter((row) => row.status === 'active').reduce((sum, row) => sum + row.quantity, 0), 2);
  assert.equal(h.state.products.b.stock, 3);
});

test('replace commits a positive and negative stock delta atomically on the same order', async () => {
  const h = fixture();
  const proposal = await h.inbound('message-replace', 'Cambiame Producto A por tres Producto B');
  assert.equal(proposal.operation, 'ORDER_AMENDMENT_PROPOSED');
  assert.equal(h.state.products.a.stock, 17);
  assert.equal(h.state.products.b.stock, 20);
  assert.deepEqual(h.state.amendments[0].delta.changes.map((row) => [row.productId, row.stockDelta]),
    [['a', -3], ['b', 3]]);
  h.advance(1000); h.human('human-replace', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  h.advance(30000);
  const job = h.state.jobs[0];
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: job.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: job.revision })).confirmed, true);
  assert.equal(h.state.products.a.stock, 20);
  assert.equal(h.state.products.b.stock, 17);
  assert.deepEqual(h.state.order.items.map((row) => [row.productId, row.quantity]), [['b', 3]]);
  assert.equal(h.state.baselineReservations[0].status, 'cancelled');
  assert.equal(h.state.order.finalizationVersion, 2);
});

test('lot tracked decrease restores allocation once and later increase consumes FEFO', async () => {
  const h = fixture({ lotBasedA: true });
  await h.inbound('message-lot-down', 'Mejor dejame dos Producto A');
  assert.equal(h.state.lots[0].availableQuantity, 17);
  h.advance(1000); h.human('human-lot-down', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  h.advance(30000);
  const first = h.state.jobs[0];
  const firstArgs = { tenantId: 'tenant-a', channelId: 'channel-a', amendmentId: first.amendmentId,
    conversationId: 'conversation-a', orderId: 'order-a', revision: first.revision };
  assert.equal((await h.service.confirmCandidate(firstArgs)).confirmed, true);
  assert.equal((await h.service.confirmCandidate(firstArgs)).confirmed, false);
  assert.equal(h.state.lots[0].availableQuantity, 18);
  assert.equal(h.state.allocations[0].quantity, 2);
  assert.equal(h.state.movements.length, 1);
  h.advance(1000);
  await h.inbound('message-lot-up', 'Sumale uno Producto A');
  h.advance(1000); h.human('human-lot-up', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  h.advance(30000);
  const second = h.state.jobs[1];
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: second.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: second.revision })).confirmed, true);
  assert.equal(h.state.lots[0].availableQuantity, 17);
  assert.equal(h.state.allocations[0].quantity, 3);
  assert.equal(h.state.movements.length, 2);
});

test('removing an item after a prior confirmed amendment restores only that item once', async () => {
  const h = fixture();
  await h.inbound('message-add-b', 'Agregame dos Producto B');
  h.advance(1000); h.human('human-add-b', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  h.advance(30000);
  const first = h.state.jobs[0];
  assert.equal((await h.service.confirmCandidate({ tenantId: 'tenant-a', channelId: 'channel-a',
    amendmentId: first.amendmentId, conversationId: 'conversation-a', orderId: 'order-a',
    revision: first.revision })).confirmed, true);
  assert.equal(h.state.products.b.stock, 18);
  h.advance(1000);
  await h.inbound('message-remove-b', 'Sacame Producto B');
  assert.equal(h.state.products.b.stock, 18);
  h.advance(1000); h.human('human-remove-b', 'Te envío el pedido actualizado.');
  assert.equal((await h.service.scanCandidates()).created, 1);
  h.advance(30000);
  const second = h.state.jobs[1];
  const args = { tenantId: 'tenant-a', channelId: 'channel-a', amendmentId: second.amendmentId,
    conversationId: 'conversation-a', orderId: 'order-a', revision: second.revision };
  assert.equal((await h.service.confirmCandidate(args)).confirmed, true);
  assert.equal((await h.service.confirmCandidate(args)).confirmed, false);
  assert.equal(h.state.products.b.stock, 20);
  assert.deepEqual(h.state.order.items.map((item) => item.productId), ['a']);
  assert.equal(h.state.order.finalizationVersion, 3);
});

test('abandoned amendment expires and releases its additional reservation', async () => {
  const h = fixture();
  await h.inbound('message-abandoned', 'Agregame dos Producto B');
  h.advance(24 * 60 * 60 * 1000 + 1000);
  assert.equal((await h.service.sweepInvalidated()).cancelled, 1);
  assert.equal(h.state.amendments[0].status, 'cancelled');
  assert.equal(h.state.reservations[0].status, 'released');
  assert.equal(h.state.products.b.stock, 20);
  assert.equal(h.state.order.finalizationVersion, 1);
});
