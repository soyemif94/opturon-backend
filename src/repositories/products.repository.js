const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeProduct(row) {
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    description: row.description || null,
    price: Number(row.price || 0),
    currency: row.currency,
    stock: Number(row.stock || 0),
    status: row.status,
    sku: row.sku || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listProductsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, description, price, currency, stock, status, sku, "createdAt", "updatedAt"
     FROM products
     WHERE "clinicId" = $1::uuid
     ORDER BY "createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeProduct);
}

async function findProductById(productId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, description, price, currency, stock, status, sku, "createdAt", "updatedAt"
     FROM products
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [productId, clinicId]
  );

  return result.rows[0] ? normalizeProduct(result.rows[0]) : null;
}

async function createProduct(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO products (
       "clinicId",
       name,
       description,
       price,
       currency,
       stock,
       status,
       sku,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.name,
      input.description || null,
      input.price,
      input.currency,
      input.stock,
      input.status,
      input.sku || null
    ]
  );

  return findProductById(result.rows[0].id, input.clinicId, client);
}

async function updateProduct(productId, clinicId, payload, client = null) {
  const current = await findProductById(productId, clinicId, client);
  if (!current) return null;

  await dbQuery(
    client,
    `UPDATE products
     SET
       name = $3,
       description = $4,
       price = $5,
       currency = $6,
       stock = $7,
       status = $8,
       sku = $9,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid`,
    [
      productId,
      clinicId,
      payload.name,
      payload.description || null,
      payload.price,
      payload.currency,
      payload.stock,
      payload.status,
      payload.sku || null
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
