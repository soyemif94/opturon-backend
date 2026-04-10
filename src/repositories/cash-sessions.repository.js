const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeCashSession(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    paymentDestinationId: row.paymentDestinationId,
    openedByUserId: row.openedByUserId,
    openedByNameSnapshot: row.openedByNameSnapshot || null,
    openedAt: row.openedAt || null,
    openingAmount: quantizeDecimal(row.openingAmount || 0, 2, 0),
    status: row.status || 'open',
    closedByUserId: row.closedByUserId || null,
    closedByNameSnapshot: row.closedByNameSnapshot || null,
    closedAt: row.closedAt || null,
    cashCountedAmount:
      row.cashCountedAmount === null || row.cashCountedAmount === undefined ? null : quantizeDecimal(row.cashCountedAmount, 2, 0),
    transferCountedAmount:
      row.transferCountedAmount === null || row.transferCountedAmount === undefined ? null : quantizeDecimal(row.transferCountedAmount, 2, 0),
    countedAmount: row.countedAmount === null || row.countedAmount === undefined ? null : quantizeDecimal(row.countedAmount, 2, 0),
    totalCountedAmount: row.countedAmount === null || row.countedAmount === undefined ? null : quantizeDecimal(row.countedAmount, 2, 0),
    expectedAmount: row.expectedAmount === null || row.expectedAmount === undefined ? null : quantizeDecimal(row.expectedAmount, 2, 0),
    differenceAmount: row.differenceAmount === null || row.differenceAmount === undefined ? null : quantizeDecimal(row.differenceAmount, 2, 0),
    notes: row.notes || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function baseSelect() {
  return `SELECT
      id,
      "clinicId",
      "paymentDestinationId",
      "openedByUserId",
      "openedByNameSnapshot",
      "openedAt",
      "openingAmount",
      status,
      "closedByUserId",
      "closedByNameSnapshot",
      "closedAt",
      "cashCountedAmount",
      "transferCountedAmount",
      "countedAmount",
      "expectedAmount",
      "differenceAmount",
      notes,
      "createdAt",
      "updatedAt"
    FROM cash_sessions`;
}

async function listCashSessionsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseSelect()}
     WHERE "clinicId" = $1::uuid
     ORDER BY "openedAt" DESC, "createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeCashSession);
}

async function findCashSessionById(sessionId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseSelect()}
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [sessionId, clinicId]
  );

  return normalizeCashSession(result.rows[0] || null);
}

async function findOpenCashSessionByDestinationId(paymentDestinationId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseSelect()}
     WHERE "paymentDestinationId" = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'open'
     LIMIT 1`,
    [paymentDestinationId, clinicId]
  );

  return normalizeCashSession(result.rows[0] || null);
}

async function createCashSession(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO cash_sessions (
       "clinicId",
       "paymentDestinationId",
       "openedByUserId",
       "openedByNameSnapshot",
       "openedAt",
       "openingAmount",
       status,
       notes,
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, COALESCE($5::timestamptz, NOW()), $6, 'open', $7, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.paymentDestinationId,
      input.openedByUserId,
      input.openedByNameSnapshot,
      input.openedAt || null,
      quantizeDecimal(input.openingAmount || 0, 2, 0),
      input.notes || null
    ]
  );

  return findCashSessionById(result.rows[0].id, input.clinicId, client);
}

async function closeCashSession(sessionId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE cash_sessions
     SET
       status = 'closed',
       "closedByUserId" = $3::uuid,
       "closedByNameSnapshot" = $4,
       "closedAt" = $5,
       "cashCountedAmount" = $6,
       "transferCountedAmount" = $7,
       "countedAmount" = $8,
       "expectedAmount" = $9,
       "differenceAmount" = $10,
       notes = COALESCE($11, notes),
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'open'
     RETURNING id`,
    [
      sessionId,
      clinicId,
      input.closedByUserId,
      input.closedByNameSnapshot,
      input.closedAt,
      input.cashCountedAmount === null || input.cashCountedAmount === undefined ? null : quantizeDecimal(input.cashCountedAmount, 2, 0),
      input.transferCountedAmount === null || input.transferCountedAmount === undefined ? null : quantizeDecimal(input.transferCountedAmount, 2, 0),
      quantizeDecimal(input.countedAmount || 0, 2, 0),
      quantizeDecimal(input.expectedAmount || 0, 2, 0),
      quantizeDecimal(input.differenceAmount || 0, 2, 0),
      input.notes || null
    ]
  );

  if (!result.rows[0]) return null;
  return findCashSessionById(sessionId, clinicId, client);
}

module.exports = {
  listCashSessionsByClinicId,
  findCashSessionById,
  findOpenCashSessionByDestinationId,
  createCashSession,
  closeCashSession
};
