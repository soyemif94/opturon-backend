const { query } = require('../db/client');
const { logError } = require('../utils/logger');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeItem(item) {
  return {
    id: item.id,
    productId: item.productId || null,
    nameSnapshot: item.nameSnapshot,
    skuSnapshot: item.skuSnapshot || null,
    priceSnapshot: Number(item.priceSnapshot || 0),
    currencySnapshot: item.currencySnapshot || null,
    quantity: Number(item.quantity || 0),
    variant: item.variant || null,
    createdAt: item.createdAt
  };
}

function normalizeInsertItem(item, fallbackCurrency) {
  const currencySnapshot = String(item.currencySnapshot || fallbackCurrency || 'ARS').trim().toUpperCase() || 'ARS';
  const skuSnapshot = String(item.skuSnapshot || '').trim();

  return {
    productId: item.productId || null,
    nameSnapshot: String(item.nameSnapshot || '').trim(),
    skuSnapshot: skuSnapshot || null,
    priceSnapshot: Number(item.priceSnapshot || 0),
    currencySnapshot,
    quantity: Number.parseInt(String(item.quantity || 0), 10),
    variant: String(item.variant || '').trim() || null
  };
}

function normalizeOrder(row) {
  const items = Array.isArray(row.items) ? row.items.map(normalizeItem) : [];
  return {
    id: row.id,
    clinicId: row.clinicId,
    contactId: row.contactId || null,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    notes: row.notes || null,
    subtotal: Number(row.subtotal || 0),
    total: Number(row.total || 0),
    currency: row.currency,
    paymentStatus: row.paymentStatus,
    orderStatus: row.orderStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: row.contactName || null,
          phone: row.contactPhone || null
        }
      : null,
    items
  };
}

async function listOrdersByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       o.id,
       o."clinicId",
       o."contactId",
       o."customerName",
       o."customerPhone",
       o.notes,
       o.subtotal,
       o.total,
       o.currency,
       o."paymentStatus",
       o."orderStatus",
       o."createdAt",
       o."updatedAt",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       COALESCE(items.items, '[]'::json) AS items
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o."contactId"
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'id', oi.id,
           'productId', oi."productId",
           'nameSnapshot', oi."nameSnapshot",
           'skuSnapshot', oi."skuSnapshot",
           'priceSnapshot', oi."priceSnapshot",
           'currencySnapshot', oi."currencySnapshot",
           'quantity', oi.quantity,
           'variant', oi.variant,
           'createdAt', oi."createdAt"
         )
         ORDER BY oi."createdAt" ASC
       ) AS items
       FROM order_items oi
       WHERE oi."orderId" = o.id
     ) items ON TRUE
     WHERE o."clinicId" = $1::uuid
     ORDER BY o."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeOrder);
}

async function findOrderById(orderId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       o.id,
       o."clinicId",
       o."contactId",
       o."customerName",
       o."customerPhone",
       o.notes,
       o.subtotal,
       o.total,
       o.currency,
       o."paymentStatus",
       o."orderStatus",
       o."createdAt",
       o."updatedAt",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       COALESCE(items.items, '[]'::json) AS items
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o."contactId"
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'id', oi.id,
           'productId', oi."productId",
           'nameSnapshot', oi."nameSnapshot",
           'skuSnapshot', oi."skuSnapshot",
           'priceSnapshot', oi."priceSnapshot",
           'currencySnapshot', oi."currencySnapshot",
           'quantity', oi.quantity,
           'variant', oi.variant,
           'createdAt', oi."createdAt"
         )
         ORDER BY oi."createdAt" ASC
       ) AS items
       FROM order_items oi
       WHERE oi."orderId" = o.id
     ) items ON TRUE
     WHERE o.id = $1::uuid
       AND o."clinicId" = $2::uuid
     LIMIT 1`,
    [orderId, clinicId]
  );

  return result.rows[0] ? normalizeOrder(result.rows[0]) : null;
}

async function createOrder(input, client = null) {
  const insertOrder = await dbQuery(
    client,
    `INSERT INTO orders (
       "clinicId",
       "contactId",
       "customerName",
       "customerPhone",
       notes,
       subtotal,
       total,
       currency,
       "paymentStatus",
       "orderStatus",
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.contactId || null,
      input.customerName,
      input.customerPhone,
      input.notes || null,
      input.subtotal,
      input.total,
      input.currency,
      input.paymentStatus,
      input.orderStatus
    ]
  );

  const orderId = insertOrder.rows[0].id;

  for (const item of input.items) {
    const safeItem = normalizeInsertItem(item, input.currency);

    try {
      await dbQuery(
        client,
        `INSERT INTO order_items (
           "orderId",
           "productId",
           "nameSnapshot",
           "skuSnapshot",
           "priceSnapshot",
           "currencySnapshot",
           quantity,
           variant
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          safeItem.productId,
          safeItem.nameSnapshot,
          safeItem.skuSnapshot,
          safeItem.priceSnapshot,
          safeItem.currencySnapshot,
          safeItem.quantity,
          safeItem.variant
        ]
      );
    } catch (error) {
      logError('order_item_insert_failed', {
        orderId,
        clinicId: input.clinicId,
        productId: safeItem.productId,
        skuSnapshot: safeItem.skuSnapshot,
        currencySnapshot: safeItem.currencySnapshot,
        quantity: safeItem.quantity,
        error: error.message,
        code: error.code || null,
        detail: error.detail || null,
        where: error.where || null,
        constraint: error.constraint || null
      });
      throw error;
    }
  }

  return findOrderById(orderId, input.clinicId, client);
}

async function updateOrderStatus(orderId, clinicId, payload, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE orders
     SET
       "orderStatus" = $3,
       "paymentStatus" = COALESCE($4, "paymentStatus"),
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [orderId, clinicId, payload.orderStatus, payload.paymentStatus || null]
  );

  if (!result.rows[0]) return null;
  return findOrderById(orderId, clinicId, client);
}

module.exports = {
  listOrdersByClinicId,
  findOrderById,
  createOrder,
  updateOrderStatus
};
