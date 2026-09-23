const { query, withTransaction } = require('../db/client');
const { findOrderById } = require('./orders.repository');

function dbQuery(client, sql, params) {
  return client && typeof client.query === 'function' ? client.query(sql, params) : query(sql, params);
}

async function findActive(tenantId, conversationId, contactId, client = null) {
  const result = await dbQuery(client,
    `SELECT * FROM order_amendments WHERE "tenantId"=$1::uuid AND "conversationId"=$2::uuid
       AND "contactId"=$3::uuid AND status IN ('in_progress','candidate','blocked')
     ORDER BY "createdAt" DESC LIMIT 2`, [tenantId, conversationId, contactId]);
  return result.rows;
}

async function findRecentConfirmedTargets(tenantId, conversationId, contactId, since, client = null) {
  const result = await dbQuery(client,
    `SELECT id, "finalizedAt", "finalizationVersion", "updatedAt" FROM orders
     WHERE "clinicId"=$1::uuid AND "conversationId"=$2::uuid AND "contactId"=$3::uuid
       AND source='human_takeover' AND status='confirmed' AND "finalizedAt" >= $4::timestamptz
     ORDER BY "finalizedAt" DESC, id DESC LIMIT 2`,
    [tenantId, conversationId, contactId, since]);
  return result.rows;
}

async function lockOrder(tenantId, orderId, client) {
  return findOrderById(orderId, tenantId, client, { forUpdate: true });
}

async function hasFinancialCoupling(tenantId, orderId, client) {
  const result = await dbQuery(client,
    `SELECT 1 FROM invoices WHERE "clinicId"=$1::uuid AND "orderId"=$2::uuid
     UNION ALL
     SELECT 1 FROM payments WHERE "clinicId"=$1::uuid
       AND metadata->>'orderId'=$2::text AND status <> 'void'
     LIMIT 1`,
    [tenantId, orderId]);
  return Boolean(result.rows[0]);
}

async function createAmendment(input, client) {
  const result = await dbQuery(client,
    `INSERT INTO order_amendments
      ("tenantId","channelId","conversationId","contactId","orderId","baseVersion","targetVersion",
       baseline,proposed,delta,"sourceMessageIds","lastSourceMessageId","baseOrderUpdatedAt")
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,
             ARRAY[$11::uuid],$11::uuid,$12::timestamptz) RETURNING *`,
    [input.tenantId, input.channelId, input.conversationId, input.contactId, input.orderId,
      input.baseVersion, input.baseVersion + 1, JSON.stringify(input.baseline), JSON.stringify(input.proposed),
      JSON.stringify(input.delta), input.sourceMessageId, input.baseOrderUpdatedAt]);
  return result.rows[0];
}

async function lockAmendment(tenantId, amendmentId, client) {
  const result = await dbQuery(client,
    `SELECT * FROM order_amendments WHERE id=$1::uuid AND "tenantId"=$2::uuid LIMIT 1 FOR UPDATE`,
    [amendmentId, tenantId]);
  return result.rows[0] || null;
}

