const { query, withTransaction } = require('../db/client');
const { createOrder } = require('./orders.repository');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

async function lockConversation(conversationId, client) {
  await dbQuery(client, 'SELECT pg_advisory_xact_lock(hashtext($1))', [String(conversationId)]);
}

async function listRecentConversationMessages(conversationId, tenantId, limit = 30, client = null) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const result = await dbQuery(
    client,
    `SELECT m.id, m."conversationId", m.direction, m.text, m."createdAt"
     FROM conversation_messages m
     INNER JOIN conversations c ON c.id = m."conversationId"
     WHERE m."conversationId" = $1::uuid AND c."clinicId" = $2::uuid
     ORDER BY m."createdAt" DESC, m.id DESC
     LIMIT $3`,
    [conversationId, tenantId, safeLimit]
  );
  return result.rows.reverse();
}

async function beginOperation(input, client) {
  const result = await dbQuery(
    client,
    `INSERT INTO order_automation_operations (
       "tenantId", "conversationId", "sourceMessageId", operation, result, metadata
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'processing', $5::jsonb)
     ON CONFLICT ("tenantId", "sourceMessageId") DO NOTHING
     RETURNING id`,
    [input.tenantId, input.conversationId, input.sourceMessageId, input.operation, JSON.stringify(input.metadata || {})]
  );
  return result.rows[0] || null;
}

async function completeOperation(operationId, tenantId, patch, client) {
  const result = await dbQuery(
    client,
    `UPDATE order_automation_operations
     SET "orderId" = $3::uuid,
         "productId" = $4::uuid,
         result = $5,
         operation = $6,
         "previousQuantity" = $7,
         "newQuantity" = $8,
         "reservationDelta" = $9,
         metadata = COALESCE(metadata, '{}'::jsonb) || $10::jsonb,
         "updatedAt" = NOW()
     WHERE id = $1::uuid AND "tenantId" = $2::uuid
     RETURNING id`,
    [
      operationId,
      tenantId,
      patch.orderId || null,
      patch.productId || null,
      patch.result,
      patch.operation,
      patch.previousQuantity ?? null,
      patch.newQuantity ?? null,
      patch.reservationDelta ?? null,
      JSON.stringify(patch.metadata || {})
    ]
  );
  return result.rows[0] || null;
}

async function findDraftByConversation(tenantId, conversationId, client) {
  const result = await dbQuery(
    client,
    `SELECT o.id, o."clinicId", o."contactId", o.status, o.source, o."conversationId",
            o.currency, o.notes, o."customerName", o."customerPhone"
     FROM orders o
     WHERE o."clinicId" = $1::uuid
       AND o."conversationId" = $2::uuid
       AND o.status = 'draft'
       AND o.source = 'human_takeover'
     ORDER BY o."createdAt" DESC
     LIMIT 1
     FOR UPDATE OF o`,
    [tenantId, conversationId]
  );
  return result.rows[0] || null;
}

async function getDraftSnapshot(tenantId, conversationId, client = null) {
  const draft = await findDraftByConversation(tenantId, conversationId, client);
  if (!draft) return null;
  return { ...draft, items: await listOrderItems(draft.id, client) };
}

async function listOrderItems(orderId, client) {
  const result = await dbQuery(
    client,
    `SELECT id, "orderId", "productId", COALESCE("descriptionSnapshot", "nameSnapshot") AS name,
            quantity, variant, COALESCE("unitPrice", "priceSnapshot", 0) AS "unitPrice",
            COALESCE("taxRate", 0) AS "taxRate", COALESCE("currencySnapshot", 'ARS') AS currency
     FROM order_items
     WHERE "orderId" = $1::uuid
     ORDER BY "createdAt" ASC
     FOR UPDATE`,
    [orderId]
  );
  return result.rows.map((row) => ({ ...row, quantity: Number(row.quantity || 0), unitPrice: Number(row.unitPrice || 0), taxRate: Number(row.taxRate || 0) }));
}

async function createDraft(input, client) {
  return createOrder(
    {
      clinicId: input.tenantId,
      contactId: input.contactId,
      customerName: input.customerName || null,
      customerPhone: input.customerPhone || null,
      customerType: 'registered_contact',
      source: 'human_takeover',
      status: 'draft',
      orderStatus: 'new',
      paymentStatus: 'pending',
      conversationId: input.conversationId,
      currency: input.item.currencySnapshot || input.item.currency || 'ARS',
      subtotalAmount: input.item.subtotalAmount,
      taxAmount: input.item.taxAmount,
      totalAmount: input.item.totalAmount,
      items: [input.item]
    },
    client
  );
}

async function upsertOrderItem(orderId, item, client) {
  const existing = await dbQuery(
    client,
    `SELECT id FROM order_items WHERE "orderId" = $1::uuid AND "productId" = $2::uuid LIMIT 1 FOR UPDATE`,
    [orderId, item.productId]
  );
  const params = [
    orderId, item.productId, item.descriptionSnapshot, item.skuSnapshot || null,
    item.unitPrice, item.currencySnapshot || 'ARS', item.quantity, item.taxRate,
    item.subtotalAmount, item.totalAmount, item.variant || null
  ];
  if (existing.rows[0]) {
    const result = await dbQuery(
      client,
      `UPDATE order_items
       SET "descriptionSnapshot" = $3, "nameSnapshot" = $3, "skuSnapshot" = $4,
           "unitPrice" = $5, "priceSnapshot" = $5, "currencySnapshot" = $6,
           quantity = $7, "taxRate" = $8, "subtotalAmount" = $9,
           "totalAmount" = $10, variant = $11
       WHERE id = $12::uuid
       RETURNING id, "orderId", "productId", quantity, variant`,
      [...params, existing.rows[0].id]
    );
    return { ...result.rows[0], created: false };
  }
  const result = await dbQuery(
    client,
    `INSERT INTO order_items (
       "orderId", "productId", "descriptionSnapshot", "nameSnapshot", "skuSnapshot",
       "unitPrice", "priceSnapshot", "currencySnapshot", quantity, "taxRate",
       "subtotalAmount", "totalAmount", variant
     ) VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, "orderId", "productId", quantity, variant`,
    params
  );
  return { ...result.rows[0], created: true };
}

