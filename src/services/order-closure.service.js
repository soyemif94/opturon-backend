const { createHash } = require('node:crypto');
const repository = require('../repositories/order-closure.repository');
const takeoverRepository = require('../repositories/takeover-order.repository');
const { listEligibleLotsForFefo } = require('../repositories/inventory.repository');
const { updateOrderStatus } = require('../repositories/orders.repository');
const { prepareOrderCustomerNotification } = require('./order-customer-notifications.service');
const { unitsPerPackage } = require('./takeover-order-processing.service');
const { logInfo } = require('../utils/logger');

const CLOSURE_GRACE_WINDOW_MS = 30_000;

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function isHumanCommitment(text) {
  return /\b(te envio|te mando|queda confirmado|confirmo el pedido|pedido cerrado|queda cerrado)\b/.test(normalize(text));
}

function hasOpenQuestion(text) {
  const value = normalize(text);
  return /[?¿]/.test(value) || /\b(queres|preferis|confirmame|confirmas|direccion|alternativa|tambien|agregar|agregue|sumar|sume)\b/.test(value);
}

function hasUnresolvedHumanQuestion(messages) {
  const relevant = (messages || []).filter((message) => message && message.text);
  const lastQuestion = relevant.findLastIndex((message) => message.direction === 'outbound' &&
    message.raw?.actor === 'HUMAN' && hasOpenQuestion(message.text));
  return lastQuestion >= 0 && !relevant.slice(lastQuestion + 1).some((message) => message.direction === 'inbound');
}

function mentionedQuantitiesMatchOrder(text, order) {
  const words = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const claims = [...normalize(text).matchAll(/\b(\d{1,4}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(cajas?|unidades?|packs?|paquetes?)\b/g)]
    .map((match) => ({ quantity: words[match[1]] || Number(match[1]), unit: match[2].replace(/s$/, '') }));
  if (!claims.length) return true;
  const items = (order.items || []).map((item) => ({ quantity: Number(item.quantity), unit: normalize(item.variant || '') }));
  if (claims.length !== items.length) return false;
  return claims.every((claim) => {
    const index = items.findIndex((item) => item.quantity === claim.quantity &&
      (!item.unit || item.unit === claim.unit || (item.unit === 'paquete' && claim.unit === 'pack')));
    if (index < 0) return false;
    items.splice(index, 1);
    return true;
  });
}

function detectClosure({ messages, order, lastOperation }) {
  const relevant = (messages || []).filter((message) => message && message.text);
  const latest = relevant.at(-1);
  if (!order || order.status !== 'draft' || order.source !== 'human_takeover' || !latest) {
    return { status: 'NOT_CLOSING', reason: 'missing_draft_or_message' };
  }
  const harmlessClosureUtterance = lastOperation && lastOperation.result === 'skipped' &&
    String(lastOperation.sourceMessageId) === String(latest.id) &&
    lastOperation.metadata?.reason === 'NO_ORDER_OPERATION' &&
    latest.direction === 'inbound';
  if (lastOperation && lastOperation.result !== 'applied' && !harmlessClosureUtterance) {
    return { status: 'CLOSURE_BLOCKED', reason: 'unresolved_order_operation' };
  }
  if (hasOpenQuestion(latest.text)) {
    return { status: 'CLOSURE_BLOCKED', reason: 'open_commercial_question' };
  }
  if (hasUnresolvedHumanQuestion(relevant)) {
    return { status: 'CLOSURE_BLOCKED', reason: 'unanswered_human_question' };
  }
  if (!mentionedQuantitiesMatchOrder(latest.text, order)) {
    return { status: 'CLOSURE_BLOCKED', reason: 'closure_quantity_disagrees_with_order' };
  }
  const text = normalize(latest.text);
  if (latest.direction === 'outbound' && latest.raw?.actor === 'HUMAN') {
    const explicitCommitment = isHumanCommitment(text);
    const precedingCustomerRequest = relevant.slice(0, -1).some((message) =>
      message.direction === 'inbound' && /\b(mandame|manda|quiero|llevo|poneme|dame|agregame|sumale|suma|mejor|dejame|sacame|cambiame|corregime)\b/.test(normalize(message.text)));
    return explicitCommitment && precedingCustomerRequest
      ? { status: 'CLOSURE_POSSIBLE', reason: 'human_commitment_after_customer_order', sourceMessageId: latest.id }
      : { status: 'NOT_CLOSING', reason: 'no_resolved_commercial_closure' };
  }
  if (latest.direction === 'inbound') {
    const explicitAcceptance = /\b(confirmo (el |mi )?pedido|si confirmo el pedido)\b/.test(text);
    const priorHuman = [...relevant.slice(0, -1)].reverse().find((message) => message.direction === 'outbound' && message.raw?.actor === 'HUMAN');
    return explicitAcceptance && priorHuman && isHumanCommitment(priorHuman.text) && !hasOpenQuestion(priorHuman.text)
      ? { status: 'CLOSURE_POSSIBLE', reason: 'customer_explicit_confirmation', sourceMessageId: latest.id }
      : { status: 'NOT_CLOSING', reason: 'customer_continuation' };
  }
  return { status: 'NOT_CLOSING', reason: 'message_not_commercial_closure' };
}

function fingerprintOrder(order, reservations) {
  const items = (order.items || []).map((item) => [item.id, item.productId, Number(item.quantity),
    Number(item.unitPrice), Number(item.taxRate), Number(item.subtotalAmount), Number(item.totalAmount), item.variant || null]);
  const stocks = (reservations || []).map((row) => [row.id, row.orderItemId, row.productId, Number(row.quantity), row.status]);
  items.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  stocks.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify([order.id, order.status, order.source,
    order.updatedAt, order.currency, Number(order.subtotalAmount), Number(order.taxAmount),
    Number(order.totalAmount), items, stocks])).digest('hex');
}

function nearlyEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.011;
}

async function validateOrderAndReservations(tenantId, order, reservations, deps, client) {
  const items = order && Array.isArray(order.items) ? order.items : [];
  if (!order || order.status !== 'draft' || order.source !== 'human_takeover' || !items.length) {
    return { ok: false, reason: 'order_not_eligible' };
  }
  if (reservations.length !== items.length) return { ok: false, reason: 'reservation_count_mismatch' };
  const byItem = new Map(reservations.map((row) => [String(row.orderItemId), row]));
  if (byItem.size !== items.length) return { ok: false, reason: 'reservation_item_mismatch' };
  let subtotal = 0;
  let tax = 0;
  const commitLines = [];
  for (const item of [...items].sort((a, b) => String(a.productId).localeCompare(String(b.productId)))) {
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const taxRate = Number(item.taxRate);
    const lineSubtotal = Number((unitPrice * quantity).toFixed(2));
    const lineTotal = Number((lineSubtotal * (1 + taxRate / 100)).toFixed(2));
    if (!item.id || !item.productId || !Number.isInteger(quantity) || quantity <= 0 ||
        !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(taxRate) || taxRate < 0 ||
        !nearlyEqual(Number(item.subtotalAmount), lineSubtotal) || !nearlyEqual(Number(item.totalAmount), lineTotal)) {
      return { ok: false, reason: 'invalid_order_item_or_price' };
    }
    const reservation = byItem.get(String(item.id));
    if (!reservation || String(reservation.productId) !== String(item.productId) || reservation.status !== 'active') {
      return { ok: false, reason: 'reservation_item_mismatch' };
    }
    const product = await deps.lockProduct(item.productId, tenantId, client);
    if (!product || String(product.status).toLowerCase() !== 'active') return { ok: false, reason: 'product_unavailable' };
    const catalog = product.metadata && product.metadata.catalog || {};
    const multiplier = unitsPerPackage({ unitOfMeasure: catalog.unitOfMeasure, attributes: catalog.attributes }, item.variant);
    const expectedStockQuantity = multiplier === null ? null : quantity * multiplier;
    if (expectedStockQuantity === null || !nearlyEqual(Number(reservation.quantity), expectedStockQuantity) || expectedStockQuantity <= 0) {
      return { ok: false, reason: 'reservation_quantity_mismatch' };
    }
    const trackingMode = catalog.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy';
    const totalReserved = await deps.getActiveReservedQuantity(item.productId, tenantId, client);
    const available = trackingMode === 'lot_based'
      ? (await deps.listEligibleLotsForFefo(tenantId, item.productId, client)).reduce((sum, lot) => sum + Number(lot.availableQuantity || 0), 0)
      : Number(product.stock);
    if (!Number.isFinite(available) || available < totalReserved || available < expectedStockQuantity) {
      return { ok: false, reason: 'stock_conflict' };
    }
    subtotal += lineSubtotal;
    tax += lineTotal - lineSubtotal;
    commitLines.push({ item, reservation, product, trackingMode });
  }
  if (!nearlyEqual(Number(order.subtotalAmount), subtotal) || !nearlyEqual(Number(order.taxAmount), tax) ||
      !nearlyEqual(Number(order.totalAmount), subtotal + tax)) {
    return { ok: false, reason: 'order_total_mismatch' };
  }
  return { ok: true, commitLines };
}

