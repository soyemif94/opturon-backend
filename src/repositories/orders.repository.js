const { query } = require('../db/client');
const { logError } = require('../utils/logger');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeItem(item) {
  const unitPrice = quantizeDecimal(item.unitPrice ?? item.priceSnapshot ?? 0, 2, 0);
  const taxRate = quantizeDecimal(item.taxRate ?? 0, 2, 0);
  const subtotalAmount = quantizeDecimal(item.subtotalAmount ?? unitPrice * Number(item.quantity || 0), 2, 0);
  const totalAmount = quantizeDecimal(item.totalAmount ?? subtotalAmount, 2, 0);

  return {
    id: item.id,
    productId: item.productId || null,
    descriptionSnapshot: item.descriptionSnapshot || item.nameSnapshot,
    nameSnapshot: item.nameSnapshot || item.descriptionSnapshot,
    skuSnapshot: item.skuSnapshot || null,
    unitPrice,
    priceSnapshot: unitPrice,
    currencySnapshot: item.currencySnapshot || null,
    quantity: Number(item.quantity || 0),
    taxRate,
    subtotalAmount,
    totalAmount,
    variant: item.variant || null,
    createdAt: item.createdAt
  };
}

function normalizeInsertItem(item, fallbackCurrency) {
  const currencySnapshot = String(item.currencySnapshot || fallbackCurrency || 'ARS').trim().toUpperCase() || 'ARS';
  const skuSnapshot = String(item.skuSnapshot || '').trim();
  const descriptionSnapshot = String(item.descriptionSnapshot || item.nameSnapshot || '').trim();
  const unitPrice = quantizeDecimal(item.unitPrice ?? item.priceSnapshot ?? 0, 2, 0);
  const quantity = Number(item.quantity || 0);
  const taxRate = quantizeDecimal(item.taxRate ?? 0, 2, 0);
  const subtotalAmount = quantizeDecimal(item.subtotalAmount ?? unitPrice * quantity, 2, 0);
  const totalAmount = quantizeDecimal(item.totalAmount ?? subtotalAmount * (1 + taxRate / 100), 2, 0);

  return {
    productId: item.productId || null,
    descriptionSnapshot,
    nameSnapshot: descriptionSnapshot,
    skuSnapshot: skuSnapshot || null,
    unitPrice,
    priceSnapshot: unitPrice,
    currencySnapshot,
    quantity,
    taxRate,
    subtotalAmount,
    totalAmount,
    variant: String(item.variant || '').trim() || null
  };
}

function normalizeOrderStatus(status) {
  const safe = String(status || '').trim().toLowerCase();
  if (safe === 'cancelled') return 'cancelled';
  if (safe === 'confirmed') return 'confirmed';
  return 'draft';
}

function legacyOrderStatusFromBillingStatus(status) {
  const safe = normalizeOrderStatus(status);
  if (safe === 'confirmed') return 'paid';
  if (safe === 'cancelled') return 'cancelled';
  return 'new';
}