async function removeOrderItem(orderItemId, client) {
  const result = await dbQuery(client, 'DELETE FROM order_items WHERE id = $1::uuid RETURNING id', [orderItemId]);
  return result.rows[0] || null;
}

async function recalculateOrder(orderId, client) {
  const result = await dbQuery(
    client,
    `UPDATE orders o
     SET subtotal = totals.subtotal,
         total = totals.total,
         "subtotalAmount" = totals.subtotal,
         "taxAmount" = totals.tax,
         "totalAmount" = totals.total,
         "updatedAt" = NOW()
     FROM (
       SELECT COALESCE(SUM("subtotalAmount"), 0) AS subtotal,
              COALESCE(SUM("totalAmount" - "subtotalAmount"), 0) AS tax,
              COALESCE(SUM("totalAmount"), 0) AS total
       FROM order_items WHERE "orderId" = $1::uuid
     ) totals
     WHERE o.id = $1::uuid
     RETURNING o.id, o.status, o."subtotalAmount", o."taxAmount", o."totalAmount"`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function lockProduct(productId, tenantId, client) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, stock, status, sku, currency,
            COALESCE("unitPrice", price, 0) AS "unitPrice", COALESCE("vatRate", 0) AS "taxRate",
            metadata
     FROM products
     WHERE id = $1::uuid AND "clinicId" = $2::uuid AND "deletedAt" IS NULL
     LIMIT 1 FOR UPDATE`,
    [productId, tenantId]
  );
  return result.rows[0] || null;
}

async function getActiveReservedQuantity(productId, tenantId, client, excludeOrderItemId = null) {
  const result = await dbQuery(
    client,
    `SELECT COALESCE(SUM(quantity), 0) AS quantity
     FROM order_stock_reservations
     WHERE "tenantId" = $1::uuid AND "productId" = $2::uuid AND status = 'active'
       AND ($3::uuid IS NULL OR "orderItemId" <> $3::uuid)`,
    [tenantId, productId, excludeOrderItemId]
  );
  return Number(result.rows[0]?.quantity || 0);
}

async function getActiveReservation(orderItemId, tenantId, client) {
  const result = await dbQuery(
    client,
    `SELECT id, quantity FROM order_stock_reservations
     WHERE "tenantId" = $1::uuid AND "orderItemId" = $2::uuid AND status = 'active'
     LIMIT 1 FOR UPDATE`,
    [tenantId, orderItemId]
  );
  return result.rows[0] ? { ...result.rows[0], quantity: Number(result.rows[0].quantity || 0) } : null;
}

async function setReservation(input, client) {
  const existing = await getActiveReservation(input.orderItemId, input.tenantId, client);
  if (Number(input.quantity) <= 0) {
    if (!existing) return null;
    await dbQuery(
      client,
      `UPDATE order_stock_reservations
       SET quantity = 0, status = 'released', "releasedAt" = NOW(), "updatedAt" = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $1::uuid AND "tenantId" = $2::uuid`,
      [existing.id, input.tenantId, JSON.stringify(input.metadata || {})]
    );
    return { id: existing.id, quantity: 0, status: 'released' };
  }
  if (existing) {
    const result = await dbQuery(
      client,
      `UPDATE order_stock_reservations
       SET quantity = $3, metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, "updatedAt" = NOW()
       WHERE id = $1::uuid AND "tenantId" = $2::uuid
       RETURNING id, quantity, status`,
      [existing.id, input.tenantId, input.quantity, JSON.stringify(input.metadata || {})]
    );
    return result.rows[0];
  }
  const result = await dbQuery(
    client,
    `INSERT INTO order_stock_reservations (
       "tenantId", "orderId", "orderItemId", "productId", quantity, status, metadata
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'active', $6::jsonb)
     RETURNING id, quantity, status`,
    [input.tenantId, input.orderId, input.orderItemId, input.productId, input.quantity, JSON.stringify(input.metadata || {})]
  );
  return result.rows[0];
}

async function releaseOrderReservations(tenantId, orderId, client) {
  const result = await dbQuery(
    client,
    `UPDATE order_stock_reservations
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'releasedQuantity', quantity,
           'releaseReason', 'order_cancelled'
         ),
         quantity = 0,
         status = 'cancelled',
         "releasedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE "tenantId" = $1::uuid AND "orderId" = $2::uuid AND status = 'active'
     RETURNING "orderItemId", "productId"`,
    [tenantId, orderId]
  );
  return result.rows;
}

module.exports = {
  withTransaction,
  lockConversation,
  listRecentConversationMessages,
  beginOperation,
  completeOperation,
  findDraftByConversation,
  getDraftSnapshot,
  listOrderItems,
  createDraft,
  upsertOrderItem,
  removeOrderItem,
  recalculateOrder,
  lockProduct,
  getActiveReservedQuantity,
  getActiveReservation,
  setReservation,
  releaseOrderReservations
};
