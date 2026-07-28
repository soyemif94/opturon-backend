const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findProductById, updateProduct } = require('../repositories/products.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');
const { insertInventoryMovement } = require('../repositories/inventory.repository');
const {
  reserveNextInternalCodeNumber,
  ensurePrimaryInventoryLocation,
  ensureInventoryBalanceRow,
  updateInventoryBalanceQuantity,
  listInventoryBalancesByTenant,
  listInventoryMovementsByProductId,
  findInventoryMovementByIdempotencyKey
} = require('../repositories/inventory-base.repository');
const { normalizeInventoryMovementTypeForApi } = require('../utils/inventory-movement-types');

const MOVEMENT_TYPES = new Set([
  'opening_balance',
  'purchase_receipt',
  'sale',
  'manual_increase',
  'manual_decrease',
  'correction',
  'return_in',
  'return_out'
]);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolveDisplayedStock(row) {
  if (row && row.balanceQuantity !== undefined && row.balanceQuantity !== null && row.balanceQuantity !== '') {
    const balanceValue = Number(row.balanceQuantity);
    if (Number.isFinite(balanceValue)) return balanceValue;
  }
  const productStock = Number(row && row.stock);
  return Number.isFinite(productStock) ? productStock : 0;
}

function resolveActorId(actor = {}) {
  return normalizeString(actor.actorId || actor.id) || null;
}

function formatInternalCodeFromNumber(value) {
  const safeValue = Number(value);
  if (!Number.isInteger(safeValue) || safeValue < 0 || safeValue > 259999) {
    throw new Error('internal_code_range_exhausted');
  }
  const letterIndex = Math.floor(safeValue / 10000);
  const suffix = safeValue % 10000;
  const letter = String.fromCharCode(65 + letterIndex);
  return `${letter}-${String(suffix).padStart(4, '0')}`;
}

async function reserveNextInternalCode(clinicId, client) {
  const value = await reserveNextInternalCodeNumber(clinicId, client);
  return formatInternalCodeFromNumber(value);
}

async function assignInternalCodeToProduct(clinicId, productId, client) {
  const product = await findProductById(productId, clinicId, client);
  if (!product) return null;
  if (product.internalCode) return product.internalCode;
  const internalCode = await reserveNextInternalCode(clinicId, client);
  const updated = await updateProduct(
    productId,
    clinicId,
    {
      ...product,
      internalCode,
      stock: product.stock
    },
    client
  );
  return updated && updated.internalCode ? updated.internalCode : internalCode;
}

function classifyStockState(quantity) {
  const safe = Number(quantity || 0);
  if (safe <= 0) return 'without_stock';
  if (safe <= 5) return 'low_stock';
  return 'with_stock';
}

async function listPortalInventoryProducts(tenantId, filters = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const location = await withTransaction((client) => ensurePrimaryInventoryLocation(context.clinic.id, client));
  const result = await listInventoryBalancesByTenant(context.clinic.id, filters);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    location,
    page: Math.max(Number(filters.page || 1), 1),
    pageSize: Math.min(Math.max(Number(filters.pageSize || 50), 1), 100),
    total: result.total,
    products: result.rows.map((row) => ({
      id: row.id,
      clinicId: row.clinicId,
      name: row.name,
      description: row.description || null,
      price: Number(row.price || 0),
      unitPrice: Number(row.unitPrice || row.price || 0),
      currency: row.currency,
      vatRate: Number(row.vatRate || 0),
      stock: resolveDisplayedStock(row),
      status: row.status,
      sku: row.sku || null,
      internalCode: row.internalCode || null,
      categoryId: row.categoryId || null,
      categoryName: row.categoryName || null,
      metadata: normalizeMetadata(row.metadata),
      locationId: row.locationId || location.id,
      locationName: row.locationName || location.name,
      lastMovementAt: row.lastMovementAt || null,
      lastMovementType: normalizeInventoryMovementTypeForApi(row.lastMovementType || null),
      stockState: classifyStockState(resolveDisplayedStock(row)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))
  };
}

async function getPortalInventoryProductHistory(tenantId, productId, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeProductId = normalizeString(productId);
  if (!safeProductId) return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };

  const product = await findProductById(safeProductId, context.clinic.id);
  if (!product) return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };

  const movements = await listInventoryMovementsByProductId(context.clinic.id, safeProductId, options);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    product,
    movements
  };
}

