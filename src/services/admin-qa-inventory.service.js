const {
  listPortalProducts,
  createPortalProduct
} = require('./portal-products.service');
const {
  listPortalInventoryLots,
  getPortalInventoryLot,
  createPortalInventoryLot,
  adjustPortalInventoryLot,
  listPortalInventoryLocations,
  createPortalInventoryLocation
} = require('./inventory-lots.service');

const QA_FLOW = 'ALERTS.CANARY.LOT.1A';
const QA_METADATA_KEY = 'qaInventoryCanary';
const QA_PRODUCT_NAME = 'QA Alerts Canary Product';
const QA_PRODUCT_SKU = 'QA-ALERTS-CANARY-PRODUCT';
const QA_LOCATION_NAME = 'QA Alerts Canary Location';
const QA_LOCATION_CODE = 'QA_ALERTS_CANARY';
const QA_LOT_NUMBER = 'QA-ALERTS-CANARY-20260820';
const QA_EXPIRES_AT = '2026-08-20';
const QA_LOT_CREATE_IDEMPOTENCY_KEY = 'qa-alerts-canary-lot-create-v1';
const QA_LOT_ROLLBACK_IDEMPOTENCY_KEY = 'qa-alerts-canary-lot-rollback-v1';
const QA_LOT_NOTES = 'QA interno — ALERTS.CANARY.LOT.1A; no comercial.';
const QA_LOT_ROLLBACK_REASON = 'QA interno — cierre ALERTS.CANARY.LOT.1A';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isUuid(value) {
  return UUID_PATTERN.test(normalizeString(value));
}

function canonicalQaMetadata(kind) {
  return {
    [QA_METADATA_KEY]: {
      flow: QA_FLOW,
      kind,
      version: 1,
      nonCommercial: true
    }
  };
}

function hasCanonicalQaMetadata(metadata, kind) {
  const marker = normalizeMetadata(metadata)[QA_METADATA_KEY];
  return marker &&
    typeof marker === 'object' &&
    !Array.isArray(marker) &&
    marker.flow === QA_FLOW &&
    marker.kind === kind &&
    marker.version === 1 &&
    marker.nonCommercial === true;
}

function canonicalProductPayload() {
  return {
    name: QA_PRODUCT_NAME,
    description: 'Producto interno no comercial para ALERTS.CANARY.LOT.1A.',
    sku: QA_PRODUCT_SKU,
    unitPrice: 0,
    vatRate: 0,
    currency: 'ARS',
    status: 'active',
    metadata: {
      ...canonicalQaMetadata('product'),
      catalog: {
        inventoryTrackingMode: 'lot_based',
        nonCommercial: true
      }
    }
  };
}

function canonicalLocationPayload() {
  return {
    name: QA_LOCATION_NAME,
    code: QA_LOCATION_CODE,
    type: 'other',
    active: true
  };
}

function canonicalLotPayload(productId, locationId) {
  return {
    productId,
    locationId,
    lotNumber: QA_LOT_NUMBER,
    quantity: 1,
    expiresAt: QA_EXPIRES_AT,
    status: 'active',
    operationalStatus: 'active',
    notes: QA_LOT_NOTES,
    metadata: canonicalQaMetadata('lot'),
    idempotencyKey: QA_LOT_CREATE_IDEMPOTENCY_KEY,
    movementIdempotencyKey: QA_LOT_CREATE_IDEMPOTENCY_KEY,
    referenceType: 'qa_alerts_canary_setup',
    reason: QA_LOT_NOTES
  };
}

function canonicalRollbackPayload() {
  return {
    movementType: 'manual_decrease',
    quantity: 1,
    referenceType: 'inventory_manual_writeoff',
    reason: QA_LOT_ROLLBACK_REASON,
    metadata: canonicalQaMetadata('rollback'),
    idempotencyKey: QA_LOT_ROLLBACK_IDEMPOTENCY_KEY
  };
}

