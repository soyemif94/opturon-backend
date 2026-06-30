const { query } = require('../db/client');
const { calculateInventoryExpirationStatus, normalizeDateOnly } = require('../utils/inventory-expiration');

const LOT_STATUSES = new Set(['active', 'depleted', 'expired', 'quarantined', 'cancelled']);
const MOVEMENT_TYPES = new Set([
  'initial_stock',
  'purchase_receipt',
  'manual_adjustment_in',
  'manual_adjustment_out',
  'expired_writeoff',
  'cancellation',
  'sale'
]);

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') return client.query(text, params);
  return query(text, params);
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeLot(row) {
  if (!row) return null;
  const expiration = calculateInventoryExpirationStatus(row.expiresAt);
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    productName: row.productName || null,
    productSku: row.productSku || null,
    lotNumber: row.lotNumber || null,
    supplierName: row.supplierName || null,
    receivedAt: row.receivedAt,
    manufacturedAt: normalizeDateOnly(row.manufacturedAt),
    expiresAt: normalizeDateOnly(row.expiresAt),
    initialQuantity: numberValue(row.initialQuantity),
    availableQuantity: numberValue(row.availableQuantity),
    unitCost: row.unitCost == null ? null : numberValue(row.unitCost),
    warehouseName: row.warehouseName || null,
    locationName: row.locationName || null,
    status: row.status || 'active',
    expirationStatus: expiration.status,
    daysUntilExpiration: expiration.daysUntilExpiration,
    notes: row.notes || null,
    metadata: metadataValue(row.metadata),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeMovement(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    lotId: row.lotId || null,
    movementType: row.movementType,
    quantity: numberValue(row.quantity),
    quantityBefore: row.quantityBefore == null ? null : numberValue(row.quantityBefore),
    quantityAfter: row.quantityAfter == null ? null : numberValue(row.quantityAfter),
    referenceType: row.referenceType || null,
    referenceId: row.referenceId || null,
    reason: row.reason || null,
    metadata: metadataValue(row.metadata),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt
  };
}

function buildLotSelect(whereClause = '') {
  return `SELECT
      l.id,
      l."tenantId",
      l."productId",
      p.name AS "productName",
      p.sku AS "productSku",
      l."lotNumber",
      l."supplierName",
      l."receivedAt",
      l."manufacturedAt",
      l."expiresAt",
      l."initialQuantity",
      l."availableQuantity",
      l."unitCost",
      l."warehouseName",
      l."locationName",
      l.status,
      l.notes,
      l.metadata,
      l."createdBy",
      l."createdAt",
      l."updatedAt"
    FROM inventory_lots l
    INNER JOIN products p
      ON p.id = l."productId"
     AND p."clinicId" = l."tenantId"
    ${whereClause}`;
}

async function listInventoryLots(tenantId, filters = {}, client = null) {
  const params = [tenantId];
  const conditions = ['l."tenantId" = $1::uuid'];

  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`l."productId" = $${params.length}::uuid`);
  }
  if (filters.status && LOT_STATUSES.has(filters.status)) {
    params.push(filters.status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${String(filters.search).trim()}%`);
    conditions.push(`(l."lotNumber" ILIKE $${params.length} OR l."supplierName" ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  if (filters.warehouse) {
    params.push(`%${String(filters.warehouse).trim()}%`);
    conditions.push(`l."warehouseName" ILIKE $${params.length}`);
  }
  if (filters.expiresBefore) {
    params.push(filters.expiresBefore);
    conditions.push(`l."expiresAt" <= $${params.length}::date`);
  }
  if (filters.expiresAfter) {
    params.push(filters.expiresAfter);
    conditions.push(`l."expiresAt" >= $${params.length}::date`);
  }

  const pageSize = Math.min(Math.max(Number(filters.pageSize || 100), 1), 250);
  params.push(pageSize);
  const limitIndex = params.length;

  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE ${conditions.join(' AND ')}`)}
     ORDER BY l."expiresAt" ASC NULLS LAST, l."receivedAt" ASC, l."createdAt" ASC
     LIMIT $${limitIndex}`,
    params
  );

  let lots = result.rows.map(normalizeLot);
  if (filters.expirationStatus) {
    lots = lots.filter((lot) => lot.expirationStatus === filters.expirationStatus);
  }
  return lots;
}

async function findInventoryLotById(lotId, tenantId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `${buildLotSelect('WHERE l.id = $1::uuid AND l."tenantId" = $2::uuid')}
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE OF l' : ''}`,
    [lotId, tenantId]
  );
  return normalizeLot(result.rows[0]);
}

