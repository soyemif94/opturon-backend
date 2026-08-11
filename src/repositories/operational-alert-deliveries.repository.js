const { isDeepStrictEqual } = require('util');
const { query, withTransaction } = require('../db/client');
const {
  normalizeString,
  normalizeNullableString,
  normalizeDateTime,
  isUuid,
  cloneJsonObject,
  isPositiveInteger,
  contractError
} = require('../operational-alerts/operational-alert-validation');

const DELIVERY_COLUMNS = `
  id,
  "clinicId",
  "instanceId",
  "recipientId",
  "recipientVersion",
  "channelId",
  "idempotencyKey",
  status,
  "recipientSnapshot",
  "messageSnapshot",
  "templateKey",
  "templateLanguage",
  "templateVersion",
  "formatterKey",
  "formatterVersion",
  "attemptCount",
  "availableAt",
  "lockedAt",
  "lockedBy",
  "leaseExpiresAt",
  "graphRequestStartedAt",
  "providerMessageId",
  "resultCode",
  "lastError",
  "errorMetadata",
  "sentAt",
  "deliveredAt",
  "readAt",
  "createdAt",
  "updatedAt"`;

const DELIVERY_STATUSES = new Set([
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed_retryable',
  'failed_permanent',
  'unknown_delivery',
  'skipped'
]);

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeDeliveryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    instanceId: row.instanceId,
    recipientId: row.recipientId,
    recipientVersion: Number(row.recipientVersion),
    channelId: row.channelId || null,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    recipientSnapshot: row.recipientSnapshot || {},
    messageSnapshot: row.messageSnapshot || null,
    templateKey: row.templateKey || null,
    templateLanguage: row.templateLanguage || null,
    templateVersion: row.templateVersion === null || row.templateVersion === undefined
      ? null
      : Number(row.templateVersion),
    formatterKey: row.formatterKey,
    formatterVersion: Number(row.formatterVersion),
    attemptCount: Number(row.attemptCount || 0),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt || null,
    lockedBy: row.lockedBy || null,
    leaseExpiresAt: row.leaseExpiresAt || null,
    graphRequestStartedAt: row.graphRequestStartedAt || null,
    providerMessageId: row.providerMessageId || null,
    resultCode: row.resultCode || null,
    lastError: row.lastError || null,
    errorMetadata: row.errorMetadata || null,
    sentAt: row.sentAt || null,
    deliveredAt: row.deliveredAt || null,
    readAt: row.readAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeDeliveryInsert(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError('operational_alert_delivery_not_object');
  }
  if (input.status !== undefined && input.status !== 'pending') {
    throw contractError('operational_alert_delivery_initial_status_forbidden');
  }

  const clinicId = normalizeString(input.clinicId);
  const instanceId = normalizeString(input.instanceId);
  const recipientId = normalizeString(input.recipientId);
  const channelId = normalizeNullableString(input.channelId);
  if (!isUuid(clinicId)) throw contractError('operational_alert_delivery_clinic_id_invalid');
  if (!isUuid(instanceId)) throw contractError('operational_alert_delivery_instance_id_invalid');
  if (!isUuid(recipientId)) throw contractError('operational_alert_delivery_recipient_id_invalid');
  if (channelId && !isUuid(channelId)) throw contractError('operational_alert_delivery_channel_id_invalid');
  if (!isPositiveInteger(input.recipientVersion)) {
    throw contractError('operational_alert_delivery_recipient_version_invalid');
  }

  const idempotencyKey = normalizeString(input.idempotencyKey);
  if (!idempotencyKey || idempotencyKey.length > 500) {
    throw contractError('operational_alert_delivery_idempotency_key_invalid');
  }
  const recipientSnapshot = cloneJsonObject(input.recipientSnapshot);
  if (!recipientSnapshot) throw contractError('operational_alert_delivery_recipient_snapshot_invalid');
  const messageSnapshot = input.messageSnapshot === undefined || input.messageSnapshot === null
    ? null
    : cloneJsonObject(input.messageSnapshot);
  if (input.messageSnapshot !== undefined && input.messageSnapshot !== null && !messageSnapshot) {
    throw contractError('operational_alert_delivery_message_snapshot_invalid');
  }

  const templateKey = normalizeNullableString(input.templateKey);
  const templateLanguage = normalizeNullableString(input.templateLanguage);
  const templateVersion = input.templateVersion === undefined || input.templateVersion === null
    ? null
    : input.templateVersion;
  if (templateVersion !== null && !isPositiveInteger(templateVersion)) {
    throw contractError('operational_alert_delivery_template_version_invalid');
  }
  const formatterKey = normalizeString(input.formatterKey);
  if (!formatterKey || formatterKey.length > 200) {
    throw contractError('operational_alert_delivery_formatter_key_invalid');
  }
  if (!isPositiveInteger(input.formatterVersion)) {
    throw contractError('operational_alert_delivery_formatter_version_invalid');
  }

  const availableAt = normalizeDateTime(input.availableAt) || new Date().toISOString();
  if (input.availableAt && !normalizeDateTime(input.availableAt)) {
    throw contractError('operational_alert_delivery_available_at_invalid');
  }
  return {
    clinicId,
    instanceId,
    recipientId,
    recipientVersion: input.recipientVersion,
    channelId,
    idempotencyKey,
    recipientSnapshot,
    messageSnapshot,
    templateKey,
    templateLanguage,
    templateVersion,
    formatterKey,
    formatterVersion: input.formatterVersion,
    availableAt
  };
}

