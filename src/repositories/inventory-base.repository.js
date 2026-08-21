const { query } = require('../db/client');
const { normalizeInventoryMovementTypeForApi } = require('../utils/inventory-movement-types');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') return client.query(text, params);
  return query(text, params);
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function positiveInteger(value, fallback, max = null) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max === null ? parsed : Math.min(parsed, max);
}

function normalizeInventoryMovementRow(row) {
  if (!row) return null;
  const metadata = normalizeMetadata(row.metadata);
  return {
    ...row,
    movementType: normalizeInventoryMovementTypeForApi(row.movementType),
    metadata
  };
}

function normalizeInventoryMovementListRow(row) {
  if (!row) return null;
  const metadata = normalizeMetadata(row.metadata);
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    productName: row.productName || null,
    productSku: row.productSku || null,
    internalCode: row.internalCode || null,
    lotId: row.lotId || null,
    lotNumber: row.lotNumber || null,
    locationId: row.locationId || null,
    locationName: row.locationName || null,
    movementType: normalizeInventoryMovementTypeForApi(row.movementType),
    quantity: stringValue(row.quantity) || '0',
    quantityBefore: stringValue(row.quantityBefore),
    quantityAfter: stringValue(row.quantityAfter),
    referenceType: row.referenceType || null,
    referenceId: row.referenceId || null,
    reason: row.reason || null,
    metadata,
    createdBy: row.createdBy || null,
    actorName: row.actorName || null,
    createdAt: row.createdAt,
    idempotencyKey: row.idempotencyKey || null,
    unit: row.unit || null,
    status: row.status || 'posted'
  };
}

function normalizeLocation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    isPrimary: row.isPrimary === true,
    active: row.active !== false,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeBalance(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    locationId: row.locationId,
    quantity: numberValue(row.quantity),
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function reserveNextInternalCodeNumber(clinicId, client) {
  const result = await dbQuery(
    client,
    `INSERT INTO product_internal_code_allocators ("clinicId", "nextValue", "updatedAt")
     VALUES ($1::uuid, 1, NOW())
     ON CONFLICT ("clinicId")
     DO UPDATE SET
       "nextValue" = product_internal_code_allocators."nextValue" + 1,
       "updatedAt" = NOW()
     RETURNING "nextValue" - 1 AS value`,
    [clinicId]
  );
  return Number(result.rows[0] && result.rows[0].value);
}

async function ensurePrimaryInventoryLocation(tenantId, client) {
  await dbQuery(
    client,
    `INSERT INTO inventory_locations ("tenantId", code, name, "isPrimary", active, metadata, "updatedAt")
     VALUES ($1::uuid, 'main', 'Principal', TRUE, TRUE, '{"source":"inventory_base"}'::jsonb, NOW())
     ON CONFLICT ("tenantId", code)
     DO UPDATE SET
       name = EXCLUDED.name,
       "isPrimary" = TRUE,
       active = TRUE,
       "updatedAt" = NOW()`,
    [tenantId]
  );

  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"
     FROM inventory_locations
     WHERE "tenantId" = $1::uuid
       AND code = 'main'
     LIMIT 1`,
    [tenantId]
  );
  return normalizeLocation(result.rows[0] || null);
}

async function findPrimaryInventoryLocation(tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"
     FROM inventory_locations
     WHERE "tenantId" = $1::uuid
       AND "isPrimary" = TRUE
     LIMIT 1`,
    [tenantId]
  );
  return normalizeLocation(result.rows[0] || null);
}

async function ensureInventoryBalanceRow(tenantId, productId, locationId, client, options = {}) {
  const initialQuantity = Math.max(0, Number(options.initialQuantity || 0));
  const metadata = JSON.stringify(normalizeMetadata(options.metadata));
  await dbQuery(
    client,
    `INSERT INTO inventory_balances ("tenantId", "productId", "locationId", quantity, metadata, "updatedAt")
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, NOW())
     ON CONFLICT ("tenantId", "productId", "locationId")
     DO NOTHING`,
    [tenantId, productId, locationId, initialQuantity, metadata]
  );

  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", "productId", "locationId", quantity, metadata, "createdAt", "updatedAt"
     FROM inventory_balances
     WHERE "tenantId" = $1::uuid
       AND "productId" = $2::uuid
       AND "locationId" = $3::uuid
     FOR UPDATE`,
    [tenantId, productId, locationId]
  );
  return normalizeBalance(result.rows[0] || null);
}

async function updateInventoryBalanceQuantity(balanceId, tenantId, quantity, metadata, client) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_balances
     SET quantity = $3,
         metadata = COALESCE($4::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id, "tenantId", "productId", "locationId", quantity, metadata, "createdAt", "updatedAt"`,
    [balanceId, tenantId, quantity, metadata === undefined ? null : JSON.stringify(normalizeMetadata(metadata))]
  );
  return normalizeBalance(result.rows[0] || null);
}

