const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function addEvent({ clinicId, conversationId, type, data }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO conversation_events (
      "clinicId", "conversationId", type, data
    ) VALUES ($1, $2, $3, $4::jsonb)
    RETURNING id, "clinicId", "conversationId", type, data, "createdAt"`,
    [clinicId, conversationId, type, JSON.stringify(data || {})]
  );

  return result.rows[0];
}

async function listEvents(clinicId, conversationId, limit = 50, client = null) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", type, data, "createdAt"
     FROM conversation_events
     WHERE "clinicId" = $1 AND "conversationId" = $2
     ORDER BY "createdAt" DESC
     LIMIT $3`,
    [clinicId, conversationId, safeLimit]
  );

  return result.rows;
}

async function findLatestEventByType(clinicId, conversationId, type, withinMinutes = 20, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", type, data, "createdAt"
     FROM conversation_events
     WHERE "clinicId" = $1
       AND "conversationId" = $2
       AND type = $3
       AND "createdAt" >= NOW() - make_interval(mins => $4)
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [clinicId, conversationId, type, Math.max(1, Number(withinMinutes) || 20)]
  );

  return result.rows[0] || null;
}

async function countRecentEventsByType(clinicId, conversationId, type, withinMinutes = 60, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::int AS total
     FROM conversation_events
     WHERE "clinicId" = $1
       AND "conversationId" = $2
       AND type = $3
       AND "createdAt" >= NOW() - make_interval(mins => $4)`,
    [clinicId, conversationId, type, Math.max(1, Number(withinMinutes) || 60)]
  );

  return (result.rows[0] && result.rows[0].total) || 0;
}

module.exports = {
  addEvent,
  listEvents,
  findLatestEventByType,
  countRecentEventsByType
};

