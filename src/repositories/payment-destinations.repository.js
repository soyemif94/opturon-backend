const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeDestination(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    type: row.type,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

async function listPaymentDestinationsByClinicId(clinicId, options = {}, client = null) {
  const includeInactive = Boolean(options.includeInactive);
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       name,
       type,
       "isActive",
       "createdAt",
       "updatedAt"
     FROM payment_destinations
     WHERE "clinicId" = $1::uuid
       AND ($2::boolean = TRUE OR "isActive" = TRUE)
     ORDER BY "isActive" DESC, LOWER(name) ASC, "createdAt" ASC`,
    [clinicId, includeInactive]
  );

  return result.rows.map(normalizeDestination);
}

async function findPaymentDestinationById(destinationId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       name,
       type,
       "isActive",
       "createdAt",
       "updatedAt"
     FROM payment_destinations
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [destinationId, clinicId]
  );

  return normalizeDestination(result.rows[0] || null);
}

async function createPaymentDestination(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO payment_destinations (
       "clinicId",
       name,
       type,
       "isActive",
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, NOW())
     RETURNING id`,
    [input.clinicId, input.name, input.type, input.isActive !== false]
  );

  return findPaymentDestinationById(result.rows[0].id, input.clinicId, client);
}

async function updatePaymentDestination(destinationId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE payment_destinations
     SET
       name = $3,
       type = $4,
       "isActive" = $5,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [destinationId, clinicId, input.name, input.type, input.isActive !== false]
  );

  if (!result.rows[0]) return null;
  return findPaymentDestinationById(destinationId, clinicId, client);
}

module.exports = {
  listPaymentDestinationsByClinicId,
  findPaymentDestinationById,
  createPaymentDestination,
  updatePaymentDestination
};