async function lockInventoryBalancesByProductIds(tenantId, productIds, locationId, client) {
  const ids = Array.isArray(productIds)
    ? Array.from(new Set(productIds.map((value) => String(value || '').trim()).filter(Boolean))).sort()
    : [];
  if (!ids.length || !locationId) return [];

  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", "productId", "locationId", quantity, metadata, "createdAt", "updatedAt"
     FROM inventory_balances
     WHERE "tenantId" = $1::uuid
       AND "locationId" = $2::uuid
       AND "productId" = ANY($3::uuid[])
     ORDER BY "productId" ASC
     FOR UPDATE`,
    [tenantId, locationId, ids]
  );
  return result.rows.map(normalizeBalance);
}

async function listInventoryBalancesByTenant(tenantId, filters = {}, client = null) {
  const params = [tenantId];
  const productConditions = [
    'p."clinicId" = $1::uuid',
    'p."deletedAt" IS NULL',
    `COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') <> 'lot_based'`
  ];

  if (filters.search) {
    params.push(`%${String(filters.search).trim()}%`);
    productConditions.push(`(
      p.name ILIKE $${params.length}
      OR COALESCE(p.sku, '') ILIKE $${params.length}
      OR COALESCE(p."internalCode", '') ILIKE $${params.length}
      OR COALESCE(p.metadata->'catalog'->>'barcode', '') ILIKE $${params.length}
    )`);
  }

  if (filters.productId) {
    params.push(String(filters.productId).trim());
    productConditions.push(`p.id = $${params.length}::uuid`);
  }

  const inventoryConditions = [];
  if (filters.stockFilter === 'with_stock') {
    inventoryConditions.push('"balanceQuantity" > 0');
  } else if (filters.stockFilter === 'without_stock') {
    inventoryConditions.push('"balanceQuantity" <= 0');
  }

  const pageSize = positiveInteger(filters.pageSize, 50, 100);
  const page = positiveInteger(filters.page, 1);
  params.push(pageSize);
  const limitIndex = params.length;
  params.push((page - 1) * pageSize);
  const offsetIndex = params.length;

  const result = await dbQuery(
    client,
    `WITH primary_location AS (
       SELECT id, name
       FROM inventory_locations
       WHERE "tenantId" = $1::uuid
         AND "isPrimary" = TRUE
       ORDER BY "createdAt" ASC, id ASC
       LIMIT 1
     ),
     product_scope AS (
       SELECT
         p.id,
         p."clinicId",
         p.name,
         p.description,
         p.price,
         p."unitPrice",
         p.currency,
         p."vatRate",
         p.stock,
         p.status,
         p.sku,
         p."internalCode",
         p."categoryId",
         (
           SELECT c.name
           FROM product_categories c
           WHERE c.id = p."categoryId"
             AND c."clinicId" = p."clinicId"
           LIMIT 1
         ) AS "categoryName",
         p.metadata,
         p."createdAt",
         p."updatedAt",
         (SELECT location.id FROM primary_location location) AS "locationId",
         (SELECT location.name FROM primary_location location) AS "locationName",
         COALESCE(
           (
             SELECT b.quantity
             FROM inventory_balances b
             INNER JOIN primary_location location
               ON location.id = b."locationId"
             WHERE b."tenantId" = p."clinicId"
               AND b."productId" = p.id
             ORDER BY b."updatedAt" DESC, b.id DESC
             LIMIT 1
           ),
           p.stock,
           0
         ) AS "balanceQuantity",
         (
           SELECT im."createdAt"
           FROM inventory_movements im
           WHERE im."tenantId" = p."clinicId"
             AND im."productId" = p.id
           ORDER BY im."createdAt" DESC, im.id DESC
           LIMIT 1
         ) AS "lastMovementAt",
         (
           SELECT im."movementType"
           FROM inventory_movements im
           WHERE im."tenantId" = p."clinicId"
             AND im."productId" = p.id
           ORDER BY im."createdAt" DESC, im.id DESC
           LIMIT 1
         ) AS "lastMovementType"
       FROM products p
       WHERE ${productConditions.join(' AND ')}
     ),
     scoped AS (
       SELECT product_scope.*
       FROM product_scope
       ${inventoryConditions.length > 0 ? `WHERE ${inventoryConditions.join(' AND ')}` : ''}
     ),
     aggregated AS (
       SELECT
         COUNT(DISTINCT id)::int AS "totalItems",
         COUNT(DISTINCT id) FILTER (WHERE "balanceQuantity" > 0)::int AS "withStock",
         COUNT(DISTINCT id) FILTER (WHERE "balanceQuantity" <= 0)::int AS "withoutStock"
       FROM scoped
     ),
     paged AS (
       SELECT scoped.*
       FROM scoped
       ORDER BY "internalCode" ASC NULLS LAST, "createdAt" ASC, id ASC
       LIMIT $${limitIndex}
       OFFSET $${offsetIndex}
     )
     SELECT
       paged.*,
       aggregated."totalItems",
       aggregated."withStock",
       aggregated."withoutStock"
     FROM aggregated
     LEFT JOIN paged ON TRUE
     ORDER BY paged."internalCode" ASC NULLS LAST, paged."createdAt" ASC, paged.id ASC`,
    params
  );

  const metadata = result.rows[0] || {};
  const total = Number(metadata.totalItems || 0);
  return {
    page,
    pageSize,
    total,
    summary: {
      totalProducts: total,
      withStock: Number(metadata.withStock || 0),
      withoutStock: Number(metadata.withoutStock || 0)
    },
    rows: result.rows.filter((row) => row && row.id)
  };
}

