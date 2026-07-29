const crypto = require('crypto');

const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');
const { findSupplierById } = require('../repositories/suppliers.repository');
const { findProductsByIds } = require('../repositories/products.repository');
const { findInventoryLocationById } = require('../repositories/inventory.repository');
const {
  findByTenantAndIdempotencyKey,
  insertReceipt,
  insertReceiptItem,
  listReceiptsByTenant,
  findReceiptDetailByTenantAndId
} = require('../repositories/purchase-receipts.repository');
const { applyInventoryMovementWithClient } = require('./inventory-base.service');
const { receiveInventoryLotWithClient } = require('./inventory-lots.service');
const { normalizeLotNumber } = require('../utils/inventory-lot-identity');

const SORT_VALUES = new Set(['receivedAt_desc', 'receivedAt_asc']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function normalizePage(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDecimal(value) {
  if (value === undefined || value === null || value === '') return { value: null, text: null };
  const normalized = String(value).trim();
  if (!normalized) return { value: null, text: null };
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return { value: NaN, text: normalized, scale: null };
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return { value: NaN, text: normalized };
  return {
    value: parsed,
    text: normalized,
    scale: normalized.includes('.') ? normalized.split('.')[1].length : 0
  };
}

function normalizeTimestamp(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '__invalid__';
}

function normalizeDateOnly(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '__invalid__';
}

function resolveActorId(actor = {}) {
  const actorId = normalizeString(actor.actorId || actor.id);
  return isUuid(actorId) ? actorId : null;
}

function buildPayloadSignature(payload) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(payload));
  return hash.digest('hex');
}

function createDomainError(reason, details = null) {
  const error = new Error(reason);
  error.reason = reason;
  error.details = details || null;
  error.isDomainError = true;
  return error;
}

function sanitizeReceiptMetadata(metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  delete safeMetadata.payloadSignature;
  return safeMetadata;
}

function sanitizeReceiptItemMetadata(metadata) {
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  delete safeMetadata.lineFingerprint;
  delete safeMetadata.inventoryTrackingMode;
  return safeMetadata;
}

function mapReceiptDetailPublic(receipt) {
  if (!receipt) return null;
  return {
    ...receipt,
    metadata: sanitizeReceiptMetadata(receipt.metadata),
    items: Array.isArray(receipt.items)
      ? receipt.items.map((item) => ({
          ...item,
          metadata: sanitizeReceiptItemMetadata(item.metadata)
        }))
      : []
  };
}

function normalizeListFilters(query = {}) {
  const page = normalizePage(query.page, 1);
  const pageSize = normalizePage(query.pageSize, 20);
  const sort = normalizeString(query.sort) || 'receivedAt_desc';
  const dateFrom = normalizeNullableString(query.dateFrom);
  const dateTo = normalizeNullableString(query.dateTo);

  if (page > 100000) return { ok: false, reason: 'invalid_purchase_receipt_page' };
  if (pageSize > 100) return { ok: false, reason: 'invalid_purchase_receipt_page_size' };
  if (!SORT_VALUES.has(sort)) return { ok: false, reason: 'invalid_purchase_receipt_sort' };
  if (query.supplierId && !isUuid(query.supplierId)) return { ok: false, reason: 'invalid_supplier_id' };
  if (query.locationId && !isUuid(query.locationId)) return { ok: false, reason: 'invalid_inventory_location_id' };
  if (dateFrom && normalizeDateOnly(dateFrom) === '__invalid__') return { ok: false, reason: 'invalid_purchase_receipt_date_from' };
  if (dateTo && normalizeDateOnly(dateTo) === '__invalid__') return { ok: false, reason: 'invalid_purchase_receipt_date_to' };
  if (dateFrom && dateTo && dateFrom > dateTo) return { ok: false, reason: 'invalid_purchase_receipt_date_range' };

  return {
    ok: true,
    filters: {
      page,
      pageSize,
      sort,
      supplierId: query.supplierId ? normalizeString(query.supplierId) : null,
      locationId: query.locationId ? normalizeString(query.locationId) : null,
      dateFrom: dateFrom ? `${dateFrom}T00:00:00.000Z` : null,
      dateTo: dateTo ? `${dateTo}T23:59:59.999Z` : null
    }
  };
}

