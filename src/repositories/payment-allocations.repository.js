const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeAllocation(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    paymentId: row.paymentId,
    invoiceId: row.invoiceId,
    amount: quantizeDecimal(row.amount || 0, 2, 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    payment: row.paymentId
      ? {
          id: row.paymentId,
          status: row.paymentStatus || null,
          amount: quantizeDecimal(row.paymentAmount || 0, 2, 0),
          currency: row.paymentCurrency || null,
          paidAt: row.paymentPaidAt || null
        }
      : null,
    invoice: row.invoiceId
      ? {
          id: row.invoiceId,
          invoiceNumber: row.invoiceNumber || null,
          type: row.invoiceType || null,
          status: row.invoiceStatus || null,
          totalAmount: quantizeDecimal(row.invoiceTotalAmount || 0, 2, 0),
          currency: row.invoiceCurrency || null
        }
      : null
  };
}

function baseAllocationSelect() {
  return `SELECT
       pa.id,
       pa."clinicId",
       pa."paymentId",
       pa."invoiceId",
       pa.amount,
       pa."createdAt",
       pa."updatedAt",
       p.status AS "paymentStatus",
       p.amount AS "paymentAmount",
       p.currency AS "paymentCurrency",
       p."paidAt" AS "paymentPaidAt",
       i."invoiceNumber",
       i.type AS "invoiceType",
       i.status AS "invoiceStatus",
       i."totalAmount" AS "invoiceTotalAmount",
       i.currency AS "invoiceCurrency"
     FROM payment_allocations pa
     INNER JOIN payments p ON p.id = pa."paymentId"
     INNER JOIN invoices i ON i.id = pa."invoiceId"`;
}

async function createPaymentAllocation(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO payment_allocations (
       "clinicId",
       "paymentId",
       "invoiceId",
       amount
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
     RETURNING id`,
    [
      input.clinicId,
      input.paymentId,
      input.invoiceId,
      quantizeDecimal(input.amount || 0, 2, 0)
    ]
  );

  return findPaymentAllocationById(result.rows[0].id, input.clinicId, client);
}

async function findPaymentAllocationById(allocationId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseAllocationSelect()}
     WHERE pa.id = $1::uuid
       AND pa."clinicId" = $2::uuid
     LIMIT 1`,
    [allocationId, clinicId]
  );

  return normalizeAllocation(result.rows[0] || null);
}

async function listAllocationsByPaymentId(paymentId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseAllocationSelect()}
     WHERE pa."paymentId" = $1::uuid
       AND pa."clinicId" = $2::uuid
     ORDER BY pa."createdAt" ASC`,
    [paymentId, clinicId]
  );

  return result.rows.map(normalizeAllocation);
}

async function listAllocationsByInvoiceId(invoiceId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseAllocationSelect()}
     WHERE pa."invoiceId" = $1::uuid
       AND pa."clinicId" = $2::uuid
     ORDER BY pa."createdAt" ASC`,
    [invoiceId, clinicId]
  );

  return result.rows.map(normalizeAllocation);
}

async function sumRecordedAllocatedAmountsByInvoiceIds(clinicId, invoiceIds = [], client = null) {
  const ids = Array.isArray(invoiceIds) ? invoiceIds.filter(Boolean) : [];
  if (!ids.length) return {};

  const result = await dbQuery(
    client,
    `WITH effective_allocations AS (
       SELECT
         pa."invoiceId",
         pa.amount
       FROM payment_allocations pa
       INNER JOIN payments p
         ON p.id = pa."paymentId"
        AND p."clinicId" = pa."clinicId"
       WHERE pa."clinicId" = $1::uuid
         AND pa."invoiceId" = ANY($2::uuid[])
         AND p.status = 'recorded'

       UNION ALL

       SELECT
         p."invoiceId",
         p.amount
       FROM payments p
       WHERE p."clinicId" = $1::uuid
         AND p."invoiceId" = ANY($2::uuid[])
         AND p.status = 'recorded'
         AND NOT EXISTS (
           SELECT 1
           FROM payment_allocations pa
           WHERE pa."paymentId" = p.id
             AND pa."clinicId" = p."clinicId"
         )
     )
     SELECT
       "invoiceId",
       COALESCE(SUM(amount), 0)::numeric(12,2) AS "paidAmount"
     FROM effective_allocations
     GROUP BY "invoiceId"`,
    [clinicId, ids]
  );

  return result.rows.reduce((acc, row) => {
    acc[row.invoiceId] = quantizeDecimal(row.paidAmount || 0, 2, 0);
    return acc;
  }, {});
}

async function sumRecordedAllocatedAmountsByPaymentIds(clinicId, paymentIds = [], client = null) {
  const ids = Array.isArray(paymentIds) ? paymentIds.filter(Boolean) : [];
  if (!ids.length) return {};

  const result = await dbQuery(
    client,
    `WITH effective_allocations AS (
       SELECT
         pa."paymentId",
         pa.amount
       FROM payment_allocations pa
       INNER JOIN payments p
         ON p.id = pa."paymentId"
        AND p."clinicId" = pa."clinicId"
       WHERE pa."clinicId" = $1::uuid
         AND pa."paymentId" = ANY($2::uuid[])
         AND p.status = 'recorded'

       UNION ALL

       SELECT
         p.id AS "paymentId",
         p.amount
       FROM payments p
       WHERE p."clinicId" = $1::uuid
         AND p.id = ANY($2::uuid[])
         AND p.status = 'recorded'
         AND p."invoiceId" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM payment_allocations pa
           WHERE pa."paymentId" = p.id
             AND pa."clinicId" = p."clinicId"
         )
     )
     SELECT
       "paymentId",
       COALESCE(SUM(amount), 0)::numeric(12,2) AS "allocatedAmount"
     FROM effective_allocations
     GROUP BY "paymentId"`,
    [clinicId, ids]
  );

  return result.rows.reduce((acc, row) => {
    acc[row.paymentId] = quantizeDecimal(row.allocatedAmount || 0, 2, 0);
    return acc;
  }, {});
}

module.exports = {
  createPaymentAllocation,
  findPaymentAllocationById,
  listAllocationsByPaymentId,
  listAllocationsByInvoiceId,
  sumRecordedAllocatedAmountsByInvoiceIds,
  sumRecordedAllocatedAmountsByPaymentIds
};
