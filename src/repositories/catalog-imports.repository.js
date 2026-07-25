const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeImportJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    clinicId: row.clinicId,
    actorId: row.actorId || null,
    actorName: row.actorName || null,
    status: row.status,
    originalFileName: row.originalFileName,
    safeFileName: row.safeFileName,
    fileType: row.fileType,
    mimeType: row.mimeType || null,
    fileSizeBytes: Number(row.fileSizeBytes || 0),
    config: row.config || {},
    analysis: row.analysis || {},
    result: row.result || {},
    confirmedAt: row.confirmedAt || null,
    completedAt: row.completedAt || null,
    cancelledAt: row.cancelledAt || null,
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

async function createCatalogImportJob(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO catalog_import_jobs (
      "tenantId",
      "clinicId",
      "actorId",
      "actorName",
      status,
      "originalFileName",
      "safeFileName",
      "fileType",
      "mimeType",
      "fileSizeBytes",
      config,
      analysis,
      result,
      "expiresAt",
      "updatedAt"
    )
    VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::jsonb, '{}'::jsonb), COALESCE($12::jsonb, '{}'::jsonb), COALESCE($13::jsonb, '{}'::jsonb), $14::timestamptz, NOW())
    RETURNING *`,
    [
      input.tenantId,
      input.clinicId,
      input.actorId || null,
      input.actorName || null,
      input.status || 'uploaded',
      input.originalFileName,
      input.safeFileName,
      input.fileType,
      input.mimeType || null,
      Number(input.fileSizeBytes || 0),
      JSON.stringify(input.config || {}),
      JSON.stringify(input.analysis || {}),
      JSON.stringify(input.result || {}),
      input.expiresAt
    ]
  );

  return normalizeImportJob(result.rows[0] || null);
}

async function findCatalogImportJobById(importId, clinicId, client = null, { forUpdate = false } = {}) {
  const result = await dbQuery(
    client,
    `SELECT *
     FROM catalog_import_jobs
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [importId, clinicId]
  );

  return normalizeImportJob(result.rows[0] || null);
}

async function listCatalogImportJobsByClinicId(clinicId, options = {}, client = null) {
  const safeLimit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 20;
  const result = await dbQuery(
    client,
    `SELECT *
     FROM catalog_import_jobs
     WHERE "clinicId" = $1::uuid
     ORDER BY COALESCE("completedAt", "confirmedAt", "createdAt") DESC, "createdAt" DESC
     LIMIT $2`,
    [clinicId, safeLimit]
  );

  return result.rows.map(normalizeImportJob);
}

async function updateCatalogImportJob(importId, clinicId, patch, client = null) {
  const current = await findCatalogImportJobById(importId, clinicId, client);
  if (!current) return null;

  const result = await dbQuery(
    client,
    `UPDATE catalog_import_jobs
     SET
       status = $3,
       config = $4::jsonb,
       analysis = $5::jsonb,
       result = $6::jsonb,
       "confirmedAt" = $7::timestamptz,
       "completedAt" = $8::timestamptz,
       "cancelledAt" = $9::timestamptz,
       "expiresAt" = $10::timestamptz,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING *`,
    [
      importId,
      clinicId,
      patch.status || current.status,
      JSON.stringify(patch.config !== undefined ? patch.config : current.config || {}),
      JSON.stringify(patch.analysis !== undefined ? patch.analysis : current.analysis || {}),
      JSON.stringify(patch.result !== undefined ? patch.result : current.result || {}),
      patch.confirmedAt !== undefined ? patch.confirmedAt : current.confirmedAt,
      patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
      patch.cancelledAt !== undefined ? patch.cancelledAt : current.cancelledAt,
      patch.expiresAt !== undefined ? patch.expiresAt : current.expiresAt
    ]
  );

  return normalizeImportJob(result.rows[0] || null);
}

module.exports = {
  createCatalogImportJob,
  findCatalogImportJobById,
  listCatalogImportJobsByClinicId,
  updateCatalogImportJob
};
