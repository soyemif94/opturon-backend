const { query } = require('../db/client');
const {
  calculateInventoryExpirationStatus,
  humanExpirationLabel,
  normalizeDateOnly
} = require('../utils/inventory-expiration');
const { normalizeInventoryMovementTypeForApi } = require('../utils/inventory-movement-types');
const { normalizeLotNumber } = require('../utils/inventory-lot-identity');
const {
  deriveLotDisplayStatus,
  normalizeLotOperationalStatus,
  isLotCommerciallyAvailable,
  resolveLotPhysicalQuantity,
  resolveLotCommercialAvailableQuantity
} = require('../utils/inventory-lot-state');

const LOT_STATUSES = new Set(['active', 'depleted', 'expired', 'quarantined', 'cancelled']);
const LOT_OPERATIONAL_STATUSES = new Set(['active', 'blocked', 'written_off']);
const LOCATION_TYPES = new Set(['main', 'warehouse', 'shelf', 'other']);
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

function normalizeLocation(row) {
  if (!row) return null;
  const metadata = metadataValue(row.metadata);
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    type: String(metadata.type || (row.isPrimary ? 'main' : 'other')).toLowerCase(),
    isPrimary: row.isPrimary === true,
    active: row.active !== false,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeLot(row, options = {}) {
  if (!row) return null;
  const expiration = calculateInventoryExpirationStatus(row.expiresAt, options);
  const committedQuantity = numberValue(row.committedQuantity);
  const operationalStatus = normalizeLotOperationalStatus(row);
  const status = deriveLotDisplayStatus(row);
  const physicalQuantity = resolveLotPhysicalQuantity({ ...row, committedQuantity });
  const availableCommercialQuantity = resolveLotCommercialAvailableQuantity({ ...row, committedQuantity }, expiration.status);

  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    productName: row.productName || null,
    productSku: row.productSku || null,
    lotNumber: row.lotNumber || null,
    normalizedLotNumber: row.normalizedLotNumber || normalizeLotNumber(row.lotNumber),
    supplierName: row.supplierName || null,
    receivedAt: row.receivedAt,
    manufacturedAt: normalizeDateOnly(row.manufacturedAt),
    expiresAt: normalizeDateOnly(row.expiresAt),
    initialQuantity: numberValue(row.initialQuantity),
    availableQuantity: numberValue(row.availableQuantity),
    committedQuantity,
    physicalQuantity,
    availableCommercialQuantity,
    unitCost: row.unitCost == null ? null : numberValue(row.unitCost),
    warehouseName: row.warehouseName || null,
    locationName: row.locationDisplayName || row.locationName || null,
    locationId: row.locationId || null,
    locationCode: row.locationCode || null,
    status,
    legacyStatus: row.status || 'active',
    operationalStatus,
    blockedAt: row.blockedAt || null,
    blockedBy: row.blockedBy || null,
    blockReason: row.blockReason || null,
    writtenOffAt: row.writtenOffAt || null,
    writtenOffBy: row.writtenOffBy || null,
    writeoffReason: row.writeoffReason || null,
    expirationStatus: expiration.status,
    daysUntilExpiration: expiration.daysUntilExpiration,
    expirationLabel: humanExpirationLabel(expiration.daysUntilExpiration, expiration.status),
    notes: row.notes || null,
    metadata: metadataValue(row.metadata),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeMovement(row) {
  if (!row) return null;
  const metadata = metadataValue(row.metadata);
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    lotId: row.lotId || null,
    locationId: row.locationId || null,
    locationName: row.locationName || null,
    movementType: normalizeInventoryMovementTypeForApi(row.movementType),
    quantity: numberValue(row.quantity),
    quantityBefore: row.quantityBefore == null ? null : numberValue(row.quantityBefore),
    quantityAfter: row.quantityAfter == null ? null : numberValue(row.quantityAfter),
    referenceType: row.referenceType || null,
    referenceId: row.referenceId || null,
    reason: row.reason || null,
    metadata,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    idempotencyKey: row.idempotencyKey || null,
    unit: row.unit || null,
    status: row.status || 'posted',
    reversalOfMovementId: row.reversalOfMovementId || null,
    reversedByMovementId: row.reversedByMovementId || null
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
      l."normalizedLotNumber",
      l."supplierName",
      l."receivedAt",
      l."manufacturedAt",
      l."expiresAt",
      l."initialQuantity",
      l."availableQuantity",
      l."unitCost",
      l."warehouseName",
      l."locationName",
      l."locationId",
      l.status,
      l."operationalStatus",
      l."blockedAt",
      l."blockedBy",
      l."blockReason",
      l."writtenOffAt",
      l."writtenOffBy",
      l."writeoffReason",
      l.notes,
      l.metadata,
      l."createdBy",
      l."createdAt",
      l."updatedAt",
      loc.code AS "locationCode",
      loc.name AS "locationDisplayName",
      COALESCE(alloc.committed_quantity, 0) AS "committedQuantity"
    FROM inventory_lots l
    INNER JOIN products p
      ON p.id = l."productId"
     AND p."clinicId" = l."tenantId"
    LEFT JOIN inventory_locations loc
      ON loc.id = l."locationId"
     AND loc."tenantId" = l."tenantId"
    LEFT JOIN (
      SELECT "tenantId", "lotId", COALESCE(SUM(quantity) FILTER (WHERE status = 'allocated'), 0) AS committed_quantity
      FROM inventory_lot_allocations
      GROUP BY "tenantId", "lotId"
    ) alloc
      ON alloc."tenantId" = l."tenantId"
     AND alloc."lotId" = l.id
    ${whereClause}`;
}

function expirationSqlCase(todayParam, thresholds) {
  return `CASE
    WHEN l."expiresAt" IS NULL THEN 'no_expiration'
    WHEN l."expiresAt" < $${todayParam}::date THEN 'expired'
    WHEN l."expiresAt" = $${todayParam}::date THEN 'today'
    WHEN l."expiresAt" <= ($${todayParam}::date + ${Number(thresholds.criticalDays || 3)} * INTERVAL '1 day')::date THEN 'critical'
    WHEN l."expiresAt" <= ($${todayParam}::date + ${Number(thresholds.urgentDays || 7)} * INTERVAL '1 day')::date THEN 'urgent'
    WHEN l."expiresAt" <= ($${todayParam}::date + ${Number(thresholds.warningDays || 15)} * INTERVAL '1 day')::date THEN 'warning'
    WHEN l."expiresAt" <= ($${todayParam}::date + ${Number(thresholds.upcomingDays || 30)} * INTERVAL '1 day')::date THEN 'upcoming'
    ELSE 'normal'
  END`;
}

function addLotFilters(params, conditions, filters = {}) {
  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`l."productId" = $${params.length}::uuid`);
  }
  if (filters.categoryId) {
    params.push(filters.categoryId);
    conditions.push(`p."categoryId" = $${params.length}::uuid`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' WHEN l.status = 'cancelled' THEN 'cancelled' ELSE 'active' END) = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${String(filters.search).trim()}%`);
    conditions.push(`(l."lotNumber" ILIKE $${params.length} OR l."supplierName" ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  if (filters.warehouse) {
    params.push(`%${String(filters.warehouse).trim()}%`);
    conditions.push(`l."warehouseName" ILIKE $${params.length}`);
  }
  if (filters.location) {
    params.push(`%${String(filters.location).trim()}%`);
    conditions.push(`(l."locationName" ILIKE $${params.length} OR loc.name ILIKE $${params.length})`);
  }
  if (filters.locationId) {
    params.push(filters.locationId);
    conditions.push(`l."locationId" = $${params.length}::uuid`);
  }
  if (filters.supplier) {
    params.push(`%${String(filters.supplier).trim()}%`);
    conditions.push(`l."supplierName" ILIKE $${params.length}`);
  }
  if (filters.expiresBefore) {
    params.push(filters.expiresBefore);
    conditions.push(`l."expiresAt" <= $${params.length}::date`);
  }
  if (filters.expiresAfter) {
    params.push(filters.expiresAfter);
    conditions.push(`l."expiresAt" >= $${params.length}::date`);
  }
  if (filters.hasStock === true || filters.hasStock === 'true') {
    conditions.push(`l."availableQuantity" > 0`);
  } else if (filters.hasStock === false || filters.hasStock === 'false') {
    conditions.push(`l."availableQuantity" <= 0`);
  }
}

async function listInventoryLots(tenantId, filters = {}, client = null) {
  const params = [tenantId];
  const conditions = ['l."tenantId" = $1::uuid'];
  const todayISO = filters.todayISO || new Date().toISOString().slice(0, 10);
  params.push(todayISO);
  const todayParam = params.length;
  const thresholds = filters.thresholds || {};
  const expirationCase = expirationSqlCase(todayParam, thresholds);

  addLotFilters(params, conditions, filters);
  if (filters.expirationStatus) {
    params.push(filters.expirationStatus);
    conditions.push(`${expirationCase} = $${params.length}`);
  }

  const pageSize = Math.min(Math.max(Number(filters.pageSize || 100), 1), 250);
  params.push(pageSize);
  const limitIndex = params.length;

  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE ${conditions.join(' AND ')}`)}
     ORDER BY
       CASE ${expirationCase}
         WHEN 'expired' THEN 0
         WHEN 'today' THEN 1
         WHEN 'critical' THEN 2
         WHEN 'urgent' THEN 3
         WHEN 'warning' THEN 4
         WHEN 'upcoming' THEN 5
         WHEN 'normal' THEN 6
         ELSE 7
       END ASC,
       CASE WHEN l."expiresAt" IS NULL THEN 999999 ELSE (l."expiresAt" - $${todayParam}::date) END ASC,
       l."availableQuantity" DESC,
       l."receivedAt" ASC NULLS LAST,
       l."createdAt" ASC
     LIMIT $${limitIndex}`,
    params
  );

  return result.rows.map((row) => normalizeLot(row, { todayISO, thresholds }));
}

async function findInventoryLotById(lotId, tenantId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `${buildLotSelect('WHERE l.id = $1::uuid AND l."tenantId" = $2::uuid')}
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE OF l' : ''}`,
    [lotId, tenantId]
  );
  return normalizeLot(result.rows[0], options);
}

