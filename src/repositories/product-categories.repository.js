const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    isActive: row.isActive !== false,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

async function listProductCategoriesByClinicId(clinicId, { includeInactive = true } = {}, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, "isActive", "createdAt", "updatedAt"
     FROM product_categories
     WHERE "clinicId" = $1::uuid
       AND ($2::boolean = TRUE OR "isActive" = TRUE)
     ORDER BY lower(name) ASC, "createdAt" DESC`,
    [clinicId, includeInactive]
  );

  return result.rows.map(normalizeCategory);
}

async function findProductCategoryById(categoryId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, "isActive", "createdAt", "updatedAt"
     FROM product_categories
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [categoryId, clinicId]
  );

  return normalizeCategory(result.rows[0] || null);
}

async function createProductCategory(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO product_categories (
       "clinicId",
       name,
       "isActive",
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, NOW())
     RETURNING id`,
    [input.clinicId, input.name, input.isActive !== false]
  );

  return findProductCategoryById(result.rows[0].id, input.clinicId, client);
}

async function updateProductCategory(categoryId, clinicId, input, client = null) {
  const current = await findProductCategoryById(categoryId, clinicId, client);
  if (!current) return null;

  await dbQuery(
    client,
    `UPDATE product_categories
     SET
       name = $3,
       "isActive" = $4,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid`,
    [categoryId, clinicId, input.name, input.isActive !== false]
  );

  return findProductCategoryById(categoryId, clinicId, client);
}

module.exports = {
  listProductCategoriesByClinicId,
  findProductCategoryById,
  createProductCategory,
  updateProductCategory
};
