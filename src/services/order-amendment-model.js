const { buildItem, buildOrderDecision, normalizeText, parseQuantity, productMentions, unitsPerPackage } = require('./takeover-order-processing.service');

const AMENDMENT_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

function isExplicitNewOrder(text) {
  return /\b(?:otro pedido|nuevo pedido|pedido aparte|aparte haceme|separado de este pedido)\b/.test(normalizeText(text));
}

function isCancelAmendment(text) {
  return /\b(?:dejalo como estaba|deja el pedido como estaba|cancel[aá] (?:el )?cambio|sin cambios)\b/.test(normalizeText(text));
}

function lineFromOrderItem(item) {
  return {
    id: item.id || null,
    productId: item.productId,
    descriptionSnapshot: item.descriptionSnapshot || item.nameSnapshot || item.name,
    skuSnapshot: item.skuSnapshot || null,
    unitPrice: Number(item.unitPrice),
    currencySnapshot: item.currencySnapshot || 'ARS',
    quantity: Number(item.quantity),
    taxRate: Number(item.taxRate || 0),
    subtotalAmount: Number(item.subtotalAmount),
    totalAmount: Number(item.totalAmount),
    variant: item.variant || null
  };
}

function snapshotOrder(order) {
  return {
    orderId: order.id,
    version: Number(order.finalizationVersion),
    finalizedAt: order.finalizedAt,
    updatedAt: order.updatedAt,
    subtotalAmount: Number(order.subtotalAmount),
    taxAmount: Number(order.taxAmount),
    totalAmount: Number(order.totalAmount),
    currency: order.currency,
    items: (order.items || []).map(lineFromOrderItem)
  };
}

function withQuantity(item, quantity) {
  const subtotalAmount = Number((Number(item.unitPrice) * quantity).toFixed(2));
  const totalAmount = Number((subtotalAmount * (1 + Number(item.taxRate) / 100)).toFixed(2));
  return { ...item, quantity, subtotalAmount, totalAmount };
}

function summarizeLines(items) {
  const subtotalAmount = Number(items.reduce((sum, item) => sum + Number(item.subtotalAmount), 0).toFixed(2));
  const totalAmount = Number(items.reduce((sum, item) => sum + Number(item.totalAmount), 0).toFixed(2));
  return { subtotalAmount, taxAmount: Number((totalAmount - subtotalAmount).toFixed(2)), totalAmount };
}

function decideAmendment({ text, products, messages, proposed }) {
  const normalized = normalizeText(text);
  if (isCancelAmendment(text)) return { kind: 'cancel' };
  if (isExplicitNewOrder(text)) return { kind: 'new_order' };
  const replacement = normalized.match(/\b(?:cambia|cambiame|reemplaza|reemplazame)\b.+\bpor\b/);
  if (replacement) {
    const [fromText, toText] = normalized.split(/\bpor\b/, 2);
    const from = productMentions(products, fromText);
    const to = productMentions(products, toText);
    const quantity = parseQuantity(toText);
    if (from.length !== 1 || to.length !== 1 || !quantity || from[0].id === to[0].id) {
      return { kind: 'blocked', reason: 'REPLACE_AMBIGUOUS' };
    }
    if (!(proposed.items || []).some((item) => item.productId === from[0].id)) {
      return { kind: 'blocked', reason: 'REPLACE_SOURCE_NOT_IN_ORDER' };
    }
    if ((proposed.items || []).some((item) => item.productId === to[0].id)) {
      return { kind: 'blocked', reason: 'REPLACE_TARGET_ALREADY_IN_ORDER' };
    }
    return { kind: 'replace', fromProduct: from[0], toProduct: to[0], quantity };
  }
  const decision = buildOrderDecision({ text, products, messages, draftItems: proposed.items });
  return decision.confidence === 'HIGH_CONFIDENCE'
    ? { kind: 'change', decision }
    : { kind: 'none', reason: decision.reason, confidence: decision.confidence };
}

