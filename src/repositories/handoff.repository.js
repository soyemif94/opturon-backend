const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function openHandoff({ clinicId, conversationId, contactId, leadId, reason }, client = null) {
  const existing = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", "contactId", "leadId", status, "assignedTo", reason
     FROM handoff_requests
     WHERE "clinicId" = $1 AND "conversationId" = $2 AND status IN ('open', 'assigned')
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [clinicId, conversationId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const result = await dbQuery(
    client,
    `INSERT INTO handoff_requests (
      "clinicId", "conversationId", "contactId", "leadId", status, reason, "updatedAt"
    ) VALUES ($1, $2, $3, $4, 'open', $5, NOW())
    RETURNING id, "clinicId", "conversationId", "contactId", "leadId", status, "assignedTo", reason`,
    [clinicId, conversationId, contactId, leadId || null, reason]
  );

  return result.rows[0];
}

async function assignHandoff(handoffId, staffUserId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE handoff_requests
     SET status = 'assigned', "assignedTo" = $2, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "conversationId", "contactId", "leadId", status, "assignedTo", reason`,
    [handoffId, staffUserId]
  );

  return result.rows[0] || null;
}

async function resolveHandoff(handoffId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE handoff_requests
     SET status = 'resolved', "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "conversationId", status`,
    [handoffId]
  );

  return result.rows[0] || null;
}

async function getOpenHandoff(clinicId, conversationId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", "contactId", "leadId", status, "assignedTo", reason
     FROM handoff_requests
     WHERE "clinicId" = $1 AND "conversationId" = $2 AND status IN ('open', 'assigned')
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [clinicId, conversationId]
  );

  return result.rows[0] || null;
}

module.exports = {
  openHandoff,
  assignHandoff,
  resolveHandoff,
  getOpenHandoff
};

