const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { getClinicInventorySettingsById, updateClinicInventorySettingsById } = require('../repositories/tenant.repository');
const { findProductById } = require('../repositories/products.repository');
const {
  LOT_STATUSES,
  MOVEMENT_TYPES,
  listInventoryLots,
  getInventoryExpirationSummary,
  findInventoryLotById,
  createInventoryLot,
  updateInventoryLotState,
  insertInventoryMovement,
  listInventoryMovementsForLot,
  syncProductStockFromLots,
  setProductInventoryTrackingMode
} = require('../repositories/inventory.repository');
const {
  DEFAULT_EXPIRATION_ALERT_THRESHOLDS,
  calculateInventoryExpirationStatus,
  getTenantTodayISO,
  normalizeExpirationAlertThresholds,
  resolveTenantTimezone
} = require('../utils/inventory-expiration');

const LOT_STATUS_SET = new Set(LOT_STATUSES);
const MOVEMENT_TYPE_SET = new Set(MOVEMENT_TYPES);
const INBOUND_TYPES = new Set(['initial_stock', 'purchase_receipt', 'manual_adjustment_in']);
const OUTBOUND_TYPES = new Set(['manual_adjustment_out', 'expired_writeoff', 'cancellation']);

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
    supplierName: normalizeNullableString(payload && payload.supplierName),
    receivedAt,
    manufacturedAt,
    expiresAt,
    initialQuantity,
    availableQuantity: initialQuantity,
    unitCost,
    warehouseName: normalizeNullableString(payload && payload.warehouseName),
    locationName: normalizeNullableString(payload && payload.locationName),
    status: resolveLotStatus(initialQuantity, requestedStatus),
    notes: normalizeNullableString(payload && payload.notes),
    metadata: normalizeMetadata(payload && payload.metadata),
    createdBy: normalizeActorId(actor)
  };
}

function validateLotPayload(lot) {
  if (!lot.productId) return 'missing_product_id';
  if (!Number.isFinite(lot.initialQuantity) || lot.initialQuantity < 0) return 'invalid_lot_quantity';
  if (lot.unitCost !== null && (!Number.isFinite(lot.unitCost) || lot.unitCost < 0)) return 'invalid_lot_unit_cost';
  if (lot.receivedAt === '__invalid__') return 'invalid_lot_received_at';
  if (lot.manufacturedAt === '__invalid__') return 'invalid_lot_manufactured_at';
  if (lot.expiresAt === '__invalid__') return 'invalid_lot_expires_at';
  if (!LOT_STATUS_SET.has(lot.status)) return 'invalid_lot_status';
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
    metadata: normalizeMetadata(payload && payload.metadata)
  };
}

function validateAdjustment(adjustment) {
  if (!MOVEMENT_TYPE_SET.has(adjustment.movementType)) return 'invalid_movement_type';
  if (!Number.isFinite(adjustment.quantity) || adjustment.quantity <= 0) return 'invalid_movement_quantity';
  if (adjustment.referenceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(adjustment.referenceId)) {
    return 'invalid_movement_reference_id';
  }
  return null;
}

async function resolveInventoryContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  return context;
}

async function listPortalInventoryLots(tenantId, filters = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const runtime = await resolveInventoryRuntime(context);
  const lots = await listInventoryLots(context.clinic.id, { ...filters, todayISO: runtime.todayISO, thresholds: runtime.thresholds });
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lots, thresholds: runtime.thresholds, timezone: runtime.timezone };
}

async function getPortalInventoryLot(tenantId, lotId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };

  const runtime = await resolveInventoryRuntime(context);
  const lot = await findInventoryLotById(safeLotId, context.clinic.id, null, { todayISO: runtime.todayISO, thresholds: runtime.thresholds });
  if (!lot) return { ok: false, tenantId: context.tenantId, reason: 'inventory_lot_not_found' };
  const movements = await listInventoryMovementsForLot(safeLotId, context.clinic.id);
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot, movements };
}

async function getPortalInventoryExpirationSummary(tenantId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const runtime = await resolveInventoryRuntime(context);
  const summary = await getInventoryExpirationSummary(context.clinic.id, {
    todayISO: runtime.todayISO,
    thresholds: runtime.thresholds
  });
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    summary,
    thresholds: runtime.thresholds,
    timezone: runtime.timezone,
    today: runtime.todayISO
  };
}

async function getPortalInventoryExpirationSettings(tenantId) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const runtime = await resolveInventoryRuntime(context);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    thresholds: runtime.thresholds,
    timezone: runtime.timezone,
    today: runtime.todayISO
  };
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
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    thresholds,
    timezone,
    auditAction: 'inventory_expiration_settings_updated'
  };
}

