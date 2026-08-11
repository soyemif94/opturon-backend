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

const INSTANCE_COLUMNS = `
  id,
  "clinicId",
  "ruleId",
  "eventId",
  "ruleVersion",
  "occurrenceKey",
  "evaluationWindowKey",
  "snapshotVersion",
  snapshot,
  status,
  "expiresAt",
  "createdAt",
  "updatedAt",
  "completedAt"`;

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeInstanceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    ruleId: row.ruleId,
    eventId: row.eventId,
    ruleVersion: Number(row.ruleVersion),
    occurrenceKey: row.occurrenceKey,
    evaluationWindowKey: row.evaluationWindowKey || null,
    snapshotVersion: Number(row.snapshotVersion),
    snapshot: row.snapshot || {},
    status: row.status,
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt || null
  };
}

function normalizeInstanceInsert(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError('operational_alert_instance_not_object');
  }
  if (input.status !== undefined && input.status !== 'pending') {
    throw contractError('operational_alert_instance_initial_status_forbidden');
  }

  const clinicId = normalizeString(input.clinicId);
  const ruleId = normalizeString(input.ruleId);
  const eventId = normalizeString(input.eventId);
  if (!isUuid(clinicId)) throw contractError('operational_alert_instance_clinic_id_invalid');
  if (!isUuid(ruleId)) throw contractError('operational_alert_instance_rule_id_invalid');
  if (!isUuid(eventId)) throw contractError('operational_alert_instance_event_id_invalid');
  if (!isPositiveInteger(input.ruleVersion)) {
    throw contractError('operational_alert_instance_rule_version_invalid');
  }

  const occurrenceKey = normalizeString(input.occurrenceKey);
  if (!occurrenceKey || occurrenceKey.length > 500) {
    throw contractError('operational_alert_instance_occurrence_key_invalid');
  }
  const evaluationWindowKey = normalizeNullableString(input.evaluationWindowKey);
  if (evaluationWindowKey && evaluationWindowKey.length > 300) {
    throw contractError('operational_alert_instance_evaluation_window_key_invalid');
  }

  const snapshotVersion = input.snapshotVersion === undefined ? 1 : input.snapshotVersion;
  if (!isPositiveInteger(snapshotVersion)) {
    throw contractError('operational_alert_instance_snapshot_version_invalid');
  }
  const snapshot = cloneJsonObject(input.snapshot);
  if (!snapshot) throw contractError('operational_alert_instance_snapshot_invalid');

  const expiresAt = normalizeDateTime(input.expiresAt);
  if (input.expiresAt && !expiresAt) throw contractError('operational_alert_instance_expires_at_invalid');
  return {
    clinicId,
    ruleId,
    eventId,
    ruleVersion: input.ruleVersion,
    occurrenceKey,
    evaluationWindowKey,
    snapshotVersion,
    snapshot,
    expiresAt
  };
}

function sameInstanceIdentity(existing, candidate) {
  return existing.clinicId === candidate.clinicId
    && existing.ruleId === candidate.ruleId
    && existing.eventId === candidate.eventId
    && existing.ruleVersion === candidate.ruleVersion
    && existing.occurrenceKey === candidate.occurrenceKey
    && existing.evaluationWindowKey === candidate.evaluationWindowKey
    && existing.snapshotVersion === candidate.snapshotVersion
    && normalizeDateTime(existing.expiresAt) === candidate.expiresAt
    && isDeepStrictEqual(existing.snapshot, candidate.snapshot);
}

async function insertOperationalAlertInstance(input, client = null) {
  const instance = normalizeInstanceInsert(input);
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_instances (
       "clinicId",
       "ruleId",
       "eventId",
       "ruleVersion",
       "occurrenceKey",
       "evaluationWindowKey",
       "snapshotVersion",
       snapshot,
       status,
       "expiresAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4,
       $5,
       $6,
       $7,
       $8::jsonb,
       'pending',
       $9::timestamptz,
       NOW()
     )
     ON CONFLICT ("clinicId", "ruleId", "occurrenceKey") DO NOTHING
     RETURNING ${INSTANCE_COLUMNS}`,
    [
      instance.clinicId,
      instance.ruleId,
      instance.eventId,
      instance.ruleVersion,
      instance.occurrenceKey,
      instance.evaluationWindowKey,
      instance.snapshotVersion,
      JSON.stringify(instance.snapshot),
      instance.expiresAt
    ]
  );
  if (result.rows[0]) return { instance: normalizeInstanceRow(result.rows[0]), inserted: true };

  const existingResult = await dbQuery(
    client,
    `SELECT ${INSTANCE_COLUMNS}
     FROM operational_alert_instances
     WHERE "clinicId" = $1::uuid
       AND "ruleId" = $2::uuid
       AND "occurrenceKey" = $3
     LIMIT 1`,
    [instance.clinicId, instance.ruleId, instance.occurrenceKey]
  );
  const existing = normalizeInstanceRow(existingResult.rows[0]);
  if (!existing || !sameInstanceIdentity(existing, instance)) {
    throw contractError('operational_alert_instance_idempotency_conflict');
  }
  return { instance: existing, inserted: false };
}

async function findOperationalAlertInstanceById(instanceId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${INSTANCE_COLUMNS}
     FROM operational_alert_instances
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [instanceId, clinicId]
  );
  return normalizeInstanceRow(result.rows[0]);
}

async function listOperationalAlertInstances(clinicId, options = {}, client = null) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const params = [clinicId];
  const conditions = ['"clinicId" = $1::uuid'];
  for (const [key, column, cast] of [
    ['ruleId', '"ruleId"', '::uuid'],
    ['eventId', '"eventId"', '::uuid'],
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
    `SELECT ${INSTANCE_COLUMNS}
     FROM operational_alert_instances
     WHERE ${conditions.join(' AND ')}
     ORDER BY "createdAt" DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeInstanceRow);
}

module.exports = {
  insertOperationalAlertInstance,
  findOperationalAlertInstanceById,
  listOperationalAlertInstances
};
