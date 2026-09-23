const { createHash } = require('node:crypto');
const amendmentRepository = require('../repositories/order-amendment.repository');
const takeoverRepository = require('../repositories/takeover-order.repository');
const closureRepository = require('../repositories/order-closure.repository');
const inventoryRepository = require('../repositories/inventory.repository');
const { listProductsByClinicId } = require('../repositories/products.repository');
const { detectClosure, CLOSURE_GRACE_WINDOW_MS } = require('./order-closure.service');
const { prepareOrderAmendmentNotification } = require('./order-customer-notifications.service');
const {
  AMENDMENT_CONTEXT_WINDOW_MS, isExplicitNewOrder, snapshotOrder,
  decideAmendment, applyDecision, calculateDelta, stockUnits
} = require('./order-amendment-model');
const { logInfo } = require('../utils/logger');

function isOrderAmendable(order, scope) {
  return Boolean(order && order.status === 'confirmed' && order.source === 'human_takeover' &&
    String(order.clinicId) === String(scope.clinicId) &&
    String(order.conversationId) === String(scope.conversationId) &&
    String(order.contactId) === String(scope.contactId) &&
    Number(order.finalizationVersion) > 0 &&
    ['pending', 'unpaid'].includes(String(order.paymentStatus || '').toLowerCase()) &&
    String(order.orderStatus || '').toLowerCase() === 'pending_payment');
}

function fingerprint(amendment, order, reservations) {
  return createHash('sha256').update(JSON.stringify([
    amendment.id, amendment.revision, amendment.baseline, amendment.proposed, amendment.delta,
    order.id, order.finalizationVersion, order.updatedAt,
    reservations.map((row) => [row.id, row.productId, row.quantity, row.status])
  ])).digest('hex');
}

function relevantAmendmentMessages(messages, amendment) {
  const from = new Date(amendment.createdAt).getTime();
  const sourceIds = new Set((amendment.sourceMessageIds || []).map(String));
  return messages.filter((message) => sourceIds.has(String(message.id)) ||
    new Date(message.createdAt).getTime() >= from);
}

function closureForAmendment(messages, amendment, lastOperation) {
  return detectClosure({
    messages: relevantAmendmentMessages(messages, amendment),
    order: { status: 'draft', source: 'human_takeover', items: amendment.proposed.items },
    lastOperation
  });
}

function trackingMode(product) {
  return product.metadata?.catalog?.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy';
}

async function availableStock(product, tenantId, client, deps) {
  if (trackingMode(product) === 'lot_based') {
    const lots = await deps.inventory.listEligibleLotsForFefo(tenantId, product.id, client);
    return lots.reduce((sum, lot) => sum + Number(lot.availableQuantity), 0);
  }
  return product.stock == null ? null : Number(product.stock);
}

function positiveByProduct(delta) {
  return new Map(delta.changes.filter((change) => change.stockDelta > 0)
    .map((change) => [String(change.productId), Number(change.stockDelta)]));
}

