const { query } = require('../db/client');

const NOTIFICATION_STATUSES = new Set([
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed_retryable',
  'failed_permanent',
  'unknown_delivery',
  'skipped_no_contact'
]);

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeNotification(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    orderId: row.orderId,
    contactId: row.contactId || null,
    conversationId: row.conversationId || null,
    channelId: row.channelId || null,
    notificationType: row.notificationType,
    finalizationVersion: Number(row.finalizationVersion || 0),
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    snapshot: row.snapshot,
    attemptCount: Number(row.attemptCount || 0),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt || null,
    lockedBy: row.lockedBy || null,
    leaseExpiresAt: row.leaseExpiresAt || null,
    providerMessageId: row.providerMessageId || null,
    lastError: row.lastError || null,
    errorMetadata: row.errorMetadata || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt || null,
    deliveredAt: row.deliveredAt || null,
    readAt: row.readAt || null
  };
}

const RETURNING_COLUMNS = `
  id,
  "clinicId",
  "orderId",
  "contactId",
  "conversationId",
  "channelId",
  "notificationType",
  "finalizationVersion",
  "idempotencyKey",
  status,
  snapshot,
  "attemptCount",
  "availableAt",
  "lockedAt",
  "lockedBy",
  "leaseExpiresAt",
  "providerMessageId",
  "lastError",
  "errorMetadata",
  "createdAt",
  "updatedAt",
  "sentAt",
  "deliveredAt",
  "readAt"`;

async function insertOrderCustomerNotification(input, client = null) {
  const status = String(input && input.status || '').trim().toLowerCase();
  if (!NOTIFICATION_STATUSES.has(status)) {
    throw new Error('Invalid order customer notification status.');
  }

  const result = await dbQuery(
    client,
    `INSERT INTO order_customer_notifications (
       "clinicId",
       "orderId",
       "contactId",
       "conversationId",
       "channelId",
       "notificationType",
       "finalizationVersion",
       "idempotencyKey",
       status,
       snapshot,
       "availableAt"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
     ON CONFLICT ("idempotencyKey") DO NOTHING
     RETURNING ${RETURNING_COLUMNS}`,
    [
      input.clinicId,
      input.orderId,
      input.contactId || null,
      input.conversationId || null,
      input.channelId || null,
      input.notificationType,
      input.finalizationVersion,
      input.idempotencyKey,
      status,
      JSON.stringify(input.snapshot),
      input.availableAt || new Date().toISOString()
    ]
  );

  if (result.rows[0]) {
    return {
      notification: normalizeNotification(result.rows[0]),
      inserted: true
    };
  }

  const existing = await findOrderCustomerNotificationByIdempotencyKey(input.idempotencyKey, client);
  if (!existing) {
    throw new Error('Order customer notification conflict could not be resolved.');
  }
  if (
    existing.clinicId !== input.clinicId ||
    existing.orderId !== input.orderId ||
    existing.notificationType !== input.notificationType ||
    existing.finalizationVersion !== Number(input.finalizationVersion)
  ) {
    throw new Error('Order customer notification idempotency key collision.');
  }

  return {
    notification: existing,
    inserted: false
  };
}

async function findOrderCustomerNotificationById(notificationId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${RETURNING_COLUMNS}
     FROM order_customer_notifications
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [notificationId, clinicId]
  );

  return normalizeNotification(result.rows[0]);
}

async function findOrderCustomerNotificationByIdempotencyKey(idempotencyKey, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${RETURNING_COLUMNS}
     FROM order_customer_notifications
     WHERE "idempotencyKey" = $1
     LIMIT 1`,
    [idempotencyKey]
  );

  return normalizeNotification(result.rows[0]);
}

async function listOrderCustomerNotificationsByOrder(orderId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${RETURNING_COLUMNS}
     FROM order_customer_notifications
     WHERE "orderId" = $1::uuid
       AND "clinicId" = $2::uuid
     ORDER BY "createdAt" ASC, id ASC`,
    [orderId, clinicId]
  );

  return result.rows.map(normalizeNotification);
}

function sanitizeStoredError(value) {
  if (value === undefined || value === null) return null;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 2000) || null;
}

async function updateOrderCustomerNotificationStatus(notificationId, clinicId, patch, client = null) {
  const status = String(patch && patch.status || '').trim().toLowerCase();
  if (!NOTIFICATION_STATUSES.has(status)) {
    throw new Error('Invalid order customer notification status.');
  }

  const shouldReleaseLease = status !== 'sending';
  const result = await dbQuery(
    client,
    `UPDATE order_customer_notifications
     SET
       status = $3,
       "providerMessageId" = CASE WHEN $4::boolean THEN $5 ELSE "providerMessageId" END,
       "lastError" = CASE WHEN $6::boolean THEN $7 ELSE "lastError" END,
       "errorMetadata" = CASE WHEN $8::boolean THEN $9::jsonb ELSE "errorMetadata" END,
       "availableAt" = CASE WHEN $10::boolean THEN $11::timestamptz ELSE "availableAt" END,
       "lockedAt" = CASE WHEN $12::boolean THEN NULL ELSE "lockedAt" END,
       "lockedBy" = CASE WHEN $12::boolean THEN NULL ELSE "lockedBy" END,
       "leaseExpiresAt" = CASE WHEN $12::boolean THEN NULL ELSE "leaseExpiresAt" END,
       "sentAt" = CASE WHEN $13::boolean THEN COALESCE($14::timestamptz, NOW()) ELSE "sentAt" END,
       "deliveredAt" = CASE WHEN $15::boolean THEN COALESCE($16::timestamptz, NOW()) ELSE "deliveredAt" END,
       "readAt" = CASE WHEN $17::boolean THEN COALESCE($18::timestamptz, NOW()) ELSE "readAt" END,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING ${RETURNING_COLUMNS}`,
    [
      notificationId,
      clinicId,
      status,
      Object.prototype.hasOwnProperty.call(patch, 'providerMessageId'),
      patch.providerMessageId || null,
      Object.prototype.hasOwnProperty.call(patch, 'lastError'),
      sanitizeStoredError(patch.lastError),
      Object.prototype.hasOwnProperty.call(patch, 'errorMetadata'),
      JSON.stringify(patch.errorMetadata || {}),
      Object.prototype.hasOwnProperty.call(patch, 'availableAt'),
      patch.availableAt || null,
      shouldReleaseLease,
      status === 'sent',
      patch.sentAt || null,
      status === 'delivered',
      patch.deliveredAt || null,
      status === 'read',
      patch.readAt || null
    ]
  );

  return normalizeNotification(result.rows[0]);
}

module.exports = {
  NOTIFICATION_STATUSES: Array.from(NOTIFICATION_STATUSES),
  insertOrderCustomerNotification,
  findOrderCustomerNotificationById,
  findOrderCustomerNotificationByIdempotencyKey,
  listOrderCustomerNotificationsByOrder,
  updateOrderCustomerNotificationStatus
};
