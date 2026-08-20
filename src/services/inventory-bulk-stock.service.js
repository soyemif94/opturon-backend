const crypto = require('crypto');

const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findProductsByIds } = require('../repositories/products.repository');
const {
  createPortalUserAuditEvent,
  findLatestPortalUserAuditEventByIdempotencyKey
} = require('../repositories/portal-user-audit.repository');
const {
  findPrimaryInventoryLocation,
  ensurePrimaryInventoryLocation,
  lockInventoryBalancesByProductIds
} = require('../repositories/inventory-base.repository');
const { applyInventoryMovementWithClient } = require('./inventory-base.service');

const BULK_ADJUSTMENT_REASONS = new Set([
  'initial_stock',
  'physical_count',
  'inventory_correction',
  'other'
]);
const MAX_BULK_ITEMS = 2000;
const MAX_STOCK_QUANTITY = 2147483647;
const BULK_AUDIT_ACTION = 'inventory_bulk_stock_adjusted';
const ITEM_AUDIT_ACTION = 'inventory_correction_created';

function normalizeString(value) {
  return String(value || '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function normalizeUuid(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStockQuantity(value) {
  if (typeof value !== 'number') return NaN;
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_STOCK_QUANTITY ? value : NaN;
}

function resolveActorId(actor = {}) {
  const actorId = normalizeString(actor.actorId || actor.id);
  return isUuid(actorId) ? actorId : null;
}

function normalizeBulkDraft(payload = {}) {
  const rawItems = Array.isArray(payload.items) ? payload.items : null;
  return {
    idempotencyKey: normalizeUuid(payload.idempotencyKey),
    reason: normalizeString(payload.reason).toLowerCase(),
    note: normalizeString(payload.note) || null,
    items: rawItems
      ? rawItems.map((item) => ({
          productId: normalizeUuid(item && item.productId),
          targetQuantity: normalizeStockQuantity(item && item.targetQuantity),
          expectedCurrentQuantity: normalizeStockQuantity(item && item.expectedCurrentQuantity)
        }))
      : null
  };
}

function validateBulkDraft(draft) {
  if (!draft.idempotencyKey) return 'missing_inventory_bulk_idempotency_key';
  if (!isUuid(draft.idempotencyKey)) return 'invalid_inventory_bulk_idempotency_key';
  if (!BULK_ADJUSTMENT_REASONS.has(draft.reason)) return 'invalid_inventory_bulk_reason';
  if (draft.note && draft.note.length > 500) return 'invalid_inventory_bulk_note';
  if (draft.reason === 'other' && !draft.note) return 'inventory_bulk_note_required';
  if (!Array.isArray(draft.items) || draft.items.length === 0) return 'invalid_inventory_bulk_items';
  if (draft.items.length > MAX_BULK_ITEMS) return 'inventory_bulk_too_many_items';

  const seenProductIds = new Set();
  for (const item of draft.items) {
    if (!isUuid(item.productId)) return 'invalid_inventory_bulk_product_id';
    if (!Number.isFinite(item.targetQuantity)) return 'invalid_inventory_bulk_target_quantity';
    if (!Number.isFinite(item.expectedCurrentQuantity)) return 'invalid_inventory_bulk_expected_quantity';
    if (seenProductIds.has(item.productId)) return 'duplicate_inventory_bulk_product';
    seenProductIds.add(item.productId);
  }
  return null;
}

function canonicalPayload(draft) {
  return {
    reason: draft.reason,
    note: draft.note,
    items: [...draft.items]
      .sort((left, right) => left.productId.localeCompare(right.productId))
      .map((item) => ({
        productId: item.productId,
        targetQuantity: item.targetQuantity,
        expectedCurrentQuantity: item.expectedCurrentQuantity
      }))
  };
}

function buildPayloadHash(draft) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalPayload(draft))).digest('hex');
}

function createDomainError(reason, details = null) {
  const error = new Error(reason);
  error.reason = reason;
  error.details = details || null;
  error.isDomainError = true;
  return error;
}

async function acquireBulkOperationLock(client, clinicId, idempotencyKey) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`inventory_bulk_stock:${clinicId}`, idempotencyKey]
  );
}

function movementReason(draft) {
  if (draft.note) return draft.note;
  if (draft.reason === 'initial_stock') return 'Carga inicial de inventario';
  if (draft.reason === 'physical_count') return 'Conteo fisico de inventario';
  if (draft.reason === 'inventory_correction') return 'Correccion de inventario';
  return 'Ajuste masivo de inventario';
}