function normalizeReceiptDraft(payload = {}) {
  const items = Array.isArray(payload.items)
    ? payload.items.map((rawItem, index) => {
        const quantity = normalizeDecimal(rawItem && rawItem.quantity);
        const unitCost = normalizeDecimal(rawItem && rawItem.unitCost);
        return {
          originalIndex: index,
          productId: normalizeString(rawItem && rawItem.productId),
          quantity,
          unitCost,
          lotNumber: normalizeNullableString(rawItem && rawItem.lotNumber),
          normalizedLotNumber: normalizeLotNumber(rawItem && rawItem.lotNumber),
          expiresAt: normalizeDateOnly(rawItem && rawItem.expiresAt),
          rejectedOperationalFields: [
            rawItem && Object.prototype.hasOwnProperty.call(rawItem, 'inventoryLotId') ? 'inventoryLotId' : null,
            rawItem && Object.prototype.hasOwnProperty.call(rawItem, 'inventoryMovementId') ? 'inventoryMovementId' : null,
            rawItem && Object.prototype.hasOwnProperty.call(rawItem, 'tenantId') ? 'tenantId' : null,
            rawItem && Object.prototype.hasOwnProperty.call(rawItem, 'createdBy') ? 'createdBy' : null,
            rawItem && Object.prototype.hasOwnProperty.call(rawItem, 'metadata') ? 'metadata' : null
          ].filter(Boolean)
        };
      })
    : null;

  return {
    supplierId: normalizeString(payload.supplierId),
    locationId: normalizeString(payload.locationId),
    documentNumber: normalizeNullableString(payload.documentNumber),
    receivedAt: normalizeTimestamp(payload.receivedAt),
    notes: normalizeNullableString(payload.notes),
    idempotencyKey: normalizeString(payload.idempotencyKey),
    items
  };
}

function validateReceiptDraft(draft) {
  if (!draft.supplierId) return 'missing_supplier_id';
  if (!isUuid(draft.supplierId)) return 'invalid_supplier_id';
  if (!draft.locationId) return 'missing_inventory_location_id';
  if (!isUuid(draft.locationId)) return 'invalid_inventory_location_id';
  if (!draft.idempotencyKey) return 'missing_purchase_receipt_idempotency_key';
  if (!draft.receivedAt) return 'missing_purchase_receipt_received_at';
  if (draft.receivedAt === '__invalid__') return 'invalid_purchase_receipt_received_at';
  if (!Array.isArray(draft.items) || draft.items.length === 0) return 'missing_purchase_receipt_items';

  for (const item of draft.items) {
    if (item.rejectedOperationalFields.length > 0) return 'invalid_purchase_receipt_item_operational_fields';
    if (!item.productId) return 'missing_product_id';
    if (!isUuid(item.productId)) return 'invalid_product_id';
    if (!Number.isFinite(item.quantity.value) || item.quantity.value <= 0) return 'invalid_purchase_receipt_quantity';
    if (item.quantity.scale !== null && item.quantity.scale > 3) return 'invalid_purchase_receipt_quantity';
    if (item.unitCost.value !== null && (!Number.isFinite(item.unitCost.value) || item.unitCost.value < 0)) {
      return 'invalid_purchase_receipt_unit_cost';
    }
    if (item.unitCost.scale !== null && item.unitCost.scale > 4) return 'invalid_purchase_receipt_unit_cost';
    if (item.expiresAt === '__invalid__') return 'invalid_purchase_receipt_expires_at';
  }
  return null;
}

