const { query, withTransaction } = require('../db/client');

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
    resultCode: row.resultCode || null,
    snapshot: row.snapshot,
    attemptCount: Number(row.attemptCount || 0),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt || null,
    lockedBy: row.lockedBy || null,
    leaseExpiresAt: row.leaseExpiresAt || null,
    graphRequestStartedAt: row.graphRequestStartedAt || null,
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
  "resultCode",
  snapshot,
  "attemptCount",
  "availableAt",
  "lockedAt",
  "lockedBy",
  "leaseExpiresAt",
  "graphRequestStartedAt",
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

function sanitizeResultCode(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim().toLowerCase().slice(0, 200) || null;
}

async function claimOrderCustomerNotifications({
  workerId,
  limit = 10,
  leaseSeconds = 120,
  maxAttempts = 5
} = {}) {
  const safeWorkerId = String(workerId || '').trim();
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(String(limit || 10), 10) || 10));
  const safeLeaseSeconds = Math.max(30, Math.min(900, Number.parseInt(String(leaseSeconds || 120), 10) || 120));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number.parseInt(String(maxAttempts || 5), 10) || 5));

  if (!safeWorkerId) {
    throw new Error('Order customer notification workerId is required.');
  }

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE order_customer_notifications
       SET status = 'sent',
           "resultCode" = COALESCE("resultCode", 'graph_accepted_inbox_pending'),
           "sentAt" = COALESCE("sentAt", "graphRequestStartedAt", NOW()),
           "lastError" = NULL,
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'provider_message_known_after_lease_expiry',
             'retriable', false,
             'recoveredAt', NOW()
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "notificationType" = 'order_summary'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "providerMessageId" IS NOT NULL`
    );

    await client.query(
      `UPDATE order_customer_notifications
       SET status = 'failed_retryable',
           "resultCode" = 'lease_expired_pre_graph_retryable',
           "lastError" = 'sending_lease_expired_before_graph_request',
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'sending_lease_expired_before_graph_request',
             'retriable', true,
             'recoveredAt', NOW()
           ),
           "availableAt" = NOW(),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "notificationType" = 'order_summary'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "graphRequestStartedAt" IS NULL
         AND "providerMessageId" IS NULL`
    );

    await client.query(
      `UPDATE order_customer_notifications
       SET status = 'unknown_delivery',
           "resultCode" = 'lease_expired_post_graph_ambiguous',
           "lastError" = 'sending_lease_expired_after_graph_request_started',
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'sending_lease_expired_after_graph_request_started',
             'retriable', false,
             'recoveredAt', NOW()
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "notificationType" = 'order_summary'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "graphRequestStartedAt" IS NOT NULL
         AND "providerMessageId" IS NULL`
    );

    await client.query(
      `UPDATE order_customer_notifications
       SET status = 'failed_permanent',
           "resultCode" = 'retry_attempts_exhausted',
           "lastError" = COALESCE("lastError", 'retry_attempts_exhausted'),
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'retry_attempts_exhausted',
             'maxAttempts', $1::int,
             'retriable', false
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'failed_retryable'
         AND "notificationType" = 'order_summary'
         AND "availableAt" <= NOW()
         AND "attemptCount" >= $1::int`,
      [safeMaxAttempts]
    );

    const result = await client.query(
      `WITH picked AS (
         SELECT id AS "pickedId"
         FROM order_customer_notifications
         WHERE status IN ('pending', 'failed_retryable')
           AND "notificationType" = 'order_summary'
           AND "availableAt" <= NOW()
           AND "attemptCount" < $4::int
         ORDER BY "availableAt" ASC, "createdAt" ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1::int
       )
       UPDATE order_customer_notifications n
       SET status = 'sending',
           "resultCode" = NULL,
           "attemptCount" = n."attemptCount" + 1,
           "lockedAt" = NOW(),
           "lockedBy" = $2,
           "leaseExpiresAt" = NOW() + ($3::int * INTERVAL '1 second'),
           "graphRequestStartedAt" = NULL,
           "updatedAt" = NOW()
       FROM picked
       WHERE n.id = picked."pickedId"
       RETURNING ${RETURNING_COLUMNS}`,
      [safeLimit, safeWorkerId, safeLeaseSeconds, safeMaxAttempts]
    );

    return result.rows.map(normalizeNotification);
  });
}

async function updateOrderCustomerNotificationRouting(
  notificationId,
  clinicId,
  { conversationId, channelId, lockedBy },
  client = null
) {
  const result = await dbQuery(
    client,
    `UPDATE order_customer_notifications
     SET "conversationId" = $3::uuid,
         "channelId" = $4::uuid,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'sending'
       AND "lockedBy" = $5
     RETURNING ${RETURNING_COLUMNS}`,
    [notificationId, clinicId, conversationId, channelId, lockedBy]
  );

  return normalizeNotification(result.rows[0]);
}

async function markOrderCustomerNotificationGraphRequestStarted(
  notificationId,
  clinicId,
  { lockedBy, startedAt },
  client = null
) {
  const safeLockedBy = String(lockedBy || '').trim();
  if (!safeLockedBy) {
    throw new Error('Order customer notification lock owner is required.');
  }

  const result = await dbQuery(
    client,
    `UPDATE order_customer_notifications
     SET "graphRequestStartedAt" = $4::timestamptz,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'sending'
       AND "lockedBy" = $3
       AND "leaseExpiresAt" IS NOT NULL
       AND "leaseExpiresAt" > NOW()
       AND "graphRequestStartedAt" IS NULL
       AND "providerMessageId" IS NULL
     RETURNING ${RETURNING_COLUMNS}`,
    [notificationId, clinicId, safeLockedBy, startedAt || new Date().toISOString()]
  );

  return normalizeNotification(result.rows[0]);
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
       "resultCode" = CASE WHEN $4::boolean THEN $5 ELSE "resultCode" END,
       "providerMessageId" = CASE WHEN $6::boolean THEN $7 ELSE "providerMessageId" END,
       "lastError" = CASE WHEN $8::boolean THEN $9 ELSE "lastError" END,
       "errorMetadata" = CASE
         WHEN $10::boolean THEN COALESCE("errorMetadata", '{}'::jsonb) || $11::jsonb
         ELSE "errorMetadata"
       END,
       "availableAt" = CASE WHEN $12::boolean THEN $13::timestamptz ELSE "availableAt" END,
       "lockedAt" = CASE WHEN $14::boolean THEN NULL ELSE "lockedAt" END,
       "lockedBy" = CASE WHEN $14::boolean THEN NULL ELSE "lockedBy" END,
       "leaseExpiresAt" = CASE WHEN $14::boolean THEN NULL ELSE "leaseExpiresAt" END,
       "sentAt" = CASE WHEN $15::boolean THEN COALESCE("sentAt", $16::timestamptz, NOW()) ELSE "sentAt" END,
       "deliveredAt" = CASE WHEN $17::boolean THEN COALESCE("deliveredAt", $18::timestamptz, NOW()) ELSE "deliveredAt" END,
       "readAt" = CASE WHEN $19::boolean THEN COALESCE("readAt", $20::timestamptz, NOW()) ELSE "readAt" END,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND ($21::text IS NULL OR "lockedBy" = $21::text)
     RETURNING ${RETURNING_COLUMNS}`,
    [
      notificationId,
      clinicId,
      status,
      Object.prototype.hasOwnProperty.call(patch, 'resultCode'),
      sanitizeResultCode(patch.resultCode),
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
      patch.readAt || null,
      patch.expectedLockedBy || null
    ]
  );

  return normalizeNotification(result.rows[0]);
}

