const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeCashSessionMovement(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    cashSessionId: row.cashSessionId,
    type: row.type,
    amount: quantizeDecimal(row.amount || 0, 2, 0),
    method: row.method,
    reason: row.reason || null,
    createdByUserId: row.createdByUserId,
    createdByNameSnapshot: row.createdByNameSnapshot || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function baseSelect() {
  return `SELECT
      id,
      "clinicId",
      "cashSessionId",
      type,
      amount,
      method,
      reason,
      "createdByUserId",
      "createdByNameSnapshot",
      "createdAt",
      "updatedAt"
    FROM cash_session_movements`;
}

async function listCashSessionMovementsBySessionId(sessionId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseSelect()}
     WHERE "cashSessionId" = $1::uuid
       AND "clinicId" = $2::uuid
     ORDER BY "createdAt" DESC, "updatedAt" DESC`,
    [sessionId, clinicId]
  );

  return result.rows.map(normalizeCashSessionMovement);
}

async function createCashSessionMovement(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO cash_session_movements (
       "clinicId",
       "cashSessionId",
       type,
       amount,
       method,
       reason,
       "createdByUserId",
       "createdByNameSnapshot",
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.cashSessionId,
      input.type,
      quantizeDecimal(input.amount || 0, 2, 0),
      input.method,
      input.reason || null,
      input.createdByUserId,
      input.createdByNameSnapshot
    ]
  );

  const movementId = result.rows[0] && result.rows[0].id;
  if (!movementId) return null;

  const movement = await dbQuery(
    client,
    `${baseSelect()}
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [movementId, input.clinicId]
  );

  return normalizeCashSessionMovement(movement.rows[0] || null);
}

module.exports = {
  listCashSessionMovementsBySessionId,
  createCashSessionMovement
};