function isCanonicalQaProduct(product) {
  const safe = product || {};
  const unitPrice = Number(safe.unitPrice ?? safe.price ?? NaN);
  return normalizeString(safe.name) === QA_PRODUCT_NAME &&
    normalizeString(safe.sku) === QA_PRODUCT_SKU &&
    safe.status === 'active' &&
    !safe.deletedAt &&
    safe.inventoryTrackingMode === 'lot_based' &&
    Number.isFinite(unitPrice) && unitPrice === 0 &&
    hasCanonicalQaMetadata(safe.metadata, 'product');
}

function isCanonicalQaLocation(location) {
  const safe = location || {};
  return normalizeString(safe.code) === QA_LOCATION_CODE &&
    normalizeString(safe.name) === QA_LOCATION_NAME &&
    safe.active === true &&
    safe.isPrimary !== true &&
    normalizeString(safe.type).toLowerCase() === 'other';
}

function isCanonicalQaLotIdentity(lot, product, location) {
  const safe = lot || {};
  return normalizeString(safe.productId) === normalizeString(product?.id) &&
    normalizeString(safe.locationId) === normalizeString(location?.id) &&
    normalizeString(safe.lotNumber) === QA_LOT_NUMBER &&
    normalizeString(safe.expiresAt) === QA_EXPIRES_AT &&
    Number(safe.initialQuantity) === 1 &&
    hasCanonicalQaMetadata(safe.metadata, 'lot');
}

function isRolledBackCanonicalLot(lot, movements) {
  const safe = lot || {};
  const rollbackRecorded = (Array.isArray(movements) ? movements : []).some((movement) =>
    normalizeString(movement?.idempotencyKey) === QA_LOT_ROLLBACK_IDEMPOTENCY_KEY &&
    normalizeString(movement?.movementType) === 'manual_decrease' &&
    Number(movement?.quantity) === 1 &&
    normalizeString(movement?.referenceType) === 'inventory_manual_writeoff'
  );

  return rollbackRecorded &&
    Number(safe.availableQuantity) === 0 &&
    normalizeString(safe.operationalStatus) === 'written_off';
}

function isUniqueViolation(error) {
  return error && typeof error === 'object' && error.code === '23505';
}

function conflict(tenantId, reason) {
  return { ok: false, tenantId, reason };
}

async function findCanonicalQaProduct(tenantId) {
  const result = await listPortalProducts(tenantId);
  if (!result.ok) return result;
  const matches = (result.products || []).filter((product) => normalizeString(product?.sku) === QA_PRODUCT_SKU);
  if (!matches.length) return { ok: true, tenantId: result.tenantId || tenantId, product: null };
  if (matches.length !== 1 || !isCanonicalQaProduct(matches[0])) {
    return conflict(result.tenantId || tenantId, 'qa_inventory_product_conflict');
  }
  return { ok: true, tenantId: result.tenantId || tenantId, product: matches[0] };
}

async function findCanonicalQaLocation(tenantId) {
  const result = await listPortalInventoryLocations(tenantId);
  if (!result.ok) return result;
  const matches = (result.locations || []).filter((location) => normalizeString(location?.code) === QA_LOCATION_CODE);
  if (!matches.length) return { ok: true, tenantId: result.tenantId || tenantId, location: null };
  if (matches.length !== 1 || !isCanonicalQaLocation(matches[0])) {
    return conflict(result.tenantId || tenantId, 'qa_inventory_location_conflict');
  }
  return { ok: true, tenantId: result.tenantId || tenantId, location: matches[0] };
}

async function ensureQaProduct(tenantId) {
  const existing = await findCanonicalQaProduct(tenantId);
  if (!existing.ok || existing.product) {
    return existing.product
      ? { ok: true, tenantId: existing.tenantId, product: existing.product, idempotent: true }
      : existing;
  }

  const created = await createPortalProduct(tenantId, canonicalProductPayload());
  if (created.ok && isCanonicalQaProduct(created.product)) {
    return { ok: true, tenantId: created.tenantId || tenantId, product: created.product, idempotent: false };
  }

  // The normal catalog service protects SKU uniqueness. A concurrent retry may
  // see that constraint first, so resolve and validate the canonical record.
  if (created.reason === 'duplicate_product_sku') {
    const retried = await findCanonicalQaProduct(tenantId);
    if (retried.ok && retried.product) {
      return { ok: true, tenantId: retried.tenantId, product: retried.product, idempotent: true };
    }
    return retried;
  }

  return created.ok
    ? conflict(created.tenantId || tenantId, 'qa_inventory_product_create_noncanonical')
    : created;
}

