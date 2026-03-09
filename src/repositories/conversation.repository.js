const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertConversation({ clinicId, channelId, contactId }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO conversations ("clinicId", "channelId", "contactId", "lastInboundAt", "updatedAt")
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT ("clinicId", "channelId", "contactId")
     DO UPDATE SET
       "lastInboundAt" = NOW(),
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "channelId", "contactId", status, stage`,
    [clinicId, channelId, contactId]
  );

  return result.rows[0];
}

async function markLastOutbound(conversationId, client = null) {
  await dbQuery(
    client,
    `UPDATE conversations
     SET "lastOutboundAt" = NOW(), "updatedAt" = NOW()
     WHERE id = $1`,
    [conversationId]
  );
}

async function findConversationById(conversationId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "contactId", status, stage, "lastInboundAt", "lastOutboundAt"
     FROM conversations
     WHERE id = $1
     LIMIT 1`,
    [conversationId]
  );

  return result.rows[0] || null;
}

async function updateConversationStatus(conversationId, status, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET status = $2, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "channelId", "contactId", status, stage`,
    [conversationId, status]
  );

  return result.rows[0] || null;
}

async function updateConversationStage(conversationId, stage, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET stage = $2, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", "channelId", "contactId", status, stage`,
    [conversationId, stage]
  );

  return result.rows[0] || null;
}

module.exports = {
  upsertConversation,
  markLastOutbound,
  findConversationById,
  updateConversationStatus,
  updateConversationStage
};