async function findPhysicalInventoryLot(input, client = null, options = {}) {
  const normalizedLotNumber = normalizeLotNumber(input.lotNumber);
  if (!input.tenantId || !input.productId || !normalizedLotNumber) return null;
  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE l."tenantId" = $1::uuid
       AND l."productId" = $2::uuid
       AND l."locationId" IS NOT DISTINCT FROM $3::uuid
       AND l."normalizedLotNumber" = $4
       AND l."expiresAt" IS NOT DISTINCT FROM $5::date`)}
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE OF l' : ''}`,
    [input.tenantId, input.productId, input.locationId, normalizedLotNumber, input.expiresAt || null]
  );
  return normalizeLot(result.rows[0], options);
}

async function findConflictingInventoryLot(input, client = null, options = {}) {
  const normalizedLotNumber = normalizeLotNumber(input.lotNumber);
  if (!input.tenantId || !input.productId || !normalizedLotNumber) return null;
  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE l."tenantId" = $1::uuid
       AND l."productId" = $2::uuid
       AND l."locationId" IS NOT DISTINCT FROM $3::uuid
       AND l."normalizedLotNumber" = $4`)}
     ORDER BY l."createdAt" ASC
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE OF l' : ''}`,
    [input.tenantId, input.productId, input.locationId, normalizedLotNumber]
  );
  return normalizeLot(result.rows[0], options);
}