function normalizeOrder(row) {
  // Canonical order fields are status/subtotalAmount/taxAmount/totalAmount.
  // orderStatus/subtotal/total stay as compatibility aliases for older flows.
  const items = Array.isArray(row.items) ? row.items.map(normalizeItem) : [];
  const status = normalizeOrderStatus(row.status || row.orderStatus);
  const subtotalAmount = quantizeDecimal(row.subtotalAmount ?? row.subtotal ?? 0, 2, 0);
  const taxAmount = quantizeDecimal(row.taxAmount ?? 0, 2, 0);
  const totalAmount = quantizeDecimal(row.totalAmount ?? row.total ?? 0, 2, 0);

  return {
    id: row.id,
    clinicId: row.clinicId,
    contactId: row.contactId || null,
    customerName: row.customerName || row.contactName || null,
    customerPhone: row.customerPhone || row.contactPhone || null,
    customerType: row.customerType || 'registered_contact',
    source: row.source || null,
    sellerUserId: row.sellerUserId || null,
    sellerNameSnapshot: row.sellerNameSnapshot || null,
    paymentDestinationId: row.paymentDestinationId || null,
    paymentDestinationNameSnapshot: row.paymentDestinationNameSnapshot || null,
    paymentDestinationTypeSnapshot: row.paymentDestinationTypeSnapshot || null,
    status,
    orderStatus: row.orderStatus || legacyOrderStatusFromBillingStatus(status),
    paymentStatus: row.paymentStatus || null,
    currency: row.currency,
    notes: row.notes || null,
    conversationId: row.conversationId || null,
    subtotalAmount,
    taxAmount,
    totalAmount,
    subtotal: subtotalAmount,
    total: totalAmount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: row.contactName || null,
          phone: row.contactPhone || null
        }
      : null,
    seller: row.sellerUserId || row.sellerNameSnapshot || row.sellerName
      ? {
          id: row.sellerUserId || null,
          name: row.sellerName || row.sellerNameSnapshot || null,
          role: row.sellerRole || null
        }
      : null,
    paymentDestination:
      row.paymentDestinationId || row.paymentDestinationNameSnapshot || row.paymentDestinationName
        ? {
            id: row.paymentDestinationId || null,
            name: row.paymentDestinationName || row.paymentDestinationNameSnapshot || null,
            type: row.paymentDestinationType || row.paymentDestinationTypeSnapshot || null,
            isActive: row.paymentDestinationIsActive === null || row.paymentDestinationIsActive === undefined
              ? null
              : Boolean(row.paymentDestinationIsActive)
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
       o."customerType",
       o.source,
       o."sellerUserId",
       o."sellerNameSnapshot",
       o."paymentDestinationId",
       o."paymentDestinationNameSnapshot",
       o."paymentDestinationTypeSnapshot",
       o.status,
       o.notes,
       o.subtotal,
       o.total,
       o."subtotalAmount",
       o."taxAmount",
       o."totalAmount",
       o.currency,
       o."paymentStatus",
       o."orderStatus",
       o."conversationId",
       o."createdAt",
       o."updatedAt",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       seller.name AS "sellerName",
       CASE WHEN seller.role = 'editor' THEN 'seller' ELSE seller.role END AS "sellerRole",
       pd.name AS "paymentDestinationName",
       pd.type AS "paymentDestinationType",
       pd."isActive" AS "paymentDestinationIsActive",
       COALESCE(items.items, '[]'::json) AS items
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o."contactId"
     LEFT JOIN staff_users seller ON seller.id = o."sellerUserId"
     LEFT JOIN payment_destinations pd
       ON pd.id = o."paymentDestinationId"
      AND pd."clinicId" = o."clinicId"
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'id', oi.id,
           'productId', oi."productId",
           'descriptionSnapshot', COALESCE(oi."descriptionSnapshot", oi."nameSnapshot"),
           'nameSnapshot', oi."nameSnapshot",
           'skuSnapshot', oi."skuSnapshot",
           'unitPrice', COALESCE(oi."unitPrice", oi."priceSnapshot"),
           'priceSnapshot', oi."priceSnapshot",
           'currencySnapshot', oi."currencySnapshot",
           'quantity', oi.quantity,
           'taxRate', oi."taxRate",
           'subtotalAmount', oi."subtotalAmount",
           'totalAmount', oi."totalAmount",
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
       o."customerType",
       o.source,
       o."sellerUserId",
       o."sellerNameSnapshot",
       o."paymentDestinationId",
       o."paymentDestinationNameSnapshot",
       o."paymentDestinationTypeSnapshot",
       o.status,
       o.notes,
       o.subtotal,
       o.total,
       o."subtotalAmount",
       o."taxAmount",
       o."totalAmount",
       o.currency,
       o."paymentStatus",
       o."orderStatus",
       o."conversationId",
       o."createdAt",
       o."updatedAt",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       seller.name AS "sellerName",
       CASE WHEN seller.role = 'editor' THEN 'seller' ELSE seller.role END AS "sellerRole",
       pd.name AS "paymentDestinationName",
       pd.type AS "paymentDestinationType",
       pd."isActive" AS "paymentDestinationIsActive",
       COALESCE(items.items, '[]'::json) AS items
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o."contactId"
     LEFT JOIN staff_users seller ON seller.id = o."sellerUserId"
     LEFT JOIN payment_destinations pd
       ON pd.id = o."paymentDestinationId"
      AND pd."clinicId" = o."clinicId"
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'id', oi.id,
           'productId', oi."productId",
           'descriptionSnapshot', COALESCE(oi."descriptionSnapshot", oi."nameSnapshot"),
           'nameSnapshot', oi."nameSnapshot",
           'skuSnapshot', oi."skuSnapshot",
           'unitPrice', COALESCE(oi."unitPrice", oi."priceSnapshot"),
           'priceSnapshot', oi."priceSnapshot",
           'currencySnapshot', oi."currencySnapshot",
           'quantity', oi.quantity,
           'taxRate', oi."taxRate",
           'subtotalAmount', oi."subtotalAmount",
           'totalAmount', oi."totalAmount",
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
  const billingStatus = normalizeOrderStatus(input.status || input.orderStatus);
  const legacyOrderStatus = input.orderStatus || legacyOrderStatusFromBillingStatus(billingStatus);
  const subtotalAmount = quantizeDecimal(input.subtotalAmount ?? input.subtotal ?? 0, 2, 0);
  const taxAmount = quantizeDecimal(input.taxAmount ?? 0, 2, 0);
  const totalAmount = quantizeDecimal(input.totalAmount ?? input.total ?? 0, 2, 0);

  const insertOrder = await dbQuery(
    client,
    `INSERT INTO orders (
       "clinicId",
       "contactId",
       "customerName",
       "customerPhone",
       "customerType",
       source,
       "sellerUserId",
       "sellerNameSnapshot",
       "paymentDestinationId",
       "paymentDestinationNameSnapshot",
       "paymentDestinationTypeSnapshot",
       status,
       notes,
       subtotal,
       total,
       "subtotalAmount",
       "taxAmount",
       "totalAmount",
       currency,
       "paymentStatus",
       "orderStatus",
       "conversationId",
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9::uuid, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::uuid, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.contactId || null,
      input.customerName || null,
      input.customerPhone || null,
      input.customerType || 'registered_contact',
      input.source || null,
      input.sellerUserId || null,
      input.sellerNameSnapshot || null,
      input.paymentDestinationId || null,
      input.paymentDestinationNameSnapshot || null,
      input.paymentDestinationTypeSnapshot || null,
      billingStatus,
      input.notes || null,
      subtotalAmount,
      totalAmount,
      subtotalAmount,
      taxAmount,
      totalAmount,
      input.currency,
      input.paymentStatus || null,
      legacyOrderStatus,
      input.conversationId || null
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
           "descriptionSnapshot",
           "nameSnapshot",
           "skuSnapshot",
           "unitPrice",
           "priceSnapshot",
           "currencySnapshot",
           quantity,
           "taxRate",
           "subtotalAmount",
           "totalAmount",
           variant
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          orderId,
          safeItem.productId,
          safeItem.descriptionSnapshot,
          safeItem.nameSnapshot,
          safeItem.skuSnapshot,
          safeItem.unitPrice,
          safeItem.priceSnapshot,
          safeItem.currencySnapshot,
          safeItem.quantity,
          safeItem.taxRate,
          safeItem.subtotalAmount,
          safeItem.totalAmount,
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
  const billingStatus = normalizeOrderStatus(payload.status || payload.orderStatus);
  const legacyOrderStatus = payload.orderStatus || legacyOrderStatusFromBillingStatus(billingStatus);

  const result = await dbQuery(
    client,
    `UPDATE orders
     SET
       status = $3,
       "orderStatus" = $4,
       "paymentStatus" = COALESCE($5, "paymentStatus"),
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [orderId, clinicId, billingStatus, legacyOrderStatus, payload.paymentStatus || null]
  );

  if (!result.rows[0]) return null;
  return findOrderById(orderId, clinicId, client);
}

async function listCashCountableOrdersByDestinationAndRange(clinicId, paymentDestinationId, openedAt, closedAt = null, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       o.id,
       o."clinicId",
       o."contactId",
       o."customerName",
       o."customerPhone",
       o."customerType",
       o.source,
       o."sellerUserId",
       o."sellerNameSnapshot",
       o."paymentDestinationId",
       o."paymentDestinationNameSnapshot",
       o."paymentDestinationTypeSnapshot",
       o.status,
       o.notes,
       o.subtotal,
       o.total,
       o."subtotalAmount",
       o."taxAmount",
       o."totalAmount",
       o.currency,
       o."paymentStatus",
       o."orderStatus",
       o."conversationId",
       o."createdAt",
       o."updatedAt",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       seller.name AS "sellerName",
       CASE WHEN seller.role = 'editor' THEN 'seller' ELSE seller.role END AS "sellerRole",
       pd.name AS "paymentDestinationName",
       pd.type AS "paymentDestinationType",
       pd."isActive" AS "paymentDestinationIsActive",
       '[]'::json AS items
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o."contactId"
     LEFT JOIN staff_users seller ON seller.id = o."sellerUserId"
     LEFT JOIN payment_destinations pd
       ON pd.id = o."paymentDestinationId"
      AND pd."clinicId" = o."clinicId"
     WHERE o."clinicId" = $1::uuid
       AND o."paymentDestinationId" = $2::uuid
       AND o."createdAt" >= $3::timestamptz
       AND ($4::timestamptz IS NULL OR o."createdAt" <= $4::timestamptz)
       AND COALESCE(o."paymentStatus", '') = 'paid'
       AND COALESCE(o.status, '') <> 'cancelled'
     ORDER BY o."createdAt" DESC`,
    [clinicId, paymentDestinationId, openedAt, closedAt]
  );

  return result.rows.map(normalizeOrder);
}

module.exports = {
  listOrdersByClinicId,
  findOrderById,
  createOrder,
  updateOrderStatus,
  listCashCountableOrdersByDestinationAndRange
};