function createOrderClosureService(overrides = {}) {
  const deps = {
    repository,
    lockProduct: takeoverRepository.lockProduct,
    getActiveReservedQuantity: takeoverRepository.getActiveReservedQuantity,
    listEligibleLotsForFefo,
    consumeLotBasedOrderItem: (...args) => require('./portal-orders.service').__private__.consumeLotBasedOrderItem(...args),
    updateOrderStatus,
    prepareOrderCustomerNotification,
    now: () => new Date(),
    ...overrides
  };

  async function createCandidateForScope(scope) {
    return deps.repository.withTransaction(async (client) => {
      const conversation = await deps.repository.lockConversation(scope.tenantId, scope.conversationId, client);
      if (!conversation || String(conversation.channelId) !== String(scope.channelId) || conversation.context?.portalBotEnabled !== false) return { created: false, reason: 'takeover_scope_inactive' };
      const order = await deps.repository.getOrder(scope.tenantId, scope.orderId, client);
      if (!order || String(order.conversationId) !== String(scope.conversationId)) return { created: false, reason: 'order_scope_mismatch' };
      const [latest, messages, reservations, lastOperation] = await Promise.all([
        deps.repository.getLatestRelevantMessage(scope.conversationId, client),
        deps.repository.listRelevantMessages(scope.conversationId, client),
        deps.repository.listReservations(scope.tenantId, scope.orderId, client),
        deps.repository.getLastOperation(scope.tenantId, scope.conversationId, client)
      ]);
      if (!latest || String(latest.id) !== String(scope.sourceMessageId)) return { created: false, reason: 'latest_message_changed' };
      const closure = detectClosure({ messages, order, lastOperation });
      if (closure.status !== 'CLOSURE_POSSIBLE') return { created: false, reason: closure.reason };
      const validation = await validateOrderAndReservations(scope.tenantId, order, reservations, deps, client);
      if (!validation.ok) return { created: false, reason: validation.reason };
      const executeAfter = new Date(deps.now().getTime() + CLOSURE_GRACE_WINDOW_MS).toISOString();
      const candidate = await deps.repository.createCandidate({
        ...scope, orderRevision: order.updatedAt, conversationRevision: latest.id,
        orderFingerprint: fingerprintOrder(order, reservations), executeAfter
      }, client);
      if (!candidate) return { created: false, reason: 'duplicate_candidate' };
      await deps.repository.enqueueCandidate(candidate, client);
      logInfo('order_closure_candidate_created', { tenantId: scope.tenantId, conversationId: scope.conversationId,
        orderId: scope.orderId, candidateId: candidate.id, orderRevision: order.updatedAt,
        conversationRevision: latest.id, sourceMessageId: latest.id, executeAfter });
      return { created: true, candidateId: candidate.id, executeAfter };
    });
  }

  async function scanCandidates(limit = 25) {
    const scopes = await deps.repository.listReviewScopes(limit);
    const results = [];
    for (const scope of scopes) {
      try { results.push(await createCandidateForScope(scope)); }
      catch (error) {
        logInfo('order_closure_candidate_scan_error', { tenantId: scope.tenantId,
          conversationId: scope.conversationId, orderId: scope.orderId, resultCode: error.code || 'candidate_scan_failed' });
        results.push({ created: false, reason: error.code || 'candidate_scan_failed' });
      }
    }
    return { reviewed: scopes.length, created: results.filter((result) => result.created).length };
  }

  async function confirmCandidate({ tenantId, channelId = null, candidateId, conversationId, orderId }) {
    const candidateScope = await deps.repository.getCandidate(tenantId, candidateId);
    if (!candidateScope || String(candidateScope.conversationId) !== String(conversationId) ||
        String(candidateScope.orderId) !== String(orderId) ||
        (channelId && String(candidateScope.channelId) !== String(channelId))) {
      return { confirmed: false, reason: 'candidate_scope_mismatch' };
    }
    return deps.repository.withTransaction(async (client) => {
      const conversation = await deps.repository.lockConversation(tenantId, conversationId, client);
      const candidate = await deps.repository.lockCandidate(tenantId, candidateId, client);
      if (!conversation || !candidate || String(conversation.channelId) !== String(candidate.channelId)) return { confirmed: false, reason: 'conversation_scope_mismatch' };
      if (candidate.status !== 'pending') return { confirmed: false, reason: candidate.status };
      if (new Date(candidate.executeAfter).getTime() > deps.now().getTime()) return { confirmed: false, reason: 'grace_not_elapsed' };
      const block = async (status, reason) => {
        await deps.repository.setCandidateStatus(tenantId, candidateId, status, reason, client);
        logInfo('order_closure_candidate_rejected', { tenantId, conversationId, orderId, candidateId, result: status, reason });
        return { confirmed: false, reason };
      };
      if (conversation.context?.portalBotEnabled !== false) return block('stale', 'takeover_inactive');
      const order = await deps.repository.getOrder(tenantId, orderId, client);
      if (!order || String(order.conversationId) !== String(conversationId) || order.status !== 'draft' || order.source !== 'human_takeover') {
        return block('stale', 'order_changed');
      }
      const [latest, messages, reservations, lastOperation] = await Promise.all([
        deps.repository.getLatestRelevantMessage(conversationId, client),
        deps.repository.listRelevantMessages(conversationId, client),
        deps.repository.listReservations(tenantId, orderId, client),
        deps.repository.getLastOperation(tenantId, conversationId, client)
      ]);
      if (!latest || String(latest.id) !== String(candidate.conversationRevision) ||
          String(order.updatedAt) !== String(candidate.orderRevision) ||
          fingerprintOrder(order, reservations) !== candidate.orderFingerprint ||
          await deps.repository.hasBlockingOperationSince(tenantId, conversationId, candidate.createdAt, client)) {
        return block('stale', 'revision_changed');
      }
      const closure = detectClosure({ messages, order, lastOperation });
      if (closure.status !== 'CLOSURE_POSSIBLE') return block('blocked', closure.reason);
      const validation = await validateOrderAndReservations(tenantId, order, reservations, deps, client);
      if (!validation.ok) return block('blocked', validation.reason);

      for (const line of validation.commitLines) {
        if (line.trackingMode === 'lot_based') {
          const result = await deps.consumeLotBasedOrderItem({ tenantId, clinic: { id: tenantId } }, order,
            { ...line.item, quantity: line.reservation.quantity }, line.product, client);
          if (!result.ok) throw new Error(`order_closure_lot_commit_failed:${result.reason || 'unknown'}`);
        } else {
          const stock = await deps.repository.commitLegacyStock(tenantId, line.item.productId, line.reservation.quantity, client);
          if (!stock) throw new Error('order_closure_legacy_stock_commit_failed');
        }
        const committed = await deps.repository.commitReservation(tenantId, line.reservation.id, client);
        if (!committed) throw new Error('order_closure_reservation_commit_failed');
      }
      const confirmedOrder = await deps.updateOrderStatus(orderId, tenantId,
        { status: 'confirmed', orderStatus: 'pending_payment', paymentStatus: order.paymentStatus || 'pending' }, client);
      if (!confirmedOrder) throw new Error('order_closure_status_update_failed');
      const finalized = await deps.prepareOrderCustomerNotification({ previousOrder: order, order: confirmedOrder, client });
      await deps.repository.setCandidateStatus(tenantId, candidateId, 'confirmed', null, client);
      logInfo('order_closure_confirmed', { tenantId, conversationId, orderId, candidateId,
        orderRevision: order.updatedAt, conversationRevision: latest.id, sourceMessageId: candidate.sourceMessageId,
        confirmationResult: 'confirmed', summaryDeliveryResult: finalized.notification ? 'queued' : 'not_queued' });
      return { confirmed: true, orderId, candidateId, summaryQueued: Boolean(finalized.notification) };
    });
  }

  async function invalidateForMessage(tenantId, conversationId, messageId, client = null) {
    return deps.repository.invalidatePendingForMessage(tenantId, conversationId, messageId, client);
  }

  return { createCandidateForScope, scanCandidates, confirmCandidate, invalidateForMessage };
}

module.exports = {
  CLOSURE_GRACE_WINDOW_MS, hasOpenQuestion, hasUnresolvedHumanQuestion, mentionedQuantitiesMatchOrder,
  detectClosure, fingerprintOrder,
  validateOrderAndReservations, createOrderClosureService,
  orderClosure: createOrderClosureService()
};