async function ensureQaLocation(tenantId, actor = {}) {
  const existing = await findCanonicalQaLocation(tenantId);
  if (!existing.ok || existing.location) {
    return existing.location
      ? { ok: true, tenantId: existing.tenantId, location: existing.location, idempotent: true }
      : existing;
  }

  try {
    const created = await createPortalInventoryLocation(tenantId, canonicalLocationPayload(), actor);
    if (created.ok && isCanonicalQaLocation(created.location)) {
      return { ok: true, tenantId: created.tenantId || tenantId, location: created.location, idempotent: false };
    }
    return created.ok
      ? conflict(created.tenantId || tenantId, 'qa_inventory_location_create_noncanonical')
      : created;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const retried = await findCanonicalQaLocation(tenantId);
    if (retried.ok && retried.location) {
      return { ok: true, tenantId: retried.tenantId, location: retried.location, idempotent: true };
    }
    return retried;
  }
}

async function resolveCanonicalQaPrerequisites(tenantId) {
  const [productResult, locationResult] = await Promise.all([
    findCanonicalQaProduct(tenantId),
    findCanonicalQaLocation(tenantId)
  ]);
  if (!productResult.ok) return productResult;
  if (!locationResult.ok) return locationResult;
  if (!productResult.product) return conflict(productResult.tenantId || tenantId, 'qa_inventory_product_not_ready');
  if (!locationResult.location) return conflict(locationResult.tenantId || tenantId, 'qa_inventory_location_not_ready');
  return {
    ok: true,
    tenantId: productResult.tenantId || locationResult.tenantId || tenantId,
    product: productResult.product,
    location: locationResult.location
  };
}

async function findExistingQaLot(tenantId, product, location) {
  const result = await listPortalInventoryLots(tenantId, {
    productId: product.id,
    locationId: location.id,
    search: QA_LOT_NUMBER,
    pageSize: 10
  });
  if (!result.ok) return result;
  const matches = (result.lots || []).filter((lot) => normalizeString(lot?.lotNumber) === QA_LOT_NUMBER);
  if (!matches.length) return { ok: true, tenantId: result.tenantId || tenantId, lot: null };
  if (matches.length !== 1 || !isCanonicalQaLotIdentity(matches[0], product, location)) {
    return conflict(result.tenantId || tenantId, 'qa_inventory_lot_conflict');
  }
  const lot = matches[0];
  const activeFixture =
    Number(lot.availableQuantity) === 1 &&
    Number(lot.committedQuantity || 0) === 0 &&
    normalizeString(lot.status) === 'active' &&
    normalizeString(lot.operationalStatus) === 'active';
  if (!activeFixture) {
    return conflict(result.tenantId || tenantId, 'qa_inventory_lot_existing_state_conflict');
  }
  return { ok: true, tenantId: result.tenantId || tenantId, lot };
}

async function createQaLot(tenantId, payload, actor = {}) {
  const productId = normalizeString(payload?.productId);
  const locationId = normalizeString(payload?.locationId);
  if (!isUuid(productId) || !isUuid(locationId)) {
    return conflict(tenantId, 'qa_inventory_lot_ids_invalid');
  }

  const prerequisites = await resolveCanonicalQaPrerequisites(tenantId);
  if (!prerequisites.ok) return prerequisites;
  if (productId !== prerequisites.product.id || locationId !== prerequisites.location.id) {
    return conflict(prerequisites.tenantId, 'qa_inventory_lot_target_mismatch');
  }

  const existing = await findExistingQaLot(tenantId, prerequisites.product, prerequisites.location);
  if (!existing.ok || existing.lot) {
    return existing.lot
      ? { ok: true, tenantId: existing.tenantId, lot: existing.lot, idempotent: true }
      : existing;
  }

  const created = await createPortalInventoryLot(
    tenantId,
    canonicalLotPayload(prerequisites.product.id, prerequisites.location.id),
    actor
  );
  if (!created.ok) return created;
  if (!isCanonicalQaLotIdentity(created.lot, prerequisites.product, prerequisites.location) || Number(created.lot.availableQuantity) !== 1) {
    return conflict(created.tenantId || tenantId, 'qa_inventory_lot_create_noncanonical');
  }
  return {
    ok: true,
    tenantId: created.tenantId || tenantId,
    lot: created.lot,
    idempotent: created.idempotent === true
  };
}

