const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertConversation({ clinicId, channelId, contactId }, client = null) {
  if (client) {
    await dbQuery(client, `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      `inbox_conversation:${clinicId}`,
      `${channelId}:${contactId}`
    ]);
  }
  const previousResult = await dbQuery(
    client,
    `SELECT "assignedSellerUserId", "leadStatus", "nextActionAt", "nextActionNote",
            jsonb_strip_nulls(jsonb_build_object(
              'portalAssignedTo', context->'portalAssignedTo',
              'portalAssignedToUserId', context->'portalAssignedToUserId',
              'portalPriority', context->'portalPriority',
              'portalDealStage', context->'portalDealStage',
              'portalNotes', context->'portalNotes',
              'portalTasks', context->'portalTasks'
            )) AS context
     FROM conversations
     WHERE "clinicId"=$1 AND "channelId"=$2 AND "contactId"=$3 AND "deletedAt" IS NOT NULL
     ORDER BY "deletedAt" DESC LIMIT 1`,
    [clinicId, channelId, contactId]
  );
  const previous = previousResult.rows[0] || {};
  const result = await dbQuery(
    client,
    `INSERT INTO conversations (
       "clinicId", "channelId", "contactId", "assignedSellerUserId", "leadStatus",
       "nextActionAt", "nextActionNote", state, context, "lastInboundAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4::uuid, COALESCE($5,'NEW'), $6, $7, 'NEW', COALESCE($8::jsonb,'{}'::jsonb), NOW(), NOW())
     ON CONFLICT ("clinicId", "channelId", "contactId") WHERE "deletedAt" IS NULL
     DO UPDATE SET
       "lastInboundAt" = NOW(),
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "channelId", "contactId", status, stage`,
    [clinicId, channelId, contactId, previous.assignedSellerUserId || null, previous.leadStatus || 'NEW',
      previous.nextActionAt || null, previous.nextActionNote || null, JSON.stringify(previous.context || {})]
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
     WHERE id = $1 AND "deletedAt" IS NULL
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