function createOrderAmendmentService(overrides = {}) {
  const deps = {
    repository: amendmentRepository,
    takeover: takeoverRepository,
    closure: closureRepository,
    inventory: inventoryRepository,
    listProducts: listProductsByClinicId,
    prepareNotification: prepareOrderAmendmentNotification,
    now: () => new Date(),
    ...overrides
  };

  async function processInbound(scope, inbound, products, priorMessages) {
    const outcome = await deps.repository.withTransaction(async (client) => {
      const conversation = await deps.closure.lockConversation(scope.clinicId, scope.conversationId, client);
      if (!conversation || String(conversation.channelId) !== String(scope.channelId) ||
          String(conversation.contactId) !== String(scope.contactId) ||
          conversation.context?.portalBotEnabled !== false) {
        return { handled: true, mutated: false, reason: 'TAKEOVER_SCOPE_INACTIVE' };
      }
      const active = await deps.repository.findActive(scope.clinicId, scope.conversationId, scope.contactId, client);
      if (active.length > 1) return { handled: true, mutated: false, reason: 'AMENDMENT_TARGET_AMBIGUOUS' };
      if (active[0] && Number.isFinite(new Date(active[0].updatedAt).getTime()) &&
          deps.now().getTime() - new Date(active[0].updatedAt).getTime() > AMENDMENT_CONTEXT_WINDOW_MS) {
        await deps.repository.releaseReservations(scope.clinicId, active[0].id, client);
        await deps.repository.setStatus(scope.clinicId, active[0].id, 'cancelled', 'AMENDMENT_CONTEXT_EXPIRED', client);
        return { handled: true, mutated: false, reason: 'AMENDMENT_CONTEXT_EXPIRED' };
      }
      const text = inbound.text || inbound.body || '';
      if (isExplicitNewOrder(text)) return active.length
        ? { handled: true, mutated: false, reason: 'ACTIVE_AMENDMENT_REQUIRES_REVIEW' }
        : { handled: false, explicitNewOrder: true };
      const since = new Date(deps.now().getTime() - AMENDMENT_CONTEXT_WINDOW_MS).toISOString();
      const targets = active.length ? [{ id: active[0].orderId }] :
        await deps.repository.findRecentConfirmedTargets(scope.clinicId, scope.conversationId, scope.contactId, since, client);
      if (!targets.length) return { handled: false };
      if (targets.length > 1) return { handled: true, mutated: false, reason: 'AMENDMENT_TARGET_AMBIGUOUS' };
      const order = await deps.repository.lockOrder(scope.clinicId, targets[0].id, client);
      const cancelStale = async (reason) => {
        if (active[0]) {
          await deps.repository.releaseReservations(scope.clinicId, active[0].id, client);
          await deps.repository.setStatus(scope.clinicId, active[0].id, 'cancelled', reason, client);
        }
        return { handled: true, mutated: false, reason };
      };
      if (!isOrderAmendable(order, scope)) return cancelStale('ORDER_NOT_AMENDABLE');
      if (new Date(inbound.createdAt).getTime() <= new Date(order.finalizedAt).getTime()) {
        return { handled: true, mutated: false, reason: 'MESSAGE_PRECEDES_CONFIRMATION' };
      }
      if (await deps.repository.hasFinancialCoupling(scope.clinicId, order.id, client)) return cancelStale('PAYMENT_OR_INVOICE_LOCK');
      let amendment = active[0] || null;
      if (amendment && (Number(amendment.baseVersion) !== Number(order.finalizationVersion) ||
          String(amendment.baseOrderUpdatedAt) !== String(order.updatedAt))) {
        return cancelStale('BASELINE_REVISION_CHANGED');
      }
      const baseline = amendment?.baseline || snapshotOrder(order);
      const proposed = amendment?.proposed || baseline;
      const decision = decideAmendment({ text, products, messages: priorMessages, proposed });
      if (decision.kind === 'none') return { handled: true, mutated: false, reason: decision.reason };
      const operation = await deps.takeover.beginOperation({
        tenantId: scope.clinicId, conversationId: scope.conversationId,
        sourceMessageId: scope.inboundMessageId, operation: 'ORDER_AMENDMENT_PROCESSING',
        metadata: { actor: 'SYSTEM', humanTakeover: true, orderId: order.id }
      }, client);
      if (!operation) return { handled: true, duplicate: true, orderId: order.id };
      const complete = async (result, name, reason = null) => {
        await deps.takeover.completeOperation(operation.id, scope.clinicId, {
          result, operation: name, orderId: order.id, metadata: { reason, amendmentId: amendment?.id || null }
        }, client);
        return { handled: true, mutated: result === 'applied', reason, orderId: order.id,
          amendmentId: amendment?.id || null, operation: name };
      };
      if (decision.kind === 'cancel') {
        if (!amendment) return complete('skipped', 'ORDER_AMENDMENT_CANCEL_SKIPPED', 'NO_ACTIVE_AMENDMENT');
        await deps.repository.releaseReservations(scope.clinicId, amendment.id, client);
        await deps.repository.setStatus(scope.clinicId, amendment.id, 'cancelled', 'CUSTOMER_CANCELLED', client);
        return complete('applied', 'ORDER_AMENDMENT_CANCELLED');
      }
      if (decision.kind === 'blocked') return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', decision.reason);
      const applied = applyDecision(proposed, decision);
      if (!applied.ok) return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', applied.reason);
      const calculated = calculateDelta(baseline, applied.proposed, products);
      if (!calculated.ok || !calculated.delta.changes.length) {
        return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', calculated.reason || 'NO_CHANGE');
      }
      const required = positiveByProduct(calculated.delta);
      const changesByProduct = new Map(calculated.delta.changes.map((change) => [String(change.productId), change]));
      const existing = amendment ? await deps.repository.listReservations(scope.clinicId, amendment.id, client) : [];
      const previous = new Map(existing.map((row) => [String(row.productId), Number(row.quantity)]));
      const productIds = [...new Set([...required.keys(), ...previous.keys()])].sort();
      for (const productId of productIds) {
        const product = await deps.takeover.lockProduct(productId, scope.clinicId, client);
        if (!product || String(product.status).toLowerCase() !== 'active') {
          return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', 'PRODUCT_NOT_ACTIVE');
        }
        const change = changesByProduct.get(productId);
        if (change && (stockUnits(change.beforeItem, product) !== change.previousUnits ||
            stockUnits(change.afterItem, product) !== change.nextUnits)) {
          return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', 'PACKAGING_CHANGED');
        }
        const proposedNew = applied.proposed.items.find((item) => String(item.productId) === String(productId) && !item.id);
        if (proposedNew && (Number(proposedNew.unitPrice) !== Number(product.unitPrice) ||
            Number(proposedNew.taxRate) !== Number(product.taxRate))) {
          return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', 'CATALOG_PRICE_CHANGED');
        }
        const totalReserved = await deps.takeover.getActiveReservedQuantity(productId, scope.clinicId, client);
        const available = await availableStock(product, scope.clinicId, client, deps);
        const needed = required.get(productId) || 0;
        if (available === null || !Number.isFinite(available)) {
          return complete('skipped', 'ORDER_AMENDMENT_BLOCKED', 'STOCK_UNKNOWN');
        }
        if (needed > available - totalReserved + (previous.get(productId) || 0)) {
          if (amendment) await deps.repository.setStatus(scope.clinicId, amendment.id, 'blocked', 'INSUFFICIENT_STOCK', client);
          return complete('skipped', 'AMENDMENT_BLOCKED_INSUFFICIENT_STOCK', 'INSUFFICIENT_STOCK');
        }
      }
      if (!amendment) {
        amendment = await deps.repository.createAmendment({
          tenantId: scope.clinicId, channelId: scope.channelId, conversationId: scope.conversationId,
          contactId: scope.contactId, orderId: order.id, baseVersion: Number(order.finalizationVersion),
          baseline, proposed: applied.proposed, delta: calculated.delta,
          sourceMessageId: scope.inboundMessageId, baseOrderUpdatedAt: order.updatedAt
        }, client);
      } else {
        amendment = await deps.repository.updateProposal(scope.clinicId, amendment.id, {
          proposed: applied.proposed, delta: calculated.delta, sourceMessageId: scope.inboundMessageId
        }, client);
      }
      for (const productId of productIds) {
        await deps.repository.setReservation(scope.clinicId, amendment.id, productId, required.get(productId) || 0, client);
      }
      const outcome = await complete('applied', 'ORDER_AMENDMENT_PROPOSED');
      return { ...outcome, baseVersion: Number(order.finalizationVersion),
        targetVersion: Number(order.finalizationVersion) + 1,
        changes: calculated.delta.changes.map((change) => ({ productId: change.productId,
          quantityDelta: Number(change.afterItem?.quantity || 0) - Number(change.beforeItem?.quantity || 0),
          stockDelta: change.stockDelta })) };
    });
    if (outcome.handled && outcome.operation) {
      logInfo('order_amendment_operation', { tenantId: scope.clinicId,
        conversationId: scope.conversationId, orderId: outcome.orderId,
        amendmentId: outcome.amendmentId, sourceMessageId: scope.inboundMessageId,
        operation: outcome.operation, reason: outcome.reason || null });
      for (const change of outcome.changes || []) {
        logInfo('order_amendment_delta', { tenantId: scope.clinicId,
          conversationId: scope.conversationId, orderId: outcome.orderId,
          amendmentId: outcome.amendmentId, baseVersion: outcome.baseVersion,
          targetVersion: outcome.targetVersion, sourceMessageId: scope.inboundMessageId,
          productId: change.productId, quantityDelta: change.quantityDelta, stockDelta: change.stockDelta });
      }
    }
    return outcome;
  }

  async function createCandidateForScope(scope) {
    return deps.repository.withTransaction(async (client) => {
      const conversation = await deps.closure.lockConversation(scope.tenantId, scope.conversationId, client);
      if (!conversation || String(conversation.channelId) !== String(scope.channelId) ||
          conversation.context?.portalBotEnabled !== false || String(conversation.contactId) !== String(scope.contactId)) {
        return { created: false, reason: 'takeover_scope_inactive' };
      }
      const order = await deps.repository.lockOrder(scope.tenantId, scope.orderId, client);
      const amendment = await deps.repository.lockAmendment(scope.tenantId, scope.amendmentId, client);
      if (!amendment || amendment.status !== 'in_progress' || String(amendment.orderId) !== String(scope.orderId)) {
        return { created: false, reason: 'amendment_changed' };
      }
      const orderScope = { clinicId: scope.tenantId, conversationId: scope.conversationId, contactId: scope.contactId };
      if (!isOrderAmendable(order, orderScope) || Number(order.finalizationVersion) !== Number(amendment.baseVersion) ||
          String(order.updatedAt) !== String(amendment.baseOrderUpdatedAt) ||
          await deps.repository.hasFinancialCoupling(scope.tenantId, scope.orderId, client)) {
        await deps.repository.releaseReservations(scope.tenantId, amendment.id, client);
        await deps.repository.setStatus(scope.tenantId, amendment.id, 'cancelled', 'ORDER_CHANGED', client);
        return { created: false, reason: 'order_changed' };
      }
      const [latest, messages, lastOperation, reservations] = await Promise.all([
        deps.closure.getLatestRelevantMessage(scope.conversationId, client),
        deps.closure.listRelevantMessages(scope.conversationId, client),
        deps.closure.getLastOperation(scope.tenantId, scope.conversationId, client),
        deps.repository.listReservations(scope.tenantId, amendment.id, client)
      ]);
      if (!latest || String(latest.id) !== String(scope.messageId)) return { created: false, reason: 'latest_message_changed' };
      const closure = closureForAmendment(messages, amendment, lastOperation);
      if (closure.status !== 'CLOSURE_POSSIBLE') return { created: false, reason: closure.reason };
      const executeAfter = new Date(deps.now().getTime() + CLOSURE_GRACE_WINDOW_MS).toISOString();
      const candidate = await deps.repository.setCandidate({ tenantId: scope.tenantId, amendmentId: amendment.id,
        messageId: latest.id, fingerprint: fingerprint(amendment, order, reservations), executeAfter }, client);
      if (!candidate) return { created: false, reason: 'candidate_race' };
      await deps.repository.enqueueCandidate(candidate, client);
      logInfo('order_amendment_candidate_created', { tenantId: scope.tenantId,
        conversationId: scope.conversationId, orderId: scope.orderId,
        amendmentId: amendment.id, revision: candidate.revision,
        sourceMessageId: latest.id, executeAfter });
      return { created: true, amendmentId: amendment.id, executeAfter };
    });
  }

  async function scanCandidates(limit = 25) {
    const scopes = await deps.repository.listCandidateScopes(limit);
    let created = 0;
    for (const scope of scopes) {
      try { if ((await createCandidateForScope(scope)).created) created += 1; }
      catch (error) {
        logInfo('order_amendment_scan_failed', { tenantId: scope.tenantId, amendmentId: scope.amendmentId,
          resultCode: String(error.code || 'scan_failed') });
      }
    }
    return { reviewed: scopes.length, created };
  }

  async function sweepInvalidated(limit = 25) {
    const expireBefore = new Date(deps.now().getTime() - AMENDMENT_CONTEXT_WINDOW_MS).toISOString();
    const scopes = await deps.repository.listInvalidatedActiveScopes(limit, null, expireBefore);
    let cancelled = 0;
    for (const scope of scopes) {
      try {
        const result = await deps.repository.withTransaction(async (client) => {
          const conversation = await deps.closure.lockConversation(scope.tenantId, scope.conversationId, client);
          const order = await deps.repository.lockOrder(scope.tenantId, scope.orderId, client);
          const amendment = await deps.repository.lockAmendment(scope.tenantId, scope.amendmentId, client);
          if (!amendment || !['in_progress', 'candidate', 'blocked'].includes(amendment.status)) return false;
          const eligible = isOrderAmendable(order, { clinicId: scope.tenantId,
            conversationId: scope.conversationId, contactId: scope.contactId }) &&
            Number(order.finalizationVersion) === Number(amendment.baseVersion) &&
            String(order.updatedAt) === String(amendment.baseOrderUpdatedAt) &&
            String(conversation?.channelId) === String(amendment.channelId) &&
            String(conversation?.contactId) === String(amendment.contactId) &&
            conversation?.context?.portalBotEnabled === false &&
            new Date(amendment.updatedAt).getTime() >= new Date(expireBefore).getTime() &&
            !await deps.repository.hasFinancialCoupling(scope.tenantId, scope.orderId, client);
          if (eligible) return false;
          await deps.repository.releaseReservations(scope.tenantId, amendment.id, client);
          await deps.repository.setStatus(scope.tenantId, amendment.id, 'cancelled', 'BASELINE_NO_LONGER_AMENDABLE', client);
          return true;
        });
        if (result) cancelled += 1;
      } catch (error) {
        logInfo('order_amendment_cleanup_failed', { tenantId: scope.tenantId,
          amendmentId: scope.amendmentId, resultCode: String(error.code || 'cleanup_failed') });
      }
    }
    return { reviewed: scopes.length, cancelled };
  }

  async function applyLotDelta({ tenantId, order, item, product, stockDelta, amendmentId, client }) {
    if (stockDelta > 0) {
      const lots = await deps.inventory.listEligibleLotsForFefo(tenantId, product.id, client);
      let remaining = stockDelta;
      for (const lot of lots) {
        if (remaining <= 0) break;
        const before = Number(lot.availableQuantity);
        const quantity = Math.min(before, remaining);
        if (quantity <= 0) continue;
        const after = Number((before - quantity).toFixed(3));
        const updated = await deps.inventory.updateInventoryLotQuantity(lot.id, tenantId, product.id,
          after, after <= 0 ? 'depleted' : 'active', client);
        if (!updated) throw new Error('amendment_lot_update_failed');
        const existing = await deps.repository.findConsumedLotAllocation(tenantId, item.id, lot.id, client);
        const allocation = existing
          ? await deps.repository.addLotAllocationQuantity(tenantId, existing.id, quantity, client)
          : await deps.inventory.createInventoryLotAllocation({ tenantId, orderId: order.id, orderItemId: item.id,
            productId: product.id, lotId: lot.id, quantity, status: 'consumed', metadata: { amendmentId } }, client);
        if (!allocation) throw new Error('amendment_lot_allocation_failed');
        await deps.inventory.insertInventoryMovement({ tenantId, productId: product.id, lotId: lot.id,
          movementType: 'sale', quantity, quantityBefore: before, quantityAfter: after,
          referenceType: 'order', referenceId: order.id, reason: 'Enmienda de pedido',
          metadata: { amendmentId, orderItemId: item.id } }, client);
        remaining = Number((remaining - quantity).toFixed(3));
      }
      if (remaining > 0) throw new Error('amendment_lot_insufficient_stock');
    } else {
      let remaining = -stockDelta;
      const allocations = (await deps.inventory.listInventoryLotAllocationsByOrder(tenantId, order.id, client, { forUpdate: true }))
        .filter((allocation) => String(allocation.orderItemId) === String(item.id) && allocation.status === 'consumed').reverse();
      for (const allocation of allocations) {
        if (remaining <= 0) break;
        const quantity = Math.min(Number(allocation.quantity), remaining);
        const lot = await deps.inventory.findInventoryLotById(allocation.lotId, tenantId, client, { forUpdate: true });
        if (!lot || lot.legacyStatus === 'cancelled' || lot.operationalStatus === 'written_off') {
          throw new Error('amendment_lot_restore_requires_review');
        }
        const before = Number(lot.availableQuantity);
        const after = Number((before + quantity).toFixed(3));
        const updated = await deps.inventory.updateInventoryLotState(lot.id, tenantId,
          { availableQuantity: after, status: 'active' }, client);
        if (!updated) throw new Error('amendment_lot_restore_failed');
        const newQuantity = Number((Number(allocation.quantity) - quantity).toFixed(3));
        if (!await deps.repository.adjustLotAllocation(tenantId, allocation.id, newQuantity, client)) {
          throw new Error('amendment_lot_allocation_restore_failed');
        }
        await deps.inventory.insertInventoryMovement({ tenantId, productId: product.id, lotId: lot.id,
          movementType: 'cancellation', quantity, quantityBefore: before, quantityAfter: after,
          referenceType: 'order', referenceId: order.id, reason: 'Enmienda de pedido',
          metadata: { amendmentId, orderItemId: item.id, allocationId: allocation.id } }, client);
        remaining = Number((remaining - quantity).toFixed(3));
      }
      if (remaining > 0) throw new Error('amendment_lot_allocation_mismatch');
    }
    await deps.inventory.syncProductStockFromLots(product.id, tenantId, client);
  }

  async function confirmCandidate({ tenantId, channelId, amendmentId, conversationId, orderId, revision }) {
    return deps.repository.withTransaction(async (client) => {
      const conversation = await deps.closure.lockConversation(tenantId, conversationId, client);
      const order = await deps.repository.lockOrder(tenantId, orderId, client);
      const amendment = await deps.repository.lockAmendment(tenantId, amendmentId, client);
      if (!conversation || !amendment || String(conversation.channelId) !== String(channelId) ||
          String(amendment.channelId) !== String(channelId) ||
          String(amendment.conversationId) !== String(conversationId) ||
          String(amendment.orderId) !== String(orderId)) return { confirmed: false, reason: 'scope_mismatch' };
      if (amendment.status !== 'candidate' || Number(amendment.revision) !== Number(revision)) {
        return { confirmed: false, reason: 'stale_candidate' };
      }
      if (new Date(amendment.executeAfter).getTime() > deps.now().getTime()) {
        return { confirmed: false, reason: 'grace_not_elapsed' };
      }
      const reject = async (reason, terminal = false) => {
        if (terminal) await deps.repository.releaseReservations(tenantId, amendmentId, client);
        await deps.repository.setStatus(tenantId, amendmentId, terminal ? 'cancelled' : 'blocked', reason, client);
        return { confirmed: false, reason };
      };
      if (conversation.context?.portalBotEnabled !== false || String(conversation.contactId) !== String(amendment.contactId)) {
        return reject('takeover_scope_changed', true);
      }
      const scope = { clinicId: tenantId, conversationId, contactId: amendment.contactId };
      if (!isOrderAmendable(order, scope) || Number(order.finalizationVersion) !== Number(amendment.baseVersion) ||
          String(order.updatedAt) !== String(amendment.baseOrderUpdatedAt) ||
          await deps.repository.hasFinancialCoupling(tenantId, orderId, client)) return reject('base_order_changed', true);
      const [latest, messages, lastOperation, reservations, products] = await Promise.all([
        deps.closure.getLatestRelevantMessage(conversationId, client),
        deps.closure.listRelevantMessages(conversationId, client),
        deps.closure.getLastOperation(tenantId, conversationId, client),
        deps.repository.listReservations(tenantId, amendmentId, client),
        deps.listProducts(tenantId)
      ]);
      if (!latest || String(latest.id) !== String(amendment.candidateConversationRevision) ||
          fingerprint(amendment, order, reservations) !== amendment.candidateFingerprint) return reject('revision_changed');
      const closure = closureForAmendment(messages, amendment, lastOperation);
      if (closure.status !== 'CLOSURE_POSSIBLE') return reject(closure.reason);
      const calculated = calculateDelta(amendment.baseline, amendment.proposed, products);
      if (!calculated.ok || JSON.stringify(calculated.delta) !== JSON.stringify(amendment.delta)) return reject('delta_changed');
      if (JSON.stringify(snapshotOrder(order)) !== JSON.stringify(amendment.baseline)) return reject('baseline_changed');
      const required = positiveByProduct(calculated.delta);
      if (reservations.length !== required.size || reservations.some((row) =>
        Number(row.quantity) !== required.get(String(row.productId)))) return reject('reservation_mismatch');
      const changes = calculated.delta.changes;
      const lockedProducts = new Map();
      const existingAllocations = await deps.inventory.listInventoryLotAllocationsByOrder(
        tenantId, orderId, client, { forUpdate: true });
      for (const change of changes) {
        const product = await deps.takeover.lockProduct(change.productId, tenantId, client);
        if (!product || String(product.status).toLowerCase() !== 'active') return reject('product_unavailable');
        if (stockUnits(change.beforeItem, product) !== change.previousUnits ||
            stockUnits(change.afterItem, product) !== change.nextUnits) return reject('packaging_changed');
        if (!change.beforeItem && (Number(change.afterItem.unitPrice) !== Number(product.unitPrice) ||
            Number(change.afterItem.taxRate) !== Number(product.taxRate))) return reject('catalog_price_changed');
        const available = await availableStock(product, tenantId, client, deps);
        const reserved = await deps.takeover.getActiveReservedQuantity(product.id, tenantId, client);
        if (available === null || available < reserved) return reject('stock_conflict');
        if (change.beforeItem) {
          const committed = await deps.repository.getCommittedBaselineReservation(tenantId, change.beforeItem.id, client);
          if (!committed || String(committed.productId) !== String(change.productId) ||
              Number(committed.quantity) !== Number(change.previousUnits)) return reject('baseline_reservation_changed');
          const allocated = existingAllocations.filter((row) =>
            String(row.orderItemId) === String(change.beforeItem.id) && row.status === 'consumed')
            .reduce((sum, row) => sum + Number(row.quantity), 0);
          if (trackingMode(product) === 'lot_based' ? allocated !== Number(change.previousUnits) : allocated !== 0) {
            return reject('inventory_tracking_changed_or_allocation_mismatch');
          }
        }
        lockedProducts.set(String(product.id), product);
      }
      for (const change of changes) {
        const product = lockedProducts.get(String(change.productId));
        const current = (order.items || []).find((item) => String(item.productId) === String(change.productId));
        if (change.beforeItem && (!current || String(current.id) !== String(change.beforeItem.id))) {
          throw new Error('amendment_order_item_changed');
        }
        const currentItem = change.afterItem
          ? await deps.takeover.upsertOrderItem(order.id, change.afterItem, client)
          : current;
        if (change.stockDelta) {
          if (trackingMode(product) === 'lot_based') {
            await applyLotDelta({ tenantId, order, item: currentItem, product,
              stockDelta: change.stockDelta, amendmentId, client });
          } else if (!await deps.repository.adjustLegacyStock(tenantId, product.id, change.stockDelta, client)) {
            throw new Error('amendment_legacy_stock_commit_failed');
          }
        }
        if (change.beforeItem) {
          const updated = await deps.repository.updateCommittedBaselineReservation(tenantId, current.id,
            change.nextUnits, client);
          if (!updated) throw new Error('amendment_committed_reservation_missing');
        } else if (change.afterItem) {
          const inserted = await deps.repository.insertCommittedReservation({ tenantId, orderId: order.id,
            orderItemId: currentItem.id, productId: product.id, quantity: change.nextUnits, amendmentId }, client);
          if (!inserted) throw new Error('amendment_committed_reservation_insert_failed');
        }
        if (!change.afterItem) await deps.takeover.removeOrderItem(current.id, client);
      }
      const after = await deps.takeover.recalculateOrder(order.id, client);
      if (!after) throw new Error('amendment_order_recalculation_failed');
      const finalized = await deps.prepareNotification({ previousOrder: order,
        order: await deps.repository.lockOrder(tenantId, orderId, client), client });
      for (const row of reservations) {
        if (!await deps.repository.commitReservation(tenantId, row.id, client)) {
          throw new Error('amendment_reservation_commit_failed');
        }
      }
      const confirmed = await deps.repository.markConfirmed({ tenantId, amendmentId,
        revision, confirmedSnapshot: snapshotOrder(finalized.order) }, client);
      if (!confirmed) throw new Error('amendment_confirm_race');
      logInfo('order_amendment_confirmed', { tenantId, conversationId, orderId, amendmentId,
        version: finalized.order.finalizationVersion, summaryQueued: Boolean(finalized.notification) });
      return { confirmed: true, orderId, amendmentId, summaryQueued: Boolean(finalized.notification) };
    });
  }

  return { processInbound, createCandidateForScope, scanCandidates, sweepInvalidated, confirmCandidate };
}

module.exports = { isOrderAmendable, fingerprint, closureForAmendment,
  createOrderAmendmentService, orderAmendment: createOrderAmendmentService() };
