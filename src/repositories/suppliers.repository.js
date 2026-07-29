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

function normalizeMetadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSupplier(row) {
  const legalName = normalizeString(row.legalName);
  const tradeName = normalizeString(row.tradeName) || null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    legalName,
    tradeName,
    displayName: tradeName || legalName,
    taxId: row.taxId || null,
    email: row.email || null,
    phone: row.phone || null,
    address: row.address || null,
    notes: row.notes || null,
    status: row.status || 'active',
    linkedProductsCount: Number(row.linkedProductsCount || 0),
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    deactivatedAt: row.deactivatedAt || null,
    deactivatedBy: row.deactivatedBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: normalizeMetadataObject(row.metadata)
  };
}

function buildListWhereClause(filters, params) {
  const clauses = ['s."tenantId" = $1::uuid'];
  if (filters.status === 'active' || filters.status === 'inactive') {
    params.push(filters.status);
    clauses.push(`s.status = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    clauses.push(`(
      s."legalName" ILIKE $${params.length}
      OR COALESCE(s."tradeName", '') ILIKE $${params.length}
      OR COALESCE(s."taxId", '') ILIKE $${params.length}
    )`);
  }
  return clauses.join(' AND ');
}

function resolveOrderBy(sort) {
  if (sort === 'name_desc') return 'display_name DESC, s."updatedAt" DESC';
  if (sort === 'updated_asc') return 's."updatedAt" ASC, display_name ASC';
  if (sort === 'updated_desc') return 's."updatedAt" DESC, display_name ASC';
  return 'display_name ASC, s."updatedAt" DESC';
}

async function listSuppliersByTenantId(tenantId, filters = {}, client = null) {
  const safeTenantId = normalizeString(tenantId);
  const page = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const pageSize = Number.isInteger(filters.pageSize) && filters.pageSize > 0 ? Math.min(filters.pageSize, 100) : 20;
  const params = [safeTenantId];
  const whereClause = buildListWhereClause(
    {
      search: normalizeString(filters.search) || null,
      status: normalizeString(filters.status).toLowerCase() || null
    },
    params
  );
  const offset = (page - 1) * pageSize;
  params.push(pageSize);
  params.push(offset);

  const result = await dbQuery(
    client,
    `WITH filtered AS (
       SELECT
         s.*,
         COALESCE(s."tradeName", s."legalName") AS display_name,
         (
           SELECT COUNT(*)::int
           FROM products p
           WHERE p."clinicId" = s."tenantId"
             AND p."defaultSupplierId" = s.id
             AND p."deletedAt" IS NULL
         ) AS "linkedProductsCount"
       FROM suppliers s
       WHERE ${whereClause}
     ),
     counted AS (
       SELECT COUNT(*)::int AS total FROM filtered
     )
     SELECT
       filtered.*,
       counted.total
     FROM filtered
     CROSS JOIN counted
     ORDER BY ${resolveOrderBy(normalizeString(filters.sort).toLowerCase())}
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );

  const total = Number(result.rows[0] && result.rows[0].total ? result.rows[0].total : 0);
  return {
    items: result.rows.map(normalizeSupplier),
    total,
    page,
    pageSize
  };
}

async function findSupplierById(supplierId, tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       s.*,
       (
         SELECT COUNT(*)::int
         FROM products p
         WHERE p."clinicId" = s."tenantId"
           AND p."defaultSupplierId" = s.id
           AND p."deletedAt" IS NULL
       ) AS "linkedProductsCount"
     FROM suppliers s
     WHERE s.id = $1::uuid
       AND s."tenantId" = $2::uuid
     LIMIT 1`,
    [supplierId, tenantId]
  );

  return result.rows[0] ? normalizeSupplier(result.rows[0]) : null;
}

async function findSupplierByTaxId(tenantId, normalizedTaxId, client = null) {
  const safeNormalizedTaxId = normalizeString(normalizedTaxId);
  if (!safeNormalizedTaxId) return null;
  const result = await dbQuery(
    client,
    `SELECT s.*
     FROM suppliers s
     WHERE s."tenantId" = $1::uuid
       AND s."normalizedTaxId" = $2
     LIMIT 1`,
    [tenantId, safeNormalizedTaxId]
  );
  return result.rows[0] ? normalizeSupplier(result.rows[0]) : null;
}

async function createSupplier(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO suppliers (
       "tenantId",
       "legalName",
       "tradeName",
       "normalizedTaxId",
       "taxId",
       email,
       phone,
       address,
       notes,
       status,
       "createdBy",
       "updatedBy",
       "createdAt",
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, NOW(), NOW())
     RETURNING id`,
    [
      input.tenantId,
      input.legalName,
      input.tradeName || null,
      input.normalizedTaxId || null,
      input.taxId || null,
      input.email || null,
      input.phone || null,
      input.address || null,
      input.notes || null,
      input.status || 'active',
      input.createdBy || null,
      input.updatedBy || input.createdBy || null
    ]
  );
  return findSupplierById(result.rows[0].id, input.tenantId, client);
}

async function updateSupplier(supplierId, tenantId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE suppliers
     SET
       "legalName" = $3,
       "tradeName" = $4,
       "normalizedTaxId" = $5,
       "taxId" = $6,
       email = $7,
       phone = $8,
       address = $9,
       notes = $10,
       "updatedBy" = $11::uuid,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id`,
    [
      supplierId,
      tenantId,
      input.legalName,
      input.tradeName || null,
      input.normalizedTaxId || null,
      input.taxId || null,
      input.email || null,
      input.phone || null,
      input.address || null,
      input.notes || null,
      input.updatedBy || null
    ]
  );
  if (!result.rows[0]) return null;
  return findSupplierById(supplierId, tenantId, client);
}

async function setSupplierStatus(supplierId, tenantId, status, actorUserId = null, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE suppliers
     SET
       status = $3,
       "updatedBy" = $4::uuid,
       "updatedAt" = NOW(),
       "deactivatedAt" = CASE WHEN $3 = 'inactive' THEN NOW() ELSE NULL END,
       "deactivatedBy" = CASE WHEN $3 = 'inactive' THEN $4::uuid ELSE NULL END
     WHERE id = $1::uuid
       AND "tenantId" = $2::uuid
     RETURNING id`,
    [supplierId, tenantId, status, actorUserId]
  );
  if (!result.rows[0]) return null;
  return findSupplierById(supplierId, tenantId, client);
}

async function listSupplierLinkedProducts(supplierId, tenantId, client = null, limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const result = await dbQuery(
    client,
    `SELECT
       p.id,
       p.name,
       p.sku,
       p.status,
       p."updatedAt"
     FROM products p
     WHERE p."clinicId" = $1::uuid
       AND p."defaultSupplierId" = $2::uuid
       AND p."deletedAt" IS NULL
     ORDER BY p."updatedAt" DESC
     LIMIT $3`,
    [tenantId, supplierId, safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku || null,
    status: row.status || 'active',
    updatedAt: row.updatedAt
  }));
}

module.exports = {
  listSuppliersByTenantId,
  findSupplierById,
  findSupplierByTaxId,
  createSupplier,
  updateSupplier,
  setSupplierStatus,
  listSupplierLinkedProducts
};