async function updateProposal(tenantId, amendmentId, input, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendments SET proposed=$3::jsonb,delta=$4::jsonb,
       "sourceMessageIds"=array_append("sourceMessageIds",$5::uuid),"lastSourceMessageId"=$5::uuid,
       revision=revision+1,status='in_progress',"candidateSourceMessageId"=NULL,
       "candidateRevision"=NULL,"candidateConversationRevision"=NULL,
       "candidateFingerprint"=NULL,"executeAfter"=NULL,reason=NULL,"updatedAt"=NOW()
     WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status IN ('in_progress','candidate','blocked')
     RETURNING *`, [amendmentId, tenantId, JSON.stringify(input.proposed), JSON.stringify(input.delta), input.sourceMessageId]);
  return result.rows[0] || null;
}

async function listReservations(tenantId, amendmentId, client) {
  const result = await dbQuery(client,
    `SELECT id,"productId",quantity,status FROM order_amendment_reservations
     WHERE "tenantId"=$1::uuid AND "amendmentId"=$2::uuid AND status='active'
     ORDER BY "productId",id FOR UPDATE`, [tenantId, amendmentId]);
  return result.rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
}

async function setReservation(tenantId, amendmentId, productId, quantity, client) {
  const existing = await dbQuery(client,
    `SELECT id,quantity FROM order_amendment_reservations WHERE "tenantId"=$1::uuid
     AND "amendmentId"=$2::uuid AND "productId"=$3::uuid AND status='active' LIMIT 1 FOR UPDATE`,
    [tenantId, amendmentId, productId]);
  const current = existing.rows[0];
  if (quantity <= 0) {
    if (!current) return null;
    await dbQuery(client,
      `UPDATE order_amendment_reservations SET status='released',"updatedAt"=NOW()
       WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='active'`, [current.id, tenantId]);
    return null;
  }
  if (current) {
    const result = await dbQuery(client,
      `UPDATE order_amendment_reservations SET quantity=$3,"updatedAt"=NOW()
       WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='active' RETURNING *`,
      [current.id, tenantId, quantity]);
    return result.rows[0];
  }
  const result = await dbQuery(client,
    `INSERT INTO order_amendment_reservations ("tenantId","amendmentId","productId",quantity)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4) RETURNING *`,
    [tenantId, amendmentId, productId, quantity]);
  return result.rows[0];
}

async function releaseReservations(tenantId, amendmentId, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendment_reservations SET status='released',"updatedAt"=NOW()
     WHERE "tenantId"=$1::uuid AND "amendmentId"=$2::uuid AND status='active' RETURNING id`,
    [tenantId, amendmentId]);
  return result.rows.length;
}

async function cancelActiveForOrder(tenantId, orderId, reason, client) {
  const result = await dbQuery(client,
    `SELECT id FROM order_amendments WHERE "tenantId"=$1::uuid AND "orderId"=$2::uuid
       AND status IN ('in_progress','candidate','blocked') FOR UPDATE`, [tenantId, orderId]);
  for (const row of result.rows) {
    await releaseReservations(tenantId, row.id, client);
    await setStatus(tenantId, row.id, 'cancelled', reason, client);
  }
  return result.rows.length;
}

async function lockActiveForOrder(tenantId, orderId, client) {
  const result = await dbQuery(client,
    `SELECT id FROM order_amendments WHERE "tenantId"=$1::uuid AND "orderId"=$2::uuid
       AND status IN ('in_progress','candidate','blocked') FOR UPDATE`, [tenantId, orderId]);
  return result.rows;
}

async function commitReservation(tenantId, reservationId, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendment_reservations SET status='committed',"updatedAt"=NOW()
     WHERE "tenantId"=$1::uuid AND id=$2::uuid AND status='active' RETURNING id`,
    [tenantId, reservationId]);
  return result.rows[0] || null;
}

async function setStatus(tenantId, amendmentId, status, reason, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendments SET status=$3,reason=$4,"updatedAt"=NOW()
     WHERE id=$1::uuid AND "tenantId"=$2::uuid RETURNING *`,
    [amendmentId, tenantId, status, reason || null]);
  return result.rows[0] || null;
}

