const crypto = require('crypto');
const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { getClinicInventorySettingsById, updateClinicInventorySettingsById } = require('../repositories/tenant.repository');
const { findProductById } = require('../repositories/products.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');
const {
  LOT_STATUSES,
  MOVEMENT_TYPES,
  listInventoryLots,
  getInventoryExpirationSummary,
  findInventoryLotById,
  findPhysicalInventoryLot,
  findConflictingInventoryLot,
  createInventoryLot,
  incrementInventoryLot,
  updateInventoryLotState,
  insertInventoryMovement,
  listInventoryMovementsForLot,
  listInventoryLotHistory,
  syncProductStockFromLots,
  setProductInventoryTrackingMode,
  listInventoryLocations,
  findInventoryLocationById,
  createInventoryLocation,
  updateInventoryLocation,
  getInventoryLocationUsageSummary
} = require('../repositories/inventory.repository');
const {
  findInventoryLotOperationByIdempotencyKey,
  createInventoryLotOperation,
  updateInventoryLotOperation
} = require('../repositories/inventory-lot-operations.repository');
const {
  DEFAULT_EXPIRATION_ALERT_THRESHOLDS,
  calculateInventoryExpirationStatus,
  getTenantTodayISO,
  normalizeExpirationAlertThresholds,
  resolveTenantTimezone
} = require('../utils/inventory-expiration');
const { normalizeLotNumber } = require('../utils/inventory-lot-identity');
const {
  deriveLotDisplayStatus,
  normalizeLotOperationalStatus,
  validateLotStateConsistency
} = require('../utils/inventory-lot-state');
const {
  isManualLotWriteoffReference,
  resolveLotAdjustmentSemantics
} = require('../utils/inventory-lot-writeoff');

const LOT_STATUS_SET = new Set(LOT_STATUSES);
const MOVEMENT_TYPE_SET = new Set(MOVEMENT_TYPES);
const INBOUND_TYPES = new Set(['initial_stock', 'purchase_receipt', 'manual_adjustment_in']);
const OUTBOUND_TYPES = new Set(['manual_adjustment_out', 'manual_decrease', 'expired_writeoff', 'cancellation']);
const LOCATION_TYPES = new Set(['main', 'warehouse', 'shelf', 'other']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeDateOnly(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '__invalid__';
}

function normalizeTimestamp(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '__invalid__';
}

function normalizeActorId(actor) {
  const actorId = normalizeString(actor && (actor.actorId || actor.id));
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)
    ? actorId
    : null;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolveInventorySettings(rawSettings) {
  const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings) ? rawSettings : {};
  const inventory = settings.inventory && typeof settings.inventory === 'object' && !Array.isArray(settings.inventory) ? settings.inventory : {};
  let thresholds = DEFAULT_EXPIRATION_ALERT_THRESHOLDS;
  try {
    thresholds = normalizeExpirationAlertThresholds(inventory.expirationAlertThresholds);
  } catch {
    thresholds = DEFAULT_EXPIRATION_ALERT_THRESHOLDS;
  }
  return { inventory, thresholds };
}

async function resolveInventoryRuntime(context) {
  const record = await getClinicInventorySettingsById(context.clinic.id);
  const settings = normalizeMetadata(record && record.settings);
  const timezone = resolveTenantTimezone({ ...context.clinic, settings });
  const { thresholds } = resolveInventorySettings(settings);
  const todayISO = getTenantTodayISO({ timezone });
  return { settings, timezone, thresholds, todayISO };
}

function resolveLotStatus(quantity, requestedStatus) {
  if (requestedStatus && LOT_STATUS_SET.has(requestedStatus)) return requestedStatus;
  return Number(quantity || 0) > 0 ? 'active' : 'depleted';
}

function buildLotPayload(payload, context, actor) {
  const initialQuantity = normalizeNumber(payload && (payload.initialQuantity ?? payload.quantity));
  const unitCost = payload && payload.unitCost !== undefined && payload.unitCost !== null && payload.unitCost !== ''
    ? normalizeNumber(payload.unitCost)
    : null;
  const receivedAt = normalizeTimestamp(payload && payload.receivedAt);
  const manufacturedAt = normalizeDateOnly(payload && payload.manufacturedAt);
  const expiresAt = normalizeDateOnly(payload && payload.expiresAt);
  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();
  return {
    tenantId: context.clinic.id,
    productId: normalizeString(payload && payload.productId),
    lotNumber: normalizeNullableString(payload && payload.lotNumber),
    normalizedLotNumber: normalizeLotNumber(payload && payload.lotNumber),
    supplierName: normalizeNullableString(payload && payload.supplierName),
    receivedAt,
    manufacturedAt,
    expiresAt,
    initialQuantity,
    availableQuantity: initialQuantity,
    unitCost,
    warehouseName: normalizeNullableString(payload && payload.warehouseName),
    locationName: normalizeNullableString(payload && payload.locationName),
    locationId: normalizeNullableString(payload && payload.locationId),
    status: resolveLotStatus(initialQuantity, requestedStatus),
    operationalStatus: normalizeString(payload && payload.operationalStatus).toLowerCase() === 'blocked' ? 'blocked' : 'active',
    notes: normalizeNullableString(payload && payload.notes),
    metadata: normalizeMetadata(payload && payload.metadata),
    createdBy: normalizeActorId(actor)
  };
}

