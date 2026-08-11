const { isDeepStrictEqual } = require('util');
const { query } = require('../db/client');
const { assertOperationalAlertEvent } = require('../operational-alerts/operational-alert-contracts');
const { assertRegisteredOperationalAlertEvent } = require('../operational-alerts/operational-alert-registry');
const {
  normalizeString,
  normalizeNullableString,
  normalizeDateTime,
  isUuid,
  contractError
} = require('../operational-alerts/operational-alert-validation');

const EVENT_COLUMNS = `
  id,
  "clinicId",
  "eventType",
  "eventVersion",
  "entityType",
  "entityId",
  "occurredAt",
  payload,
  "deduplicationKey",
  "targetRuleId",
  source,
  status,
  "attemptCount",
  "availableAt",
  "lockedAt",
  "lockedBy",
  "leaseExpiresAt",
  "lastError",
  "errorMetadata",
  "createdAt",
  "updatedAt",
  "processedAt"`;

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    eventType: row.eventType,
    eventVersion: Number(row.eventVersion),
    entityType: row.entityType,
    entityId: row.entityId,
    occurredAt: row.occurredAt,
    payload: row.payload || {},
    deduplicationKey: row.deduplicationKey,
    targetRuleId: row.targetRuleId || null,
    source: row.source,
    status: row.status,
    attemptCount: Number(row.attemptCount || 0),
    availableAt: row.availableAt,
    lockedAt: row.lockedAt || null,
    lockedBy: row.lockedBy || null,
    leaseExpiresAt: row.leaseExpiresAt || null,
    lastError: row.lastError || null,
    errorMetadata: row.errorMetadata || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    processedAt: row.processedAt || null
  };
}

function normalizeEventInsert(input) {
  if (input && input.status !== undefined && input.status !== 'pending') {
    throw contractError('operational_alert_event_initial_status_forbidden');
  }
  const event = assertOperationalAlertEvent(input);
  assertRegisteredOperationalAlertEvent(event.eventType, event.eventVersion);

  const targetRuleId = normalizeNullableString(input && input.targetRuleId);
  if (targetRuleId && !isUuid(targetRuleId)) {
    throw contractError('operational_alert_event_target_rule_id_invalid');
  }
  const source = normalizeString((input && input.source) || 'system');
  if (!source || source.length > 120) throw contractError('operational_alert_event_source_invalid');

  const availableAt = normalizeDateTime(input && input.availableAt) || new Date().toISOString();
  if (input && input.availableAt && !normalizeDateTime(input.availableAt)) {
    throw contractError('operational_alert_event_available_at_invalid');
  }
  return { ...event, targetRuleId, source, availableAt };
}

function sameEventIdentity(existing, candidate) {
  return existing.clinicId === candidate.clinicId
    && existing.eventType === candidate.eventType
    && existing.eventVersion === candidate.eventVersion
    && existing.entityType === candidate.entityType
    && existing.entityId === candidate.entityId
    && normalizeDateTime(existing.occurredAt) === candidate.occurredAt
    && existing.deduplicationKey === candidate.deduplicationKey
    && existing.targetRuleId === candidate.targetRuleId
    && existing.source === candidate.source
    && isDeepStrictEqual(existing.payload, candidate.payload);
}

async function insertOperationalAlertEvent(input, client = null) {
  const event = normalizeEventInsert(input);
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_events (
       "clinicId",
       "eventType",
       "eventVersion",
       "entityType",
       "entityId",
       "occurredAt",
       payload,
       "deduplicationKey",
       "targetRuleId",
       source,
       status,
       "attemptCount",
       "availableAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5,
       $6::timestamptz,
       $7::jsonb,
       $8,
       $9::uuid,
       $10,
       'pending',
       0,
       $11::timestamptz,
       NOW()
     )
     ON CONFLICT ("clinicId", "eventType", "eventVersion", "deduplicationKey") DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    [
      event.clinicId,
      event.eventType,
      event.eventVersion,
      event.entityType,
      event.entityId,
      event.occurredAt,
      JSON.stringify(event.payload),
      event.deduplicationKey,
      event.targetRuleId,
      event.source,
      event.availableAt
    ]
  );
  if (result.rows[0]) return { event: normalizeEventRow(result.rows[0]), inserted: true };

  const existingResult = await dbQuery(
    client,
    `SELECT ${EVENT_COLUMNS}
     FROM operational_alert_events
     WHERE "clinicId" = $1::uuid
       AND "eventType" = $2
       AND "eventVersion" = $3
       AND "deduplicationKey" = $4
     LIMIT 1`,
    [event.clinicId, event.eventType, event.eventVersion, event.deduplicationKey]
  );
  const existing = normalizeEventRow(existingResult.rows[0]);
  if (!existing || !sameEventIdentity(existing, event)) {
    throw contractError('operational_alert_event_idempotency_conflict');
  }
  return { event: existing, inserted: false };
}

async function findOperationalAlertEventById(eventId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${EVENT_COLUMNS}
     FROM operational_alert_events
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [eventId, clinicId]
  );
  return normalizeEventRow(result.rows[0]);
}

async function listOperationalAlertEvents(clinicId, options = {}, client = null) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const params = [clinicId];
  const conditions = ['"clinicId" = $1::uuid'];
  for (const [key, column] of [
    ['eventType', '"eventType"'],
    ['entityType', '"entityType"'],
    ['entityId', '"entityId"'],
    ['status', 'status']
  ]) {
    if (options[key]) {
      params.push(normalizeString(options[key]));
      conditions.push(`${column} = $${params.length}`);
    }
  }
  params.push(limit);
  const result = await dbQuery(
    client,
    `SELECT ${EVENT_COLUMNS}
     FROM operational_alert_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY "occurredAt" DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeEventRow);
}

module.exports = {
  insertOperationalAlertEvent,
  findOperationalAlertEventById,
  listOperationalAlertEvents
};