async function getInventoryExpirationSummary(tenantId, options = {}, client = null) {
  const todayISO = options.todayISO || new Date().toISOString().slice(0, 10);
  const thresholds = options.thresholds || {};
  const result = await dbQuery(
    client,
    `WITH classified AS (
       SELECT
         ${expirationSqlCase(2, thresholds)} AS expiration_status,
         l."availableQuantity",
         l.status,
         l."operationalStatus",
         l."locationId"
       FROM inventory_lots l
       INNER JOIN products p
         ON p.id = l."productId"
        AND p."clinicId" = l."tenantId"
       WHERE l."tenantId" = $1::uuid
     )
     SELECT
       COUNT(*) FILTER (WHERE expiration_status = 'expired')::int AS "expiredLots",
       COUNT(*) FILTER (WHERE expiration_status = 'today')::int AS "expiringTodayLots",
       COUNT(*) FILTER (WHERE expiration_status = 'critical')::int AS "criticalLots",
       COUNT(*) FILTER (WHERE expiration_status = 'urgent')::int AS "urgentLots",
       COUNT(*) FILTER (WHERE expiration_status = 'warning')::int AS "warningLots",
       COUNT(*) FILTER (WHERE expiration_status = 'upcoming')::int AS "upcomingLots",
       COUNT(*) FILTER (WHERE COALESCE("operationalStatus", CASE WHEN status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'blocked')::int AS "blockedLots",
       COUNT(*) FILTER (WHERE "availableQuantity" > 0 AND expiration_status = 'expired')::int AS "stockOnlyExpiredLots",
       COUNT(*) FILTER (WHERE "availableQuantity" > 0 AND expiration_status <> 'expired' AND status = 'active' AND "operationalStatus" IS NULL AND FALSE)::int AS "inconsistentLots",
       COALESCE(SUM("availableQuantity") FILTER (
         WHERE expiration_status IN ('expired', 'today', 'critical', 'urgent')
           AND "availableQuantity" > 0
           AND status NOT IN ('cancelled', 'depleted', 'quarantined')
           AND COALESCE("operationalStatus", 'active') <> 'written_off'
       ), 0)::numeric AS "unitsAtRisk7Days",
       COALESCE(SUM("availableQuantity") FILTER (
         WHERE expiration_status = 'expired'
           AND "availableQuantity" > 0
           AND status NOT IN ('cancelled', 'depleted', 'quarantined')
           AND COALESCE("operationalStatus", 'active') <> 'written_off'
       ), 0)::numeric AS "unitsExpired",
       COALESCE(SUM("availableQuantity") FILTER (
         WHERE expiration_status IN ('expired', 'today', 'critical', 'urgent', 'warning', 'upcoming')
           AND "availableQuantity" > 0
           AND status NOT IN ('cancelled', 'depleted', 'quarantined')
           AND COALESCE("operationalStatus", 'active') <> 'written_off'
       ), 0)::numeric AS "unitsAtRisk30Days",
       COUNT(*) FILTER (WHERE "locationId" IS NULL)::int AS "lotsWithoutLocation"
     FROM classified`,
    [tenantId, todayISO]
  );

  const row = result.rows[0] || {};
  return {
    expiredLots: Number(row.expiredLots || 0),
    expiringTodayLots: Number(row.expiringTodayLots || 0),
    criticalLots: Number(row.criticalLots || 0),
    urgentLots: Number(row.urgentLots || 0),
    warningLots: Number(row.warningLots || 0),
    upcomingLots: Number(row.upcomingLots || 0),
    blockedLots: Number(row.blockedLots || 0),
    stockOnlyExpiredLots: Number(row.stockOnlyExpiredLots || 0),
    inconsistentLots: Number(row.inconsistentLots || 0),
    lotsWithoutLocation: Number(row.lotsWithoutLocation || 0),
    unitsAtRisk7Days: numberValue(row.unitsAtRisk7Days),
    unitsExpired: numberValue(row.unitsExpired),
    unitsAtRisk30Days: numberValue(row.unitsAtRisk30Days)
  };
}