function resolveMovementDraft(payload = {}) {
  const movementType = normalizeString(payload.movementType).toLowerCase();
  return {
    movementType,
    quantity: normalizeNumber(payload.quantity),
    countedStock: payload.countedStock === undefined ? NaN : normalizeNumber(payload.countedStock),
    reason: normalizeString(payload.reason) || null,
    referenceType: normalizeString(payload.referenceType) || null,
    referenceId: normalizeString(payload.referenceId) || null,
    idempotencyKey: normalizeString(payload.idempotencyKey),
    metadata: normalizeMetadata(payload.metadata)
  };
}

function validateMovementDraft(draft) {
  if (!MOVEMENT_TYPES.has(draft.movementType)) return 'invalid_inventory_movement_type';
  if (!draft.idempotencyKey) return 'missing_inventory_idempotency_key';
  if (draft.movementType === 'correction') {
    if (!Number.isFinite(draft.countedStock) || draft.countedStock < 0) return 'invalid_inventory_counted_stock';
    return null;
  }
  if (!Number.isFinite(draft.quantity) || !Number.isInteger(draft.quantity) || draft.quantity <= 0) return 'invalid_inventory_quantity';
  return null;
}

function resolveDeltaFromMovement(draft, currentQuantity) {
  if (draft.movementType === 'opening_balance') {
    return draft.quantity;
  }
  if (draft.movementType === 'purchase_receipt' || draft.movementType === 'manual_increase' || draft.movementType === 'return_in') {
    return draft.quantity;
  }
  if (draft.movementType === 'sale' || draft.movementType === 'manual_decrease' || draft.movementType === 'return_out') {
    return -draft.quantity;
  }
  if (draft.movementType === 'correction') {
    return draft.countedStock - currentQuantity;
  }
  return NaN;
}

function resolveAuditAction(draft) {
  if (draft.movementType === 'opening_balance') return 'inventory_opening_balance_created';
  if (draft.movementType === 'correction') return 'inventory_correction_created';
  return 'inventory_movement_created';
}