function sameDeliveryIdentity(existing, candidate) {
  return existing.clinicId === candidate.clinicId
    && existing.instanceId === candidate.instanceId
    && existing.recipientId === candidate.recipientId
    && existing.recipientVersion === candidate.recipientVersion
    && existing.channelId === candidate.channelId
    && existing.idempotencyKey === candidate.idempotencyKey
    && existing.templateKey === candidate.templateKey
    && existing.templateLanguage === candidate.templateLanguage
    && (candidate.templateVersion === null || existing.templateVersion === candidate.templateVersion)
    && existing.formatterKey === candidate.formatterKey
    && existing.formatterVersion === candidate.formatterVersion
    && isDeepStrictEqual(existing.recipientSnapshot, candidate.recipientSnapshot)
    && (candidate.messageSnapshot === null || isDeepStrictEqual(existing.messageSnapshot, candidate.messageSnapshot));
}

async function insertOperationalAlertDelivery(input, client = null) {
  const delivery = normalizeDeliveryInsert(input);
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_deliveries (
       "clinicId",
       "instanceId",
       "recipientId",
       "recipientVersion",
       "channelId",
       "idempotencyKey",
       status,
       "recipientSnapshot",
       "messageSnapshot",
       "templateKey",
       "templateLanguage",
       "templateVersion",
       "formatterKey",
       "formatterVersion",
       "attemptCount",
       "availableAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4,
       $5::uuid,
       $6,
       'pending',
       $7::jsonb,
       $8::jsonb,
       $9,
       $10,
       $11,
       $12,
       $13,
       0,
       $14::timestamptz,
       NOW()
     )
     ON CONFLICT DO NOTHING
     RETURNING ${DELIVERY_COLUMNS}`,
    [
      delivery.clinicId,
      delivery.instanceId,
      delivery.recipientId,
      delivery.recipientVersion,
      delivery.channelId,
      delivery.idempotencyKey,
      JSON.stringify(delivery.recipientSnapshot),
      delivery.messageSnapshot === null ? null : JSON.stringify(delivery.messageSnapshot),
      delivery.templateKey,
      delivery.templateLanguage,
      delivery.templateVersion,
      delivery.formatterKey,
      delivery.formatterVersion,
      delivery.availableAt
    ]
  );
  if (result.rows[0]) return { delivery: normalizeDeliveryRow(result.rows[0]), inserted: true };

  const existingResult = await dbQuery(
    client,
    `SELECT ${DELIVERY_COLUMNS}
     FROM operational_alert_deliveries
     WHERE "idempotencyKey" = $1
        OR (
          "clinicId" = $2::uuid
          AND "instanceId" = $3::uuid
          AND "recipientId" = $4::uuid
        )
     ORDER BY CASE WHEN "idempotencyKey" = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [delivery.idempotencyKey, delivery.clinicId, delivery.instanceId, delivery.recipientId]
  );
  const existing = normalizeDeliveryRow(existingResult.rows[0]);
  if (!existing || !sameDeliveryIdentity(existing, delivery)) {
    throw contractError('operational_alert_delivery_idempotency_conflict');
  }
  return { delivery: existing, inserted: false };
}

async function findOperationalAlertDeliveryById(deliveryId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${DELIVERY_COLUMNS}
     FROM operational_alert_deliveries
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [deliveryId, clinicId]
  );
  return normalizeDeliveryRow(result.rows[0]);
}

function sanitizeStoredText(value, maxLength = 2000) {
  if (value === undefined || value === null) return null;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength) || null;
}

function sanitizeResultCode(value) {
  const safe = sanitizeStoredText(value, 200);
  return safe ? safe.toLowerCase() : null;
}

