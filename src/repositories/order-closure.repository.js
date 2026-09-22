const { query, withTransaction } = require('../db/client');
const { findOrderById } = require('./orders.repository');

function dbQuery(client, sql, params) {
  return client && typeof client.query === 'function' ? client.query(sql, params) : query(sql, params);
}

async function listReviewScopes(limit = 25) {
  const result = await query(
    `SELECT o.id AS "orderId", o."clinicId" AS "tenantId", o."conversationId",
            c."channelId", latest.id AS "sourceMessageId"
     FROM orders o
     JOIN conversations c ON c.id = o."conversationId" AND c."clinicId" = o."clinicId"
     JOIN schema_migrations activation ON activation.name = '083_order_closure_candidates.sql'
     JOIN LATERAL (
       SELECT m.id, m."createdAt"
       FROM conversation_messages m
       WHERE m."conversationId" = c.id
         AND (m.direction = 'inbound' OR
              (m.direction = 'outbound' AND m.raw->>'actor' = 'HUMAN'))
       ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1
     ) latest ON true
     WHERE o.status = 'draft' AND o.source = 'human_takeover'
       AND latest."createdAt" > activation.applied_at
       AND c.context->>'portalBotEnabled' = 'false'
       AND NOT EXISTS (
         SELECT 1 FROM order_closure_candidates existing
         WHERE existing."tenantId" = o."clinicId" AND existing."orderId" = o.id
           AND existing."sourceMessageId" = latest.id
       )
     ORDER BY latest."createdAt" DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 25))]
  );
  return result.rows;
}

async function lockConversation(tenantId, conversationId, client) {
  await dbQuery(client, 'SELECT pg_advisory_xact_lock(hashtext($1))', [String(conversationId)]);
  const result = await dbQuery(client,
    `SELECT id, "clinicId", "channelId", "contactId", context
     FROM conversations WHERE id = $1::uuid AND "clinicId" = $2::uuid LIMIT 1 FOR UPDATE`,
    [conversationId, tenantId]);
  return result.rows[0] || null;
}

async function getOrder(tenantId, orderId, client) {
  return findOrderById(orderId, tenantId, client, { forUpdate: true });
}

async function getLatestRelevantMessage(conversationId, client) {
  const result = await dbQuery(client,
    `SELECT id, direction, text, raw, "createdAt"
     FROM conversation_messages
     WHERE "conversationId" = $1::uuid
       AND (direction = 'inbound' OR (direction = 'outbound' AND raw->>'actor' = 'HUMAN'))
     ORDER BY "createdAt" DESC, id DESC LIMIT 1`, [conversationId]);
  return result.rows[0] || null;
}

async function listRelevantMessages(conversationId, client) {
  const result = await dbQuery(client,
    `SELECT * FROM (
       SELECT id, direction, text, raw, "createdAt"
       FROM conversation_messages
       WHERE "conversationId" = $1::uuid
         AND (direction = 'inbound' OR (direction = 'outbound' AND raw->>'actor' = 'HUMAN'))
       ORDER BY "createdAt" DESC, id DESC LIMIT 30
     ) recent ORDER BY "createdAt" ASC, id ASC`, [conversationId]);
  return result.rows;
}

async function listReservations(tenantId, orderId, client) {
  const result = await dbQuery(client,
    `SELECT id, "orderItemId", "productId", quantity, status
     FROM order_stock_reservations
     WHERE "tenantId" = $1::uuid AND "orderId" = $2::uuid AND status = 'active'
     ORDER BY "productId", id FOR UPDATE`, [tenantId, orderId]);
  return result.rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

async function getLastOperation(tenantId, conversationId, client) {
  const result = await dbQuery(client,
    `SELECT id, operation, result, metadata, "sourceMessageId", "createdAt"
     FROM order_automation_operations
     WHERE "tenantId" = $1::uuid AND "conversationId" = $2::uuid
     ORDER BY "createdAt" DESC, id DESC LIMIT 1`, [tenantId, conversationId]);
  return result.rows[0] || null;
}

async function hasBlockingOperationSince(tenantId, conversationId, since, client) {
  const result = await dbQuery(client,
    `SELECT 1 FROM order_automation_operations
     WHERE "tenantId" = $1::uuid AND "conversationId" = $2::uuid
       AND "createdAt" > $3::timestamptz AND result <> 'applied'
     LIMIT 1`, [tenantId, conversationId, since]);
  return Boolean(result.rows[0]);
}

async function createCandidate(input, client) {
  const result = await dbQuery(client,
    `INSERT INTO order_closure_candidates
      ("tenantId", "channelId", "conversationId", "orderId", "sourceMessageId",
       "orderRevision", "conversationRevision", "orderFingerprint", "executeAfter")
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::timestamptz,$7::uuid,$8,$9::timestamptz)
     ON CONFLICT ("tenantId", "orderId", "sourceMessageId") DO NOTHING
     RETURNING *`, [input.tenantId, input.channelId, input.conversationId, input.orderId,
      input.sourceMessageId, input.orderRevision, input.conversationRevision,
      input.orderFingerprint, input.executeAfter]);
  return result.rows[0] || null;
}

async function enqueueCandidate(candidate, client) {
  const result = await dbQuery(client,
    `INSERT INTO jobs ("clinicId", "channelId", type, payload, status, attempts, "maxAttempts", "runAt", "updatedAt")
     VALUES ($1::uuid,$2::uuid,'order_closure_confirm',$3::jsonb,'queued',0,10,$4::timestamptz,NOW())
     RETURNING id`, [candidate.tenantId, candidate.channelId,
      JSON.stringify({ candidateId: candidate.id, tenantId: candidate.tenantId,
        conversationId: candidate.conversationId, orderId: candidate.orderId }), candidate.executeAfter]);
  return result.rows[0];
}

async function lockCandidate(tenantId, candidateId, client) {
  const result = await dbQuery(client,
    `SELECT * FROM order_closure_candidates
     WHERE id = $1::uuid AND "tenantId" = $2::uuid LIMIT 1 FOR UPDATE`, [candidateId, tenantId]);
  return result.rows[0] || null;
}

async function getCandidate(tenantId, candidateId) {
  const result = await query(
    `SELECT * FROM order_closure_candidates WHERE id = $1::uuid AND "tenantId" = $2::uuid LIMIT 1`,
    [candidateId, tenantId]);
  return result.rows[0] || null;
}

async function setCandidateStatus(tenantId, candidateId, status, reason, client) {
  const result = await dbQuery(client,
    `UPDATE order_closure_candidates SET status = $3, reason = $4,
       "consumedAt" = CASE WHEN $3 = 'confirmed' THEN NOW() ELSE "consumedAt" END,
       "updatedAt" = NOW()
     WHERE id = $1::uuid AND "tenantId" = $2::uuid AND status = 'pending'
     RETURNING id`, [candidateId, tenantId, status, reason || null]);
  return result.rows[0] || null;
}

async function invalidatePendingForMessage(tenantId, conversationId, messageId, client = null) {
  const result = await dbQuery(client,
    `UPDATE order_closure_candidates candidate
     SET status = 'stale', reason = 'new_relevant_message', "updatedAt" = NOW()
     FROM conversation_messages message
     WHERE candidate."tenantId" = $1::uuid AND candidate."conversationId" = $2::uuid
       AND candidate.status = 'pending' AND message.id = $3::uuid
       AND message."conversationId" = candidate."conversationId"
       AND message."createdAt" > candidate."createdAt"
     RETURNING candidate.id`, [tenantId, conversationId, messageId]);
  return result.rows.length;
}

async function invalidatePendingForHumanSend(tenantId, conversationId) {
  const result = await query(
    `UPDATE order_closure_candidates SET status = 'stale', reason = 'human_send_started', "updatedAt" = NOW()
     WHERE "tenantId" = $1::uuid AND "conversationId" = $2::uuid AND status = 'pending'
     RETURNING id`, [tenantId, conversationId]);
  return result.rows.length;
}

async function commitLegacyStock(tenantId, productId, quantity, client) {
  const result = await dbQuery(client,
    `UPDATE products SET stock = stock - $3, "updatedAt" = NOW()
     WHERE id = $1::uuid AND "clinicId" = $2::uuid AND stock >= $3
     RETURNING id, stock`, [productId, tenantId, quantity]);
  return result.rows[0] || null;
}

async function commitReservation(tenantId, reservationId, client) {
  const result = await dbQuery(client,
    `UPDATE order_stock_reservations
     SET status = 'committed', "updatedAt" = NOW()
     WHERE id = $1::uuid AND "tenantId" = $2::uuid AND status = 'active'
     RETURNING id`, [reservationId, tenantId]);
  return result.rows[0] || null;
}

async function findRecentConfirmedTakeoverOrder(tenantId, conversationId, client = null) {
  const result = await dbQuery(client,
     `SELECT id FROM orders WHERE "clinicId" = $1::uuid AND "conversationId" = $2::uuid
       AND source = 'human_takeover' AND status = 'confirmed'
       AND "finalizedAt" >= NOW() - INTERVAL '24 hours'
     ORDER BY "finalizedAt" DESC NULLS LAST, "createdAt" DESC LIMIT 1`, [tenantId, conversationId]);
  return result.rows[0] || null;
}

module.exports = {
  withTransaction, listReviewScopes, lockConversation, getOrder, getLatestRelevantMessage,
  listRelevantMessages, listReservations, getLastOperation, hasBlockingOperationSince,
  createCandidate, enqueueCandidate, lockCandidate, getCandidate, setCandidateStatus,
  invalidatePendingForMessage, invalidatePendingForHumanSend, commitLegacyStock, commitReservation,
  findRecentConfirmedTakeoverOrder
};