async function createInventoryLot(input, client = null) {
  const normalizedLotNumber = normalizeLotNumber(input.lotNumber);
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_lots (
       "tenantId",
       "productId",
       "lotNumber",
       "normalizedLotNumber",
       "supplierName",
       "receivedAt",
       "manufacturedAt",
       "expiresAt",
       "initialQuantity",
       "availableQuantity",
       "unitCost",
       "warehouseName",
       "locationName",
       "locationId",
       status,
       "operationalStatus",
       notes,
       metadata,
       "createdBy",
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::date, $8::date, $9, $10, $11, $12, $13, $14::uuid, $15, $16, $17, $18::jsonb, $19::uuid, NOW())
     RETURNING id`,
    [
      input.tenantId,
      input.productId,
      input.lotNumber || null,
      normalizedLotNumber,
      input.supplierName || null,
      input.receivedAt || null,
      input.manufacturedAt || null,
      input.expiresAt || null,
      input.initialQuantity,
      input.availableQuantity,
      input.unitCost == null ? null : input.unitCost,
      input.warehouseName || null,
      input.locationName || null,
      input.locationId || null,
      input.status || 'active',
      input.operationalStatus || 'active',
      input.notes || null,
      JSON.stringify(metadataValue(input.metadata)),
      input.createdBy || null
    ]
  );
  return findInventoryLotById(result.rows[0].id, input.tenantId, client);
}

async function incrementInventoryLot(lotId, tenantId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_lots
     SET "availableQuantity" = "availableQuantity" + $3,
         "updatedAt" = NOW(),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{cumulativeReceivedQuantity}',
           to_jsonb(COALESCE((metadata->>'cumulativeReceivedQuantity')::numeric, "initialQuantity") + $3),
           true
         )
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id`,
    [lotId, tenantId, input.incrementQuantity]
  );
  if (!result.rows[0]) return null;
  return findInventoryLotById(lotId, tenantId, client);
}

