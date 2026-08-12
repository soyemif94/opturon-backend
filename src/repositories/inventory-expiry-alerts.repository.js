const { query } = require('../db/client');
const { isUuid, contractError } = require('../operational-alerts/operational-alert-validation');
const { INVENTORY_EXPIRY_EVENT_ITEM_LIMIT } = require('../operational-alerts/inventory-lot-expiry-alert');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeDateOnly(value) {
  const normalized = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeCandidateRow(row) {
  return {
    lotId: row.lotId,
    productId: row.productId,
    productName: row.productName,
    productSku: row.productSku || null,
    lotNumber: row.lotNumber || null,
    expiresAt: normalizeDateOnly(row.expiresAt),
    relevantQuantity: Number(row.relevantQuantity),
    supplierName: row.supplierName || null,
    locationName: row.locationName || null
  };
}

const INVENTORY_EXPIRY_CANDIDATE_QUERY = `
  WITH candidate_rows AS (
    SELECT
      l.id AS "lotId",
      l."productId",
      p.name AS "productName",
      p.sku AS "productSku",
      l."lotNumber",
      l."expiresAt",
      l."supplierName",
      COALESCE(loc.name, l."locationName", l."warehouseName") AS "locationName",
      CASE
        WHEN $4 = 'physical' THEN
          CASE
            WHEN l.status = 'cancelled'
              OR COALESCE(
                l."operationalStatus",
                CASE
                  WHEN l.status = 'quarantined' THEN 'blocked'
                  WHEN l.status = 'cancelled' THEN 'cancelled'
                  ELSE 'active'
                END
              ) = 'written_off'
            THEN 0::numeric
            ELSE l."availableQuantity"
          END
        ELSE
          CASE
            WHEN l.status NOT IN ('cancelled', 'depleted')
              AND COALESCE(
                l."operationalStatus",
                CASE
                  WHEN l.status = 'quarantined' THEN 'blocked'
                  WHEN l.status = 'cancelled' THEN 'cancelled'
                  ELSE 'active'
                END
              ) = 'active'
              AND l."availableQuantity" > 0
            THEN GREATEST(l."availableQuantity" - COALESCE(alloc."committedQuantity", 0), 0)
            ELSE 0::numeric
          END
      END AS "relevantQuantity"
    FROM inventory_lots l
    INNER JOIN products p
      ON p.id = l."productId"
     AND p."clinicId" = l."tenantId"
     AND p.status = 'active'
     AND p."deletedAt" IS NULL
     AND length(trim(p.name)) > 0
    LEFT JOIN inventory_locations loc
      ON loc.id = l."locationId"
     AND loc."tenantId" = l."tenantId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.quantity), 0) AS "committedQuantity"
      FROM inventory_lot_allocations a
      WHERE a."tenantId" = l."tenantId"
        AND a."lotId" = l.id
        AND a.status = 'allocated'
    ) alloc ON TRUE
    WHERE l."tenantId" = $1::uuid
      AND l."expiresAt" IS NOT NULL
      AND l."expiresAt" >= $2::date
      AND l."expiresAt" <= $3::date
  ),
  eligible AS (
    SELECT *
    FROM candidate_rows
    WHERE "relevantQuantity" > 0
      AND "relevantQuantity" >= $5::numeric
  ),
  totals AS (
    SELECT COUNT(*)::int AS "totalLots",
           COUNT(DISTINCT "productId")::int AS "totalProducts"
    FROM eligible
  )
  SELECT eligible.*, totals."totalLots", totals."totalProducts"
  FROM eligible
  CROSS JOIN totals
  ORDER BY eligible."expiresAt" ASC,
           LOWER(eligible."productName") ASC,
           eligible."productName" ASC,
           eligible."lotId" ASC
  LIMIT $6::int`;

async function listInventoryExpiryAlertCandidates(input, client = null) {
  if (!input || !isUuid(input.clinicId)) {
    throw contractError('inventory_expiry_candidate_clinic_id_invalid');
  }
  const rangeStartDate = normalizeDateOnly(input.rangeStartDate);
  const rangeEndDate = normalizeDateOnly(input.rangeEndDate);
  const quantityBasis = String(input.quantityBasis || '').trim();
  const minimumAvailableQuantity = Number(input.minimumAvailableQuantity);
  if (!rangeStartDate || !rangeEndDate || rangeStartDate > rangeEndDate) {
    throw contractError('inventory_expiry_candidate_date_range_invalid');
  }
  if (!['physical', 'commercial'].includes(quantityBasis)) {
    throw contractError('inventory_expiry_candidate_quantity_basis_invalid');
  }
  if (!Number.isFinite(minimumAvailableQuantity) || minimumAvailableQuantity < 0) {
    throw contractError('inventory_expiry_candidate_minimum_quantity_invalid');
  }

  const result = await dbQuery(client, INVENTORY_EXPIRY_CANDIDATE_QUERY, [
    input.clinicId,
    rangeStartDate,
    rangeEndDate,
    quantityBasis,
    minimumAvailableQuantity,
    INVENTORY_EXPIRY_EVENT_ITEM_LIMIT
  ]);
  const first = result.rows[0] || null;
  return {
    totalLots: first ? Number(first.totalLots) : 0,
    totalProducts: first ? Number(first.totalProducts) : 0,
    items: result.rows.map(normalizeCandidateRow)
  };
}

module.exports = {
  INVENTORY_EXPIRY_CANDIDATE_QUERY,
  listInventoryExpiryAlertCandidates
};