async function createPortalInventoryLot(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const lotInput = buildLotPayload(payload || {}, context, actor);
  const reason = validateLotPayload(lotInput);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };

  const product = await findProductById(lotInput.productId, context.clinic.id);
  if (!product) return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };

  const created = await withTransaction(async (client) => {
    const lot = await createInventoryLot(lotInput, client);
    const movementType = normalizeString(payload && payload.movementType).toLowerCase();
    await insertInventoryMovement(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        movementType: MOVEMENT_TYPE_SET.has(movementType) ? movementType : 'purchase_receipt',
        quantity: lot.initialQuantity,
        quantityBefore: 0,
        quantityAfter: lot.availableQuantity,
        referenceType: normalizeNullableString(payload && payload.referenceType),
        referenceId: normalizeNullableString(payload && payload.referenceId),
        reason: normalizeNullableString(payload && payload.reason) || 'Ingreso de lote',
        metadata: { ...lot.metadata, auditAction: 'inventory_lot_created', source: 'inventory_lot_create' },
        createdBy: lot.createdBy
      },
      client
    );
    await syncProductStockFromLots(lot.productId, context.clinic.id, client);
    return lot;
  });

  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot: created };
}

async function adjustPortalInventoryLot(tenantId, lotId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeLotId = normalizeString(lotId);
  if (!safeLotId) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_id' };

  const adjustment = resolveAdjustment(payload || {});
  const reason = validateAdjustment(adjustment);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };

  const result = await withTransaction(async (client) => {
    const lot = await findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true });
    if (!lot) return { ok: false, reason: 'inventory_lot_not_found' };
    if (lot.status === 'cancelled') return { ok: false, reason: 'inventory_lot_cancelled' };

    const before = Number(lot.availableQuantity || 0);
    const direction = INBOUND_TYPES.has(adjustment.movementType) ? 1 : OUTBOUND_TYPES.has(adjustment.movementType) ? -1 : 0;
    const after = before + direction * adjustment.quantity;
    if (direction === 0) return { ok: false, reason: 'invalid_movement_type' };
    if (after < 0) return { ok: false, reason: 'insufficient_lot_quantity' };

    const nextStatus =
      adjustment.movementType === 'cancellation'
        ? 'cancelled'
        : lot.status === 'quarantined'
          ? 'quarantined'
          : adjustment.movementType === 'expired_writeoff' && after === 0
            ? 'expired'
            : after > 0
              ? 'active'
              : 'depleted';

    const updatedLot = await updateInventoryLotState(
      safeLotId,
      context.clinic.id,
      {
        availableQuantity: after,
        status: nextStatus,
        metadata: {
          ...lot.metadata,
          lastMovementType: adjustment.movementType,
          lastMovementAt: new Date().toISOString()
        }
      },
      client
    );
    const movement = await insertInventoryMovement(
      {
        tenantId: context.clinic.id,
        productId: lot.productId,
        lotId: lot.id,
        movementType: adjustment.movementType,
        quantity: adjustment.quantity,
        quantityBefore: before,
        quantityAfter: after,
        referenceType: adjustment.referenceType,
        referenceId: adjustment.referenceId,
        reason: adjustment.reason,
        metadata: {
          ...adjustment.metadata,
          auditAction: adjustment.movementType === 'expired_writeoff' ? 'inventory_stock_written_off' : 'inventory_stock_adjusted'
        },
        createdBy: normalizeActorId(actor)
      },
      client
    );
    await syncProductStockFromLots(lot.productId, context.clinic.id, client);
    return { ok: true, lot: updatedLot, movement };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, lot: result.lot, movement: result.movement };
}