function emptySummary(requestedItems) {
  return {
    submittedItems: requestedItems,
    changedItems: 0,
    unchangedItems: 0,
    increases: 0,
    reductions: 0,
    unitsAdded: 0,
    unitsRemoved: 0
  };
}

function persistedReplay(context, draft, audit) {
  const payload = audit && audit.payload && typeof audit.payload === 'object' ? audit.payload : {};
  const result = payload.result && typeof payload.result === 'object' ? payload.result : null;
  if (!result) throw createDomainError('inventory_bulk_idempotency_conflict');
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    operationId: result.operationId || draft.idempotencyKey,
    reason: result.reason || draft.reason,
    note: result.note === undefined ? draft.note : result.note,
    idempotent: true,
    location: result.location || null,
    summary: result.summary || emptySummary(draft.items.length),
    items: Array.isArray(result.items) ? result.items : []
  };
}

async function createPortalInventoryBulkAdjustment(tenantId, payload = {}, actor = {}) {
  const draft = normalizeBulkDraft(payload);
  const invalidReason = validateBulkDraft(draft);
  if (invalidReason) return { ok: false, tenantId, reason: invalidReason };

  const actorUserId = resolveActorId(actor);
  if (!actorUserId) return { ok: false, tenantId, reason: 'inventory_bulk_actor_required' };

  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const payloadHash = buildPayloadHash(draft);
  const orderedItems = [...draft.items].sort((left, right) => left.productId.localeCompare(right.productId));

  try {
    return await withTransaction(async (client) => {
      await acquireBulkOperationLock(client, context.clinic.id, draft.idempotencyKey);

      const existingAudit = await findLatestPortalUserAuditEventByIdempotencyKey(
        context.clinic.id,
        BULK_AUDIT_ACTION,
        draft.idempotencyKey,
        client
      );
      if (existingAudit) {
        const persistedHash = normalizeString(existingAudit.payload && existingAudit.payload.payloadHash);
        if (!persistedHash || persistedHash !== payloadHash) {
          throw createDomainError('inventory_bulk_idempotency_payload_mismatch');
        }
        return persistedReplay(context, draft, existingAudit);
      }

      const products = await findProductsByIds(
        context.clinic.id,
        orderedItems.map((item) => item.productId),
        client,
        { includeDeleted: true, forUpdate: true }
      );
      const productsById = new Map(products.map((product) => [product.id, product]));

      for (const item of orderedItems) {
        const product = productsById.get(item.productId);
        if (!product) throw createDomainError('product_not_found', { productId: item.productId });
        if (product.deletedAt) {
          throw createDomainError('product_deleted_cannot_receive_inventory_movements', { productId: item.productId });
        }
        if (product.inventoryTrackingMode === 'lot_based') {
          throw createDomainError('inventory_base_not_supported_for_lot_based_product', { productId: item.productId });
        }
      }

      const existingLocation = await findPrimaryInventoryLocation(context.clinic.id, client);
      const balances = existingLocation
        ? await lockInventoryBalancesByProductIds(
            context.clinic.id,
            orderedItems.map((item) => item.productId),
            existingLocation.id,
            client
          )
        : [];
      const balancesByProductId = new Map(balances.map((balance) => [balance.productId, balance]));

      const inventoryConflicts = [];
      for (const item of orderedItems) {
        const product = productsById.get(item.productId);
        const balance = balancesByProductId.get(item.productId);
        const currentQuantity = balance ? Number(balance.quantity || 0) : Math.max(0, Number(product.stock || 0));
        if (currentQuantity !== item.expectedCurrentQuantity) {
          inventoryConflicts.push({
            productId: item.productId,
            expectedCurrentQuantity: item.expectedCurrentQuantity,
            currentQuantity
          });
        }
      }
      if (inventoryConflicts.length > 0) {
        throw createDomainError('inventory_changed', {
          ...inventoryConflicts[0],
          conflicts: inventoryConflicts
        });
      }

      const unchangedItems = orderedItems.filter((item) => item.targetQuantity === item.expectedCurrentQuantity);
      const changedItems = orderedItems.filter((item) => item.targetQuantity !== item.expectedCurrentQuantity);
      const summary = emptySummary(orderedItems.length);
      summary.unchangedItems = unchangedItems.length;
      const items = unchangedItems.map((item) => ({
        productId: item.productId,
        status: 'unchanged',
        previousQuantity: item.expectedCurrentQuantity,
        targetQuantity: item.targetQuantity,
        delta: 0,
        movementId: null
      }));

      if (changedItems.length === 0) {
        return {
          ok: true,
          tenantId: context.tenantId,
          clinic: context.clinic,
          operationId: draft.idempotencyKey,
          reason: draft.reason,
          note: draft.note,
          idempotent: false,
          location: null,
          summary,
          items
        };
      }

      const location = existingLocation || await ensurePrimaryInventoryLocation(context.clinic.id, client);
      if (!location || !location.id) throw createDomainError('inventory_primary_location_not_found');

      for (const item of changedItems) {
        const product = productsById.get(item.productId);
        const itemIdempotencyKey = `inventory-bulk:${draft.idempotencyKey}:${item.productId}`;
        const applied = await applyInventoryMovementWithClient(
          context.clinic.id,
          item.productId,
          {
            movementType: 'correction',
            countedStock: item.targetQuantity,
            expectedCurrentQuantity: item.expectedCurrentQuantity,
            reason: movementReason(draft),
            referenceType: 'inventory_bulk_stock',
            referenceId: draft.idempotencyKey,
            idempotencyKey: itemIdempotencyKey,
            metadata: {
              source: 'inventory_bulk_stock',
              bulkOperationId: draft.idempotencyKey,
              payloadHash,
              reasonCode: draft.reason,
              note: draft.note
            }
          },
          actor,
          client,
          { location, product, productLocked: true }
        );
        if (!applied.ok) throw createDomainError(applied.reason, applied.details);
        if (applied.idempotent) {
          throw createDomainError('inventory_bulk_idempotency_conflict', { productId: item.productId });
        }

        const previousQuantity = Number(applied.previousBalance);
        const targetQuantity = Number(applied.resultingBalance);
        const delta = targetQuantity - previousQuantity;

        summary.changedItems += 1;
        if (delta > 0) {
          summary.increases += 1;
          summary.unitsAdded += delta;
        } else {
          summary.reductions += 1;
          summary.unitsRemoved += Math.abs(delta);
        }

        const itemResult = {
          productId: item.productId,
          status: 'updated',
          previousQuantity,
          targetQuantity,
          delta,
          movementId: applied.movement.id
        };
        items.push(itemResult);

        await createPortalUserAuditEvent(
          {
            tenantId: context.tenantId,
            clinicId: context.clinic.id,
            actorUserId,
            action: ITEM_AUDIT_ACTION,
            payload: {
              productId: item.productId,
              internalCode: applied.internalCode,
              movementId: applied.movement.id,
              movementType: applied.movement.movementType,
              quantity: applied.movement.quantity,
              previousBalance: previousQuantity,
              resultingBalance: targetQuantity,
              location: location.name,
              idempotencyKey: itemIdempotencyKey,
              reason: applied.movement.reason || null,
              bulkOperationId: draft.idempotencyKey,
              bulkReason: draft.reason,
              bulkNote: draft.note,
              payloadHash
            }
          },
          client
        );
      }

      const persistedResult = {
        operationId: draft.idempotencyKey,
        reason: draft.reason,
        note: draft.note,
        location: { id: location.id, code: location.code, name: location.name },
        summary,
        items: items.sort((left, right) => left.productId.localeCompare(right.productId))
      };
      await createPortalUserAuditEvent(
        {
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actorUserId,
          action: BULK_AUDIT_ACTION,
          payload: {
            idempotencyKey: draft.idempotencyKey,
            payloadHash,
            reason: draft.reason,
            note: draft.note,
            result: persistedResult
          }
        },
        client
      );

      return {
        ok: true,
        tenantId: context.tenantId,
        clinic: context.clinic,
        idempotent: false,
        ...persistedResult
      };
    });
  } catch (error) {
    if (error && error.isDomainError) {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: error.reason,
        details: error.details || null
      };
    }
    throw error;
  }
}

module.exports = {
  BULK_ADJUSTMENT_REASONS,
  MAX_BULK_ITEMS,
  buildPayloadHash,
  normalizeBulkDraft,
  validateBulkDraft,
  createPortalInventoryBulkAdjustment
};
