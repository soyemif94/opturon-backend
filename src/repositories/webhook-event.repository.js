const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function insertWebhookEvent(
  {
    requestId,
    provider,
    object,
    eventType,
    waMessageId,
    waFrom,
    waTo,
    raw,
    headers,
    signatureValid
  },
  client = null
) {
  const result = await dbQuery(
    client,
    `INSERT INTO webhook_events (
      "requestId",
      provider,
      object,
      "eventType",
      "waMessageId",
      "waFrom",
      "waTo",
      raw,
      headers,
      "signatureValid"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
    RETURNING id, "receivedAt", "eventType", "waMessageId"`,
    [
      requestId || null,
      provider || 'meta_whatsapp',
      object || null,
      eventType || null,
      waMessageId || null,
      waFrom || null,
      waTo || null,
      JSON.stringify(raw || {}),
      headers ? JSON.stringify(headers) : null,
      signatureValid === null || signatureValid === undefined ? null : !!signatureValid
    ]
  );

  return result.rows[0] || null;
}

async function listWebhookEvents({ limit = 50, eventType = null, waMessageId = null } = {}, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 50;
  const safeLimit = Math.max(1, Math.min(200, parsedLimit));

  const where = [];
  const params = [];

  if (eventType) {
    params.push(String(eventType));
    where.push(`"eventType" = $${params.length}`);
  }

  if (waMessageId) {
    params.push(String(waMessageId));
    where.push(`"waMessageId" = $${params.length}`);
  }

  params.push(safeLimit);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const result = await dbQuery(
    client,
    `SELECT
      id,
      "receivedAt",
      "requestId",
      provider,
      object,
      "eventType",
      "waMessageId",
      "waFrom",
      "waTo",
      headers,
      "signatureValid",
      raw
     FROM webhook_events
     ${whereSql}
     ORDER BY "receivedAt" DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows;
}

module.exports = {
  insertWebhookEvent,
  listWebhookEvents
};

