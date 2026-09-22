const conversationRepo = require('../conversations/conversation.repo');
const { listProductsByClinicId } = require('../repositories/products.repository');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const repository = require('../repositories/takeover-order.repository');
const { logInfo } = require('../utils/logger');

const NUMBER_WORDS = new Map([
  ['un', 1], ['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5],
  ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10], ['once', 11],
  ['doce', 12], ['trece', 13], ['catorce', 14], ['quince', 15], ['dieciseis', 16],
  ['diecisiete', 17], ['dieciocho', 18], ['diecinueve', 19], ['veinte', 20]
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseQuantity(rawText) {
  const text = normalizeText(rawText);
  const numeric = text.match(/(?:^|\s)(\d{1,4})(?:\s|$)/);
  if (numeric) {
    const value = Number(numeric[1]);
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  for (const [word, value] of NUMBER_WORDS) {
    if (new RegExp(`(?:^|\\s)${word}(?:\\s|$)`).test(text)) return value;
  }
  return null;
}

function normalizeUnit(value) {
  const unit = normalizeText(value);
  if (!unit) return null;
  if (/^caja(?:s)?$/.test(unit)) return 'caja';
  if (/^(?:pack|packs|paquete|paquetes)$/.test(unit)) return 'pack';
  if (/^(?:unidad|unidades|u)$/.test(unit)) return 'unidad';
  return unit;
}

function parseRequestedUnit(rawText) {
  const text = normalizeText(rawText);
  const match = text.match(/(?:^|\s)(cajas?|packs?|paquetes?|unidades?|u)(?:\s|$)/);
  return match ? normalizeUnit(match[1]) : null;
}

function detectOperation(rawText) {
  const text = normalizeText(rawText);
  if (/\b(?:saca|sacame|quita|quitame|elimina|eliminame|no quiero)\b/.test(text)) return 'remove';
  if (/\b(?:mejor|cambia|cambiame|deja|dejame|corregi|corregime)\b/.test(text)) return 'set';
  if (/\b(?:agrega|agregame|suma|sumame|anadi|anadime)\b/.test(text)) return 'add';
  if (/\b(?:manda|mandame|dame|quiero|llevo|pone|poneme)\b/.test(text)) return 'set';
  return null;
}

function productMentions(products, rawText) {
  const text = normalizeText(rawText);
  if (!text) return [];
  const matches = [];
  for (const product of Array.isArray(products) ? products : []) {
    if (!product || product.status && String(product.status).toLowerCase() !== 'active') continue;
    const name = normalizeText(product.name);
    const sku = normalizeText(product.sku);
    if ((name && (` ${text} `).includes(` ${name} `)) || (sku && new RegExp(`(?:^|\\s)${sku}(?:\\s|$)`).test(text))) {
      matches.push({ product, score: name.length });
    }
  }
  if (!matches.length) return [];
  matches.sort((a, b) => b.score - a.score);
  const longest = matches[0].score;
  return matches.filter((match) => match.score === longest).map((match) => match.product);
}

function resolveContextProduct({ products, messages, currentText, draftItems = [] }) {
  const explicit = productMentions(products, currentText);
  if (explicit.length === 1) return { product: explicit[0], source: 'CURRENT_MESSAGE' };
  if (explicit.length > 1) return { product: null, reason: 'AMBIGUOUS' };

  const ordered = Array.isArray(messages) ? [...messages].reverse() : [];
  for (const message of ordered) {
    const mentioned = productMentions(products, message && (message.text || message.body));
    if (mentioned.length === 1) return { product: mentioned[0], source: 'CONVERSATION_HISTORY' };
    if (mentioned.length > 1) return { product: null, reason: 'AMBIGUOUS' };
  }

  const uniqueDraftProducts = Array.from(new Set((draftItems || []).map((item) => item.productId).filter(Boolean)));
  if (uniqueDraftProducts.length === 1) {
    const product = (products || []).find((candidate) => candidate.id === uniqueDraftProducts[0]);
    if (product) return { product, source: 'ACTIVE_DRAFT' };
  }
  return { product: null, reason: uniqueDraftProducts.length > 1 ? 'AMBIGUOUS' : 'INSUFFICIENT_CONTEXT' };
}

function hasExplicitUnknownProductCue(rawText, operation) {
  const text = normalizeText(rawText);
  const afterDe = text.match(/\bde\s+(.+)$/);
  if (afterDe && !/^(?:ese|esa|eso|el mismo|la misma)\b/.test(afterDe[1])) return true;
  if (operation === 'remove') {
    const afterVerb = text.match(/\b(?:saca|sacame|quita|quitame|elimina|eliminame)\s+(?:(?:el|la|los|las)\s+)?(.+)$/);
    if (afterVerb && !/^(?:ese|esa|eso|producto|item)\b/.test(afterVerb[1])) return true;
  }
  return false;
}

function unitsPerPackage(product, requestedUnit) {
  const productUnit = normalizeUnit(product && product.unitOfMeasure);
  if (!requestedUnit || requestedUnit === productUnit) return 1;
  const attributes = product && product.attributes && typeof product.attributes === 'object' ? product.attributes : {};
  const candidates = requestedUnit === 'caja'
    ? [attributes.unitsPerBox, attributes.unidadesPorCaja, attributes.units_per_box]
    : requestedUnit === 'pack'
      ? [attributes.unitsPerPack, attributes.unidadesPorPack, attributes.units_per_pack]
      : [];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function buildOrderDecision({ text, products, messages, draftItems = [] }) {
  const operation = detectOperation(text);
  if (!operation) return { confidence: 'INSUFFICIENT_CONTEXT', reason: 'NO_ORDER_OPERATION' };
  if (productMentions(products, text).length === 0 && hasExplicitUnknownProductCue(text, operation)) {
    return { confidence: 'INSUFFICIENT_CONTEXT', reason: 'UNKNOWN_PRODUCT_CURRENT_MESSAGE', operation };
  }
  const resolved = resolveContextProduct({ products, messages, currentText: text, draftItems });
  if (!resolved.product) return { confidence: resolved.reason || 'INSUFFICIENT_CONTEXT', reason: 'PRODUCT_NOT_RESOLVED', operation };
  if (operation === 'remove') {
    return { confidence: 'HIGH_CONFIDENCE', operation, product: resolved.product, productSource: resolved.source, quantity: 0, requestedUnit: null, stockQuantity: 0 };
  }
  const quantityText = normalizeText(text).replace(normalizeText(resolved.product.name), ' ');
  const quantity = parseQuantity(quantityText);
  if (!quantity) return { confidence: 'INSUFFICIENT_CONTEXT', reason: 'QUANTITY_NOT_RESOLVED', operation, product: resolved.product };
  const requestedUnit = parseRequestedUnit(text);
  const multiplier = unitsPerPackage(resolved.product, requestedUnit);
  return {
    confidence: 'HIGH_CONFIDENCE',
    operation,
    product: resolved.product,
    productSource: resolved.source,
    quantity,
    requestedUnit,
    stockQuantity: multiplier === null ? null : quantity * multiplier
  };
}

function buildItem(product, quantity, requestedUnit) {
  const unitPrice = Number(product.unitPrice ?? product.price ?? 0);
  const taxRate = Number(product.taxRate ?? product.vatRate ?? 0);
  const subtotalAmount = Number((unitPrice * quantity).toFixed(2));
  const totalAmount = Number((subtotalAmount * (1 + taxRate / 100)).toFixed(2));
  return {
    productId: product.id,
    descriptionSnapshot: product.name,
    skuSnapshot: product.sku || null,
    unitPrice,
    currencySnapshot: product.currency || 'ARS',
    quantity,
    taxRate,
    subtotalAmount,
    totalAmount,
    variant: requestedUnit || null
  };
}

function createTakeoverOrderProcessor(overrides = {}) {
  const deps = {
    repository,
    listProducts: listProductsByClinicId,
    listMessages: repository.listRecentConversationMessages,
    getMessage: conversationRepo.getMessageById,
    findContact: findContactByIdAndClinicId,
    previewDraft: async (scope) => repository.getDraftSnapshot(scope.clinicId, scope.conversationId),
    ...overrides
  };

  async function recordSkipped(scope, decision) {
    return deps.repository.withTransaction(async (client) => {
      await deps.repository.lockConversation(scope.conversationId, client);
      const operation = await deps.repository.beginOperation({
        tenantId: scope.clinicId,
        conversationId: scope.conversationId,
        sourceMessageId: scope.inboundMessageId,
        operation: 'ORDER_OPERATION_SKIPPED',
        metadata: { confidence: decision.confidence, reason: decision.reason, actor: 'SYSTEM', trigger: 'CUSTOMER_MESSAGE', humanTakeover: true }
      }, client);
      if (!operation) return { ok: true, duplicate: true };
      await deps.repository.completeOperation(operation.id, scope.clinicId, {
        result: 'skipped', operation: decision.confidence === 'AMBIGUOUS' ? 'ORDER_OPERATION_SKIPPED_AMBIGUOUS' : 'ORDER_OPERATION_SKIPPED_INSUFFICIENT_CONTEXT',
        metadata: { confidence: decision.confidence, reason: decision.reason }
      }, client);
      return { ok: true, mutated: false, confidence: decision.confidence, reason: decision.reason };
    });
  }

  return async function processTakeoverOrder(scope) {
    const inbound = await deps.getMessage(scope.inboundMessageId);
    if (!inbound || inbound.conversationId !== scope.conversationId) return { ok: false, reason: 'INBOUND_MESSAGE_SCOPE_MISMATCH' };
    const [products, messages, contact] = await Promise.all([
      deps.listProducts(scope.clinicId),
      deps.listMessages(scope.conversationId, scope.clinicId, 30),
      deps.findContact(scope.contactId, scope.clinicId)
    ]);
    const priorMessages = (messages || []).filter((message) => message.id !== scope.inboundMessageId);
    const previewDraft = await deps.previewDraft(scope);
    const decision = buildOrderDecision({ text: inbound.text || inbound.body, products, messages: priorMessages, draftItems: previewDraft?.items || [] });
    if (decision.confidence !== 'HIGH_CONFIDENCE') return recordSkipped(scope, decision);

    const result = await deps.repository.withTransaction(async (client) => {
      await deps.repository.lockConversation(scope.conversationId, client);
      const operationRow = await deps.repository.beginOperation({
        tenantId: scope.clinicId,
        conversationId: scope.conversationId,
        sourceMessageId: scope.inboundMessageId,
        operation: 'ORDER_DRAFT_PROCESSING',
        metadata: { confidence: decision.confidence, actor: 'SYSTEM', trigger: 'CUSTOMER_MESSAGE', humanTakeover: true, productSource: decision.productSource }
      }, client);
      if (!operationRow) return { ok: true, duplicate: true };

      let draft = await deps.repository.findDraftByConversation(scope.clinicId, scope.conversationId, client);
      const draftCreated = !draft;
      let items = draft ? await deps.repository.listOrderItems(draft.id, client) : [];
      const existingItem = items.find((item) => item.productId === decision.product.id) || null;
      const product = await deps.repository.lockProduct(decision.product.id, scope.clinicId, client);
      if (!product || String(product.status || '').toLowerCase() !== 'active') {
        await deps.repository.completeOperation(operationRow.id, scope.clinicId, {
          result: 'skipped', operation: 'ORDER_OPERATION_SKIPPED_UNKNOWN_PRODUCT', productId: decision.product.id,
          metadata: { confidence: 'INSUFFICIENT_CONTEXT', reason: 'TENANT_PRODUCT_NOT_ACTIVE' }
        }, client);
        return { ok: true, mutated: false, reason: 'TENANT_PRODUCT_NOT_ACTIVE' };
      }

      const previousQuantity = existingItem ? Number(existingItem.quantity || 0) : 0;
      const nextQuantity = decision.operation === 'remove' ? 0 : decision.operation === 'add' && existingItem ? previousQuantity + decision.quantity : decision.quantity;
      const existingReservation = existingItem ? await deps.repository.getActiveReservation(existingItem.id, scope.clinicId, client) : null;
      const previousReservation = existingReservation ? Number(existingReservation.quantity || 0) : 0;
      const nextReservation = decision.stockQuantity === null
        ? 0
        : decision.operation === 'remove'
          ? 0
          : decision.operation === 'add' && existingItem
            ? previousReservation + decision.stockQuantity
            : decision.stockQuantity;
      const otherReserved = await deps.repository.getActiveReservedQuantity(product.id, scope.clinicId, client, existingItem?.id || null);
      const physicalStock = product.stock === null || product.stock === undefined ? null : Number(product.stock);
      if (nextReservation > 0 && physicalStock === null) {
        await deps.repository.completeOperation(operationRow.id, scope.clinicId, {
          result: 'skipped', operation: 'STOCK_RESERVATION_SKIPPED_UNKNOWN', productId: product.id,
          previousQuantity, newQuantity: previousQuantity, reservationDelta: 0,
          metadata: { confidence: decision.confidence, requestedQuantity: nextReservation }
        }, client);
        return { ok: true, mutated: false, reason: 'STOCK_UNKNOWN' };
      }
      const available = physicalStock === null ? null : Math.max(0, physicalStock - otherReserved);
      if (nextReservation > 0 && nextReservation > available) {
        await deps.repository.completeOperation(operationRow.id, scope.clinicId, {
          result: 'skipped', operation: 'STOCK_RESERVATION_SKIPPED_INSUFFICIENT', productId: product.id,
          previousQuantity, newQuantity: previousQuantity, reservationDelta: 0,
          metadata: { confidence: decision.confidence, requestedQuantity: nextReservation, available }
        }, client);
        return { ok: true, mutated: false, reason: 'INSUFFICIENT_STOCK', available };
      }

      if (!draft && nextQuantity > 0) {
        const itemDraft = buildItem(product, nextQuantity, decision.requestedUnit);
        draft = await deps.repository.createDraft({
          tenantId: scope.clinicId, conversationId: scope.conversationId, contactId: scope.contactId,
          customerName: contact && (contact.fullName || contact.name), customerPhone: contact && (contact.phone || contact.whatsappPhone || contact.waId),
          item: itemDraft
        }, client);
        items = await deps.repository.listOrderItems(draft.id, client);
      } else if (draft && nextQuantity > 0) {
        await deps.repository.upsertOrderItem(draft.id, buildItem(product, nextQuantity, decision.requestedUnit), client);
      } else if (draft && existingItem) {
        await deps.repository.setReservation({
          tenantId: scope.clinicId, orderId: draft.id, orderItemId: existingItem.id, productId: product.id, quantity: 0,
          metadata: { sourceMessageId: scope.inboundMessageId, operation: 'STOCK_RESERVATION_RELEASED' }
        }, client);
        await deps.repository.removeOrderItem(existingItem.id, client);
      } else {
        await deps.repository.completeOperation(operationRow.id, scope.clinicId, {
          result: 'skipped', operation: 'ORDER_ITEM_REMOVE_SKIPPED_NOT_FOUND', productId: product.id,
          previousQuantity: 0, newQuantity: 0, reservationDelta: 0,
          metadata: { confidence: decision.confidence }
        }, client);
        return { ok: true, mutated: false, reason: 'ORDER_ITEM_NOT_FOUND' };
      }

      const currentItems = draft ? await deps.repository.listOrderItems(draft.id, client) : [];
      const currentItem = currentItems.find((item) => item.productId === product.id) || existingItem;
      if (draft && currentItem && nextQuantity > 0) {
        await deps.repository.setReservation({
          tenantId: scope.clinicId, orderId: draft.id, orderItemId: currentItem.id, productId: product.id, quantity: nextReservation,
          metadata: { sourceMessageId: scope.inboundMessageId, operation: previousReservation ? 'STOCK_RESERVATION_ADJUSTED' : 'STOCK_RESERVED' }
        }, client);
      }
      if (draft) await deps.repository.recalculateOrder(draft.id, client);

      const operationName = nextQuantity === 0
        ? 'ORDER_ITEM_REMOVED'
        : previousQuantity === 0
          ? (draftCreated ? 'ORDER_DRAFT_CREATED' : 'ORDER_ITEM_ADDED')
          : 'ORDER_ITEM_QUANTITY_CHANGED';
      const reservationDelta = nextReservation - previousReservation;
      const reservationOperation = reservationDelta > 0
        ? (previousReservation > 0 ? 'STOCK_RESERVATION_ADJUSTED' : 'STOCK_RESERVED')
        : reservationDelta < 0
          ? (nextReservation === 0 ? 'STOCK_RESERVATION_RELEASED' : 'STOCK_RESERVATION_ADJUSTED')
          : null;
      await deps.repository.completeOperation(operationRow.id, scope.clinicId, {
        result: 'applied', operation: operationName, orderId: draft && draft.id, productId: product.id,
        previousQuantity, newQuantity: nextQuantity, reservationDelta,
        metadata: { confidence: decision.confidence, commercialUnit: decision.requestedUnit, stockQuantity: decision.stockQuantity, reservationOperation }
      }, client);
      return { ok: true, mutated: true, orderId: draft && draft.id, productId: product.id, operation: operationName, quantity: nextQuantity, reservedQuantity: nextReservation, reservationDelta, reservationOperation };
    });

    logInfo('takeover_order_processing_result', {
      tenantId: scope.clinicId, conversationId: scope.conversationId, sourceMessageId: scope.inboundMessageId,
      orderId: result.orderId || null, productId: result.productId || null, operation: result.operation || result.reason || 'duplicate',
      confidence: decision.confidence, reservationDelta: result.reservationDelta ?? null
    });
    return result;
  };
}

module.exports = {
  normalizeText,
  parseQuantity,
  parseRequestedUnit,
  detectOperation,
  productMentions,
  resolveContextProduct,
  hasExplicitUnknownProductCue,
  unitsPerPackage,
  buildOrderDecision,
  createTakeoverOrderProcessor,
  processTakeoverOrder: createTakeoverOrderProcessor()
};