function validateLotPayload(lot, options = {}) {
  if (!lot.productId) return 'missing_product_id';
  if (!lot.locationId) return 'missing_inventory_location_id';
  if (!Number.isFinite(lot.initialQuantity) || lot.initialQuantity <= 0) return 'invalid_lot_quantity';
  if (lot.unitCost !== null && (!Number.isFinite(lot.unitCost) || lot.unitCost < 0)) return 'invalid_lot_unit_cost';
  if (lot.receivedAt === '__invalid__') return 'invalid_lot_received_at';
  if (lot.manufacturedAt === '__invalid__') return 'invalid_lot_manufactured_at';
  if (lot.expiresAt === '__invalid__') return 'invalid_lot_expires_at';
  if (!LOT_STATUS_SET.has(lot.status)) return 'invalid_lot_status';
  if (!options.allowMissingLotNumber && !lot.normalizedLotNumber) return 'missing_lot_number';
  return null;
}

function resolveAdjustment(payload) {
  const movementType = normalizeString(payload && payload.movementType).toLowerCase() || 'manual_adjustment_out';
  const quantity = normalizeNumber(payload && payload.quantity);
  return {
    movementType,
    quantity,
    reason: normalizeNullableString(payload && payload.reason),
    referenceType: normalizeNullableString(payload && payload.referenceType),
    referenceId: normalizeNullableString(payload && payload.referenceId),
    metadata: normalizeMetadata(payload && payload.metadata),
    idempotencyKey: normalizeNullableString(payload && payload.idempotencyKey)
  };
}

function validateAdjustment(adjustment) {
  if (!MOVEMENT_TYPE_SET.has(adjustment.movementType)) return 'invalid_movement_type';
  if (!Number.isFinite(adjustment.quantity) || adjustment.quantity <= 0) return 'invalid_movement_quantity';
  if (adjustment.referenceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(adjustment.referenceId)) {
    return 'invalid_movement_reference_id';
  }
  if (!adjustment.idempotencyKey) return 'missing_inventory_lot_idempotency_key';
  return null;
}

function normalizeLocationCode(value) {
  return normalizeString(value).toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40) || null;
}

function buildLocationDraft(payload = {}) {
  const code = normalizeLocationCode(payload.code || payload.name);
  const type = normalizeString(payload.type).toLowerCase() || 'other';
  return {
    code,
    name: normalizeNullableString(payload.name),
    type: LOCATION_TYPES.has(type) ? type : 'other',
    active: payload.active !== false
  };
}

function buildStableIdempotencyKey(prefix, parts) {
  const hash = crypto.createHash('sha1');
  hash.update(prefix);
  for (const part of parts) {
    hash.update('|');
    hash.update(String(part || ''));
  }
  return `${prefix}:${hash.digest('hex').slice(0, 32)}`;
}

async function resolveInventoryContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  return context;
}

async function ensureLocationForTenant(tenantId, locationId, client = null) {
  const location = await findInventoryLocationById(locationId, tenantId, client);
  if (!location) return { ok: false, reason: 'inventory_location_not_found' };
  if (!location.active) return { ok: false, reason: 'inventory_location_inactive' };
  return { ok: true, location };
}

async function createInventoryAuditEvent(context, actor, action, payload, client) {
  await createPortalUserAuditEvent(
    {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      actorUserId: normalizeActorId(actor),
      action,
      payload
    },
    client
  );
}

async function completeOrReuseOperation(tenantId, operationType, idempotencyKey, client, onExisting) {
  const existing = await findInventoryLotOperationByIdempotencyKey(tenantId, operationType, idempotencyKey, client);
  if (existing) return onExisting(existing);
  return null;
}

function resolveInventoryLotReceiptIdempotencyKey(context, lotInput, payload = {}) {
  return normalizeNullableString(payload.idempotencyKey)
    || buildStableIdempotencyKey('inventory_lot_receipt', [
      context.clinic.id,
      lotInput.productId,
      lotInput.locationId,
      lotInput.normalizedLotNumber,
      lotInput.expiresAt,
      lotInput.initialQuantity
    ]);
}

async function beginInventoryLotOperation(input, client, onExisting) {
  const operation = await createInventoryLotOperation(input, client);
  if (!operation) {
    return { ok: false, reason: 'inventory_lot_operation_conflict' };
  }
  if (operation.wasCreated === false) {
    return onExisting(operation);
  }
  return { ok: true, operation };
}