async function bulkWriteoffExpiredPortalInventoryLots(tenantId, payload, actor = {}) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const lotIds = Array.isArray(payload && payload.lotIds)
    ? payload.lotIds.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (!lotIds.length) return { ok: false, tenantId: context.tenantId, reason: 'missing_lot_ids' };
  if (lotIds.length > 100) return { ok: false, tenantId: context.tenantId, reason: 'too_many_lots' };

  const runtime = await resolveInventoryRuntime(context);
  const reason = normalizeNullableString(payload && payload.reason) || 'Producto vencido';
  const notes = normalizeNullableString(payload && payload.notes);

  const result = await withTransaction(async (client) => {
    const writtenOff = [];
    for (const lotId of lotIds) {
      const lot = await findInventoryLotById(lotId, context.clinic.id, client, {
        forUpdate: true,
        todayISO: runtime.todayISO,
        thresholds: runtime.thresholds
      });
      if (!lot) return { ok: false, reason: 'inventory_lot_not_found', lotId };
      const expiration = calculateInventoryExpirationStatus(lot.expiresAt, { todayISO: runtime.todayISO, thresholds: runtime.thresholds });
      const before = Number(lot.availableQuantity || 0);
      if (expiration.status !== 'expired') return { ok: false, reason: 'inventory_lot_not_expired', lotId };
      if (before <= 0) return { ok: false, reason: 'inventory_lot_without_stock', lotId };
      if (['cancelled', 'depleted', 'quarantined'].includes(lot.status)) return { ok: false, reason: 'inventory_lot_not_writeoff_eligible', lotId };

      const updatedLot = await updateInventoryLotState(
        lot.id,
        context.clinic.id,
        {
          availableQuantity: 0,
          status: 'expired',
          metadata: {
            ...lot.metadata,
            lastMovementType: 'expired_writeoff',
            lastMovementAt: new Date().toISOString()
          }
        },
        client
      );
      const movement = await insertInventoryMovement(
        {
          tenantId: context.clinic.id,
          productId: lot.productId,
          lotId: lot.id,
          movementType: 'expired_writeoff',
          quantity: before,
          quantityBefore: before,
          quantityAfter: 0,
          referenceType: 'inventory_expiration_bulk_writeoff',
          referenceId: null,
          reason,
          metadata: {
            notes,
            auditAction: 'inventory_expired_bulk_writeoff',
            expirationStatus: expiration.status,
            before,
            after: 0
          },
          createdBy: normalizeActorId(actor)
        },
        client
      );
      await syncProductStockFromLots(lot.productId, context.clinic.id, client);
      writtenOff.push({ lot: updatedLot, movement });
    }
    return { ok: true, writtenOff };
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason, lotId: result.lotId || null };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, writtenOff: result.writtenOff };
}

async function setPortalProductInventoryMode(tenantId, productId, payload) {
  const context = await resolveInventoryContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeProductId = normalizeString(productId);
  const mode = normalizeString(payload && payload.mode).toLowerCase();
  if (!safeProductId) return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  if (!['legacy', 'lot_based'].includes(mode)) return { ok: false, tenantId: context.tenantId, reason: 'invalid_inventory_tracking_mode' };

  const product = await findProductById(safeProductId, context.clinic.id);
  if (!product) return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };

  const updated = await withTransaction(async (client) => {
    const existingLots = await listInventoryLots(context.clinic.id, { productId: safeProductId, pageSize: 250 }, client);
    const activeLotStock = existingLots
      .filter((lot) => lot.status === 'active')
      .reduce((sum, lot) => sum + Number(lot.availableQuantity || 0), 0);

    if (mode === 'lot_based' && Number(product.stock || 0) > 0 && activeLotStock <= 0) {
      if (!payload || !payload.initialLot || typeof payload.initialLot !== 'object') {
        return { ok: false, reason: 'initial_lot_required' };
      }
      const initialLotInput = buildLotPayload(
        {
          ...payload.initialLot,
          productId: safeProductId,
          quantity: payload.initialLot.quantity ?? product.stock,
          status: 'active',
          metadata: {
            ...normalizeMetadata(payload.initialLot.metadata),
            source: 'inventory_mode_activation'
          }
        },
        context,
        {}
      );
      const reason = validateLotPayload(initialLotInput);
      if (reason) return { ok: false, reason };
      if (Number(initialLotInput.initialQuantity || 0) <= 0) return { ok: false, reason: 'invalid_lot_quantity' };

      const lot = await createInventoryLot(initialLotInput, client);
      await insertInventoryMovement(
        {
          tenantId: context.clinic.id,
          productId: safeProductId,
          lotId: lot.id,
          movementType: 'initial_stock',
          quantity: lot.initialQuantity,
          quantityBefore: 0,
          quantityAfter: lot.availableQuantity,
          referenceType: 'inventory_mode',
          referenceId: null,
          reason: 'Activacion de inventario por lotes desde stock legacy',
          metadata: {
            auditAction: 'inventory_mode_enabled',
            source: 'inventory_mode_activation'
          },
          createdBy: initialLotInput.createdBy
        },
        client
      );
    }

    await setProductInventoryTrackingMode(safeProductId, context.clinic.id, mode, client);
    if (mode === 'lot_based') {
      await syncProductStockFromLots(safeProductId, context.clinic.id, client);
    }
    return findProductById(safeProductId, context.clinic.id, client);
  });

  if (!updated.ok && updated.reason) {
    return { ok: false, tenantId: context.tenantId, reason: updated.reason };
  }
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, product: updated };
}

module.exports = {
  listPortalInventoryLots,
  getPortalInventoryLot,
  getPortalInventoryExpirationSummary,
  getPortalInventoryExpirationSettings,
  updatePortalInventoryExpirationSettings,
  createPortalInventoryLot,
  adjustPortalInventoryLot,
  bulkWriteoffExpiredPortalInventoryLots,
  setPortalProductInventoryMode
};