async function listOrderCustomerNotificationsNeedingInboxRecovery(limit = 25, client = null) {
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(String(limit || 25), 10) || 25));
  const result = await dbQuery(
    client,
    `SELECT ${RETURNING_COLUMNS}
     FROM order_customer_notifications n
     WHERE n.status IN ('sent', 'delivered', 'read', 'unknown_delivery')
       AND n."notificationType" = 'order_summary'
       AND n."providerMessageId" IS NOT NULL
       AND n."conversationId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM conversation_messages cm
         WHERE cm."conversationId" = n."conversationId"
           AND cm."waMessageId" = n."providerMessageId"
       )
     ORDER BY n."sentAt" ASC NULLS LAST, n."updatedAt" ASC
     LIMIT $1::int`,
    [safeLimit]
  );

  return result.rows.map(normalizeNotification);
}

async function reconcileOrderCustomerNotificationDeliveryStatus({
  clinicId,
  channelId,
  providerMessageId,
  status,
  occurredAt = null,
  failureMetadata = null
}, client = null) {
  const safeStatus = String(status || '').trim().toLowerCase();
  if (!['sent', 'delivered', 'read', 'failed'].includes(safeStatus)) return null;

  const result = await dbQuery(
    client,
    `UPDATE order_customer_notifications
     SET status = CASE
           WHEN $4 = 'read' AND status IN ('unknown_delivery', 'sent', 'delivered', 'read') THEN 'read'
           WHEN $4 = 'delivered' AND status IN ('unknown_delivery', 'sent', 'delivered') THEN 'delivered'
           WHEN $4 = 'sent' AND status IN ('unknown_delivery', 'sent') THEN 'sent'
           WHEN $4 = 'failed' AND status IN ('unknown_delivery', 'sent') THEN 'failed_permanent'
           ELSE status
         END,
         "resultCode" = CASE
           WHEN $4 = 'read' AND status IN ('unknown_delivery', 'sent', 'delivered', 'read') THEN 'meta_read'
           WHEN $4 = 'delivered' AND status IN ('unknown_delivery', 'sent', 'delivered') THEN 'meta_delivered'
           WHEN $4 = 'sent' AND status IN ('unknown_delivery', 'sent') THEN 'meta_sent'
           WHEN $4 = 'failed' AND status IN ('unknown_delivery', 'sent') THEN 'meta_failed'
           ELSE "resultCode"
         END,
         "sentAt" = CASE
           WHEN $4 IN ('sent', 'delivered', 'read') AND status IN ('unknown_delivery', 'sent', 'delivered', 'read')
             THEN COALESCE("sentAt", $5::timestamptz, NOW())
           ELSE "sentAt"
         END,
         "deliveredAt" = CASE
           WHEN $4 IN ('delivered', 'read') AND status IN ('unknown_delivery', 'sent', 'delivered', 'read')
             THEN COALESCE("deliveredAt", $5::timestamptz, NOW())
           ELSE "deliveredAt"
         END,
         "readAt" = CASE
           WHEN $4 = 'read' AND status IN ('unknown_delivery', 'sent', 'delivered', 'read')
             THEN COALESCE("readAt", $5::timestamptz, NOW())
           ELSE "readAt"
         END,
         "lastError" = CASE
           WHEN $4 = 'failed' AND status IN ('unknown_delivery', 'sent') THEN 'whatsapp_delivery_failed'
           ELSE "lastError"
         END,
         "errorMetadata" = CASE
           WHEN $4 = 'failed' AND status IN ('unknown_delivery', 'sent')
             THEN COALESCE("errorMetadata", '{}'::jsonb) || $6::jsonb
           ELSE "errorMetadata"
         END,
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND "channelId" = $2::uuid
       AND "providerMessageId" = $3
       AND "notificationType" = 'order_summary'
     RETURNING ${RETURNING_COLUMNS}`,
    [
      clinicId,
      channelId,
      providerMessageId,
      safeStatus,
      occurredAt,
      JSON.stringify(failureMetadata || {})
    ]
  );

  return normalizeNotification(result.rows[0]);
}

async function mergeOrderCustomerNotificationMetadata(notificationId, clinicId, metadata, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE order_customer_notifications
     SET "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || $3::jsonb,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING ${RETURNING_COLUMNS}`,
    [notificationId, clinicId, JSON.stringify(metadata || {})]
  );

  return normalizeNotification(result.rows[0]);
}

module.exports = {
  NOTIFICATION_STATUSES: Array.from(NOTIFICATION_STATUSES),
  insertOrderCustomerNotification,
  findOrderCustomerNotificationById,
  findOrderCustomerNotificationByIdempotencyKey,
  listOrderCustomerNotificationsByOrder,
  claimOrderCustomerNotifications,
  updateOrderCustomerNotificationRouting,
  markOrderCustomerNotificationGraphRequestStarted,
  updateOrderCustomerNotificationStatus,
  mergeOrderCustomerNotificationMetadata,
  listOrderCustomerNotificationsNeedingInboxRecovery,
  reconcileOrderCustomerNotificationDeliveryStatus
};