function assertLotStateConsistency(lot) {
  return validateLotStateConsistency({
    status: lot.legacyStatus || lot.status,
    legacyStatus: lot.legacyStatus || lot.status,
    operationalStatus: lot.operationalStatus,
    availableQuantity: lot.availableQuantity,
    blockedAt: lot.blockedAt,
    blockedBy: lot.blockedBy,
    blockReason: lot.blockReason,
    writtenOffAt: lot.writtenOffAt,
    writtenOffBy: lot.writtenOffBy,
    writeoffReason: lot.writeoffReason
  });
}

async function listPortalInventoryLots(tenantId, filters = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const runtime = await resolveInventoryRuntime(context);
  const lots = await listInventoryLots(context.clinic.id, { ...filters, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lots, thresholds: runtime.thresholds, timezone: runtime.timezone };
}

async function getPortalInventoryLot(tenantId, lotId, options = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  const runtime = await resolveInventoryRuntime(context);
  const lot = await findInventoryLotById(safeLotId, context.clinic.id, null, { todayISO: runtime.todayISO, thresholds: runtime.thresholds });
  if (!lot) return { ok: false, tenantId: context.tenantId, reason: 'inventory_lot_not_found' };
  const movements = await listInventoryMovementsForLot(safeLotId, context.clinic.id, null, options);
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot, movements };
}

async function getPortalInventoryLotHistory(tenantId, lotId, options = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  const history = await listInventoryLotHistory(context.clinic.id, safeLotId, options);
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, history };
}

async function getPortalInventoryExpirationSummary(tenantId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const runtime = await resolveInventoryRuntime(context);
  const summary = await getInventoryExpirationSummary(context.clinic.id, {
    todayISO: runtime.todayISO,
    thresholds: runtime.thresholds
  });
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, summary, thresholds: runtime.thresholds, timezone: runtime.timezone, today: runtime.todayISO };
}

async function getPortalInventoryExpirationSettings(tenantId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const runtime = await resolveInventoryRuntime(context);
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, thresholds: runtime.thresholds, timezone: runtime.timezone, today: runtime.todayISO };
}

async function updatePortalInventoryExpirationSettings(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  let thresholds;
  try {
    thresholds = normalizeExpirationAlertThresholds(payload && payload.expirationAlertThresholds ? payload.expirationAlertThresholds : payload);
  } catch (error) {
    return { ok: false, tenantId: context.tenantId, reason: error.reason || 'invalid_expiration_alert_thresholds' };
  }
  const current = await getClinicInventorySettingsById(context.clinic.id);
  const settings = normalizeMetadata(current && current.settings);
  const inventory = normalizeMetadata(settings.inventory);
  const updated = await updateClinicInventorySettingsById(context.clinic.id, {
    ...inventory,
    expirationAlertThresholds: thresholds,
    expirationAlertThresholdsUpdatedAt: new Date().toISOString(),
    expirationAlertThresholdsUpdatedBy: normalizeActorId(actor)
  });
  const timezone = resolveTenantTimezone({ ...context.clinic, settings: normalizeMetadata(updated && updated.settings) });
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, thresholds, timezone, auditAction: 'inventory_expiration_settings_updated' };
}

