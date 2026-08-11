const { isDeepStrictEqual } = require('util');
const { query } = require('../db/client');
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
    && existing.templateVersion === candidate.templateVersion
    && existing.formatterKey === candidate.formatterKey
    && existing.formatterVersion === candidate.formatterVersion
    && isDeepStrictEqual(existing.recipientSnapshot, candidate.recipientSnapshot)
    && isDeepStrictEqual(existing.messageSnapshot, candidate.messageSnapshot);
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
  insertOperationalAlertDelivery,
  findOperationalAlertDeliveryById,
  listOperationalAlertDeliveries
};