async function listInventoryMovementsByProductId(tenantId, productId, options = {}, client = null) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 25), 1), 100);
  const page = Math.max(Number(options.page || 1), 1);
  const offset = (page - 1) * pageSize;
  const result = await dbQuery(
    client,
    `SELECT
       im.id,
       im."tenantId",
       im."productId",
       im."lotId",
       im."locationId",
       im."movementType",
       im.quantity,
       im."quantityBefore",
       im."quantityAfter",
       im."referenceType",
       im."referenceId",
       im.reason,
       im.metadata,
       im."createdBy",
       im."createdAt",
       im."idempotencyKey",
       im.unit,
       im.status,
       l.name AS "locationName"
     FROM inventory_movements im
     LEFT JOIN inventory_locations l
       ON l.id = im."locationId"
      AND l."tenantId" = im."tenantId"
     WHERE im."tenantId" = $1::uuid
       AND im."productId" = $2::uuid
     ORDER BY im."createdAt" DESC, im.id DESC
     LIMIT $3
     OFFSET $4`,
    [tenantId, productId, pageSize, offset]
  );

  return result.rows.map(normalizeInventoryMovementRow);
}

async function listInventoryMovementsByTenant(tenantId, filters = {}, client = null) {
  const params = [tenantId];
  const conditions = ['im."tenantId" = $1::uuid'];

  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`im."productId" = $${params.length}::uuid`);
  }

  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`im."locationId" = $${params.length}::uuid`);
  }

  if (filters.movementType) {
    params.push(filters.movementType);
    conditions.push(`im."movementType" = $${params.length}`);
  }

  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`im."createdAt" >= $${params.length}::date`);
  }

  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`im."createdAt" < ($${params.length}::date + INTERVAL '1 day')`);
  }

  if (filters.lotNumber) {
    params.push(`%${String(filters.lotNumber).trim()}%`);
    conditions.push(`COALESCE(l."lotNumber", '') ILIKE $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${String(filters.search).trim()}%`);
    conditions.push(`(
      p.name ILIKE $${params.length}
      OR COALESCE(p.sku, '') ILIKE $${params.length}
      OR COALESCE(p."internalCode", '') ILIKE $${params.length}
      OR COALESCE(l."lotNumber", '') ILIKE $${params.length}
    )`);
  }

  const pageSize = Math.min(Math.max(Number(filters.pageSize || 25), 1), 100);
  const page = Math.max(Number(filters.page || 1), 1);
  params.push(pageSize);
  const limitIndex = params.length;
  params.push((page - 1) * pageSize);
  const offsetIndex = params.length;

  const result = await dbQuery(
    client,
    `WITH scoped AS (
       SELECT
         im.id,
         im."tenantId",
         im."productId",
         p.name AS "productName",
         p.sku AS "productSku",
         p."internalCode",
         im."lotId",
         l."lotNumber",
         im."locationId",
         loc.name AS "locationName",
         im."movementType",
         (
           CASE
             WHEN im."movementType" IN ('sale', 'manual_decrease', 'return_out', 'manual_adjustment_out', 'expired_writeoff', 'cancellation')
               THEN -im.quantity
             ELSE im.quantity
           END
         )::text AS quantity,
         im."quantityBefore"::text AS "quantityBefore",
         im."quantityAfter"::text AS "quantityAfter",
         im."referenceType",
         im."referenceId",
         im.reason,
         im.metadata,
         im."createdBy",
         actor.name AS "actorName",
         im."createdAt",
         im."idempotencyKey",
         im.unit,
         im.status
       FROM inventory_movements im
       INNER JOIN products p
         ON p.id = im."productId"
        AND p."clinicId" = im."tenantId"
       LEFT JOIN inventory_lots l
         ON l.id = im."lotId"
        AND l."tenantId" = im."tenantId"
       LEFT JOIN inventory_locations loc
         ON loc.id = im."locationId"
        AND loc."tenantId" = im."tenantId"
       LEFT JOIN staff_users actor
         ON actor.id = im."createdBy"
       WHERE ${conditions.join(' AND ')}
     ),
     counted AS (
       SELECT COUNT(*)::int AS total FROM scoped
     )
     SELECT scoped.*, counted.total
     FROM scoped
     CROSS JOIN counted
     ORDER BY scoped."createdAt" DESC, scoped.id DESC
     LIMIT $${limitIndex}
     OFFSET $${offsetIndex}`,
    params
  );

  return {
    page,
    pageSize,
    total: Number((result.rows[0] && result.rows[0].total) || 0),
    items: result.rows.map(normalizeInventoryMovementListRow)
  };
}

