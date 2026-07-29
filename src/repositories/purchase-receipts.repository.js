const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeNumericString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function normalizeSupplier(row) {
  if (!row || !row.supplierId) return null;
  const legalName = normalizeString(row.supplierLegalName);
  const tradeName = normalizeNullableString(row.supplierTradeName);
  return {
    id: row.supplierId,
    legalName,
    tradeName,
    displayName: tradeName || legalName,
    status: row.supplierStatus || 'active'
  };
}

function normalizeLocation(row) {
  if (!row || !row.locationId) return null;
  return {
    id: row.locationId,
    code: row.locationCode || null,
    name: row.locationName || null,
    active: row.locationActive !== false
  };
}

function normalizeReceiptListItem(row) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    documentNumber: row.documentNumber || null,
    receivedAt: row.receivedAt,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    supplier: normalizeSupplier(row),
    location: normalizeLocation(row),
    itemCount: Number(row.itemCount || 0),
    totalQuantity: normalizeNumericString(row.totalQuantity) || '0',
    totalCost: normalizeNumericString(row.totalCost)
  };
}

function normalizeReceiptHeader(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    supplierId: row.supplierId,
    locationId: row.locationId,
    documentNumber: row.documentNumber || null,
    receivedAt: row.receivedAt,
    notes: row.notes || null,
    idempotencyKey: row.idempotencyKey,
    metadata: normalizeMetadata(row.metadata),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    supplier: normalizeSupplier(row),
    location: normalizeLocation(row),
    actor: row.actorUserId
      ? {
          id: row.actorUserId,
          name: row.actorName || null,
          email: row.actorEmail || null
        }
      : null
  };
}

function normalizeReceiptItem(row) {
  return {
    id: row.id,
    receiptId: row.receiptId,
    tenantId: row.tenantId,
    productId: row.productId,
    quantity: normalizeNumericString(row.quantity) || '0',
    unitCost: normalizeNumericString(row.unitCost),
    lotNumber: row.lotNumber || null,
    normalizedLotNumber: row.normalizedLotNumber || null,
    expiresAt: row.expiresAt || null,
    inventoryLotId: row.inventoryLotId || null,
    inventoryMovementId: row.inventoryMovementId || null,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.createdAt,
    product: {
      id: row.productId,
      name: row.productName || null,
      internalCode: row.productInternalCode || null,
      sku: row.productSku || null,
      inventoryTrackingMode: row.productInventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy'
    }
  };
}

async function findByTenantAndIdempotencyKey(tenantId, idempotencyKey, client = null) {
  if (!tenantId || !idempotencyKey) return null;
  const result = await dbQuery(
    client,
    `SELECT
       pr.id,
       pr."tenantId",
       pr."supplierId",
       pr."locationId",
       pr."documentNumber",
       pr."receivedAt",
       pr.notes,
       pr."idempotencyKey",
       pr.metadata,
       pr."createdBy",
       pr."createdAt",
       pr."confirmedAt"
     FROM purchase_receipts pr
     WHERE pr."tenantId" = $1::uuid
       AND pr."idempotencyKey" = $2
     LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  return normalizeReceiptHeader(result.rows[0] || null);
}

async function insertReceipt(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO purchase_receipts (
       id,
       "tenantId",
       "supplierId",
       "locationId",
       "documentNumber",
       "receivedAt",
       notes,
       "idempotencyKey",
       metadata,
       "createdBy",
       "createdAt",
       "confirmedAt"
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5,
       $6::timestamptz,
       $7,
       $8,
       $9::jsonb,
       $10::uuid,
       COALESCE($11::timestamptz, NOW()),
       COALESCE($12::timestamptz, NOW())
     )
     ON CONFLICT ("tenantId", "idempotencyKey") DO NOTHING
     RETURNING id`,
    [
      input.id,
      input.tenantId,
      input.supplierId,
      input.locationId,
      input.documentNumber || null,
      input.receivedAt,
      input.notes || null,
      input.idempotencyKey,
      JSON.stringify(normalizeMetadata(input.metadata)),
      input.createdBy || null,
      input.createdAt || null,
      input.confirmedAt || null
    ]
  );
  if (!result.rows[0]) return null;
  return findReceiptDetailByTenantAndId(input.tenantId, input.id, client);
}

