const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizePayment(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    contactId: row.contactId || null,
    invoiceId: row.invoiceId || null,
    amount: quantizeDecimal(row.amount || 0, 2, 0),
    currency: row.currency || 'ARS',
    method: row.method || 'other',
    status: row.status || 'recorded',
    paidAt: row.paidAt || null,
    externalReference: row.externalReference || null,
    notes: row.notes || null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: row.contactName || null,
          phone: row.contactPhone || null
        }
      : null
  };
}

function basePaymentSelect() {
  return `SELECT
       p.id,
       p."clinicId",
       p."contactId",
       p."invoiceId",
       p.amount,
       p.currency,
       p.method,
       p.status,
       p."paidAt",
       p."externalReference",
       p.notes,
       p.metadata,
       p."createdAt",
       p."updatedAt",
       c.name AS "contactName",
       c.phone AS "contactPhone"
     FROM payments p
     LEFT JOIN contacts c ON c.id = p."contactId"`;
}

async function listPaymentsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${basePaymentSelect()}
     WHERE p."clinicId" = $1::uuid
     ORDER BY p."paidAt" DESC, p."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizePayment);
}

async function listPaymentsByContactId(clinicId, contactId, client = null) {
  const result = await dbQuery(
    client,
    `${basePaymentSelect()}
     WHERE p."clinicId" = $1::uuid
       AND p."contactId" = $2::uuid
     ORDER BY p."paidAt" DESC, p."createdAt" DESC`,
    [clinicId, contactId]
  );

  return result.rows.map(normalizePayment);
}

async function findPaymentById(paymentId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${basePaymentSelect()}
     WHERE p.id = $1::uuid
       AND p."clinicId" = $2::uuid
     LIMIT 1`,
    [paymentId, clinicId]
  );

  return normalizePayment(result.rows[0] || null);
}

async function lockPaymentById(paymentId, clinicId, client) {
  const result = await dbQuery(
    client,
    `SELECT id
     FROM payments
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     FOR UPDATE`,
    [paymentId, clinicId]
  );

  return Boolean(result.rows[0]);
}

async function createPayment(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO payments (
       "clinicId",
       "contactId",
       "invoiceId",
       amount,
       currency,
       method,
       status,
       "paidAt",
       "externalReference",
       notes,
       metadata,
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.contactId || null,
      input.invoiceId || null,
      quantizeDecimal(input.amount || 0, 2, 0),
      input.currency || 'ARS',
      input.method || 'other',
      input.status || 'recorded',
      input.paidAt || null,
      input.externalReference || null,
      input.notes || null,
      JSON.stringify(input.metadata || {})
    ]
  );

  return findPaymentById(result.rows[0].id, input.clinicId, client);
}

async function voidPayment(paymentId, clinicId, input = {}, client = null) {
  const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata || {});

  await dbQuery(
    client,
    `UPDATE payments
     SET status = 'void',
         notes = COALESCE($3, notes),
         "externalReference" = COALESCE($4, "externalReference"),
         metadata = COALESCE($5::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid`,
    [
      paymentId,
      clinicId,
      input.notes || null,
      input.externalReference || null,
      metadataJson
    ]
  );

  return findPaymentById(paymentId, clinicId, client);
}

module.exports = {
  listPaymentsByClinicId,
  listPaymentsByContactId,
  findPaymentById,
  lockPaymentById,
  createPayment,
  voidPayment
};