async function setCandidate(input, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendments SET status='candidate',"candidateSourceMessageId"=$3::uuid,
       "candidateRevision"=revision,"candidateConversationRevision"=$3::uuid,
       "candidateFingerprint"=$4,"executeAfter"=$5::timestamptz,"updatedAt"=NOW()
     WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='in_progress'
     RETURNING *`, [input.amendmentId, input.tenantId, input.messageId, input.fingerprint, input.executeAfter]);
  return result.rows[0] || null;
}

async function enqueueCandidate(amendment, client) {
  const result = await dbQuery(client,
    `INSERT INTO jobs ("clinicId","channelId",type,payload,status,attempts,"maxAttempts","runAt","updatedAt")
     VALUES ($1::uuid,$2::uuid,'order_amendment_confirm',$3::jsonb,'queued',0,10,$4::timestamptz,NOW()) RETURNING id`,
    [amendment.tenantId, amendment.channelId,
      JSON.stringify({ amendmentId: amendment.id, orderId: amendment.orderId,
        conversationId: amendment.conversationId, revision: amendment.revision }), amendment.executeAfter]);
  return result.rows[0];
}

async function listCandidateScopes(limit = 25, client = null) {
  const result = await dbQuery(client,
    `SELECT a.id AS "amendmentId",a."tenantId",a."channelId",a."conversationId",a."contactId",
            a."orderId",latest.id AS "messageId"
     FROM order_amendments a
     JOIN conversations c ON c.id=a."conversationId" AND c."clinicId"=a."tenantId"
     JOIN LATERAL (
       SELECT m.id,m."createdAt" FROM conversation_messages m
       WHERE m."conversationId"=a."conversationId"
         AND (m.direction='inbound' OR (m.direction='outbound' AND m.raw->>'actor'='HUMAN'))
       ORDER BY m."createdAt" DESC,m.id DESC LIMIT 1
     ) latest ON true
     WHERE a.status='in_progress' AND latest.id <> a."lastSourceMessageId"
       AND latest."createdAt" > a."createdAt" AND c.context->>'portalBotEnabled'='false'
     ORDER BY latest."createdAt" DESC LIMIT $1`, [Math.max(1, Math.min(100, Number(limit) || 25))]);
  return result.rows;
}

async function listInvalidatedActiveScopes(limit = 25, client = null, expireBefore = null) {
  const result = await dbQuery(client,
    `SELECT a.id AS "amendmentId",a."tenantId",a."orderId",a."conversationId",a."contactId"
     FROM order_amendments a
     JOIN orders o ON o.id=a."orderId" AND o."clinicId"=a."tenantId"
     JOIN conversations c ON c.id=a."conversationId" AND c."clinicId"=a."tenantId"
     WHERE a.status IN ('in_progress','candidate','blocked')
       AND (o.status IS DISTINCT FROM 'confirmed' OR o.source IS DISTINCT FROM 'human_takeover'
         OR o."paymentStatus" IS NULL OR o."paymentStatus" NOT IN ('pending','unpaid')
         OR o."orderStatus" IS DISTINCT FROM 'pending_payment'
         OR o."contactId" IS DISTINCT FROM a."contactId"
         OR o."conversationId" IS DISTINCT FROM a."conversationId"
         OR c."channelId" IS DISTINCT FROM a."channelId"
         OR o."finalizationVersion" <> a."baseVersion"
         OR o."updatedAt" <> a."baseOrderUpdatedAt"
         OR c.context->>'portalBotEnabled' IS DISTINCT FROM 'false'
         OR ($2::timestamptz IS NOT NULL AND a."updatedAt" < $2::timestamptz))
     ORDER BY a."updatedAt" ASC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 25)), expireBefore]);
  return result.rows;
}

async function invalidateForMessage(tenantId, conversationId, messageId, client = null) {
  const result = await dbQuery(client,
    `UPDATE order_amendments a SET status='in_progress',revision=revision+1,
       "candidateSourceMessageId"=NULL,"candidateRevision"=NULL,
       "candidateConversationRevision"=NULL,"candidateFingerprint"=NULL,"executeAfter"=NULL,
       "updatedAt"=NOW()
     FROM conversation_messages m WHERE a."tenantId"=$1::uuid AND a."conversationId"=$2::uuid
       AND a.status='candidate' AND m.id=$3::uuid AND m."conversationId"=a."conversationId"
       AND m."createdAt" > a."updatedAt" RETURNING a.id`, [tenantId, conversationId, messageId]);
  return result.rows.length;
}

async function invalidateForHumanSend(tenantId, conversationId) {
  const result = await query(
    `UPDATE order_amendments SET status='in_progress',revision=revision+1,
       "candidateSourceMessageId"=NULL,"candidateRevision"=NULL,
       "candidateConversationRevision"=NULL,"candidateFingerprint"=NULL,"executeAfter"=NULL,
       "updatedAt"=NOW()
     WHERE "tenantId"=$1::uuid AND "conversationId"=$2::uuid AND status='candidate' RETURNING id`,
    [tenantId, conversationId]);
  return result.rows.length;
}

async function adjustLegacyStock(tenantId, productId, delta, client) {
  const result = await dbQuery(client,
    `UPDATE products SET stock=stock-$3,"updatedAt"=NOW()
     WHERE id=$1::uuid AND "clinicId"=$2::uuid AND stock-$3 >= 0 RETURNING id,stock`,
    [productId, tenantId, delta]);
  return result.rows[0] || null;
}

