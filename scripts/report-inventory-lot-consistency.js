const { Client } = require('pg');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
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
  const text = String(value || '');
  return text.length <= 12 ? text : `${text.slice(0, 8)}...${text.slice(-4)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client();
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');

  try {
    const filters = [];
    const params = [];
    if (args.tenant) {
      params.push(args.tenant);
      filters.push(`l."tenantId" = $${params.length}::uuid`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await client.query(
      `WITH lot_allocations AS (
         SELECT
           "tenantId",
           "lotId",
           COALESCE(SUM(quantity) FILTER (WHERE status = 'allocated'), 0) AS committed,
           COUNT(*) FILTER (WHERE quantity < 0) AS negative_allocations
         FROM inventory_lot_allocations
         GROUP BY "tenantId", "lotId"
       ),
       lot_based_product_stock AS (
         SELECT
           p."clinicId" AS "tenantId",
           p.id AS "productId",
           p.stock AS "productStock",
           FLOOR(
             COALESCE(SUM(l."availableQuantity") FILTER (
               WHERE l.status <> 'cancelled'
                 AND COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'
                 AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)
             ), 0)
           )::numeric AS "expectedStock"
         FROM products p
         LEFT JOIN inventory_lots l
           ON l."tenantId" = p."clinicId"
          AND l."productId" = p.id
         WHERE COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'
         GROUP BY p."clinicId", p.id, p.stock
       ),
       tenant_product_stock_divergence AS (
         SELECT "tenantId", COUNT(*) AS divergent_products
         FROM lot_based_product_stock
         WHERE COALESCE("productStock", 0) <> COALESCE("expectedStock", 0)
         GROUP BY "tenantId"
       ),
       tenant_lot_based_with_balance_base AS (
         SELECT p."clinicId" AS "tenantId", COUNT(*) AS products_with_base_balance
         FROM products p
         INNER JOIN inventory_balances b
           ON b."tenantId" = p."clinicId"
          AND b."productId" = p.id
          AND b.quantity > 0
         WHERE COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'
         GROUP BY p."clinicId"
       ),
       recent_expired_sales AS (
         SELECT l."tenantId", COUNT(*) AS expired_sales
         FROM inventory_movements im
         INNER JOIN inventory_lots l
           ON l.id = im."lotId"
          AND l."tenantId" = im."tenantId"
         WHERE im."movementType" = 'sale'
           AND im."createdAt" >= NOW() - INTERVAL '30 days'
           AND l."expiresAt" IS NOT NULL
           AND l."expiresAt" < im."createdAt"::date
         GROUP BY l."tenantId"
       ),
       invalid_allocations AS (
         SELECT a."tenantId", COUNT(*) AS invalid_allocations
         FROM inventory_lot_allocations a
         LEFT JOIN inventory_lots l
           ON l.id = a."lotId"
          AND l."tenantId" = a."tenantId"
          AND l."productId" = a."productId"
         WHERE l.id IS NULL OR a.quantity <= 0
         GROUP BY a."tenantId"
       ),
       movement_tenant_mismatch AS (
         SELECT im."tenantId", COUNT(*) AS mismatched_movements
         FROM inventory_movements im
         LEFT JOIN inventory_lots l ON l.id = im."lotId"
         LEFT JOIN products p ON p.id = im."productId"
         WHERE (l.id IS NOT NULL AND l."tenantId" <> im."tenantId")
            OR (p.id IS NOT NULL AND p."clinicId" <> im."tenantId")
         GROUP BY im."tenantId"
       ),
       allocation_tenant_mismatch AS (
         SELECT a."tenantId", COUNT(*) AS mismatched_allocations
         FROM inventory_lot_allocations a
         LEFT JOIN inventory_lots l ON l.id = a."lotId"
         LEFT JOIN products p ON p.id = a."productId"
         WHERE (l.id IS NOT NULL AND l."tenantId" <> a."tenantId")
            OR (p.id IS NOT NULL AND p."clinicId" <> a."tenantId")
         GROUP BY a."tenantId"
       )
       SELECT
         l."tenantId",
         COUNT(*) FILTER (WHERE l."locationId" IS NULL) AS missing_location_id,
         COUNT(*) FILTER (
           WHERE l."locationId" IS NOT NULL
             AND EXISTS (SELECT 1 FROM inventory_locations loc WHERE loc.id = l."locationId" AND loc."tenantId" <> l."tenantId")
         ) AS location_tenant_mismatch,
         COUNT(*) FILTER (WHERE l."lotNumber" IS NOT NULL AND l."normalizedLotNumber" IS NULL) AS missing_normalized_lot_number,
         COUNT(*) FILTER (WHERE l."availableQuantity" < 0) AS negative_available,
         COUNT(*) FILTER (WHERE COALESCE(a.committed, 0) > l."availableQuantity") AS committed_gt_available,
         COUNT(*) FILTER (
           WHERE COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') <> 'lot_based'
         ) AS legacy_with_lots,
         COUNT(*) FILTER (
           WHERE l."normalizedLotNumber" IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM inventory_lots dup
               WHERE dup."tenantId" = l."tenantId"
                 AND dup."productId" = l."productId"
                 AND dup."locationId" IS NOT DISTINCT FROM l."locationId"
                 AND dup."normalizedLotNumber" = l."normalizedLotNumber"
                 AND dup."expiresAt" IS NOT DISTINCT FROM l."expiresAt"
                 AND dup.id <> l.id
             )
         ) AS duplicate_physical_identity,
         COUNT(*) FILTER (
           WHERE l."normalizedLotNumber" IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM inventory_lots dup
               WHERE dup."tenantId" = l."tenantId"
                 AND dup."productId" = l."productId"
                 AND dup."locationId" IS NOT DISTINCT FROM l."locationId"
                 AND dup."normalizedLotNumber" = l."normalizedLotNumber"
                 AND dup."expiresAt" IS DISTINCT FROM l."expiresAt"
                 AND dup.id <> l.id
             )
         ) AS conflicting_physical_identity,
         COUNT(*) FILTER (
           WHERE COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'written_off'
             AND l."availableQuantity" > 0
         ) AS written_off_with_quantity,
         COUNT(*) FILTER (
           WHERE COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) <> 'blocked'
             AND (l."blockedAt" IS NOT NULL OR l."blockedBy" IS NOT NULL OR l."blockReason" IS NOT NULL)
         ) AS block_metadata_without_blocked_status,
         COUNT(*) FILTER (
           WHERE COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'active'
             AND (l."writtenOffAt" IS NOT NULL OR l."writtenOffBy" IS NOT NULL OR l."writeoffReason" IS NOT NULL)
         ) AS active_with_writeoff_metadata,
         COUNT(*) FILTER (
           WHERE COALESCE(l."operationalStatus", CASE WHEN l.status = 'quarantined' THEN 'blocked' ELSE 'active' END) = 'blocked'
             AND l."availableQuantity" <= 0
         ) AS blocked_without_quantity,
         COUNT(*) FILTER (
           WHERE l.status = 'cancelled'
             AND l."availableQuantity" > 0
             AND (l."expiresAt" IS NULL OR l."expiresAt" >= CURRENT_DATE)
         ) AS cancelled_fefo_eligible,
         COUNT(*) FILTER (
           WHERE COALESCE(p.deletedAt, NULL) IS NOT NULL
             AND l."availableQuantity" > 0
             AND l.status <> 'cancelled'
         ) AS tombstone_product_with_active_lot,
         COUNT(*) FILTER (
           WHERE l.status = 'quarantined'
         ) AS legacy_quarantined_rows,
         COALESCE(SUM(a.negative_allocations), 0) AS committed_negative,
         COALESCE(MAX(stock_divergence.divergent_products), 0) AS product_stock_divergent,
         COALESCE(MAX(base_balance.products_with_base_balance), 0) AS lot_based_with_base_balance,
         COALESCE(MAX(expired_sales.expired_sales), 0) AS expired_used_recently,
         COALESCE(MAX(invalid_alloc.invalid_allocations), 0) AS invalid_allocations,
         COALESCE(MAX(movement_mismatch.mismatched_movements), 0) AS movement_tenant_mismatch,
         COALESCE(MAX(allocation_mismatch.mismatched_allocations), 0) AS allocation_tenant_mismatch
       FROM inventory_lots l
       INNER JOIN products p
         ON p.id = l."productId"
        AND p."clinicId" = l."tenantId"
       LEFT JOIN lot_allocations a
         ON a."tenantId" = l."tenantId"
        AND a."lotId" = l.id
       LEFT JOIN tenant_product_stock_divergence stock_divergence
         ON stock_divergence."tenantId" = l."tenantId"
       LEFT JOIN tenant_lot_based_with_balance_base base_balance
         ON base_balance."tenantId" = l."tenantId"
       LEFT JOIN recent_expired_sales expired_sales
         ON expired_sales."tenantId" = l."tenantId"
       LEFT JOIN invalid_allocations invalid_alloc
         ON invalid_alloc."tenantId" = l."tenantId"
       LEFT JOIN movement_tenant_mismatch movement_mismatch
         ON movement_mismatch."tenantId" = l."tenantId"
       LEFT JOIN allocation_tenant_mismatch allocation_mismatch
         ON allocation_mismatch."tenantId" = l."tenantId"
       ${whereClause}
       GROUP BY l."tenantId"
       ORDER BY l."tenantId"`,
      params
    );

    const output = result.rows.map((row) => ({
      tenant: shorten(row.tenantId),
      missingLocationId: Number(row.missing_location_id || 0),
      locationTenantMismatch: Number(row.location_tenant_mismatch || 0),
      missingNormalizedLotNumber: Number(row.missing_normalized_lot_number || 0),
      negativeAvailable: Number(row.negative_available || 0),
      committedNegative: Number(row.committed_negative || 0),
      committedGtAvailable: Number(row.committed_gt_available || 0),
      productStockDivergent: Number(row.product_stock_divergent || 0),
      lotBasedWithBaseBalance: Number(row.lot_based_with_base_balance || 0),
      legacyWithLots: Number(row.legacy_with_lots || 0),
      duplicatePhysicalIdentity: Number(row.duplicate_physical_identity || 0),
      conflictingPhysicalIdentity: Number(row.conflicting_physical_identity || 0),
      writtenOffWithQuantity: Number(row.written_off_with_quantity || 0),
      blockMetadataWithoutBlockedStatus: Number(row.block_metadata_without_blocked_status || 0),
      activeWithWriteoffMetadata: Number(row.active_with_writeoff_metadata || 0),
      blockedWithoutQuantity: Number(row.blocked_without_quantity || 0),
      cancelledFefoEligible: Number(row.cancelled_fefo_eligible || 0),
      expiredUsedRecently: Number(row.expired_used_recently || 0),
      invalidAllocations: Number(row.invalid_allocations || 0),
      tombstoneProductWithActiveLot: Number(row.tombstone_product_with_active_lot || 0),
      movementTenantMismatch: Number(row.movement_tenant_mismatch || 0),
      allocationTenantMismatch: Number(row.allocation_tenant_mismatch || 0),
      legacyQuarantinedRows: Number(row.legacy_quarantined_rows || 0)
    }));

    console.log(JSON.stringify({ dryRun: true, readOnlyTransaction: true, tenants: output }, null, 2));
    await client.query('ROLLBACK');
    await client.end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = 1;
});