async function createInventoryLot(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_lots (
       "tenantId",
       "productId",
       "lotNumber",
       "supplierName",
       "receivedAt",
       "manufacturedAt",
       "expiresAt",
       "initialQuantity",
       "availableQuantity",
       "unitCost",
       "warehouseName",
       "locationName",
       status,
       notes,
       metadata,
       "createdBy",
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, COALESCE($5::timestamptz, NOW()), $6::date, $7::date, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::uuid, NOW())
     RETURNING id`,
    [
      input.tenantId,
      input.productId,
      input.lotNumber || null,
      input.supplierName || null,
      input.receivedAt || null,
      input.manufacturedAt || null,
      input.expiresAt || null,
      input.initialQuantity,
      input.availableQuantity,
      input.unitCost == null ? null : input.unitCost,
      input.warehouseName || null,
      input.locationName || null,
      input.status,
      input.notes || null,
      JSON.stringify(metadataValue(input.metadata)),
      input.createdBy || null
    ]
  );
  return findInventoryLotById(result.rows[0].id, input.tenantId, client);
}

async function updateInventoryLotState(lotId, tenantId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_lots
     SET "availableQuantity" = $3,
         status = $4,
         notes = COALESCE($5, notes),
         metadata = COALESCE($6::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id`,
    [
      lotId,
      tenantId,
      input.availableQuantity,
      input.status,
      input.notes === undefined ? null : input.notes,
      input.metadata === undefined ? null : JSON.stringify(metadataValue(input.metadata))
    ]
  );
  if (!result.rows[0]) return null;
  return findInventoryLotById(lotId, tenantId, client);
}

async function insertInventoryMovement(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_movements (
       "tenantId",
       "productId",
       "lotId",
       "movementType",
       quantity,
       "quantityBefore",
       "quantityAfter",
       "referenceType",
       "referenceId",
       reason,
       metadata,
       "createdBy"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::uuid, $10, $11::jsonb, $12::uuid)
     RETURNING *`,
    [
      input.tenantId,
      input.productId,
      input.lotId || null,
      input.movementType,
      input.quantity,
      input.quantityBefore == null ? null : input.quantityBefore,
      input.quantityAfter == null ? null : input.quantityAfter,
      input.referenceType || null,
      input.referenceId || null,
      input.reason || null,
      JSON.stringify(metadataValue(input.metadata)),
      input.createdBy || null
    ]
  );
  return normalizeMovement(result.rows[0]);
}

async function listInventoryMovementsForLot(lotId, tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT *
     FROM inventory_movements
     WHERE "tenantId" = $1::uuid
       AND "lotId" = $2::uuid
     ORDER BY "createdAt" DESC`,
    [tenantId, lotId]
  );
  return result.rows.map(normalizeMovement);
}

async function sumActiveLotStockByProductId(productId, tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COALESCE(SUM("availableQuantity"), 0) AS stock
     FROM inventory_lots
     WHERE "tenantId" = $1::uuid
       AND "productId" = $2::uuid
       AND status = 'active'`,
    [tenantId, productId]
  );
  return numberValue(result.rows[0] && result.rows[0].stock);
}

async function syncProductStockFromLots(productId, tenantId, client = null) {
  const stock = await sumActiveLotStockByProductId(productId, tenantId, client);
  await dbQuery(
    client,
    `UPDATE products
     SET stock = $3,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND COALESCE(metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'`,
    [productId, tenantId, Math.max(0, Math.floor(stock))]
  );
  return stock;
}

async function setProductInventoryTrackingMode(productId, tenantId, mode, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE products
     SET metadata = jsonb_set(
           jsonb_set(COALESCE(metadata, '{}'::jsonb), '{catalog}', COALESCE(metadata->'catalog', '{}'::jsonb), true),
           '{catalog,inventoryTrackingMode}',
           to_jsonb($3::text),
           true
         ),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [productId, tenantId, mode]
  );
  return Boolean(result.rows[0]);
}