async function updateInventoryLotState(lotId, tenantId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_lots
     SET "availableQuantity" = COALESCE($3, "availableQuantity"),
         status = COALESCE($4, status),
         "operationalStatus" = COALESCE($5, "operationalStatus"),
         notes = COALESCE($6, notes),
         metadata = COALESCE($7::jsonb, metadata),
         "locationId" = COALESCE($8::uuid, "locationId"),
         "expiresAt" = CASE WHEN $16::boolean THEN NULL ELSE COALESCE($9::date, "expiresAt") END,
         "blockedAt" = CASE WHEN $17::boolean THEN NULL ELSE COALESCE($10::timestamptz, "blockedAt") END,
         "blockedBy" = CASE WHEN $17::boolean THEN NULL ELSE COALESCE($11::uuid, "blockedBy") END,
         "blockReason" = CASE WHEN $17::boolean THEN NULL ELSE COALESCE($12, "blockReason") END,
         "writtenOffAt" = CASE WHEN $18::boolean THEN NULL ELSE COALESCE($13::timestamptz, "writtenOffAt") END,
         "writtenOffBy" = CASE WHEN $18::boolean THEN NULL ELSE COALESCE($14::uuid, "writtenOffBy") END,
         "writeoffReason" = CASE WHEN $18::boolean THEN NULL ELSE COALESCE($15, "writeoffReason") END,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id`,
    [
      lotId,
      tenantId,
      input.availableQuantity === undefined ? null : input.availableQuantity,
      input.status || null,
      input.operationalStatus === undefined ? null : input.operationalStatus,
      input.notes === undefined ? null : input.notes,
      input.metadata === undefined ? null : JSON.stringify(metadataValue(input.metadata)),
      input.locationId || null,
      input.expiresAt === undefined ? null : input.expiresAt,
      input.blockedAt === undefined ? null : input.blockedAt,
      input.blockedBy === undefined ? null : input.blockedBy,
      input.blockReason === undefined ? null : input.blockReason,
      input.writtenOffAt === undefined ? null : input.writtenOffAt,
      input.writtenOffBy === undefined ? null : input.writtenOffBy,
      input.writeoffReason === undefined ? null : input.writeoffReason,
      input.clearExpiresAt === true,
      input.clearBlock === true,
      input.clearWriteoff === true
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
       "locationId",
       "movementType",
       quantity,
       "quantityBefore",
       "quantityAfter",
       "referenceType",
       "referenceId",
       reason,
       metadata,
       "createdBy",
       "idempotencyKey",
       unit,
       status,
       "reversalOfMovementId",
       "reversedByMovementId"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb, $13::uuid, $14, $15, $16, $17::uuid, $18::uuid)
     RETURNING *`,
    [
      input.tenantId,
      input.productId,
      input.lotId || null,
      input.locationId || null,
      input.movementType,
      input.quantity,
      input.quantityBefore == null ? null : input.quantityBefore,
      input.quantityAfter == null ? null : input.quantityAfter,
      input.referenceType || null,
      input.referenceId || null,
      input.reason || null,
      JSON.stringify(metadataValue(input.metadata)),
      input.createdBy || null,
      input.idempotencyKey || null,
      input.unit || null,
      input.status || 'posted',
      input.reversalOfMovementId || null,
      input.reversedByMovementId || null
    ]
  );
  return normalizeMovement(result.rows[0]);
}