async function receiveInventoryLotWithClient(context, payload, actor = {}, client, options = {}) {
  const lotInput = buildLotPayload(payload || {}, context, actor);
  const idempotencyKey = resolveInventoryLotReceiptIdempotencyKey(context, lotInput, payload);
  const reason = validateLotPayload(lotInput);
  if (reason) return { ok: false, reason };

  const product = options.product || await findProductById(lotInput.productId, context.clinic.id, client);
  if (!product) return { ok: false, reason: 'product_not_found' };
  if (product.deletedAt) return { ok: false, reason: 'product_deleted_cannot_receive_inventory_lots' };
  if (product.inventoryTrackingMode !== 'lot_based') return { ok: false, reason: 'inventory_lot_product_mode_required' };

  const runtime = options.runtime || await resolveInventoryRuntime(context);
  const movementIdempotencyKey = normalizeNullableString(payload && payload.movementIdempotencyKey) || idempotencyKey;
  const locationResult = await ensureLocationForTenant(context.clinic.id, lotInput.locationId, client);
  if (!locationResult.ok) return locationResult;

  const operationStart = await beginInventoryLotOperation(
    {
      tenantId: context.clinic.id,
      productId: lotInput.productId,
      operationType: 'create_lot',
      idempotencyKey,
      requestMetadata: {
        locationId: lotInput.locationId,
        lotNumber: lotInput.lotNumber,
        normalizedLotNumber: lotInput.normalizedLotNumber,
        expiresAt: lotInput.expiresAt,
        quantity: lotInput.initialQuantity
      },
      createdBy: lotInput.createdBy
    },
    client,
    async (existing) => {
      if (existing.lotId) {
        const lot = await findInventoryLotById(existing.lotId, context.clinic.id, client, {
          todayISO: runtime.todayISO,
          thresholds: runtime.thresholds
        });
        return { ok: true, idempotent: true, lot, movement: null };
      }
      return { ok: false, reason: existing.failureCode || 'inventory_lot_operation_conflict' };
    }
  );
  if (!operationStart.ok || operationStart.idempotent === true || operationStart.reason) return operationStart;
  const operation = operationStart.operation;

  const exact = await findPhysicalInventoryLot(
    {
      tenantId: context.clinic.id,
      productId: lotInput.productId,
      locationId: lotInput.locationId,
      lotNumber: lotInput.lotNumber,
      expiresAt: lotInput.expiresAt
    },
    client,
    { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds }
  );

  let lot = exact;
  const conflicting = exact
    ? null
    : await findConflictingInventoryLot(
        {
          tenantId: context.clinic.id,
          productId: lotInput.productId,
          locationId: lotInput.locationId,
          lotNumber: lotInput.lotNumber
        },
        client,
        { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds }
      );

  if (conflicting && normalizeDateOnly(conflicting.expiresAt) !== lotInput.expiresAt) {
    await updateInventoryLotOperation(
      operation.id,
      context.clinic.id,
      { status: 'failed', failureCode: 'inventory_lot_conflict_requires_new_physical_lot' },
      client
    );
    return { ok: false, reason: 'inventory_lot_conflict_requires_new_physical_lot' };
  }

  let movement;
  if (lot) {
    const previous = Number(lot.availableQuantity || 0);
    lot = await incrementInventoryLot(lot.id, context.clinic.id, { incrementQuantity: lotInput.initialQuantity }, client);
    movement = await insertInventoryMovement(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        locationId: lot.locationId,
        movementType: 'purchase_receipt',
        quantity: lotInput.initialQuantity,
        quantityBefore: previous,
        quantityAfter: Number(lot.availableQuantity || 0),
        referenceType: normalizeNullableString(payload && payload.referenceType),
        referenceId: normalizeNullableString(payload && payload.referenceId),
        reason: normalizeNullableString(payload && payload.reason) || 'Ingreso de lote',
        metadata: {
          ...lot.metadata,
          auditAction: 'inventory_lot_incremented',
          source: 'inventory_lot_create',
          idempotencyKey
        },
        createdBy: lotInput.createdBy,
        idempotencyKey: movementIdempotencyKey
      },
      client
    );
    await updateInventoryLotOperation(
      operation.id,
      context.clinic.id,
      { lotId: lot.id, status: 'completed', result: { mode: 'incremented', lotId: lot.id, movementId: movement.id } },
      client
    );
  } else {
    lot = await createInventoryLot(lotInput, client);
    movement = await insertInventoryMovement(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        locationId: lot.locationId,
        movementType: MOVEMENT_TYPE_SET.has(normalizeString(payload && payload.movementType).toLowerCase())
          ? normalizeString(payload.movementType).toLowerCase()
          : 'purchase_receipt',
        quantity: lot.initialQuantity,
        quantityBefore: 0,
        quantityAfter: lot.availableQuantity,
        referenceType: normalizeNullableString(payload && payload.referenceType),
        referenceId: normalizeNullableString(payload && payload.referenceId),
        reason: normalizeNullableString(payload && payload.reason) || 'Ingreso de lote',
        metadata: {
          ...lot.metadata,
          auditAction: 'inventory_lot_created',
          source: 'inventory_lot_create',
          idempotencyKey
        },
        createdBy: lot.createdBy,
        idempotencyKey: movementIdempotencyKey
      },
      client
    );
    await updateInventoryLotOperation(
      operation.id,
      context.clinic.id,
      { lotId: lot.id, status: 'completed', result: { mode: 'created', lotId: lot.id, movementId: movement.id } },
      client
    );
  }

  await syncProductStockFromLots(lot.productId, context.clinic.id, client, { todayISO: runtime.todayISO });
  if (options.skipAudit !== true) {
    await createInventoryAuditEvent(
      context,
      actor,
      'inventory_lot_receipt_created',
      {
        productId: lot.productId,
        lotId: lot.id,
        locationId: lot.locationId,
        quantity: lotInput.initialQuantity,
        idempotencyKey
      },
      client
    );
  }
  return { ok: true, idempotent: false, lot, movement };
}

async function createPortalInventoryLot(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const lotInput = buildLotPayload(payload || {}, context, actor);
  const reason = validateLotPayload(lotInput);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };

  const product = await findProductById(lotInput.productId, context.clinic.id);
  if (!product) return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
  if (product.deletedAt) return { ok: false, tenantId: context.tenantId, reason: 'product_deleted_cannot_receive_inventory_lots' };
  if (product.inventoryTrackingMode !== 'lot_based') return { ok: false, tenantId: context.tenantId, reason: 'inventory_lot_product_mode_required' };

  const runtime = await resolveInventoryRuntime(context);
  const created = await withTransaction(async (client) => {
    return receiveInventoryLotWithClient(context, payload, actor, client, { runtime, product });
  });

  if (!created.ok) return { ok: false, tenantId: context.tenantId, reason: created.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, idempotent: created.idempotent, lot: created.lot };
}