function buildCanonicalReceiptItems(items) {
  return items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity.value.toFixed(3),
    unitCost: item.unitCost.value === null ? null : item.unitCost.value.toFixed(4),
    lotNumber: item.lotNumber,
    normalizedLotNumber: item.normalizedLotNumber,
    expiresAt: item.expiresAt
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function buildLineFingerprint(item) {
  const hash = crypto.createHash('sha1');
  hash.update(JSON.stringify({
    productId: item.productId,
    quantity: item.quantity.value.toFixed(3),
    unitCost: item.unitCost.value === null ? null : item.unitCost.value.toFixed(4),
    normalizedLotNumber: item.normalizedLotNumber,
    expiresAt: item.expiresAt
  }));
  return hash.digest('hex').slice(0, 32);
}

function buildDuplicateKey(item, product) {
  if (product.inventoryTrackingMode === 'lot_based') {
    return `lot:${item.productId}:${item.normalizedLotNumber || ''}:${item.expiresAt || ''}`;
  }
  return `legacy:${item.productId}`;
}

function buildPayloadSignatureSource(draft, normalizedItems) {
  return {
    supplierId: draft.supplierId,
    locationId: draft.locationId,
    documentNumber: draft.documentNumber,
    receivedAt: draft.receivedAt,
    notes: draft.notes,
    items: buildCanonicalReceiptItems(normalizedItems)
  };
}

async function listPortalPurchaseReceipts(tenantId, query = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const normalizedFilters = normalizeListFilters(query);
  if (!normalizedFilters.ok) {
    return { ok: false, tenantId: context.tenantId, reason: normalizedFilters.reason };
  }

  const result = await listReceiptsByTenant(context.clinic.id, normalizedFilters.filters);
  return {
    ok: true,
    tenantId: context.tenantId,
    items: result.items,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total
  };
}

async function getPortalPurchaseReceiptDetail(tenantId, receiptId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const safeReceiptId = normalizeString(receiptId);
  if (!safeReceiptId) return { ok: false, tenantId: context.tenantId, reason: 'missing_purchase_receipt_id' };
  if (!isUuid(safeReceiptId)) return { ok: false, tenantId: context.tenantId, reason: 'invalid_purchase_receipt_id' };

  const receipt = await findReceiptDetailByTenantAndId(context.clinic.id, safeReceiptId);
  if (!receipt) return { ok: false, tenantId: context.tenantId, reason: 'purchase_receipt_not_found' };

  return {
    ok: true,
    tenantId: context.tenantId,
    receipt: mapReceiptDetailPublic(receipt)
  };
}

async function createPortalPurchaseReceipt(tenantId, payload = {}, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const draft = normalizeReceiptDraft(payload);
  const draftReason = validateReceiptDraft(draft);
  if (draftReason) return { ok: false, tenantId: context.tenantId, reason: draftReason };

  const actorId = resolveActorId(actor);

  const result = await withTransaction(async (client) => {
    const existing = await findByTenantAndIdempotencyKey(context.clinic.id, draft.idempotencyKey, client);
    if (existing) {
      const requestedSignature = buildPayloadSignature(buildPayloadSignatureSource(draft, draft.items));
      const persistedSignature = normalizeNullableString(existing.metadata && existing.metadata.payloadSignature);
      if (persistedSignature && persistedSignature !== requestedSignature) {
        return { ok: false, reason: 'purchase_receipt_idempotency_payload_mismatch' };
      }
      const receipt = await findReceiptDetailByTenantAndId(context.clinic.id, existing.id, client);
      return { ok: true, idempotent: true, receipt: mapReceiptDetailPublic(receipt) };
    }

    const supplier = await findSupplierById(draft.supplierId, context.clinic.id, client);
    if (!supplier) return { ok: false, reason: 'supplier_not_found' };
    if (supplier.status !== 'active') return { ok: false, reason: 'supplier_inactive' };

    const location = await findInventoryLocationById(draft.locationId, context.clinic.id, client);
    if (!location) return { ok: false, reason: 'inventory_location_not_found' };
    if (!location.active) return { ok: false, reason: 'inventory_location_inactive' };

    const products = await findProductsByIds(
      context.clinic.id,
      draft.items.map((item) => item.productId),
      client,
      { includeDeleted: true }
    );
    const productMap = new Map(products.map((product) => [product.id, product]));

    const normalizedItems = [];
    const seenKeys = new Set();
    const todayISO = new Date().toISOString().slice(0, 10);

    for (const item of draft.items) {
      const product = productMap.get(item.productId);
      if (!product) return { ok: false, reason: 'product_not_found' };
      if (product.deletedAt) return { ok: false, reason: 'product_deleted_cannot_receive_purchase_receipts' };

      if (product.inventoryTrackingMode === 'lot_based') {
        if (!item.normalizedLotNumber) return { ok: false, reason: 'purchase_receipt_lot_number_required' };
        if (item.expiresAt && item.expiresAt < todayISO) return { ok: false, reason: 'purchase_receipt_lot_expired' };
      } else {
        if (item.lotNumber || item.expiresAt) return { ok: false, reason: 'purchase_receipt_legacy_lot_not_allowed' };
        if (!Number.isInteger(item.quantity.value)) return { ok: false, reason: 'legacy_purchase_receipt_quantity_must_be_integer' };
      }

      const duplicateKey = buildDuplicateKey(item, product);
      if (seenKeys.has(duplicateKey)) return { ok: false, reason: 'duplicate_purchase_receipt_item' };
      seenKeys.add(duplicateKey);

      normalizedItems.push({
        ...item,
        product,
        lineFingerprint: buildLineFingerprint(item)
      });
    }

    const payloadSignature = buildPayloadSignature(buildPayloadSignatureSource(draft, normalizedItems));
    const receiptId = randomUUID();
    const insertedReceipt = await insertReceipt(
      {
        id: receiptId,
        tenantId: context.clinic.id,
        supplierId: draft.supplierId,
        locationId: draft.locationId,
        documentNumber: draft.documentNumber,
        receivedAt: draft.receivedAt,
        notes: draft.notes,
        idempotencyKey: draft.idempotencyKey,
        metadata: {
          payloadSignature,
          source: 'purchase_receipt',
          supplierDisplayName: supplier.displayName || supplier.legalName
        },
        createdBy: actorId,
        createdAt: draft.receivedAt,
        confirmedAt: draft.receivedAt
      },
      client
    );

    if (!insertedReceipt) {
      const conflicted = await findByTenantAndIdempotencyKey(context.clinic.id, draft.idempotencyKey, client);
      if (!conflicted) return { ok: false, reason: 'purchase_receipt_idempotency_conflict' };
      const persistedSignature = normalizeNullableString(conflicted.metadata && conflicted.metadata.payloadSignature);
      if (persistedSignature && persistedSignature !== payloadSignature) {
        return { ok: false, reason: 'purchase_receipt_idempotency_payload_mismatch' };
      }
      const receipt = await findReceiptDetailByTenantAndId(context.clinic.id, conflicted.id, client);
      return { ok: true, idempotent: true, receipt: mapReceiptDetailPublic(receipt) };
    }

    const productIds = [];
    let totalQuantity = 0;

    for (const item of normalizedItems) {
      const movementIdempotencyKey = `receipt:${receiptId}:item:${item.lineFingerprint}:movement`;
      const lotIdempotencyKey = `receipt:${receiptId}:item:${item.lineFingerprint}:lot`;
      let inventoryLotId = null;
      let inventoryMovementId = null;

      if (item.product.inventoryTrackingMode === 'lot_based') {
        const lotResult = await receiveInventoryLotWithClient(
          context,
          {
            productId: item.productId,
            quantity: item.quantity.value,
            initialQuantity: item.quantity.value,
            unitCost: item.unitCost.value,
            lotNumber: item.lotNumber,
            expiresAt: item.expiresAt,
            receivedAt: draft.receivedAt,
            locationId: location.id,
            supplierName: supplier.displayName || supplier.legalName,
            movementType: 'purchase_receipt',
            referenceType: 'purchase_receipt',
            referenceId: receiptId,
            reason: 'Recepcion de mercaderia',
            idempotencyKey: lotIdempotencyKey,
            movementIdempotencyKey,
            metadata: {
              source: 'purchase_receipt',
              purchaseReceiptId: receiptId,
              lineFingerprint: item.lineFingerprint
            }
          },
          actor,
          client,
          { product: item.product }
        );
        if (!lotResult.ok) throw createDomainError(lotResult.reason, lotResult.details);
        inventoryLotId = lotResult.lot.id;
        inventoryMovementId = lotResult.movement && lotResult.movement.id ? lotResult.movement.id : null;
      } else {
        const movementResult = await applyInventoryMovementWithClient(
          context.clinic.id,
          item.productId,
          {
            movementType: 'purchase_receipt',
            quantity: item.quantity.value,
            reason: 'Recepcion de mercaderia',
            referenceType: 'purchase_receipt',
            referenceId: receiptId,
            idempotencyKey: movementIdempotencyKey,
            metadata: {
              source: 'purchase_receipt',
              purchaseReceiptId: receiptId,
              lineFingerprint: item.lineFingerprint
            }
          },
          actor,
          client
        );
        if (!movementResult.ok) throw createDomainError(movementResult.reason, movementResult.details);
        inventoryMovementId = movementResult.movement.id;
      }

      await insertReceiptItem(
        {
          id: randomUUID(),
          receiptId,
          tenantId: context.clinic.id,
          productId: item.productId,
          quantity: item.quantity.value.toFixed(3),
          unitCost: item.unitCost.value === null ? null : item.unitCost.value.toFixed(4),
          lotNumber: item.lotNumber,
          normalizedLotNumber: item.normalizedLotNumber,
          expiresAt: item.expiresAt,
          inventoryLotId,
          inventoryMovementId,
          metadata: {
            lineFingerprint: item.lineFingerprint,
            inventoryTrackingMode: item.product.inventoryTrackingMode
          },
          createdAt: draft.receivedAt
        },
        client
      );

      totalQuantity += item.quantity.value;
      productIds.push(item.productId);
    }

    await createPortalUserAuditEvent(
      {
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId: actorId,
        action: 'purchase_receipt_confirmed',
        payload: {
          receiptId,
          supplierId: draft.supplierId,
          locationId: draft.locationId,
          itemCount: normalizedItems.length,
          productIds: Array.from(new Set(productIds)),
          totalQuantity: totalQuantity.toFixed(3),
          documentNumber: draft.documentNumber,
          receivedAt: draft.receivedAt,
          idempotent: false
        }
      },
      client
    );

    const receipt = await findReceiptDetailByTenantAndId(context.clinic.id, receiptId, client);
    return { ok: true, idempotent: false, receipt: mapReceiptDetailPublic(receipt) };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason, details: result.details || null };
  return {
    ok: true,
    tenantId: context.tenantId,
    idempotent: result.idempotent === true,
    receipt: result.receipt
  };
}

async function createPortalPurchaseReceiptSafe(tenantId, payload = {}, actor = {}) {
  try {
    return await createPortalPurchaseReceipt(tenantId, payload, actor);
  } catch (error) {
    if (error && error.isDomainError) {
      return { ok: false, tenantId, reason: error.reason, details: error.details || null };
    }
    throw error;
  }
}

module.exports = {
  listPortalPurchaseReceipts,
  getPortalPurchaseReceiptDetail,
  createPortalPurchaseReceipt: createPortalPurchaseReceiptSafe
};