async function recoverOperationalAlertDeliveryLeases({ maxAttempts = 5 } = {}) {
  const safeMaxAttempts = Math.max(1, Math.min(20, Number.parseInt(String(maxAttempts || 5), 10) || 5));
  return withTransaction(async (client) => {
    const providerKnown = await client.query(
      `UPDATE operational_alert_deliveries
       SET status = 'sent',
           "resultCode" = COALESCE("resultCode", 'graph_accepted_recovered'),
           "sentAt" = COALESCE("sentAt", "graphRequestStartedAt", NOW()),
           "lastError" = NULL,
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'provider_message_known_after_lease_expiry',
             'retriable', false
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "providerMessageId" IS NOT NULL
       RETURNING ${DELIVERY_COLUMNS}`
    );
    const preGraph = await client.query(
      `UPDATE operational_alert_deliveries
       SET status = 'failed_retryable',
           "resultCode" = 'lease_expired_pre_graph_retryable',
           "availableAt" = NOW(),
           "lastError" = 'delivery_lease_expired_before_graph_request',
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'delivery_lease_expired_before_graph_request',
             'retriable', true
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "graphRequestStartedAt" IS NULL
         AND "providerMessageId" IS NULL
       RETURNING ${DELIVERY_COLUMNS}`
    );
    const postGraph = await client.query(
      `UPDATE operational_alert_deliveries
       SET status = 'unknown_delivery',
           "resultCode" = 'lease_expired_post_graph_ambiguous',
           "lastError" = 'delivery_lease_expired_after_graph_request_started',
           "errorMetadata" = COALESCE("errorMetadata", '{}'::jsonb) || jsonb_build_object(
             'reason', 'delivery_lease_expired_after_graph_request_started',
             'retriable', false
           ),
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = NOW()
       WHERE status = 'sending'
         AND "leaseExpiresAt" IS NOT NULL
         AND "leaseExpiresAt" <= NOW()
         AND "graphRequestStartedAt" IS NOT NULL
         AND "providerMessageId" IS NULL
       RETURNING ${DELIVERY_COLUMNS}`
    );
    const exhausted = await client.query(
      `UPDATE operational_alert_deliveries
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
         AND "availableAt" <= NOW()
         AND "attemptCount" >= $1::int
       RETURNING ${DELIVERY_COLUMNS}`,
      [safeMaxAttempts]
    );
    return {
      providerKnown: providerKnown.rows.map(normalizeDeliveryRow),
      preGraph: preGraph.rows.map(normalizeDeliveryRow),
      postGraph: postGraph.rows.map(normalizeDeliveryRow),
      exhausted: exhausted.rows.map(normalizeDeliveryRow)
    };
  });
}