async function adjustPortalInventoryLot(tenantId, lotId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  const adjustment = resolveAdjustment(payload || {});
  const reason = validateAdjustment(adjustment);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };
  const runtime = await resolveInventoryRuntime(context);
  const semantics = resolveLotAdjustmentSemantics(adjustment);
  if (isManualLotWriteoffReference(adjustment.referenceType) && !semantics.isManualWriteoff) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_movement_type' };
  }

  const result = await withTransaction(async (client) => {
    const lot = await findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
    if (!lot) return { ok: false, reason: 'inventory_lot_not_found' };
    if (lot.status === 'cancelled') return { ok: false, reason: 'inventory_lot_cancelled' };
    if (normalizeLotOperationalStatus(lot) === 'written_off') return { ok: false, reason: 'inventory_lot_written_off' };
    const consistencyError = assertLotStateConsistency(lot);
    if (consistencyError) return { ok: false, reason: consistencyError };
    const expiration = calculateInventoryExpirationStatus(lot.expiresAt, { todayISO: runtime.todayISO, thresholds: runtime.thresholds });
    if (semantics.isExpiredWriteoff && expiration.status !== 'expired') return { ok: false, reason: 'inventory_lot_not_expired' };

    const operationStart = await beginInventoryLotOperation(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        operationType: semantics.operationType,
        idempotencyKey: adjustment.idempotencyKey,
        requestMetadata: {
          movementType: adjustment.movementType,
          quantity: adjustment.quantity,
          reason: adjustment.reason,
          referenceType: adjustment.referenceType,
          writeoffKind: semantics.writeoffKind
        },
        createdBy: normalizeActorId(actor)
      },
      client,
      async (operation) => {
        const currentLot = operation.lotId ? await findInventoryLotById(operation.lotId, context.clinic.id, client, { todayISO: runtime.todayISO, thresholds: runtime.thresholds }) : null;
        return { ok: true, idempotent: true, lot: currentLot, movement: null };
      }
    );
    if (!operationStart.ok || operationStart.idempotent === true || operationStart.reason) return operationStart;
    const operation = operationStart.operation;

    const before = Number(lot.availableQuantity || 0);
    const committedQuantity = Number(lot.committedQuantity || 0);
    const freePhysicalQuantity = Math.max(0, before - committedQuantity);
    const direction = INBOUND_TYPES.has(adjustment.movementType) ? 1 : OUTBOUND_TYPES.has(adjustment.movementType) ? -1 : 0;
    const after = before + direction * adjustment.quantity;
    if (direction === 0) return { ok: false, reason: 'invalid_movement_type' };
    if (after < 0) return { ok: false, reason: 'insufficient_lot_quantity' };
    if (semantics.isWriteoff && adjustment.quantity > freePhysicalQuantity) {
      await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'failed', failureCode: 'inventory_lot_writeoff_conflicts_with_committed_stock' }, client);
      return { ok: false, reason: 'inventory_lot_writeoff_conflicts_with_committed_stock' };
    }

    const nextStatus =
      adjustment.movementType === 'cancellation'
        ? 'cancelled'
        : after > 0
          ? 'active'
          : 'depleted';
    const previousOperationalStatus = normalizeLotOperationalStatus(lot);
    const completedWriteoff = semantics.isWriteoff && after === 0;
    const nextOperationalStatus = completedWriteoff
      ? 'written_off'
      : previousOperationalStatus === 'blocked'
        ? 'blocked'
        : 'active';

    const updatedLot = await updateInventoryLotState(
      safeLotId,
      context.clinic.id,
      {
        availableQuantity: after,
        status: nextStatus,
        operationalStatus: nextOperationalStatus === 'cancelled' ? null : nextOperationalStatus,
        metadata: {
          ...lot.metadata,
          lastMovementType: adjustment.movementType,
          lastMovementAt: new Date().toISOString()
        },
        writtenOffAt: completedWriteoff ? new Date().toISOString() : lot.writtenOffAt,
        writtenOffBy: completedWriteoff ? normalizeActorId(actor) : lot.writtenOffBy,
        writeoffReason: completedWriteoff ? adjustment.reason : lot.writeoffReason
      },
      client
    );
    const movement = await insertInventoryMovement(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        locationId: lot.locationId,
        movementType: adjustment.movementType,
        quantity: adjustment.quantity,
        quantityBefore: before,
        quantityAfter: after,
        referenceType: adjustment.referenceType,
        referenceId: adjustment.referenceId,
        reason: adjustment.reason,
        metadata: {
          ...adjustment.metadata,
          auditAction: semantics.auditAction,
          writeoffKind: semantics.writeoffKind
        },
        createdBy: normalizeActorId(actor),
        idempotencyKey: adjustment.idempotencyKey
      },
      client
    );
    await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'completed', result: { lotId: updatedLot.id, movementId: movement.id } }, client);
    await syncProductStockFromLots(lot.productId, context.clinic.id, client, { todayISO: runtime.todayISO });
    return { ok: true, lot: updatedLot, movement };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, idempotent: result.idempotent === true, lot: result.lot, movement: result.movement };
}

