const { createScriptPgClient } = require('./lib/postgres-cli');
const { parseArgs } = require('./lib/inventory-lot-preflight');
const {
  loadDivergentProductDetails
} = require('./lib/inventory-lot-preflight');
const {
  buildRepairFingerprint,
  shorten
} = require('./lib/inventory-lot-stock-divergence');
const {
  createPortalUserAuditEvent,
  findLatestPortalUserAuditEventByIdempotencyKey
} = require('../src/repositories/portal-user-audit.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

async function loadTargetProductDetail(client, tenantId, productId) {
  const rows = await client.query(
    `SELECT
       p."clinicId" AS tenant_id,
       p.id AS product_id,
       p.stock AS product_stock,
       p.status AS product_status,
       p."deletedAt" AS deleted_at,
       p."updatedAt" AS updated_at,
       COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') AS tracking_mode,
       c.timezone
     FROM products p
     INNER JOIN clinics c ON c.id = p."clinicId"
     WHERE p."clinicId" = $1::uuid
       AND p.id = $2::uuid
     LIMIT 1`,
    [tenantId, productId]
  );
  const record = rows.rows[0];
  if (!record) return null;
  const [detail] = await loadDivergentProductDetails(client, [record]);
  return detail;
}

function buildAuditPayload(detail, previousStock, newStock, rootCauseCode, idempotencyKey) {
  return {
    productId: shorten(detail.productId),
    previousStock,
    newStock,
    delta: newStock - previousStock,
    calculationMode: detail.expectedSemantics,
    physicalTotal: detail.physicalTotal,
    committedTotal: detail.committedTotal,
    commercialAvailableTotal: detail.commercialAvailableTotal,
    rootCauseCode,
    scriptVersion: 'inventory-lot-product-stock-divergence-repair-1',
    idempotencyKey
  };
}

async function repairProductStock(client, args = {}, dependencies = {}) {
  const loadDetail = dependencies.loadTargetProductDetail || loadTargetProductDetail;
  const createAudit = dependencies.createPortalUserAuditEvent || createPortalUserAuditEvent;
  const findAuditByIdempotencyKey =
    dependencies.findLatestPortalUserAuditEventByIdempotencyKey || findLatestPortalUserAuditEventByIdempotencyKey;
  const tenantId = normalizeString(args.tenant);
  const productId = normalizeString(args.product);
  if (!tenantId || !productId) {
    return { ok: false, reason: 'missing_target_product' };
  }

  const detail = await loadDetail(client, tenantId, productId);
  if (!detail) return { ok: false, reason: 'product_not_found' };

  const currentProductStock = detail.productStock;
  const expectedProductStock = detail.expectedProductStock;
  const delta = expectedProductStock - currentProductStock;
  const lotFingerprint = buildRepairFingerprint({
    fingerprint: detail.fingerprint,
    expectedProductStock
  });

  const dryRunResponse = {
    ok: true,
    dryRun: args.apply !== true,
    tenantId: shorten(detail.tenantId),
    productId: shorten(detail.productId),
    currentProductStock,
    expectedProductStock,
    delta,
    physicalTotal: detail.physicalTotal,
    committedTotal: detail.committedTotal,
    commercialAvailableTotal: detail.commercialAvailableTotal,
    expectedSemantics: detail.expectedSemantics,
    rootCauseCode: detail.rootCauseCode,
    repairSafe: detail.repairSafe,
    sourceOfTruth: detail.sourceOfTruth,
    fingerprint: lotFingerprint,
    ledgerConsistency: detail.ledgerConsistency.status,
    alreadyConsistent: delta === 0
  };

  if (args.apply !== true) {
    return dryRunResponse;
  }

  if (detail.trackingMode !== 'lot_based') return { ok: false, reason: 'inventory_product_stock_repair_requires_lot_based' };
  if (detail.deletedAt) return { ok: false, reason: 'inventory_product_stock_repair_tombstone_rejected' };
  if (!detail.repairSafe || detail.sourceOfTruth !== 'LOTS') {
    return { ok: false, reason: 'inventory_product_stock_repair_source_unresolved', detail: dryRunResponse };
  }
  if (delta === 0) {
    return { ok: true, alreadyConsistent: true, writes: 0, auditCreated: false, ...dryRunResponse };
  }

  const reason = normalizeString(args.reason);
  const actor = normalizeString(args.actor);
  const expectedCurrentStock = normalizeNumber(args['expected-current-stock']);
  const expectedLotFingerprint = normalizeString(args['expected-lot-fingerprint']);
  if (!reason) return { ok: false, reason: 'inventory_product_stock_repair_reason_required' };
  if (!actor) return { ok: false, reason: 'inventory_product_stock_repair_actor_required' };
  if (!isUuid(actor)) return { ok: false, reason: 'inventory_product_stock_repair_actor_invalid' };
  if (!Number.isFinite(expectedCurrentStock)) return { ok: false, reason: 'inventory_product_stock_repair_expected_current_stock_required' };
  if (!expectedLotFingerprint) return { ok: false, reason: 'inventory_product_stock_repair_expected_lot_fingerprint_required' };

  await client.query('BEGIN');
  try {
    const current = await client.query(
      `SELECT p.id, p.stock, p.status, p."deletedAt", p."updatedAt",
              COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') AS tracking_mode,
              c.timezone
       FROM products p
       INNER JOIN clinics c ON c.id = p."clinicId"
       WHERE p."clinicId" = $1::uuid
         AND p.id = $2::uuid
       FOR UPDATE`,
      [tenantId, productId]
    );
    if (!current.rows[0]) throw new Error('product_not_found');

    const actorResult = await client.query(
      `SELECT id, role, active, "clinicId", "accountType"
       FROM staff_users
       WHERE id = $1::uuid
         AND "clinicId" = $2::uuid
       LIMIT 1`,
      [actor, tenantId]
    );
    const actorRow = actorResult.rows[0];
    if (!actorRow || actorRow.active !== true || actorRow.accountType !== 'client_portal') {
      throw new Error('inventory_product_stock_repair_actor_not_authorized');
    }
    if (!['owner', 'manager'].includes(String(actorRow.role || '').trim().toLowerCase())) {
      throw new Error('inventory_product_stock_repair_actor_not_authorized');
    }

    await client.query(
      `SELECT id
       FROM inventory_lots
       WHERE "tenantId" = $1::uuid
         AND "productId" = $2::uuid
       ORDER BY id
       FOR UPDATE`,
      [tenantId, productId]
    );

    const lockedDetail = await loadDetail(client, tenantId, productId);
    if (!lockedDetail) throw new Error('product_not_found');

    if (lockedDetail.productStock === lockedDetail.expectedProductStock) {
      await client.query('ROLLBACK');
      return { ok: true, alreadyConsistent: true, writes: 0, auditCreated: false, ...dryRunResponse };
    }
    if (lockedDetail.productStock !== expectedCurrentStock) {
      throw new Error('inventory_product_stock_repair_stale_snapshot');
    }
    const lockedFingerprint = buildRepairFingerprint({
      fingerprint: lockedDetail.fingerprint,
      expectedProductStock: lockedDetail.expectedProductStock
    });
    if (lockedFingerprint !== expectedLotFingerprint) {
      throw new Error('inventory_product_stock_repair_stale_snapshot');
    }
    if (!lockedDetail.repairSafe || lockedDetail.sourceOfTruth !== 'LOTS') {
      throw new Error('inventory_product_stock_repair_source_unresolved');
    }

    const idempotencyKey = `inventory_lot_product_stock_resynchronized:${tenantId}:${productId}:${lockedFingerprint}:${lockedDetail.expectedProductStock}`;
    const existingAudit = await findAuditByIdempotencyKey(tenantId, 'inventory_lot_product_stock_resynchronized', idempotencyKey, client);
    if (existingAudit) {
      await client.query('ROLLBACK');
      return { ok: true, alreadyConsistent: true, writes: 0, auditCreated: false, ...dryRunResponse };
    }

    await client.query(
      `UPDATE products
       SET stock = $3,
           "updatedAt" = NOW()
       WHERE "clinicId" = $1::uuid
         AND id = $2::uuid`,
      [tenantId, productId, lockedDetail.expectedProductStock]
    );

    const audit = await createAudit(
      {
        tenantId,
        clinicId: tenantId,
        actorUserId: actor,
        action: 'inventory_lot_product_stock_resynchronized',
        payload: buildAuditPayload(lockedDetail, lockedDetail.productStock, lockedDetail.expectedProductStock, lockedDetail.rootCauseCode, idempotencyKey)
      },
      client
    );
    if (!audit || !audit.id) throw new Error('inventory_product_stock_repair_audit_failed');

    await client.query('COMMIT');
    return {
      ok: true,
      dryRun: false,
      tenantId: shorten(lockedDetail.tenantId),
      productId: shorten(lockedDetail.productId),
      previousProductStock: lockedDetail.productStock,
      newProductStock: lockedDetail.expectedProductStock,
      writes: 1,
      auditCreated: true,
      auditId: shorten(audit.id),
      lotesModified: 0,
      movementsCreated: 0,
      allocationsModified: 0
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, reason: error.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createScriptPgClient();
  await client.connect();
  try {
    const result = await repairProductStock(client, args);
    console.log(JSON.stringify(result, null, 2));
    await client.end();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  buildAuditPayload,
  isUuid,
  loadTargetProductDetail,
  repairProductStock
};
