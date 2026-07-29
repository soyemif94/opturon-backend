const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') return client.query(text, params);
  return query(text, params);
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeOperation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    lotId: row.lotId || null,
    operationType: row.operationType,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    requestMetadata: normalizeMetadata(row.requestMetadata),
    result: normalizeMetadata(row.result),
    createdBy: row.createdBy || null,
    createdAt: row.createdAt,
    completedAt: row.completedAt || null,
    failureCode: row.failureCode || null
  };
}

async function findInventoryLotOperationByIdempotencyKey(tenantId, operationType, idempotencyKey, client = null, options = {}) {
  if (!tenantId || !operationType || !idempotencyKey) return null;
  const result = await dbQuery(
    client,
    `SELECT *
     FROM inventory_lot_operations
     WHERE "tenantId" = $1::uuid
       AND "operationType" = $2
       AND "idempotencyKey" = $3
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId, operationType, idempotencyKey]
  );
  return normalizeOperation(result.rows[0] || null);
}

async function createInventoryLotOperation(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO inventory_lot_operations (
       "tenantId",
       "productId",
       "lotId",
       "operationType",
       "idempotencyKey",
       status,
       "requestMetadata",
       result,
       "createdBy"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid)
     ON CONFLICT ("tenantId", "operationType", "idempotencyKey") DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.productId,
      input.lotId || null,
      input.operationType,
      input.idempotencyKey,
      input.status || 'processing',
      JSON.stringify(normalizeMetadata(input.requestMetadata)),
      JSON.stringify(normalizeMetadata(input.result)),
      input.createdBy || null
    ]
  );
  if (result.rows[0]) {
    return { ...normalizeOperation(result.rows[0]), wasCreated: true };
  }

  const existing = await findInventoryLotOperationByIdempotencyKey(
    input.tenantId,
    input.operationType,
    input.idempotencyKey,
    client,
    { forUpdate: true }
  );
  return existing ? { ...existing, wasCreated: false } : null;
}

async function updateInventoryLotOperation(operationId, tenantId, patch, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE inventory_lot_operations
     SET "lotId" = COALESCE($3::uuid, "lotId"),
         status = COALESCE($4, status),
         result = COALESCE($5::jsonb, result),
         "completedAt" = CASE WHEN $4 IN ('completed', 'failed', 'partially_completed') THEN COALESCE($6::timestamptz, NOW()) ELSE "completedAt" END,
         "failureCode" = COALESCE($7, "failureCode")
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING *`,
    [
      operationId,
      tenantId,
      patch.lotId || null,
      patch.status || null,
      patch.result === undefined ? null : JSON.stringify(normalizeMetadata(patch.result)),
      patch.completedAt || null,
      patch.failureCode || null
    ]
  );
  return normalizeOperation(result.rows[0] || null);
}

module.exports = {
  findInventoryLotOperationByIdempotencyKey,
  createInventoryLotOperation,
  updateInventoryLotOperation
};