async function listInventoryMovementsForLot(lotId, tenantId, client = null, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 100), 1), 250);
  const offset = Math.max(Number(options.offset || 0), 0);
  const result = await dbQuery(
    client,
    `SELECT im.*, l.name AS "locationName"
     FROM inventory_movements im
     LEFT JOIN inventory_locations l
       ON l.id = im."locationId"
      AND l."tenantId" = im."tenantId"
     WHERE im."tenantId" = $1::uuid
       AND im."lotId" = $2::uuid
     ORDER BY im."createdAt" DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, lotId, pageSize, offset]
  );
  return result.rows.map(normalizeMovement);
}

async function listInventoryLotHistory(tenantId, lotId, options = {}, client = null) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 25), 1), 100);
  const offset = Math.max(Number(options.offset || 0), 0);
  const result = await dbQuery(
    client,
    `WITH history AS (
       SELECT
         im.id,
         'movement' AS kind,
         normalize_inventory_type."movementType" AS type,
         im.quantity,
         im."quantityBefore",
         im."quantityAfter",
         im.reason,
         im.metadata,
         im."createdBy",
         im."createdAt",
         loc.name AS "locationName"
       FROM inventory_movements im
       LEFT JOIN inventory_locations loc
         ON loc.id = im."locationId"
        AND loc."tenantId" = im."tenantId"
       CROSS JOIN LATERAL (
         SELECT im."movementType"
       ) normalize_inventory_type
       WHERE im."tenantId" = $1::uuid
         AND im."lotId" = $2::uuid

       UNION ALL

       SELECT
         op.id,
         'operation' AS kind,
         op."operationType" AS type,
         NULL::numeric AS quantity,
         NULL::numeric AS "quantityBefore",
         NULL::numeric AS "quantityAfter",
         COALESCE(op.result->>'reason', op."failureCode") AS reason,
         jsonb_build_object(
           'status', op.status,
           'idempotencyKey', op."idempotencyKey",
           'requestMetadata', op."requestMetadata",
           'result', op.result
         ) AS metadata,
         op."createdBy",
         COALESCE(op."completedAt", op."createdAt") AS "createdAt",
         NULL::text AS "locationName"
       FROM inventory_lot_operations op
       WHERE op."tenantId" = $1::uuid
         AND op."lotId" = $2::uuid
         AND (
           op.status = 'failed'
           OR op."operationType" IN ('block', 'unblock', 'change_expiration')
         )
     )
     SELECT *
     FROM history
     ORDER BY "createdAt" DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, lotId, pageSize, offset]
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    type: normalizeInventoryMovementTypeForApi(row.type),
    quantity: row.quantity == null ? null : numberValue(row.quantity),
    quantityBefore: row.quantityBefore == null ? null : numberValue(row.quantityBefore),
    quantityAfter: row.quantityAfter == null ? null : numberValue(row.quantityAfter),
    reason: row.reason || null,
    metadata: metadataValue(row.metadata),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    locationName: row.locationName || null
  }));
}

async function sumActiveLotStockByProductId(productId, tenantId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `SELECT COALESCE(SUM("availableQuantity"), 0) AS stock
     FROM inventory_lots
     WHERE "tenantId" = $1::uuid
       AND "productId" = $2::uuid
       AND status <> 'cancelled'
       AND COALESCE("operationalStatus", CASE WHEN status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'
       AND ("expiresAt" IS NULL OR "expiresAt" >= COALESCE($3::date, CURRENT_DATE))`,
    [tenantId, productId, options.todayISO || null]
  );
  return numberValue(result.rows[0] && result.rows[0].stock);
}