function applyDecision(proposed, decision) {
  const items = proposed.items.map((item) => ({ ...item }));
  const apply = (product, operation, quantity, requestedUnit) => {
    const index = items.findIndex((item) => item.productId === product.id);
    const current = index >= 0 ? items[index] : null;
    if (operation === 'remove' && !current) return { ok: false, reason: 'ITEM_NOT_IN_ORDER' };
    const nextQuantity = operation === 'remove' ? 0 : operation === 'add' && current
      ? Number(current.quantity) + quantity : quantity;
    if (!Number.isInteger(nextQuantity) || nextQuantity < 0) return { ok: false, reason: 'INVALID_QUANTITY' };
    if (nextQuantity === 0) items.splice(index, 1);
    else if (current) {
      if (requestedUnit && requestedUnit !== current.variant) return { ok: false, reason: 'UNIT_CHANGE_REQUIRES_REVIEW' };
      items[index] = withQuantity(current, nextQuantity);
    } else {
      if (unitsPerPackage(product, requestedUnit) === null) return { ok: false, reason: 'UNIT_NOT_CONVERTIBLE' };
      if (product.unitPrice == null && product.price == null) return { ok: false, reason: 'PRICE_UNKNOWN' };
      if (!Number.isFinite(Number(product.unitPrice ?? product.price)) || Number(product.unitPrice ?? product.price) < 0) {
        return { ok: false, reason: 'PRICE_INVALID' };
      }
      items.push(buildItem(product, nextQuantity, requestedUnit));
    }
    return { ok: true };
  };
  if (decision.kind === 'replace') {
    const removed = apply(decision.fromProduct, 'remove', 0, null);
    if (!removed.ok) return removed;
    const added = apply(decision.toProduct, 'set', decision.quantity, null);
    if (!added.ok) return added;
  } else if (decision.kind === 'change') {
    const d = decision.decision;
    const changed = apply(d.product, d.operation, d.quantity, d.requestedUnit);
    if (!changed.ok) return changed;
  } else return { ok: false, reason: 'NO_CHANGE' };
  if (!items.length) return { ok: false, reason: 'EMPTY_ORDER_REQUIRES_FULL_CANCELLATION' };
  return { ok: true, proposed: { ...proposed, ...summarizeLines(items), items } };
}

function stockUnits(item, product) {
  if (!item) return 0;
  const catalog = product && product.metadata && product.metadata.catalog || {};
  const multiplier = unitsPerPackage({ unitOfMeasure: catalog.unitOfMeasure, attributes: catalog.attributes }, item.variant);
  return multiplier === null ? null : Number(item.quantity) * multiplier;
}

function calculateDelta(baseline, proposed, products) {
  const byProduct = new Map(products.map((product) => [String(product.id), product]));
  const before = new Map(baseline.items.map((item) => [String(item.productId), item]));
  const after = new Map(proposed.items.map((item) => [String(item.productId), item]));
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(id) || null;
    const next = after.get(id) || null;
    if (previous && next && Number(previous.quantity) === Number(next.quantity) &&
        String(previous.variant || '') === String(next.variant || '')) continue;
    const product = byProduct.get(id);
    if (!product) return { ok: false, reason: 'PRODUCT_NOT_IN_TENANT_CATALOG' };
    const previousUnits = stockUnits(previous, product);
    const nextUnits = stockUnits(next, product);
    if (previousUnits === null || nextUnits === null) return { ok: false, reason: 'UNIT_NOT_CONVERTIBLE' };
    const stockDelta = nextUnits - previousUnits;
    if (stockDelta || Number(previous?.quantity || 0) !== Number(next?.quantity || 0)) {
      changes.push({ productId: id, beforeItem: previous, afterItem: next, previousUnits, nextUnits, stockDelta });
    }
  }
  changes.sort((a, b) => a.productId.localeCompare(b.productId));
  return { ok: true, delta: { changes } };
}

module.exports = {
  AMENDMENT_CONTEXT_WINDOW_MS, isExplicitNewOrder, isCancelAmendment, snapshotOrder,
  decideAmendment, applyDecision, calculateDelta, stockUnits
};