async function listEligibleLotsForFefo(tenantId, productId, client = null) {
  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE l."tenantId" = $1::uuid
       AND l."productId" = $2::uuid
       AND l.status = 'active'
       AND l."availableQuantity" > 0
       AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)`)}
     ORDER BY
       CASE WHEN l."expiresAt" IS NULL THEN 1 ELSE 0 END ASC,
       l."expiresAt" ASC NULLS LAST,
       l."receivedAt" ASC,
       l.id ASC
     FOR UPDATE OF l`,
    [tenantId, productId]
  );
  return result.rows.map(normalizeLot);
}

async function updateInventoryLotQuantity(lotId, tenantId, productId, availableQuantity, status, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_lots
     SET "availableQuantity" = $4,
         status = $5,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
       AND "productId" = $3::uuid
     RETURNING id`,
    [lotId, tenantId, productId, availableQuantity, status]
  );
  if (!result.rows[0]) return null;
  return findInventoryLotById(lotId, tenantId, client);
}

function normalizeAllocation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    productId: row.productId,
    lotId: row.lotId,
    lotNumber: row.lotNumber || null,
    productName: row.productName || null,
    quantity: numberValue(row.quantity),
    status: row.status,
    metadata: metadataValue(row.metadata),
    createdAt: row.createdAt,
    releasedAt: row.releasedAt || null
  };
}

async function createInventoryLotAllocation(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_lot_allocations (
       "tenantId",
       "orderId",
       "orderItemId",
       "productId",
       "lotId",
       quantity,
       status,
       metadata
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      input.tenantId,
      input.orderId,
      input.orderItemId,
      input.productId,
      input.lotId,
      input.quantity,
      input.status || 'consumed',
      JSON.stringify(metadataValue(input.metadata))
    ]
  );
  return normalizeAllocation(result.rows[0]);
}

async function listInventoryLotAllocationsByOrder(tenantId, orderId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `SELECT
       a.id,
       a."tenantId",
       a."orderId",
       a."orderItemId",
       a."productId",
       a."lotId",
       l."lotNumber",
       p.name AS "productName",
       a.quantity,
       a.status,
       a.metadata,
       a."createdAt",
       a."releasedAt"
     FROM inventory_lot_allocations a
     INNER JOIN inventory_lots l
       ON l.id = a."lotId"
      AND l."tenantId" = a."tenantId"
      AND l."productId" = a."productId"
     INNER JOIN products p
       ON p.id = a."productId"
      AND p."clinicId" = a."tenantId"
     WHERE a."tenantId" = $1::uuid
       AND a."orderId" = $2::uuid
     ORDER BY a."createdAt" ASC, a.id ASC
     ${options.forUpdate ? 'FOR UPDATE OF a' : ''}`,
    [tenantId, orderId]
  );
  return result.rows.map(normalizeAllocation);
}

async function markInventoryLotAllocationsReleased(tenantId, allocationIds, status, client = null) {
  if (!Array.isArray(allocationIds) || allocationIds.length === 0) return [];
  const result = await dbQuery(
    client,
    `UPDATE inventory_lot_allocations
     SET status = $3,
         "releasedAt" = COALESCE("releasedAt", NOW()),
         metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{releasedAt}', to_jsonb(NOW()::text), true)
     WHERE "tenantId" = $1::uuid
       AND id = ANY($2::uuid[])
       AND status IN ('allocated', 'consumed')
     RETURNING *`,
    [tenantId, allocationIds, status || 'released']
  );
  return result.rows.map(normalizeAllocation);
}

module.exports = {
  LOT_STATUSES: Array.from(LOT_STATUSES),
  MOVEMENT_TYPES: Array.from(MOVEMENT_TYPES),
  listInventoryLots,
  findInventoryLotById,
  createInventoryLot,
  updateInventoryLotState,
  insertInventoryMovement,
  listInventoryMovementsForLot,
  sumActiveLotStockByProductId,
  syncProductStockFromLots,
  setProductInventoryTrackingMode,
  listEligibleLotsForFefo,
  updateInventoryLotQuantity,
  createInventoryLotAllocation,
  listInventoryLotAllocationsByOrder,
  markInventoryLotAllocationsReleased
};
