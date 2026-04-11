const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized.slice(0, 10);
  return normalized;
}

function normalizeProduct(row) {
  const unitPrice = quantizeDecimal(row.unitPrice ?? row.price ?? 0, 2, 0);
  const vatRate = quantizeDecimal(row.vatRate ?? 0, 2, 0);
  const status = row.status || 'active';

  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    description: row.description || null,
    unitPrice,
    price: unitPrice,
    currency: row.currency,
    vatRate,
    taxRate: vatRate,
    stock: Number(row.stock || 0),
    status,
    active: status === 'active',
    sku: row.sku || null,
    categoryId: row.categoryId || null,
    categoryName: row.categoryName || null,
    expirationDate: normalizeDateOnly(row.expirationDate),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listProductsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
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
       p."categoryId",
       p."expirationDate",
       c.name AS "categoryName",
       p.metadata,
       p."createdAt",
       p."updatedAt"
     FROM products p
     LEFT JOIN product_categories c
       ON c.id = p."categoryId"
     WHERE p."clinicId" = $1::uuid
     ORDER BY p."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeProduct);
}

async function findProductById(productId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
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
       p."categoryId",
       p."expirationDate",
       c.name AS "categoryName",
       p.metadata,
       p."createdAt",
       p."updatedAt"
     FROM products p
     LEFT JOIN product_categories c
       ON c.id = p."categoryId"
     WHERE p.id = $1::uuid
       AND p."clinicId" = $2::uuid
     LIMIT 1`,
    [productId, clinicId]
  );

  return result.rows[0] ? normalizeProduct(result.rows[0]) : null;
}

async function createProduct(input, client = null) {
  const safeUnitPrice = quantizeDecimal(input.unitPrice ?? input.price ?? 0, 2, 0);
  const safeVatRate = quantizeDecimal(input.vatRate ?? input.taxRate ?? 0, 2, 0);

  const result = await dbQuery(
    client,
    `INSERT INTO products (
       "clinicId",
       name,
       description,
       price,
       "unitPrice",
       currency,
       "vatRate",
       stock,
       status,
       sku,
       "categoryId",
       "expirationDate",
       metadata,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::date, $13::jsonb, NOW())
      RETURNING id`,
    [
      input.clinicId,
      input.name,
      input.description || null,
      safeUnitPrice,
      safeUnitPrice,
      input.currency,
      safeVatRate,
      input.stock,
      input.status,
      input.sku || null,
      input.categoryId || null,
      input.expirationDate || null,
      JSON.stringify(input.metadata || {})
    ]
  );

  return findProductById(result.rows[0].id, input.clinicId, client);
}

async function updateProduct(productId, clinicId, payload, client = null) {
  const current = await findProductById(productId, clinicId, client);
  if (!current) return null;

  const safeUnitPrice = quantizeDecimal(payload.unitPrice ?? payload.price ?? current.unitPrice ?? current.price ?? 0, 2, 0);
  const safeVatRate = quantizeDecimal(payload.vatRate ?? payload.taxRate ?? current.vatRate ?? current.taxRate ?? 0, 2, 0);

  await dbQuery(
    client,
    `UPDATE products
     SET
       name = $3,
       description = $4,
       price = $5,
       "unitPrice" = $6,
       currency = $7,
       "vatRate" = $8,
       stock = $9,
       status = $10,
       sku = $11,
       "categoryId" = $12::uuid,
       "expirationDate" = $13::date,
       metadata = $14::jsonb,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid`,
    [
      productId,
      clinicId,
      payload.name,
      payload.description || null,
      safeUnitPrice,
      safeUnitPrice,
      payload.currency,
      safeVatRate,
      payload.stock,
      payload.status,
      payload.sku || null,
      payload.categoryId || null,
      payload.expirationDate || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  return findProductById(productId, clinicId, client);
}

async function updateProductStatus(productId, clinicId, status, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE products
     SET
       status = $3,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [productId, clinicId, status]
  );

  if (!result.rows[0]) return null;
  return findProductById(productId, clinicId, client);
}

async function deleteProductById(productId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `DELETE FROM products
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [productId, clinicId]
  );

  return Boolean(result.rows[0]);
}

module.exports = {
  listProductsByClinicId,
  findProductById,
  createProduct,
  updateProduct,
  updateProductStatus,
  deleteProductById
};
