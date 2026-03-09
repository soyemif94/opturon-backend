const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createFailure({ reason, phoneNumberId, providerMessageId, requestId, raw, error }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO inbound_failures (
      reason,
      "phoneNumberId",
      "providerMessageId",
      "requestId",
      raw,
      error
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    RETURNING id, reason, "receivedAt"`,
    [
      reason,
      phoneNumberId || null,
      providerMessageId || null,
      requestId || null,
      JSON.stringify(raw || {}),
      error ? String(error).slice(0, 2000) : null
    ]
  );

  return result.rows[0] || null;
}

async function listFailures(limit = 50, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 50;
  const safeLimit = Math.max(1, Math.min(200, parsedLimit));

  const result = await dbQuery(
    client,
    `SELECT id, "receivedAt", reason, "phoneNumberId", "providerMessageId", "requestId", raw, error
     FROM inbound_failures
     ORDER BY "receivedAt" DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
}

module.exports = {
  createFailure,
  listFailures
};