async function applyInventoryMovementWithClient(clinicId, productId, payload, actor = {}, client) {
  const safeClinicId = normalizeString(clinicId);
  const safeProductId = normalizeString(productId);
  if (!safeClinicId || !safeProductId) return { ok: false, reason: 'missing_product_id' };

  const draft = resolveMovementDraft(payload);
  const invalidReason = validateMovementDraft(draft);
  if (invalidReason) return { ok: false, reason: invalidReason };

  const product = await findProductById(safeProductId, safeClinicId, client);
  if (!product) return { ok: false, reason: 'product_not_found' };
  if (product.deletedAt) return { ok: false, reason: 'product_deleted_cannot_receive_inventory_movements' };
  if (product.inventoryTrackingMode === 'lot_based') {
    return { ok: false, reason: 'inventory_base_not_supported_for_lot_based_product' };
  }

  const internalCode = product.internalCode || await assignInternalCodeToProduct(safeClinicId, safeProductId, client);
  const location = await ensurePrimaryInventoryLocation(safeClinicId, client);
  const existing = await findInventoryMovementByIdempotencyKey(safeClinicId, draft.movementType, draft.idempotencyKey, client);
  if (existing) {
    const balance = await ensureInventoryBalanceRow(safeClinicId, safeProductId, location.id, client, {
      initialQuantity: Math.max(0, Number(product.stock || 0)),
      metadata: { source: 'inventory_base_legacy_seed' }
    });
    return { ok: true, idempotent: true, product, location, balance, movement: existing, internalCode };
  }

  const balance = await ensureInventoryBalanceRow(safeClinicId, safeProductId, location.id, client, {
    initialQuantity: Math.max(0, Number(product.stock || 0)),
    metadata: { source: 'inventory_base_legacy_seed' }
  });
  const currentQuantity = Number(balance.quantity || 0);
  if (draft.movementType === 'opening_balance') {
    const existingHistory = await listInventoryMovementsByProductId(safeClinicId, safeProductId, { page: 1, pageSize: 1 }, client);
    if (existingHistory.length > 0) {
      return { ok: false, reason: 'inventory_opening_balance_already_exists' };
    }
  }

  const delta = resolveDeltaFromMovement(draft, currentQuantity);
  if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: 'inventory_zero_delta_not_allowed' };
  const nextQuantity = currentQuantity + delta;
  if (nextQuantity < 0) {
    return {
      ok: false,
      reason: 'inventory_negative_stock_blocked',
      details: { available: currentQuantity, requested: draft.quantity, resulting: nextQuantity }
    };
  }

  let movement;
  try {
    movement = await insertInventoryMovement(
      {
        tenantId: safeClinicId,
        productId: safeProductId,
        lotId: null,
        locationId: location.id,
        movementType: draft.movementType,
        quantity: Math.abs(delta),
        quantityBefore: currentQuantity,
        quantityAfter: nextQuantity,
        referenceType: draft.referenceType,
        referenceId: draft.referenceId || null,
        reason: draft.reason || (draft.movementType === 'opening_balance' ? 'Carga inicial de inventario' : null),
        metadata: {
          ...draft.metadata,
          inventoryBase: true,
          internalCode,
          locationCode: location.code
        },
        createdBy: resolveActorId(actor),
        idempotencyKey: draft.idempotencyKey,
        unit: 'unit',
        status: 'posted'
      },
      client
    );
  } catch (error) {
    if (error && error.code === '23505') {
      const persisted = await findInventoryMovementByIdempotencyKey(safeClinicId, draft.movementType, draft.idempotencyKey, client);
      if (persisted) {
        const lockedBalance = await ensureInventoryBalanceRow(safeClinicId, safeProductId, location.id, client);
        return { ok: true, idempotent: true, product, location, balance: lockedBalance, movement: persisted, internalCode };
      }
    }
    throw error;
  }

  const updatedBalance = await updateInventoryBalanceQuantity(
    balance.id,
    safeClinicId,
    nextQuantity,
    {
      source: 'inventory_base',
      lastMovementId: movement.id,
      internalCode
    },
    client
  );

  const updatedProduct = await updateProduct(
    safeProductId,
    safeClinicId,
    {
      ...product,
      internalCode,
      stock: nextQuantity
    },
    client
  );

  return {
    ok: true,
    idempotent: false,
    product: updatedProduct || { ...product, internalCode, stock: nextQuantity },
    location,
    balance: updatedBalance,
    movement,
    internalCode,
    previousBalance: currentQuantity,
    resultingBalance: nextQuantity
  };
}

async function createPortalInventoryMovement(tenantId, productId, payload, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeProductId = normalizeString(productId);
  if (!safeProductId) return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };

  const result = await withTransaction(async (client) => {
    const applied = await applyInventoryMovementWithClient(context.clinic.id, safeProductId, payload, actor, client);
    if (!applied.ok) return applied;
    if (applied.idempotent) return applied;

    await createPortalUserAuditEvent(
      {
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId: resolveActorId(actor),
        action: resolveAuditAction(resolveMovementDraft(payload)),
        payload: {
          productId: safeProductId,
          internalCode: applied.internalCode,
          movementId: applied.movement.id,
          movementType: applied.movement.movementType,
          quantity: applied.movement.quantity,
          previousBalance: applied.previousBalance ?? applied.movement.quantityBefore,
          resultingBalance: applied.resultingBalance ?? applied.movement.quantityAfter,
          location: applied.location.name,
          idempotencyKey: applied.movement.idempotencyKey,
          reason: applied.movement.reason || null
        }
      },
      client
    );

    return applied;
  });

  if (!result.ok) return { ok: false, tenantId: context.tenantId, reason: result.reason, details: result.details || null };
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    idempotent: result.idempotent,
    product: result.product,
    location: result.location,
    balance: result.balance,
    movement: result.movement,
    internalCode: result.internalCode
  };
}

module.exports = {
  formatInternalCodeFromNumber,
  reserveNextInternalCode,
  assignInternalCodeToProduct,
  listPortalInventoryProducts,
  getPortalInventoryProductHistory,
  createPortalInventoryMovement,
  applyInventoryMovementWithClient
};