async function bulkWriteoffExpiredPortalInventoryLots(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const lotIds = Array.isArray(payload && payload.lotIds) ? payload.lotIds.map((value) => normalizeString(value)).filter(Boolean) : [];
  if (!lotIds.length) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_ids' };
  if (lotIds.length > 100) return { ok: false, tenantId: context.tenantId, reason: 'too_many_lots' };
  const runtime = await resolveInventoryRuntime(context);
  const reason = normalizeNullableString(payload && payload.reason) || 'Producto vencido';
  const notes = normalizeNullableString(payload && payload.notes);

  const result = await withTransaction(async (client) => {
    const writtenOff = [];
    for (const lotId of lotIds) {
      const lot = await findInventoryLotById(lotId, context.clinic.id, client, { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
      if (!lot) return { ok: false, reason: 'inventory_lot_not_found', lotId };
      const expiration = calculateInventoryExpirationStatus(lot.expiresAt, { todayISO: runtime.todayISO, thresholds: runtime.thresholds });
      const before = Number(lot.availableQuantity || 0);
      const committedQuantity = Number(lot.committedQuantity || 0);
      if (expiration.status !== 'expired') return { ok: false, reason: 'inventory_lot_not_expired', lotId };
      if (before <= 0) return { ok: false, reason: 'inventory_lot_without_stock', lotId };
      if (['cancelled', 'depleted', 'blocked', 'written_off'].includes(deriveLotDisplayStatus(lot))) return { ok: false, reason: 'inventory_lot_not_writeoff_eligible', lotId };
      if (committedQuantity > 0) return { ok: false, reason: 'inventory_lot_writeoff_conflicts_with_committed_stock', lotId };

      const idempotencyKey = buildStableIdempotencyKey('inventory_expired_bulk_writeoff', [context.clinic.id, lot.id, before]);
      const existing = await findInventoryLotOperationByIdempotencyKey(context.clinic.id, 'writeoff', idempotencyKey, client);
      if (existing && existing.lotId) {
        writtenOff.push({ lot: await findInventoryLotById(existing.lotId, context.clinic.id, client, { todayISO: runtime.todayISO, thresholds: runtime.thresholds }), movement: null });
        continue;
      }

      const operation = await createInventoryLotOperation({
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        operationType: 'writeoff',
        idempotencyKey,
        requestMetadata: { bulk: true, reason, before },
        createdBy: normalizeActorId(actor)
      }, client);

      const updatedLot = await updateInventoryLotState(
        lot.id,
        context.clinic.id,
        {
          availableQuantity: 0,
          status: 'depleted',
          operationalStatus: 'written_off',
          metadata: { ...lot.metadata, lastMovementType: 'expired_writeoff', lastMovementAt: new Date().toISOString() },
          writtenOffAt: new Date().toISOString(),
          writtenOffBy: normalizeActorId(actor),
          writeoffReason: reason
        },
        client
      );
      const movement = await insertInventoryMovement(
        {
          tenantId: context.clinic.id,
          productId: lot.productId,
          lotId: lot.id,
          locationId: lot.locationId,
          movementType: 'expired_writeoff',
          quantity: before,
          quantityBefore: before,
          quantityAfter: 0,
          referenceType: 'inventory_expiration_bulk_writeoff',
          referenceId: null,
          reason,
          metadata: { notes, auditAction: 'inventory_expired_bulk_writeoff', expirationStatus: expiration.status, before, after: 0 },
          createdBy: normalizeActorId(actor),
          idempotencyKey
        },
        client
      );
      await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'completed', result: { lotId: updatedLot.id, movementId: movement.id } }, client);
      await syncProductStockFromLots(lot.productId, context.clinic.id, client, { todayISO: runtime.todayISO });
      writtenOff.push({ lot: updatedLot, movement });
    }
    return { ok: true, writtenOff };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason, lotId: result.lotId || null };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, writtenOff: result.writtenOff };
}

async function setPortalProductInventoryMode(tenantId, productId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeProductId = normalizeString(productId);
  const mode = normalizeString(payload && payload.mode).toLowerCase();
  if (!safeProductId) return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  if (!['legacy', 'lot_based'].includes(mode)) return { ok: false, tenantId: context.tenantId, reason: 'invalid_inventory_tracking_mode' };
  const product = await findProductById(safeProductId, context.clinic.id);
  if (!product) return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };

  const updated = await withTransaction(async (client) => {
    if (mode === 'lot_based' && Number(product.stock || 0) > 0) {
      return { ok: false, reason: 'inventory_lot_conversion_required' };
    }
    await setProductInventoryTrackingMode(safeProductId, context.clinic.id, mode, client);
    if (mode === 'lot_based') {
      await syncProductStockFromLots(safeProductId, context.clinic.id, client);
    }
    await createInventoryAuditEvent(context, actor, 'inventory_product_mode_updated', {
      productId: safeProductId,
      previousMode: product.inventoryTrackingMode || 'legacy',
      nextMode: mode
    }, client);
    return findProductById(safeProductId, context.clinic.id, client);
  });
  if (!updated.ok && updated.reason) return { ok: false, tenantId: context.tenantId, reason: updated.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, product: updated };
}