async function claimOperationalAlertDeliveries({
  workerId,
  limit = 10,
  leaseSeconds = 120,
  maxAttempts = 5
} = {}) {
  const safeWorkerId = normalizeString(workerId);
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(String(limit || 10), 10) || 10));
  const safeLeaseSeconds = Math.max(30, Math.min(900, Number.parseInt(String(leaseSeconds || 120), 10) || 120));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number.parseInt(String(maxAttempts || 5), 10) || 5));
  if (!safeWorkerId) throw contractError('operational_alert_delivery_worker_id_required');

  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH picked AS (
         SELECT id AS "pickedId"
         FROM operational_alert_deliveries
         WHERE status IN ('pending', 'failed_retryable')
           AND "availableAt" <= NOW()
           AND "attemptCount" < $4::int
         ORDER BY "availableAt" ASC, "createdAt" ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1::int
       )
       UPDATE operational_alert_deliveries d
       SET status = 'sending',
           "attemptCount" = d."attemptCount" + 1,
           "lockedAt" = NOW(),
           "lockedBy" = $2,
           "leaseExpiresAt" = NOW() + ($3::int * INTERVAL '1 second'),
           "graphRequestStartedAt" = NULL,
           "resultCode" = NULL,
           "lastError" = NULL,
           "updatedAt" = NOW()
       FROM picked
       WHERE d.id = picked."pickedId"
       RETURNING ${DELIVERY_COLUMNS}`,
      [safeLimit, safeWorkerId, safeLeaseSeconds, safeMaxAttempts]
    );
    return result.rows.map(normalizeDeliveryRow);
  });
}

async function materializeOperationalAlertMessageSnapshot(
  deliveryId,
  clinicId,
  { lockedBy, messageSnapshot, templateVersion = 1 },
  client = null
) {
  const snapshot = cloneJsonObject(messageSnapshot);
  if (!snapshot) throw contractError('operational_alert_delivery_message_snapshot_invalid');
  if (!isPositiveInteger(templateVersion)) {
    throw contractError('operational_alert_delivery_template_version_invalid');
  }
  const result = await dbQuery(
    client,
    `UPDATE operational_alert_deliveries
     SET "messageSnapshot" = $4::jsonb,
         "templateVersion" = COALESCE("templateVersion", $5::int),
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'sending'
       AND "lockedBy" = $3
       AND "leaseExpiresAt" > NOW()
       AND "messageSnapshot" IS NULL
     RETURNING ${DELIVERY_COLUMNS}`,
    [deliveryId, clinicId, normalizeString(lockedBy), JSON.stringify(snapshot), templateVersion]
  );
  return normalizeDeliveryRow(result.rows[0]);
}

async function markOperationalAlertGraphRequestStarted(
  deliveryId,
  clinicId,
  { lockedBy, startedAt },
  client = null
) {
  const result = await dbQuery(
    client,
    `UPDATE operational_alert_deliveries
     SET "graphRequestStartedAt" = $4::timestamptz,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
       AND status = 'sending'
       AND "lockedBy" = $3
       AND "leaseExpiresAt" > NOW()
       AND "graphRequestStartedAt" IS NULL
       AND "providerMessageId" IS NULL
       AND "messageSnapshot" IS NOT NULL
     RETURNING ${DELIVERY_COLUMNS}`,
    [deliveryId, clinicId, normalizeString(lockedBy), startedAt || new Date().toISOString()]
  );
  return normalizeDeliveryRow(result.rows[0]);
}

async function updateOperationalAlertDeliveryStatus(deliveryId, clinicId, patch, client = null) {
  const status = normalizeString(patch && patch.status).toLowerCase();
  if (!DELIVERY_STATUSES.has(status)) throw contractError('operational_alert_delivery_status_invalid');
  const releaseLease = status !== 'sending';
  const result = await dbQuery(
    client,
    `UPDATE operational_alert_deliveries
     SET status = $3,
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
       AND ($21::text IS NULL OR "lockedBy" = $21)
     RETURNING ${DELIVERY_COLUMNS}`,
    [
      deliveryId,
      clinicId,
      status,
      Object.prototype.hasOwnProperty.call(patch, 'resultCode'),
      sanitizeResultCode(patch.resultCode),
      Object.prototype.hasOwnProperty.call(patch, 'providerMessageId'),
      sanitizeStoredText(patch.providerMessageId, 500),
      Object.prototype.hasOwnProperty.call(patch, 'lastError'),
      sanitizeStoredText(patch.lastError),
      Object.prototype.hasOwnProperty.call(patch, 'errorMetadata'),
      JSON.stringify(patch.errorMetadata || {}),
      Object.prototype.hasOwnProperty.call(patch, 'availableAt'),
      patch.availableAt || null,
      releaseLease,
      ['sent', 'delivered', 'read'].includes(status),
      patch.sentAt || null,
      ['delivered', 'read'].includes(status),
      patch.deliveredAt || null,
      status === 'read',
      patch.readAt || null,
      normalizeNullableString(patch.expectedLockedBy)
    ]
  );
  return normalizeDeliveryRow(result.rows[0]);
}

async function reconcileOperationalAlertDeliveryStatus({
  clinicId,
  channelId,
  providerMessageId,
  status,
  occurredAt = null,
  failureMetadata = null
}, client = null) {
  const safeStatus = normalizeString(status).toLowerCase();
  if (!['sent', 'delivered', 'read', 'failed'].includes(safeStatus)) return null;
  const result = await dbQuery(
    client,
    `UPDATE operational_alert_deliveries
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
     RETURNING ${DELIVERY_COLUMNS}`,
    [clinicId, channelId, providerMessageId, safeStatus, occurredAt, JSON.stringify(failureMetadata || {})]
  );
  return normalizeDeliveryRow(result.rows[0]);
}

async function listOperationalAlertDeliveries(clinicId, options = {}, client = null) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const params = [clinicId];
  const conditions = ['"clinicId" = $1::uuid'];
  for (const [key, column, cast] of [
    ['instanceId', '"instanceId"', '::uuid'],
    ['recipientId', '"recipientId"', '::uuid'],
    ['status', 'status', '']
  ]) {
    if (options[key]) {
      params.push(normalizeString(options[key]));
      conditions.push(`${column} = $${params.length}${cast}`);
    }
  }
  params.push(limit);
  const result = await dbQuery(
    client,
    `SELECT ${DELIVERY_COLUMNS}
     FROM operational_alert_deliveries
     WHERE ${conditions.join(' AND ')}
     ORDER BY "createdAt" DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeDeliveryRow);
}

module.exports = {
  DELIVERY_STATUSES: Array.from(DELIVERY_STATUSES),
  insertOperationalAlertDelivery,
  findOperationalAlertDeliveryById,
  listOperationalAlertDeliveries,
  recoverOperationalAlertDeliveryLeases,
  claimOperationalAlertDeliveries,
  materializeOperationalAlertMessageSnapshot,
  markOperationalAlertGraphRequestStarted,
  updateOperationalAlertDeliveryStatus,
  reconcileOperationalAlertDeliveryStatus
};