async function updateCommittedBaselineReservation(tenantId, orderItemId, quantity, client) {
  const result = await dbQuery(client,
    `UPDATE order_stock_reservations SET quantity=$3,status=CASE WHEN $3 > 0 THEN 'committed' ELSE 'cancelled' END,
       "updatedAt"=NOW() WHERE "tenantId"=$1::uuid AND "orderItemId"=$2::uuid AND status='committed'
     RETURNING id`, [tenantId, orderItemId, quantity]);
  return result.rows[0] || null;
}

async function getCommittedBaselineReservation(tenantId, orderItemId, client) {
  const result = await dbQuery(client,
    `SELECT id,"productId",quantity FROM order_stock_reservations
     WHERE "tenantId"=$1::uuid AND "orderItemId"=$2::uuid AND status='committed'
     LIMIT 1 FOR UPDATE`, [tenantId, orderItemId]);
  return result.rows[0] || null;
}

async function insertCommittedReservation(input, client) {
  const result = await dbQuery(client,
    `INSERT INTO order_stock_reservations
      ("tenantId","orderId","orderItemId","productId",quantity,status,metadata)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'committed',$6::jsonb) RETURNING id`,
    [input.tenantId, input.orderId, input.orderItemId, input.productId,
      input.quantity, JSON.stringify({ source: 'order_amendment', amendmentId: input.amendmentId })]);
  return result.rows[0];
}

async function adjustLotAllocation(tenantId, allocationId, quantity, client) {
  const result = await dbQuery(client,
    `UPDATE inventory_lot_allocations
     SET quantity=CASE WHEN $3 > 0 THEN $3 ELSE quantity END,
         status=CASE WHEN $3 > 0 THEN 'consumed' ELSE 'released' END,
         "releasedAt"=CASE WHEN $3 > 0 THEN "releasedAt" ELSE NOW() END
     WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='consumed' RETURNING id`,
    [allocationId, tenantId, quantity]);
  return result.rows[0] || null;
}

async function addLotAllocationQuantity(tenantId, allocationId, quantity, client) {
  const result = await dbQuery(client,
    `UPDATE inventory_lot_allocations SET quantity=quantity+$3
     WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='consumed' RETURNING id`,
    [allocationId, tenantId, quantity]);
  return result.rows[0] || null;
}

async function findConsumedLotAllocation(tenantId, orderItemId, lotId, client) {
  const result = await dbQuery(client,
    `SELECT id,quantity FROM inventory_lot_allocations WHERE "tenantId"=$1::uuid
       AND "orderItemId"=$2::uuid AND "lotId"=$3::uuid AND status='consumed'
     LIMIT 1 FOR UPDATE`, [tenantId, orderItemId, lotId]);
  return result.rows[0] || null;
}

async function markConfirmed(input, client) {
  const result = await dbQuery(client,
    `UPDATE order_amendments SET status='confirmed',"confirmedSnapshot"=$3::jsonb,
       "confirmedAt"=NOW(),"updatedAt"=NOW()
     WHERE id=$1::uuid AND "tenantId"=$2::uuid AND status='candidate' AND revision=$4 RETURNING id`,
    [input.amendmentId, input.tenantId, JSON.stringify(input.confirmedSnapshot), input.revision]);
  return result.rows[0] || null;
}

module.exports = {
  withTransaction, findActive, findRecentConfirmedTargets, lockOrder, hasFinancialCoupling,
  createAmendment, lockAmendment, updateProposal, listReservations, setReservation,
  releaseReservations, lockActiveForOrder, cancelActiveForOrder,
  commitReservation, setStatus, setCandidate, enqueueCandidate,
  listCandidateScopes, listInvalidatedActiveScopes,
  invalidateForMessage, invalidateForHumanSend, adjustLegacyStock,
  updateCommittedBaselineReservation, getCommittedBaselineReservation,
  insertCommittedReservation, adjustLotAllocation,
  addLotAllocationQuantity, findConsumedLotAllocation, markConfirmed
};