async function syncProductStockFromLots(productId, tenantId, client = null, options = {}) {
  const stock = await sumActiveLotStockByProductId(productId, tenantId, client, options);
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

async function listEligibleLotsForFefo(tenantId, productId, client = null, options = {}) {
  const todayISO = options.todayISO || null;
  // Legacy FEFO baseline retained for compatibility checks:
  // AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)
  const result = await dbQuery(
    client,
    `${buildLotSelect(`WHERE l."tenantId" = $1::uuid
       AND l."productId" = $2::uuid
       AND l.status <> 'cancelled'
       AND COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'
       AND l."availableQuantity" > 0
       AND (l."expiresAt" IS NULL OR l."expiresAt" >= COALESCE($3::date, CURRENT_DATE))`)}
     ORDER BY
       CASE WHEN l."expiresAt" IS NULL THEN 1 ELSE 0 END ASC,
       l."expiresAt" ASC NULLS LAST,
       l."receivedAt" ASC,
       l.id ASC
     FOR UPDATE OF l`,
    [tenantId, productId, todayISO]
  );
  return result.rows.map((row) => normalizeLot(row, options));
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

async function listInventoryLocations(tenantId, filters = {}, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"
     FROM inventory_locations
     WHERE "tenantId" = $1::uuid
       ${filters.activeOnly ? 'AND active = TRUE' : ''}
     ORDER BY "isPrimary" DESC, active DESC, name ASC`,
    [tenantId]
  );
  return result.rows.map(normalizeLocation);
}

async function findInventoryLocationById(locationId, tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"
     FROM inventory_locations
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     LIMIT 1`,
    [locationId, tenantId]
  );
  return normalizeLocation(result.rows[0] || null);
}

async function createInventoryLocation(input, client = null) {
  const metadata = metadataValue(input.metadata);
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_locations ("tenantId", code, name, "isPrimary", active, metadata, "updatedAt")
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, NOW())
     RETURNING id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"`,
    [
      input.tenantId,
      input.code,
      input.name,
      input.isPrimary === true,
      input.active !== false,
      JSON.stringify({
        ...metadata,
        type: LOCATION_TYPES.has(String(input.type || '').toLowerCase()) ? String(input.type).toLowerCase() : 'other'
      })
    ]
  );
  return normalizeLocation(result.rows[0]);
}

async function updateInventoryLocation(locationId, tenantId, patch, client = null) {
  const current = await findInventoryLocationById(locationId, tenantId, client);
  if (!current) return null;
  const result = await dbQuery(
    client,
    `UPDATE inventory_locations
     SET code = COALESCE($3, code),
         name = COALESCE($4, name),
         active = COALESCE($5, active),
         metadata = COALESCE($6::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"`,
    [
      locationId,
      tenantId,
      patch.code || null,
      patch.name || null,
      patch.active === undefined ? null : patch.active,
      patch.metadata === undefined
        ? null
        : JSON.stringify({
            ...current.metadata,
            ...metadataValue(patch.metadata)
          })
    ]
  );
  return normalizeLocation(result.rows[0] || null);
}

async function getInventoryLocationUsageSummary(locationId, tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       (SELECT COUNT(*) FROM inventory_lots WHERE "tenantId" = $2::uuid AND "locationId" = $1::uuid AND "availableQuantity" > 0 AND status <> 'cancelled') AS "activeLots",
       (SELECT COUNT(*) FROM inventory_balances WHERE "tenantId" = $2::uuid AND "locationId" = $1::uuid AND quantity > 0) AS "activeBalances",
       (SELECT COUNT(*) FROM inventory_movements WHERE "tenantId" = $2::uuid AND "locationId" = $1::uuid) AS movements`,
    [locationId, tenantId]
  );
  const row = result.rows[0] || {};
  return {
    activeLots: Number(row.activeLots || 0),
    activeBalances: Number(row.activeBalances || 0),
    movements: Number(row.movements || 0)
  };
}

module.exports = {
  LOT_STATUSES: Array.from(LOT_STATUSES),
  LOT_OPERATIONAL_STATUSES: Array.from(LOT_OPERATIONAL_STATUSES),
  MOVEMENT_TYPES: Array.from(MOVEMENT_TYPES),
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
  sumActiveLotStockByProductId,
  syncProductStockFromLots,
  setProductInventoryTrackingMode,
  listEligibleLotsForFefo,
  updateInventoryLotQuantity,
  createInventoryLotAllocation,
  listInventoryLotAllocationsByOrder,
  markInventoryLotAllocationsReleased,
  listInventoryLocations,
  findInventoryLocationById,
  createInventoryLocation,
  updateInventoryLocation,
  getInventoryLocationUsageSummary
};