async function listPortalInventoryLocations(tenantId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const locations = await listInventoryLocations(context.clinic.id);
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, locations };
}

async function createPortalInventoryLocation(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const draft = buildLocationDraft(payload);
  if (!draft.code || !draft.name) return { ok: false, tenantId: context.tenantId, reason: 'invalid_inventory_location' };

  const location = await withTransaction(async (client) => {
    const created = await createInventoryLocation({ tenantId: context.clinic.id, ...draft }, client);
    await createInventoryAuditEvent(context, actor, 'inventory_location_created', { locationId: created.id, code: created.code }, client);
    return created;
  });
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, location };
}

async function updatePortalInventoryLocation(tenantId, locationId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLocationId = normalizeString(locationId);
  if (!safeLocationId) return { ok: false, tenantId: context.tenantId, reason: 'missing_inventory_location_id' };
  const draft = buildLocationDraft(payload);

  const updated = await withTransaction(async (client) => {
    const current = await findInventoryLocationById(safeLocationId, context.clinic.id, client);
    if (!current) return { ok: false, reason: 'inventory_location_not_found' };
    if (current.isPrimary && payload && payload.active === false) return { ok: false, reason: 'inventory_location_primary_cannot_deactivate' };
    if (payload && payload.active === false) {
      const usage = await getInventoryLocationUsageSummary(safeLocationId, context.clinic.id, client);
      if (usage.activeLots > 0 || usage.activeBalances > 0) return { ok: false, reason: 'inventory_location_in_use' };
    }
    const location = await updateInventoryLocation(
      safeLocationId,
      context.clinic.id,
      {
        code: draft.code,
        name: draft.name,
        active: payload && Object.prototype.hasOwnProperty.call(payload, 'active') ? payload.active === true : undefined,
        metadata: { ...current.metadata, type: draft.type }
      },
      client
    );
    await createInventoryAuditEvent(context, actor, 'inventory_location_updated', { locationId: safeLocationId, active: location.active }, client);
    return { ok: true, location };
  });

  if (!updated.ok) return { ok: false, tenantId: context.tenantId, reason: updated.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, location: updated.location };
}

async function blockPortalInventoryLot(tenantId, lotId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  const reason = normalizeNullableString(payload && payload.reason);
  const idempotencyKey = normalizeNullableString(payload && payload.idempotencyKey);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  if (!reason) return { ok: false, tenantId: context.tenantId, reason: 'missing_block_reason' };
  if (!idempotencyKey) return { ok: false, tenantId: context.tenantId, reason: 'missing_inventory_lot_idempotency_key' };
  const runtime = await resolveInventoryRuntime(context);

  const result = await withTransaction(async (client) => {
    const lot = await findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
    if (!lot) return { ok: false, reason: 'inventory_lot_not_found' };
    if (lot.status === 'cancelled') return { ok: false, reason: 'inventory_lot_cancelled' };
    if (deriveLotDisplayStatus(lot) === 'written_off') return { ok: false, reason: 'inventory_lot_written_off' };
    if (Number(lot.availableQuantity || 0) <= 0) return { ok: false, reason: 'inventory_lot_depleted_cannot_block' };
    const operationStart = await beginInventoryLotOperation(
      { tenantId: context.clinic.id, productId: lot.productId, lotId: lot.id, operationType: 'block', idempotencyKey, requestMetadata: { reason }, createdBy: normalizeActorId(actor) },
      client,
      async (operation) => ({
        ok: true,
        idempotent: true,
        lot: operation.lotId ? await findInventoryLotById(operation.lotId, context.clinic.id, client, { todayISO: runtime.todayISO, thresholds: runtime.thresholds }) : null
      })
    );
    if (!operationStart.ok || operationStart.idempotent === true || operationStart.reason) return operationStart;
    const operation = operationStart.operation;
    const updatedLot = await updateInventoryLotState(lot.id, context.clinic.id, {
      operationalStatus: 'blocked',
      blockedAt: new Date().toISOString(),
      blockedBy: normalizeActorId(actor),
      blockReason: reason
    }, client);
    await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'completed', result: { lotId: updatedLot.id, reason } }, client);
    await syncProductStockFromLots(lot.productId, context.clinic.id, client, { todayISO: runtime.todayISO });
    await createInventoryAuditEvent(context, actor, 'inventory_lot_blocked', { lotId: lot.id, reason, idempotencyKey }, client);
    return { ok: true, lot: updatedLot };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot: result.lot, idempotent: result.idempotent === true };
}

