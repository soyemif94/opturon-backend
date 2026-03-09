const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertLeadForConversation({ clinicId, channelId, conversationId, contactId, primaryIntent }, client = null) {
  const intent = primaryIntent || null;
  const result = await dbQuery(
    client,
    `INSERT INTO leads (
      "clinicId", "channelId", "conversationId", "contactId", status, source, "primaryIntent", "updatedAt"
    ) VALUES ($1, $2, $3, $4, 'new', 'whatsapp', $5, NOW())
    ON CONFLICT ("clinicId", "conversationId")
    DO UPDATE SET
      "channelId" = EXCLUDED."channelId",
      "contactId" = EXCLUDED."contactId",
      "primaryIntent" = COALESCE(leads."primaryIntent", EXCLUDED."primaryIntent"),
      "updatedAt" = NOW()
    RETURNING id, "clinicId", "channelId", "conversationId", "contactId", status, source, "primaryIntent", notes, "assignedTo"`,
    [clinicId, channelId, conversationId, contactId, intent]
  );

  return result.rows[0];
}

async function updateLeadStatus(leadId, status, notes, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE leads
     SET status = $2,
         notes = COALESCE($3, notes),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "conversationId", status, notes`,
    [leadId, status, notes || null]
  );

  return result.rows[0] || null;
}

async function assignLead(leadId, staffUserId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE leads
     SET "assignedTo" = $2,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "conversationId", "assignedTo"`,
    [leadId, staffUserId]
  );

  return result.rows[0] || null;
}

async function findLeadByConversation(clinicId, conversationId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "conversationId", "contactId", status, source, "primaryIntent", notes, "assignedTo"
     FROM leads
     WHERE "clinicId" = $1 AND "conversationId" = $2
     LIMIT 1`,
    [clinicId, conversationId]
  );

  return result.rows[0] || null;
}

async function listLeads({ clinicId, status, limit = 50 }, client = null) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));

  if (status) {
    const result = await dbQuery(
      client,
      `SELECT id, "clinicId", "conversationId", "contactId", status, source, "primaryIntent", notes, "assignedTo", "updatedAt", "createdAt"
       FROM leads
       WHERE "clinicId" = $1 AND status = $2
       ORDER BY "updatedAt" DESC
       LIMIT $3`,
      [clinicId, status, safeLimit]
    );
    return result.rows;
  }

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", "contactId", status, source, "primaryIntent", notes, "assignedTo", "updatedAt", "createdAt"
     FROM leads
     WHERE "clinicId" = $1
     ORDER BY "updatedAt" DESC
     LIMIT $2`,
    [clinicId, safeLimit]
  );

  return result.rows;
}

module.exports = {
  upsertLeadForConversation,
  updateLeadStatus,
  assignLead,
  findLeadByConversation,
  listLeads
};