async function rollbackQaLot(tenantId, lotId, actor = {}) {
  const safeLotId = normalizeString(lotId);
  if (!isUuid(safeLotId)) return conflict(tenantId, 'qa_inventory_lot_id_invalid');

  const prerequisites = await resolveCanonicalQaPrerequisites(tenantId);
  if (!prerequisites.ok) return prerequisites;

  const detail = await getPortalInventoryLot(tenantId, safeLotId);
  if (!detail.ok || !detail.lot) return detail.ok ? conflict(tenantId, 'inventory_lot_not_found') : detail;
  if (!isCanonicalQaLotIdentity(detail.lot, prerequisites.product, prerequisites.location)) {
    return conflict(prerequisites.tenantId, 'qa_inventory_lot_target_mismatch');
  }

  if (isRolledBackCanonicalLot(detail.lot, detail.movements)) {
    return {
      ok: true,
      tenantId: detail.tenantId || tenantId,
      lot: detail.lot,
      movement: null,
      idempotent: true
    };
  }

  if (
    Number(detail.lot.availableQuantity) !== 1 ||
    Number(detail.lot.committedQuantity || 0) !== 0 ||
    normalizeString(detail.lot.status) !== 'active' ||
    normalizeString(detail.lot.operationalStatus) !== 'active'
  ) {
    return conflict(detail.tenantId || tenantId, 'qa_inventory_lot_not_rollback_eligible');
  }

  const adjusted = await adjustPortalInventoryLot(tenantId, safeLotId, canonicalRollbackPayload(), actor);
  if (!adjusted.ok) {
    // A concurrent retry can observe the terminal lot state before the normal
    // write-off service reaches its idempotency operation lookup. Re-read only
    // to acknowledge our own completed rollback, never an arbitrary write-off.
    const latest = await getPortalInventoryLot(tenantId, safeLotId);
    if (latest.ok && isRolledBackCanonicalLot(latest.lot, latest.movements)) {
      return { ok: true, tenantId: latest.tenantId || tenantId, lot: latest.lot, movement: null, idempotent: true };
    }
    return adjusted;
  }

  if (
    Number(adjusted.lot?.availableQuantity) !== 0 ||
    normalizeString(adjusted.lot?.operationalStatus) !== 'written_off' ||
    normalizeString(adjusted.lot?.status) !== 'depleted'
  ) {
    return conflict(adjusted.tenantId || tenantId, 'qa_inventory_lot_rollback_noncanonical');
  }
  return {
    ok: true,
    tenantId: adjusted.tenantId || tenantId,
    lot: adjusted.lot,
    movement: adjusted.movement || null,
    idempotent: adjusted.idempotent === true
  };
}

module.exports = {
  ensureQaProduct,
  ensureQaLocation,
  createQaLot,
  rollbackQaLot,
  __private__: {
    QA_FLOW,
    QA_METADATA_KEY,
    QA_PRODUCT_NAME,
    QA_PRODUCT_SKU,
    QA_LOCATION_NAME,
    QA_LOCATION_CODE,
    QA_LOT_NUMBER,
    QA_EXPIRES_AT,
    QA_LOT_CREATE_IDEMPOTENCY_KEY,
    QA_LOT_ROLLBACK_IDEMPOTENCY_KEY,
    QA_LOT_NOTES,
    QA_LOT_ROLLBACK_REASON,
    isUuid,
    canonicalProductPayload,
    canonicalLocationPayload,
    canonicalLotPayload,
    canonicalRollbackPayload,
    isCanonicalQaProduct,
    isCanonicalQaLocation,
    isCanonicalQaLotIdentity,
    isRolledBackCanonicalLot
  }
};
