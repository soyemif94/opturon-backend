const { detectInventoryLotSchemaCapabilities } = require('../../src/utils/inventory-lot-schema-capabilities');
const { beginReadOnlyTransaction, readOnlyQuery } = require('./postgres-cli');
const { summarizeProductStockDivergence, shorten: shortenValue } = require('./inventory-lot-stock-divergence');

function parseArgs(argv) {
  const options = { apply: false, readOnly: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'apply') {
      options.apply = true;
      options.readOnly = false;
      continue;
    }
    if (key === 'read-only') {
      options.readOnly = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function shorten(value) {
  return shortenValue(value);
}

function toNumber(value) {
  return Number(value || 0);
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

async function listVisibleClientTenantIds(client, args = {}) {
  if (args.tenant) return [args.tenant];
  const result = await readOnlyQuery(
    client,
    `SELECT c.id
     FROM clinics c
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::INT AS "activePortalUsers",
              COUNT(*) FILTER (WHERE su.role = 'owner')::INT AS "activeOwners"
       FROM staff_users su
       WHERE su."clinicId" = c.id
         AND su."accountType" = 'client_portal'
         AND su.email IS NOT NULL
         AND su.active = TRUE
     ) membership ON TRUE
     WHERE NULLIF(TRIM(COALESCE(c."externalTenantId", '')), '') IS NOT NULL
       AND COALESCE(c.settings->'portal'->>'accountScope', '') <> 'opturon_admin'
       AND COALESCE(c.settings->'portal'->'lifecycle'->>'status', c.settings->'portal'->>'status', c.settings->>'status', 'active')
         NOT IN ('archived', 'deleted', 'inactive', 'cancelled')
       AND NULLIF(COALESCE(c.settings->'portal'->'lifecycle'->>'archivedAt', c.settings->'portal'->>'archivedAt', c.settings->>'archivedAt', ''), '') IS NULL
       AND NULLIF(COALESCE(c.settings->'portal'->'lifecycle'->>'deletedAt', c.settings->'portal'->>'deletedAt', c.settings->>'deletedAt', ''), '') IS NULL
       AND COALESCE(membership."activePortalUsers", 0) > 0
       AND COALESCE(membership."activeOwners", 0) > 0
     ORDER BY c."createdAt" ASC, c.id ASC`
  );
  return result.rows.map((row) => row.id);
}

function buildCheck({ name, count = 0, confidence = 'exact', status, requiredMigration = null }) {
  const numericCount = toNumber(count);
  return {
    name,
    status: status || (numericCount > 0 ? 'findings' : 'passed'),
    count: numericCount,
    confidence,
    requiredMigration
  };
}

function buildSkippedCheck(name, confidence, requiredMigration) {
  return buildCheck({
    name,
    count: 0,
    confidence,
    status: 'skipped_schema_not_available',
    requiredMigration
  });
}

function getStockAvailabilityPredicate(capabilities) {
  if (capabilities.hasOperationalStatus) {
    return `COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'`;
  }
  return `COALESCE(l.status, 'active') NOT IN ('cancelled', 'quarantined', 'depleted')`;
}

async function fetchScalarCount(client, sql, params = []) {
  const result = await readOnlyQuery(client, sql, params);
  const row = result.rows[0] || {};
  return toNumber(row.count || row.total || row.value || 0);
}

async function listDivergentLotBasedProducts(client, tenantIds, capabilities) {
  const activePredicate = getStockAvailabilityPredicate(capabilities);
  const result = await readOnlyQuery(
    client,
    `WITH lot_based_product_stock AS (
       SELECT
         p."clinicId" AS tenant_id,
         p.id AS product_id,
         p.stock AS product_stock,
         p.status AS product_status,
         p."deletedAt" AS deleted_at,
         p."updatedAt" AS updated_at,
         COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') AS tracking_mode,
         c.timezone,
         COUNT(l.id) AS lot_count,
         FLOOR(
           COALESCE(SUM(l."availableQuantity") FILTER (
             WHERE l.status <> 'cancelled'
               AND ${activePredicate}
               AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)
           ), 0)
         )::numeric AS expected_stock,
         COALESCE((SELECT COUNT(*) FROM inventory_movements im WHERE im."tenantId" = p."clinicId" AND im."productId" = p.id), 0) AS movement_count,
         COALESCE((SELECT COUNT(*) FROM inventory_lot_allocations a WHERE a."tenantId" = p."clinicId" AND a."productId" = p.id), 0) AS allocation_count
       FROM products p
       INNER JOIN clinics c ON c.id = p."clinicId"
       LEFT JOIN inventory_lots l
         ON l."tenantId" = p."clinicId"
        AND l."productId" = p.id
       WHERE p."clinicId" = ANY($1::uuid[])
         AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'
       GROUP BY p."clinicId", p.id, p.stock, p.status, p."deletedAt", p."updatedAt", tracking_mode, c.timezone
     )
     SELECT *
     FROM lot_based_product_stock
     WHERE COALESCE(product_stock, 0) <> COALESCE(expected_stock, 0)
     ORDER BY tenant_id, product_id`,
    [tenantIds]
  );
  return result.rows;
}

async function loadDivergentProductDetails(client, divergentRows) {
  const productIds = divergentRows.map((row) => row.product_id);
  if (!productIds.length) return [];

  const lotRows = await readOnlyQuery(
    client,
    `SELECT
       l.id,
       l."tenantId" AS tenant_id,
       l."productId" AS product_id,
       l.status,
       l."availableQuantity" AS available_quantity,
       l."expiresAt" AS expires_at,
       l."receivedAt" AS received_at,
       l."manufacturedAt" AS manufactured_at,
       l."createdAt" AS created_at,
       l."updatedAt" AS updated_at,
       COALESCE((
         SELECT SUM(a.quantity)
         FROM inventory_lot_allocations a
         WHERE a."tenantId" = l."tenantId"
           AND a."lotId" = l.id
           AND a.status = 'allocated'
       ), 0) AS committed_quantity,
       (
         SELECT MAX(im."createdAt")
         FROM inventory_movements im
         WHERE im."tenantId" = l."tenantId"
           AND im."lotId" = l.id
       ) AS last_movement_at,
       (
         SELECT MAX(a."createdAt")
         FROM inventory_lot_allocations a
         WHERE a."tenantId" = l."tenantId"
           AND a."lotId" = l.id
       ) AS last_allocation_at
     FROM inventory_lots l
     WHERE l."productId" = ANY($1::uuid[])
     ORDER BY l."productId", l."createdAt", l.id`,
    [productIds]
  );

  const movementRows = await readOnlyQuery(
    client,
    `SELECT
       im.id,
       im."tenantId" AS tenant_id,
       im."productId" AS product_id,
       im."lotId" AS lot_id,
       im."movementType" AS movement_type,
       im.quantity,
       im."quantityBefore" AS quantity_before,
       im."quantityAfter" AS quantity_after,
       im."createdAt" AS created_at,
       im."referenceType" AS reference_type
     FROM inventory_movements im
     WHERE im."productId" = ANY($1::uuid[])
     ORDER BY im."productId", im."createdAt", im.id`,
    [productIds]
  );

  const allocationRows = await readOnlyQuery(
    client,
    `SELECT
       a.id,
       a."tenantId" AS tenant_id,
       a."productId" AS product_id,
       a."lotId" AS lot_id,
       a.quantity,
       a.status,
       a."createdAt" AS created_at,
       a."releasedAt" AS released_at
     FROM inventory_lot_allocations a
     WHERE a."productId" = ANY($1::uuid[])
     ORDER BY a."productId", a."createdAt", a.id`,
    [productIds]
  );

  return divergentRows.map((row) =>
    summarizeProductStockDivergence(
      row,
      lotRows.rows.filter((lot) => lot.product_id === row.product_id),
      movementRows.rows.filter((movement) => movement.product_id === row.product_id),
      allocationRows.rows.filter((allocation) => allocation.product_id === row.product_id)
    )
  );
}

async function collectBaseCounts(client, tenantIds, capabilities) {
  const params = [tenantIds];
  const activePredicate = getStockAvailabilityPredicate(capabilities);
  const counts = {};

  counts.totalLots = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     WHERE l."tenantId" = ANY($1::uuid[])`,
    params
  );

  counts.lotBasedProducts = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM products p
     WHERE p."clinicId" = ANY($1::uuid[])
       AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'`,
    params
  );

  counts.negativeAvailable = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     WHERE l."tenantId" = ANY($1::uuid[])
       AND l."availableQuantity" < 0`,
    params
  );

  counts.committedNegative = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lot_allocations a
     WHERE a."tenantId" = ANY($1::uuid[])
       AND a.quantity < 0`,
    params
  );

  counts.committedGtPhysical = await fetchScalarCount(
    client,
    `WITH lot_allocations AS (
       SELECT "tenantId", "lotId", COALESCE(SUM(quantity) FILTER (WHERE status = 'allocated'), 0) AS committed
       FROM inventory_lot_allocations
       WHERE "tenantId" = ANY($1::uuid[])
       GROUP BY "tenantId", "lotId"
     )
     SELECT COUNT(*) AS count
     FROM inventory_lots l
     LEFT JOIN lot_allocations a
       ON a."tenantId" = l."tenantId"
      AND a."lotId" = l.id
     WHERE l."tenantId" = ANY($1::uuid[])
       AND COALESCE(a.committed, 0) > COALESCE(l."availableQuantity", 0)`,
    params
  );

  counts.productStockDivergent = await fetchScalarCount(
    client,
    `WITH lot_based_product_stock AS (
       SELECT
         p.id AS "productId",
         p."clinicId" AS "tenantId",
         p.stock AS "productStock",
         FLOOR(
           COALESCE(SUM(l."availableQuantity") FILTER (
             WHERE l.status <> 'cancelled'
               AND ${activePredicate}
               AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)
           ), 0)
         )::numeric AS "expectedStock"
       FROM products p
       LEFT JOIN inventory_lots l
         ON l."tenantId" = p."clinicId"
        AND l."productId" = p.id
       WHERE p."clinicId" = ANY($1::uuid[])
         AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'
       GROUP BY p.id, p."clinicId", p.stock
     )
     SELECT COUNT(*) AS count
     FROM lot_based_product_stock
     WHERE COALESCE("productStock", 0) <> COALESCE("expectedStock", 0)`,
    params
  );

  counts.lotBasedWithBaseBalance = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM products p
     INNER JOIN inventory_balances b
       ON b."tenantId" = p."clinicId"
      AND b."productId" = p.id
      AND b.quantity > 0
     WHERE p."clinicId" = ANY($1::uuid[])
       AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'`,
    params
  );

  counts.legacyWithLots = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     INNER JOIN products p
       ON p.id = l."productId"
      AND p."clinicId" = l."tenantId"
     WHERE l."tenantId" = ANY($1::uuid[])
       AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') <> 'lot_based'`,
    params
  );

  counts.cancelledFefoEligible = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     WHERE l."tenantId" = ANY($1::uuid[])
       AND l.status = 'cancelled'
       AND l."availableQuantity" > 0
       AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)`,
    params
  );

  counts.expiredUsedRecently = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_movements im
     INNER JOIN inventory_lots l
       ON l.id = im."lotId"
      AND l."tenantId" = im."tenantId"
     WHERE im."tenantId" = ANY($1::uuid[])
       AND im."movementType" = 'sale'
       AND im."createdAt" >= NOW() - INTERVAL '30 days'
       AND l."expiresAt" IS NOT NULL
       AND l."expiresAt" < im."createdAt"::date`,
    params
  );

  counts.invalidAllocations = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lot_allocations a
     LEFT JOIN inventory_lots l
       ON l.id = a."lotId"
      AND l."tenantId" = a."tenantId"
      AND l."productId" = a."productId"
     WHERE a."tenantId" = ANY($1::uuid[])
       AND (l.id IS NULL OR a.quantity <= 0)`,
    params
  );

  counts.tombstoneProductWithActiveLot = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     INNER JOIN products p
       ON p.id = l."productId"
      AND p."clinicId" = l."tenantId"
     WHERE l."tenantId" = ANY($1::uuid[])
       AND p."deletedAt" IS NOT NULL
       AND l."availableQuantity" > 0
       AND l.status <> 'cancelled'`,
    params
  );

  counts.movementTenantMismatch = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_movements im
     LEFT JOIN inventory_lots l ON l.id = im."lotId"
     LEFT JOIN products p ON p.id = im."productId"
     WHERE im."tenantId" = ANY($1::uuid[])
       AND (
         (l.id IS NOT NULL AND l."tenantId" <> im."tenantId")
         OR (p.id IS NOT NULL AND p."clinicId" <> im."tenantId")
       )`,
    params
  );

  counts.allocationTenantMismatch = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lot_allocations a
     LEFT JOIN inventory_lots l ON l.id = a."lotId"
     LEFT JOIN products p ON p.id = a."productId"
     WHERE a."tenantId" = ANY($1::uuid[])
       AND (
         (l.id IS NOT NULL AND l."tenantId" <> a."tenantId")
         OR (p.id IS NOT NULL AND p."clinicId" <> a."tenantId")
       )`,
    params
  );

  counts.approximateDuplicatePhysicalIdentity = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     WHERE l."tenantId" = ANY($1::uuid[])
       AND COALESCE(NULLIF(TRIM(l."lotNumber"), ''), '') <> ''
       AND EXISTS (
         SELECT 1
         FROM inventory_lots dup
         WHERE dup."tenantId" = l."tenantId"
           AND dup."productId" = l."productId"
           AND dup.id <> l.id
           AND UPPER(TRIM(COALESCE(dup."lotNumber", ''))) = UPPER(TRIM(COALESCE(l."lotNumber", '')))
           AND UPPER(TRIM(COALESCE(dup."locationName", dup."warehouseName", ''))) = UPPER(TRIM(COALESCE(l."locationName", l."warehouseName", '')))
           AND dup."expiresAt" IS NOT DISTINCT FROM l."expiresAt"
       )`,
    params
  );

  counts.approximateConflictingPhysicalIdentity = await fetchScalarCount(
    client,
    `SELECT COUNT(*) AS count
     FROM inventory_lots l
     WHERE l."tenantId" = ANY($1::uuid[])
       AND COALESCE(NULLIF(TRIM(l."lotNumber"), ''), '') <> ''
       AND EXISTS (
         SELECT 1
         FROM inventory_lots dup
         WHERE dup."tenantId" = l."tenantId"
           AND dup."productId" = l."productId"
           AND dup.id <> l.id
           AND UPPER(TRIM(COALESCE(dup."lotNumber", ''))) = UPPER(TRIM(COALESCE(l."lotNumber", '')))
           AND UPPER(TRIM(COALESCE(dup."locationName", dup."warehouseName", ''))) = UPPER(TRIM(COALESCE(l."locationName", l."warehouseName", '')))
           AND dup."expiresAt" IS DISTINCT FROM l."expiresAt"
       )`,
    params
  );

  return counts;
}

async function collectPost067Counts(client, tenantIds) {
  const params = [tenantIds];
  return {
    missingLocationId: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."locationId" IS NULL`,
      params
    ),
    locationTenantMismatch: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."locationId" IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM inventory_locations loc
           WHERE loc.id = l."locationId"
             AND loc."tenantId" <> l."tenantId"
         )`,
      params
    ),
    missingNormalizedLotNumber: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."lotNumber" IS NOT NULL
         AND l."normalizedLotNumber" IS NULL`,
      params
    ),
    duplicatePhysicalIdentity: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."normalizedLotNumber" IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM inventory_lots dup
           WHERE dup."tenantId" = l."tenantId"
             AND dup."productId" = l."productId"
             AND dup."locationId" IS NOT DISTINCT FROM l."locationId"
             AND dup."normalizedLotNumber" = l."normalizedLotNumber"
             AND dup."expiresAt" IS NOT DISTINCT FROM l."expiresAt"
             AND dup.id <> l.id
         )`,
      params
    ),
    conflictingPhysicalIdentity: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."normalizedLotNumber" IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM inventory_lots dup
           WHERE dup."tenantId" = l."tenantId"
             AND dup."productId" = l."productId"
             AND dup."locationId" IS NOT DISTINCT FROM l."locationId"
             AND dup."normalizedLotNumber" = l."normalizedLotNumber"
             AND dup."expiresAt" IS DISTINCT FROM l."expiresAt"
             AND dup.id <> l.id
         )`,
      params
    ),
    inactiveLocationReferenced: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       INNER JOIN inventory_locations loc
         ON loc.id = l."locationId"
        AND loc."tenantId" = l."tenantId"
       WHERE l."tenantId" = ANY($1::uuid[])
         AND loc.active = FALSE`,
      params
    )
  };
}

async function collectPost068Counts(client, tenantIds) {
  const params = [tenantIds];
  return {
    writtenOffWithQuantity: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'written_off'
         AND l."availableQuantity" > 0`,
      params
    ),
    blockMetadataWithoutBlockedStatus: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) <> 'blocked'
         AND (l."blockedAt" IS NOT NULL OR l."blockedBy" IS NOT NULL OR l."blockReason" IS NOT NULL)`,
      params
    ),
    activeWithWriteoffMetadata: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'
         AND (l."writtenOffAt" IS NOT NULL OR l."writtenOffBy" IS NOT NULL OR l."writeoffReason" IS NOT NULL)`,
      params
    ),
    invalidOperationalStatus: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."operationalStatus" IS NOT NULL
         AND l."operationalStatus" NOT IN ('active', 'blocked', 'written_off')`,
      params
    ),
    operationalStatusNull: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l."operationalStatus" IS NULL
         AND l.status <> 'cancelled'`,
      params
    ),
    quarantinedCompatibility: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
         AND l.status = 'quarantined'
         AND COALESCE(l."operationalStatus", 'blocked') <> 'blocked'`,
      params
    )
  };
}

async function collectPost069Counts(client, tenantIds) {
  const params = [tenantIds];
  return {
    duplicateLotOperations: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM (
         SELECT "tenantId", "operationType", "idempotencyKey"
         FROM inventory_lot_operations
         WHERE "tenantId" = ANY($1::uuid[])
         GROUP BY "tenantId", "operationType", "idempotencyKey"
         HAVING COUNT(*) > 1
       ) duplicates`,
      params
    ),
    invalidOperationStatus: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lot_operations op
       WHERE op."tenantId" = ANY($1::uuid[])
         AND op.status NOT IN ('pending', 'processing', 'completed', 'partially_completed', 'failed')`,
      params
    ),
    emptyIdempotencyKey: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lot_operations op
       WHERE op."tenantId" = ANY($1::uuid[])
         AND LENGTH(TRIM(COALESCE(op."idempotencyKey", ''))) = 0`,
      params
    ),
    lotOperationTenantMismatch: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lot_operations op
       LEFT JOIN products p
         ON p.id = op."productId"
       LEFT JOIN inventory_lots l
         ON l.id = op."lotId"
       WHERE op."tenantId" = ANY($1::uuid[])
         AND (
           (p.id IS NOT NULL AND p."clinicId" <> op."tenantId")
           OR (l.id IS NOT NULL AND (l."tenantId" <> op."tenantId" OR l."productId" <> op."productId"))
         )`,
      params
    ),
    orphanLotOperation: await fetchScalarCount(
      client,
      `SELECT COUNT(*) AS count
       FROM inventory_lot_operations op
       LEFT JOIN products p
         ON p.id = op."productId"
        AND p."clinicId" = op."tenantId"
       LEFT JOIN inventory_lots l
         ON l.id = op."lotId"
        AND l."tenantId" = op."tenantId"
        AND l."productId" = op."productId"
       WHERE op."tenantId" = ANY($1::uuid[])
         AND (p.id IS NULL OR (op."lotId" IS NOT NULL AND l.id IS NULL))`,
      params
    )
  };
}

function buildChecksFromCounts(capabilities, counts) {
  const checks = [
    buildCheck({ name: 'total_lots', count: counts.totalLots, confidence: 'exact', status: 'passed' }),
    buildCheck({ name: 'lot_based_products', count: counts.lotBasedProducts, confidence: 'exact', status: 'passed' }),
    buildCheck({ name: 'negative_available_quantity', count: counts.negativeAvailable, confidence: 'exact' }),
    buildCheck({ name: 'negative_committed_quantity', count: counts.committedNegative, confidence: 'exact' }),
    buildCheck({ name: 'committed_gt_physical_legacy', count: counts.committedGtPhysical, confidence: 'exact' }),
    buildCheck({ name: 'product_stock_divergent', count: counts.productStockDivergent, confidence: 'exact' }),
    buildCheck({ name: 'lot_based_with_base_balance', count: counts.lotBasedWithBaseBalance, confidence: 'exact' }),
    buildCheck({ name: 'legacy_products_with_lots', count: counts.legacyWithLots, confidence: 'exact' }),
    buildCheck({ name: 'cancelled_fefo_eligible', count: counts.cancelledFefoEligible, confidence: 'exact' }),
    buildCheck({ name: 'expired_used_recently', count: counts.expiredUsedRecently, confidence: 'exact' }),
    buildCheck({ name: 'invalid_allocations', count: counts.invalidAllocations, confidence: 'exact' }),
    buildCheck({ name: 'tombstone_product_with_active_lot', count: counts.tombstoneProductWithActiveLot, confidence: 'exact' }),
    buildCheck({ name: 'movement_tenant_mismatch', count: counts.movementTenantMismatch, confidence: 'exact' }),
    buildCheck({ name: 'allocation_tenant_mismatch', count: counts.allocationTenantMismatch, confidence: 'exact' }),
    buildCheck({ name: 'approximate_duplicate_physical_identity_pre067', count: counts.approximateDuplicatePhysicalIdentity, confidence: 'approximate' }),
    buildCheck({ name: 'approximate_conflicting_physical_identity_pre067', count: counts.approximateConflictingPhysicalIdentity, confidence: 'approximate' })
  ];

  if (capabilities.hasLocationId && capabilities.hasNormalizedLotNumber) {
    checks.push(
      buildCheck({ name: 'missing_location_id', count: counts.missingLocationId, confidence: 'exact' }),
      buildCheck({ name: 'location_tenant_mismatch', count: counts.locationTenantMismatch, confidence: 'exact' }),
      buildCheck({ name: 'missing_normalized_lot_number', count: counts.missingNormalizedLotNumber, confidence: 'exact' }),
      buildCheck({ name: 'duplicate_physical_identity', count: counts.duplicatePhysicalIdentity, confidence: 'exact' }),
      buildCheck({ name: 'conflicting_physical_identity', count: counts.conflictingPhysicalIdentity, confidence: 'exact' }),
      buildCheck({ name: 'inactive_location_referenced', count: counts.inactiveLocationReferenced, confidence: 'exact' })
    );
  } else {
    checks.push(
      buildSkippedCheck('missing_location_id', 'unavailable', '067'),
      buildSkippedCheck('location_tenant_mismatch', 'unavailable', '067'),
      buildSkippedCheck('missing_normalized_lot_number', 'unavailable', '067'),
      buildSkippedCheck('duplicate_physical_identity', 'unavailable', '067'),
      buildSkippedCheck('conflicting_physical_identity', 'unavailable', '067'),
      buildSkippedCheck('inactive_location_referenced', 'unavailable', '067')
    );
  }

  if (capabilities.hasOperationalStatus && capabilities.hasBlockingMetadata && capabilities.hasWriteoffMetadata) {
    checks.push(
      buildCheck({ name: 'written_off_with_quantity', count: counts.writtenOffWithQuantity, confidence: 'exact' }),
      buildCheck({ name: 'block_metadata_without_blocked_status', count: counts.blockMetadataWithoutBlockedStatus, confidence: 'exact' }),
      buildCheck({ name: 'active_with_writeoff_metadata', count: counts.activeWithWriteoffMetadata, confidence: 'exact' }),
      buildCheck({ name: 'invalid_operational_status', count: counts.invalidOperationalStatus, confidence: 'exact' }),
      buildCheck({ name: 'operational_status_null', count: counts.operationalStatusNull, confidence: 'exact' }),
      buildCheck({ name: 'quarantined_compatibility_mismatch', count: counts.quarantinedCompatibility, confidence: 'exact' })
    );
  } else {
    checks.push(
      buildSkippedCheck('written_off_with_quantity', 'unavailable', '068'),
      buildSkippedCheck('block_metadata_without_blocked_status', 'unavailable', '068'),
      buildSkippedCheck('active_with_writeoff_metadata', 'unavailable', '068'),
      buildSkippedCheck('invalid_operational_status', 'unavailable', '068'),
      buildSkippedCheck('operational_status_null', 'unavailable', '068'),
      buildSkippedCheck('quarantined_compatibility_mismatch', 'unavailable', '068')
    );
  }

  if (capabilities.hasLotOperations) {
    checks.push(
      buildCheck({ name: 'duplicate_lot_operations', count: counts.duplicateLotOperations, confidence: 'exact' }),
      buildCheck({ name: 'invalid_operation_status', count: counts.invalidOperationStatus, confidence: 'exact' }),
      buildCheck({ name: 'empty_idempotency_key', count: counts.emptyIdempotencyKey, confidence: 'exact' }),
      buildCheck({ name: 'lot_operation_tenant_mismatch', count: counts.lotOperationTenantMismatch, confidence: 'exact' }),
      buildCheck({ name: 'orphan_lot_operations', count: counts.orphanLotOperation, confidence: 'exact' })
    );
  } else {
    checks.push(
      buildSkippedCheck('duplicate_lot_operations', 'unavailable', '069'),
      buildSkippedCheck('invalid_operation_status', 'unavailable', '069'),
      buildSkippedCheck('empty_idempotency_key', 'unavailable', '069'),
      buildSkippedCheck('lot_operation_tenant_mismatch', 'unavailable', '069'),
      buildSkippedCheck('orphan_lot_operations', 'unavailable', '069')
    );
  }

  return checks;
}

function assessMigrationReadiness(checks) {
  const blockingChecks = new Set([
    'negative_available_quantity',
    'negative_committed_quantity',
    'invalid_allocations',
    'movement_tenant_mismatch',
    'allocation_tenant_mismatch',
    'location_tenant_mismatch',
    'duplicate_physical_identity',
    'duplicate_lot_operations',
    'invalid_operation_status',
    'empty_idempotency_key',
    'lot_operation_tenant_mismatch',
    'orphan_lot_operations'
  ]);
  const reviewChecks = new Set([
    'committed_gt_physical_legacy',
    'product_stock_divergent',
    'lot_based_with_base_balance',
    'tombstone_product_with_active_lot',
    'approximate_duplicate_physical_identity_pre067',
    'approximate_conflicting_physical_identity_pre067',
    'conflicting_physical_identity',
    'missing_location_id',
    'missing_normalized_lot_number',
    'inactive_location_referenced',
    'written_off_with_quantity',
    'block_metadata_without_blocked_status',
    'active_with_writeoff_metadata',
    'invalid_operational_status',
    'quarantined_compatibility_mismatch'
  ]);

  const blockingFindings = checks.filter((check) => check.status === 'findings' && blockingChecks.has(check.name));
  const nonBlockingFindings = checks.filter((check) => check.status === 'findings' && !blockingChecks.has(check.name));
  const skippedChecks = checks.filter((check) => check.status === 'skipped_schema_not_available');

  let migrationReadiness = 'ready';
  if (blockingFindings.length > 0) migrationReadiness = 'blocked';
  else if (nonBlockingFindings.some((check) => reviewChecks.has(check.name)) || skippedChecks.length > 0) migrationReadiness = 'review_required';

  return {
    blockingFindings: blockingFindings.map((check) => check.name),
    nonBlockingFindings: nonBlockingFindings.map((check) => check.name),
    skippedChecks: skippedChecks.map((check) => check.name),
    migrationReadiness
  };
}

async function runInventoryLotConsistencyReport(client, args = {}) {
  await beginReadOnlyTransaction(client);

  try {
    const schemaCapabilities = await detectInventoryLotSchemaCapabilities({
      query: (...params) => readOnlyQuery(client, ...params)
    });
    const tenantIds = await listVisibleClientTenantIds(client, args);
    const counts = await collectBaseCounts(client, tenantIds, schemaCapabilities);
    const divergentProducts = args.details === 'product_stock_divergent'
      ? await loadDivergentProductDetails(client, await listDivergentLotBasedProducts(client, tenantIds, schemaCapabilities))
      : [];

    if (schemaCapabilities.hasLocationId && schemaCapabilities.hasNormalizedLotNumber) {
      Object.assign(counts, await collectPost067Counts(client, tenantIds));
    }
    if (schemaCapabilities.hasOperationalStatus && schemaCapabilities.hasBlockingMetadata && schemaCapabilities.hasWriteoffMetadata) {
      Object.assign(counts, await collectPost068Counts(client, tenantIds));
    }
    if (schemaCapabilities.hasLotOperations) {
      Object.assign(counts, await collectPost069Counts(client, tenantIds));
    }

    const checks = buildChecksFromCounts(schemaCapabilities, counts);
    const summary = assessMigrationReadiness(checks);

    await client.query('ROLLBACK');
    return {
      dryRun: true,
      readOnlyTransaction: true,
      schemaCapabilities: {
        phase: schemaCapabilities.schemaPhase,
        columnsPresent: schemaCapabilities.columnsPresent,
        tablesPresent: schemaCapabilities.tablesPresent
      },
      tenantsReviewed: tenantIds.length,
      tenantScope: tenantIds.map((tenantId) => shorten(tenantId)),
      checks,
      summary,
      details:
        args.details === 'product_stock_divergent'
          ? {
              requested: 'product_stock_divergent',
              products: divergentProducts.map((item) => ({
                tenantId: shorten(item.tenantId),
                productId: shorten(item.productId),
                productStock: item.productStock,
                physicalTotal: item.physicalTotal,
                commercialAvailableTotal: item.commercialAvailableTotal,
                expectedProductStock: item.expectedProductStock,
                committedTotal: item.committedTotal,
                diffPhysical: item.diffPhysical,
                diffCommercial: item.diffCommercial,
                diffExpected: item.diffExpected,
                expectedSemantics: item.expectedSemantics,
                rootCauseCode: item.rootCauseCode,
                sourceOfTruth: item.sourceOfTruth,
                repairSafe: item.repairSafe,
                productStatus: item.productStatus,
                deletedAt: item.deletedAt,
                trackingMode: item.trackingMode,
                lotCount: item.lotCount,
                movementCount: item.movementCount,
                allocationCount: item.allocationCount,
                timezone: item.timezone,
                ledgerConsistency: item.ledgerConsistency.status
              }))
            }
          : null
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function classifyLocationProposal(row, tenantLocations, allLocations, options = {}) {
  const hasLocationId = options.hasLocationId === true;
  if (hasLocationId && row.locationId) {
    return {
      lotId: row.id,
      tenantId: row.tenantId,
      classification: 'already_assigned',
      matchedLocationId: null
    };
  }

  const source = normalizeText(row.locationName || row.warehouseName);
  const exact = tenantLocations.filter(
    (location) => normalizeText(location.name) === source || normalizeText(location.code) === source
  );
  const activeExact = exact.filter((location) => location.active !== false);
  const exactOutsideTenant = allLocations.filter(
    (location) =>
      location.tenantId !== row.tenantId &&
      (normalizeText(location.name) === source || normalizeText(location.code) === source)
  );

  let classification = 'no_match';
  let matchedLocationId = null;
  if (activeExact.length === 1) {
    classification = 'exact_match';
    matchedLocationId = activeExact[0].id;
  } else if (activeExact.length > 1) {
    classification = 'ambiguous_match';
  } else if (exact.length > 0) {
    classification = 'inactive_location';
  } else if (exactOutsideTenant.length > 0) {
    classification = 'tenant_mismatch';
  }

  return {
    lotId: row.id,
    tenantId: row.tenantId,
    classification,
    matchedLocationId
  };
}

async function runInventoryLotLocationBackfill(client, args = {}) {
  const schemaCapabilities = await detectInventoryLotSchemaCapabilities({
    query: (...params) => readOnlyQuery(client, ...params)
  });

  if (args.apply && !schemaCapabilities.hasLocationId) {
    throw new Error('inventory_lot_location_column_missing');
  }

  await client.query('BEGIN');
  if (!args.apply || args.readOnly) {
    await client.query('SET TRANSACTION READ ONLY');
  }

  try {
    const tenantIds = await listVisibleClientTenantIds(client, args);
    const lotSelect = schemaCapabilities.hasLocationId ? 'l."locationId"' : 'NULL::uuid AS "locationId"';
    const lotRows = await readOnlyQuery(
      client,
      `SELECT l.id, l."tenantId", l."warehouseName", l."locationName", ${lotSelect}
       FROM inventory_lots l
       WHERE l."tenantId" = ANY($1::uuid[])
       ORDER BY l."tenantId", l."createdAt" ASC`,
      [tenantIds]
    );

    const locationRows = await readOnlyQuery(
      client,
      `SELECT id, "tenantId", code, name, "isPrimary", active
       FROM inventory_locations
       WHERE "tenantId" = ANY($1::uuid[])
       ORDER BY "tenantId", "isPrimary" DESC, name ASC`,
      [tenantIds]
    );

    const byTenant = new Map();
    for (const row of locationRows.rows) {
      const list = byTenant.get(row.tenantId) || [];
      list.push(row);
      byTenant.set(row.tenantId, list);
    }

    const proposals = lotRows.rows.map((row) =>
      classifyLocationProposal(row, byTenant.get(row.tenantId) || [], locationRows.rows, {
        hasLocationId: schemaCapabilities.hasLocationId
      })
    );

    let updatedLots = 0;
    if (args.apply) {
      for (const proposal of proposals) {
        if (proposal.classification !== 'exact_match' || !proposal.matchedLocationId) continue;
        await client.query(
          `UPDATE inventory_lots
           SET "locationId" = $3::uuid
           WHERE id = $1::uuid
             AND "tenantId" = $2::uuid
             AND "locationId" IS NULL`,
          [proposal.lotId, proposal.tenantId, proposal.matchedLocationId]
        );
        updatedLots += 1;
      }
    }

    const summary = proposals.reduce(
      (acc, proposal) => {
        acc[proposal.classification] = toNumber(acc[proposal.classification]) + 1;
        return acc;
      },
      {
        already_assigned: 0,
        exact_match: 0,
        ambiguous_match: 0,
        no_match: 0,
        tenant_mismatch: 0,
        inactive_location: 0
      }
    );

    if (args.apply) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    return {
      apply: args.apply === true,
      readOnlyTransaction: args.apply !== true,
      schemaCapabilities: {
        phase: schemaCapabilities.schemaPhase,
        columnsPresent: schemaCapabilities.columnsPresent,
        tablesPresent: schemaCapabilities.tablesPresent
      },
      totalLots: proposals.length,
      writes: updatedLots,
      proposals: proposals.map((proposal) => ({
        lotId: `${String(proposal.lotId).slice(0, 8)}...`,
        tenantId: shorten(proposal.tenantId),
        classification: proposal.classification,
        matchedLocationId: proposal.matchedLocationId ? shorten(proposal.matchedLocationId) : null
      })),
      summary
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  assessMigrationReadiness,
  buildChecksFromCounts,
  buildSkippedCheck,
  classifyLocationProposal,
  listVisibleClientTenantIds,
  loadDivergentProductDetails,
  normalizeText,
  parseArgs,
  runInventoryLotConsistencyReport,
  runInventoryLotLocationBackfill,
  listDivergentLotBasedProducts,
  shorten
};