async function unblockPortalInventoryLot(tenantId, lotId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  const reason = normalizeNullableString(payload && payload.reason);
  const idempotencyKey = normalizeNullableString(payload && payload.idempotencyKey);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  if (!reason) return { ok: false, tenantId: context.tenantId, reason: 'missing_unblock_reason' };
  if (!idempotencyKey) return { ok: false, tenantId: context.tenantId, reason: 'missing_inventory_lot_idempotency_key' };
  const runtime = await resolveInventoryRuntime(context);

  const result = await withTransaction(async (client) => {
    const lot = await findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
    if (!lot) return { ok: false, reason: 'inventory_lot_not_found' };
    if (lot.status === 'cancelled') return { ok: false, reason: 'inventory_lot_cancelled' };
    if (deriveLotDisplayStatus(lot) === 'written_off') return { ok: false, reason: 'inventory_lot_written_off' };
    if (Number(lot.availableQuantity || 0) <= 0) return { ok: false, reason: 'inventory_lot_depleted_cannot_unblock' };
    const operationStart = await beginInventoryLotOperation(
      { tenantId: context.clinic.id, productId: lot.productId, lotId: lot.id, operationType: 'unblock', idempotencyKey, requestMetadata: { reason }, createdBy: normalizeActorId(actor) },
      client,
      async (operation) => ({
        ok: true,
        idempotent: true,
        lot: operation.lotId ? await findInventoryLotById(operation.lotId, context.clinic.id, client, { todayISO: runtime.todayISO, thresholds: runtime.thresholds }) : null
      })
    );
    if (!operationStart.ok || operationStart.idempotent === true || operationStart.reason) return operationStart;
    const operation = operationStart.operation;
    const updatedLot = await updateInventoryLotState(lot.id, context.clinic.id, {
      operationalStatus: 'active',
      clearBlock: true
    }, client);
    await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'completed', result: { lotId: updatedLot.id, reason } }, client);
    await syncProductStockFromLots(lot.productId, context.clinic.id, client, { todayISO: runtime.todayISO });
    await createInventoryAuditEvent(context, actor, 'inventory_lot_unblocked', { lotId: lot.id, reason, idempotencyKey }, client);
    return { ok: true, lot: updatedLot };
  });
  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot: result.lot, idempotent: result.idempotent === true };
}

async function updatePortalInventoryLotExpiration(tenantId, lotId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  const newExpirationDate = normalizeDateOnly(payload && payload.expiresAt);
  const reason = normalizeNullableString(payload && payload.reason);
  const idempotencyKey = normalizeNullableString(payload && payload.idempotencyKey);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };
  if (newExpirationDate === '__invalid__') return { ok: false, tenantId: context.tenantId, reason: 'invalid_lot_expires_at' };
  if (!reason) return { ok: false, tenantId: context.tenantId, reason: 'missing_expiration_change_reason' };
  if (!idempotencyKey) return { ok: false, tenantId: context.tenantId, reason: 'missing_inventory_lot_idempotency_key' };
  const runtime = await resolveInventoryRuntime(context);

  const result = await withTransaction(async (client) => {
    const lot = await findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
    if (!lot) return { ok: false, reason: 'inventory_lot_not_found' };
    const operationStart = await beginInventoryLotOperation(
      { tenantId: context.clinic.id, productId: lot.productId, lotId: lot.id, operationType: 'change_expiration', idempotencyKey, requestMetadata: { previousExpirationDate: lot.expiresAt, newExpirationDate, reason }, createdBy: normalizeActorId(actor) },
      client,
      async (operation) => ({
        ok: true,
        idempotent: true,
        lot: operation.lotId ? await findInventoryLotById(operation.lotId, context.clinic.id, client, { todayISO: runtime.todayISO, thresholds: runtime.thresholds }) : null
      })
    );
    if (!operationStart.ok || operationStart.idempotent === true || operationStart.reason) return operationStart;
    const operation = operationStart.operation;
    const updatedLot = await updateInventoryLotState(lot.id, context.clinic.id, {
      expiresAt: newExpirationDate,
      clearExpiresAt: newExpirationDate === null,
      metadata: { ...lot.metadata, previousExpirationDate: lot.expiresAt, expirationChangedAt: new Date().toISOString(), expirationChangeReason: reason }
    }, client);
    await updateInventoryLotOperation(operation.id, context.clinic.id, { status: 'completed', result: { lotId: updatedLot.id, previousExpirationDate: lot.expiresAt, newExpirationDate } }, client);
    await createInventoryAuditEvent(context, actor, 'inventory_lot_expiration_changed', { lotId: lot.id, previousExpirationDate: lot.expiresAt, newExpirationDate, reason, idempotencyKey }, client);
    return { ok: true, lot: updatedLot };
  });
  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot: result.lot, idempotent: result.idempotent === true };
}

module.exports = {
  listPortalInventoryLots,
  getPortalInventoryLot,
  getPortalInventoryLotHistory,
  getPortalInventoryExpirationSummary,
  getPortalInventoryExpirationSettings,
  updatePortalInventoryExpirationSettings,
  createPortalInventoryLot,
  adjustPortalInventoryLot,
  bulkWriteoffExpiredPortalInventoryLots,
  setPortalProductInventoryMode,
  listPortalInventoryLocations,
  createPortalInventoryLocation,
  updatePortalInventoryLocation,
  blockPortalInventoryLot,
  unblockPortalInventoryLot,
  updatePortalInventoryLotExpiration,
  receiveInventoryLotWithClient
};