async function insertReceiptItem(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO purchase_receipt_items (
       id,
       "receiptId",
       "tenantId",
       "productId",
       quantity,
       "unitCost",
       "lotNumber",
       "normalizedLotNumber",
       "expiresAt",
       "inventoryLotId",
       "inventoryMovementId",
       metadata,
       "createdAt"
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5,
       $6,
       $7,
       $8,
       $9::date,
       $10::uuid,
       $11::uuid,
       $12::jsonb,
       COALESCE($13::timestamptz, NOW())
     )
     RETURNING id`,
    [
      input.id,
      input.receiptId,
      input.tenantId,
      input.productId,
      input.quantity,
      input.unitCost == null ? null : input.unitCost,
      input.lotNumber || null,
      input.normalizedLotNumber || null,
      input.expiresAt || null,
      input.inventoryLotId || null,
      input.inventoryMovementId || null,
      JSON.stringify(normalizeMetadata(input.metadata)),
      input.createdAt || null
    ]
  );
  return Boolean(result.rows[0]);
}

async function listReceiptsByTenant(tenantId, filters = {}, client = null) {
  const params = [tenantId];
  const conditions = ['pr."tenantId" = $1::uuid'];

  if (filters.supplierId) {
    params.push(filters.supplierId);
    conditions.push(`pr."supplierId" = $${params.length}::uuid`);
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`pr."locationId" = $${params.length}::uuid`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`pr."receivedAt" >= $${params.length}::timestamptz`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`pr."receivedAt" <= $${params.length}::timestamptz`);
  }

  const page = Number(filters.page || 1);
  const pageSize = Number(filters.pageSize || 20);
  params.push(pageSize);
  const limitIndex = params.length;
  params.push((page - 1) * pageSize);
  const offsetIndex = params.length;

  const orderBy = filters.sort === 'receivedAt_asc'
    ? `scoped."receivedAt" ASC, scoped."createdAt" ASC, scoped.id ASC`
    : `scoped."receivedAt" DESC, scoped."createdAt" DESC, scoped.id DESC`;

  const result = await dbQuery(
    client,
    `WITH scoped AS (
       SELECT
         pr.id,
         pr."tenantId",
         pr."supplierId" AS "supplierId",
         s."legalName" AS "supplierLegalName",
         s."tradeName" AS "supplierTradeName",
         s.status AS "supplierStatus",
         pr."locationId" AS "locationId",
         loc.code AS "locationCode",
         loc.name AS "locationName",
         loc.active AS "locationActive",
         pr."documentNumber",
         pr."receivedAt",
         pr."confirmedAt",
         pr."createdAt",
         COUNT(pri.id)::int AS "itemCount",
         COALESCE(SUM(pri.quantity), 0)::text AS "totalQuantity",
         CASE
           WHEN COUNT(*) FILTER (WHERE pri."unitCost" IS NOT NULL) = 0 THEN NULL
           ELSE ROUND(COALESCE(SUM(pri.quantity * pri."unitCost") FILTER (WHERE pri."unitCost" IS NOT NULL), 0), 4)::text
         END AS "totalCost"
       FROM purchase_receipts pr
       INNER JOIN suppliers s
         ON s.id = pr."supplierId"
        AND s."tenantId" = pr."tenantId"
       INNER JOIN inventory_locations loc
         ON loc.id = pr."locationId"
        AND loc."tenantId" = pr."tenantId"
       INNER JOIN purchase_receipt_items pri
         ON pri."receiptId" = pr.id
        AND pri."tenantId" = pr."tenantId"
       WHERE ${conditions.join(' AND ')}
       GROUP BY
         pr.id,
         pr."tenantId",
         pr."supplierId",
         s."legalName",
         s."tradeName",
         s.status,
         pr."locationId",
         loc.code,
         loc.name,
         loc.active,
         pr."documentNumber",
         pr."receivedAt",
         pr."confirmedAt",
         pr."createdAt"
     ),
     counted AS (
       SELECT COUNT(*)::int AS total FROM scoped
     )
     SELECT scoped.*, counted.total
     FROM scoped
     CROSS JOIN counted
     ORDER BY ${orderBy}
     LIMIT $${limitIndex}
     OFFSET $${offsetIndex}`,
    params
  );

  return {
    items: result.rows.map(normalizeReceiptListItem),
    total: Number(result.rows[0] && result.rows[0].total || 0),
    page,
    pageSize
  };
}

async function findReceiptDetailByTenantAndId(tenantId, receiptId, client = null) {
  const headerResult = await dbQuery(
    client,
    `SELECT
       pr.id,
       pr."tenantId",
       pr."supplierId" AS "supplierId",
       s."legalName" AS "supplierLegalName",
       s."tradeName" AS "supplierTradeName",
       s.status AS "supplierStatus",
       pr."locationId" AS "locationId",
       loc.code AS "locationCode",
       loc.name AS "locationName",
       loc.active AS "locationActive",
       pr."documentNumber",
       pr."receivedAt",
       pr.notes,
       pr."idempotencyKey",
       pr.metadata,
       pr."createdBy",
       pr."createdAt",
       pr."confirmedAt",
       actor.id AS "actorUserId",
       actor.name AS "actorName",
       actor.email AS "actorEmail"
     FROM purchase_receipts pr
     INNER JOIN suppliers s
       ON s.id = pr."supplierId"
      AND s."tenantId" = pr."tenantId"
     INNER JOIN inventory_locations loc
       ON loc.id = pr."locationId"
      AND loc."tenantId" = pr."tenantId"
     LEFT JOIN staff_users actor
       ON actor.id = pr."createdBy"
     WHERE pr.id = $1::uuid
       AND pr."tenantId" = $2::uuid
     LIMIT 1`,
    [receiptId, tenantId]
  );

  const header = normalizeReceiptHeader(headerResult.rows[0] || null);
  if (!header) return null;

  const itemsResult = await dbQuery(
    client,
    `SELECT
       pri.id,
       pri."receiptId" AS "receiptId",
       pri."tenantId" AS "tenantId",
       pri."productId" AS "productId",
       pri.quantity,
       pri."unitCost",
       pri."lotNumber",
       pri."normalizedLotNumber",
       pri."expiresAt",
       pri."inventoryLotId",
       pri."inventoryMovementId",
       pri.metadata,
       pri."createdAt",
       p.name AS "productName",
       p."internalCode" AS "productInternalCode",
       p.sku AS "productSku",
       COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') AS "productInventoryTrackingMode"
     FROM purchase_receipt_items pri
     INNER JOIN products p
       ON p.id = pri."productId"
      AND p."clinicId" = pri."tenantId"
     WHERE pri."receiptId" = $1::uuid
       AND pri."tenantId" = $2::uuid
     ORDER BY pri."createdAt" ASC, pri.id ASC`,
    [receiptId, tenantId]
  );

  const items = itemsResult.rows.map(normalizeReceiptItem);
  const summaryResult = await dbQuery(
    client,
    `SELECT
       COUNT(*)::int AS "itemCount",
       COALESCE(SUM(pri.quantity), 0)::text AS "totalQuantity",
       CASE
         WHEN COUNT(*) FILTER (WHERE pri."unitCost" IS NOT NULL) = 0 THEN NULL
         ELSE ROUND(COALESCE(SUM(pri.quantity * pri."unitCost") FILTER (WHERE pri."unitCost" IS NOT NULL), 0), 4)::text
       END AS "totalCost"
     FROM purchase_receipt_items pri
     WHERE pri."receiptId" = $1::uuid
       AND pri."tenantId" = $2::uuid`,
    [receiptId, tenantId]
  );
  const summaryRow = summaryResult.rows[0] || {};

  return {
    ...header,
    items,
    summary: {
      itemCount: Number(summaryRow.itemCount || items.length || 0),
      totalQuantity: normalizeNumericString(summaryRow.totalQuantity) || '0.000',
      totalCost: normalizeNumericString(summaryRow.totalCost)
    }
  };
}

module.exports = {
  findByTenantAndIdempotencyKey,
  insertReceipt,
  insertReceiptItem,
  listReceiptsByTenant,
  findReceiptDetailByTenantAndId
};