async function findInventoryMovementByIdempotencyKey(tenantId, movementType, idempotencyKey, client = null) {
  const safeTenantId = String(tenantId || '').trim();
  const safeMovementType = String(movementType || '').trim();
  const safeKey = String(idempotencyKey || '').trim();
  if (!safeTenantId || !safeMovementType || !safeKey) return null;

  const result = await dbQuery(
    client,
    `SELECT
       im.id,
       im."tenantId",
       im."productId",
       im."lotId",
       im."locationId",
       im."movementType",
       im.quantity,
       im."quantityBefore",
       im."quantityAfter",
       im."referenceType",
       im."referenceId",
       im.reason,
       im.metadata,
       im."createdBy",
       im."createdAt",
       im."idempotencyKey",
       im.unit,
       im.status,
       l.name AS "locationName"
     FROM inventory_movements im
     LEFT JOIN inventory_locations l
       ON l.id = im."locationId"
      AND l."tenantId" = im."tenantId"
     WHERE im."tenantId" = $1::uuid
       AND im."movementType" = $2
       AND im."idempotencyKey" = $3
     ORDER BY im."createdAt" DESC, im.id DESC
     LIMIT 1`,
    [safeTenantId, safeMovementType, safeKey]
  );

  return normalizeInventoryMovementRow(result.rows[0] || null);
}

module.exports = {
  reserveNextInternalCodeNumber,
  ensurePrimaryInventoryLocation,
  findPrimaryInventoryLocation,
  ensureInventoryBalanceRow,
  updateInventoryBalanceQuantity,
  lockInventoryBalancesByProductIds,
  listInventoryBalancesByTenant,
  listInventoryMovementsByProductId,
  listInventoryMovementsByTenant,
  findInventoryMovementByIdempotencyKey
};
