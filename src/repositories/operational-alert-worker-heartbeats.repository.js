const { query } = require('../db/client');
const {
  normalizeString,
  normalizeDateTime,
  contractError
} = require('../operational-alerts/operational-alert-validation');

const MAX_WORKER_ID_LENGTH = 160;
const MAX_LAST_ERROR_LENGTH = 240;

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function hasOwn(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

function normalizeWorkerId(value) {
  const workerId = normalizeString(value);
  if (!workerId || workerId.length > MAX_WORKER_ID_LENGTH) {
    throw contractError('operational_alert_worker_heartbeat_worker_id_invalid');
  }
  return workerId;
}

function sanitizeLastError(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:access_?token|token|authorization|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[REDACTED]')
    .trim()
    .slice(0, MAX_LAST_ERROR_LENGTH) || null;
}

function normalizeOptionalDateTime(input, key) {
  if (!hasOwn(input, key)) return null;
  const value = normalizeDateTime(input[key]);
  if (!value) throw contractError(`operational_alert_worker_heartbeat_${key}_invalid`);
  return value;
}

function normalizeHeartbeatInput(input) {
  const workerId = normalizeWorkerId(input && input.workerId);
  const hasStartedAt = hasOwn(input, 'startedAt');
  const hasPollStartedAt = hasOwn(input, 'lastPollStartedAt');
  const hasPollCompletedAt = hasOwn(input, 'lastPollCompletedAt');
  const hasSuccessfulPollAt = hasOwn(input, 'lastSuccessfulPollAt');
  const hasLastError = hasOwn(input, 'lastError');

  return {
    workerId,
    startedAt: normalizeOptionalDateTime(input, 'startedAt'),
    lastPollStartedAt: normalizeOptionalDateTime(input, 'lastPollStartedAt'),
    lastPollCompletedAt: normalizeOptionalDateTime(input, 'lastPollCompletedAt'),
    lastSuccessfulPollAt: normalizeOptionalDateTime(input, 'lastSuccessfulPollAt'),
    lastError: hasLastError ? sanitizeLastError(input.lastError) : null,
    updatedAt: normalizeOptionalDateTime(input, 'updatedAt') || new Date().toISOString(),
    hasStartedAt,
    hasPollStartedAt,
    hasPollCompletedAt,
    hasSuccessfulPollAt,
    hasLastError
  };
}

function normalizeHeartbeatRow(row) {
  if (!row) return null;
  return {
    workerId: row.workerId,
    startedAt: row.startedAt,
    lastPollStartedAt: row.lastPollStartedAt || null,
    lastPollCompletedAt: row.lastPollCompletedAt || null,
    lastSuccessfulPollAt: row.lastSuccessfulPollAt || null,
    lastError: row.lastError || null,
    updatedAt: row.updatedAt
  };
}

async function upsertOperationalAlertWorkerHeartbeat(input, client = null) {
  const heartbeat = normalizeHeartbeatInput(input);
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_worker_heartbeats (
       "workerId",
       "startedAt",
       "lastPollStartedAt",
       "lastPollCompletedAt",
       "lastSuccessfulPollAt",
       "lastError",
       "updatedAt"
     )
     VALUES (
       $1,
       COALESCE($2::timestamptz, NOW()),
       $3::timestamptz,
       $4::timestamptz,
       $5::timestamptz,
       CASE WHEN $10::boolean THEN $6 ELSE NULL END,
       $7::timestamptz
     )
     ON CONFLICT ("workerId") DO UPDATE
     SET "startedAt" = CASE
           WHEN $8::boolean THEN EXCLUDED."startedAt"
           ELSE operational_alert_worker_heartbeats."startedAt"
         END,
         "lastPollStartedAt" = CASE
           WHEN $9::boolean THEN EXCLUDED."lastPollStartedAt"
           ELSE operational_alert_worker_heartbeats."lastPollStartedAt"
         END,
         "lastPollCompletedAt" = CASE
           WHEN $11::boolean THEN EXCLUDED."lastPollCompletedAt"
           ELSE operational_alert_worker_heartbeats."lastPollCompletedAt"
         END,
         "lastSuccessfulPollAt" = CASE
           WHEN $12::boolean THEN EXCLUDED."lastSuccessfulPollAt"
           ELSE operational_alert_worker_heartbeats."lastSuccessfulPollAt"
         END,
         "lastError" = CASE
           WHEN $10::boolean THEN EXCLUDED."lastError"
           ELSE operational_alert_worker_heartbeats."lastError"
         END,
         "updatedAt" = EXCLUDED."updatedAt"
     RETURNING
       "workerId",
       "startedAt",
       "lastPollStartedAt",
       "lastPollCompletedAt",
       "lastSuccessfulPollAt",
       "lastError",
       "updatedAt"`,
    [
      heartbeat.workerId,
      heartbeat.startedAt,
      heartbeat.lastPollStartedAt,
      heartbeat.lastPollCompletedAt,
      heartbeat.lastSuccessfulPollAt,
      heartbeat.lastError,
      heartbeat.updatedAt,
      heartbeat.hasStartedAt,
      heartbeat.hasPollStartedAt,
      heartbeat.hasLastError,
      heartbeat.hasPollCompletedAt,
      heartbeat.hasSuccessfulPollAt
    ]
  );
  return normalizeHeartbeatRow(result.rows[0] || null);
}

async function findOperationalAlertWorkerHeartbeat(workerId, client = null) {
  const safeWorkerId = normalizeWorkerId(workerId);
  const result = await dbQuery(
    client,
    `SELECT
       "workerId",
       "startedAt",
       "lastPollStartedAt",
       "lastPollCompletedAt",
       "lastSuccessfulPollAt",
       "lastError",
       "updatedAt"
     FROM operational_alert_worker_heartbeats
     WHERE "workerId" = $1
     LIMIT 1`,
    [safeWorkerId]
  );
  return normalizeHeartbeatRow(result.rows[0] || null);
}

async function findLatestOperationalAlertWorkerHeartbeat(client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       "workerId",
       "startedAt",
       "lastPollStartedAt",
       "lastPollCompletedAt",
       "lastSuccessfulPollAt",
       "lastError",
       "updatedAt"
     FROM operational_alert_worker_heartbeats
     ORDER BY "updatedAt" DESC, "workerId" ASC
     LIMIT 1`,
    []
  );
  return normalizeHeartbeatRow(result.rows[0] || null);
}

module.exports = {
  upsertOperationalAlertWorkerHeartbeat,
  findOperationalAlertWorkerHeartbeat,
  findLatestOperationalAlertWorkerHeartbeat,
  __private__: {
    MAX_WORKER_ID_LENGTH,
    MAX_LAST_ERROR_LENGTH,
    normalizeWorkerId,
    sanitizeLastError,
    normalizeHeartbeatInput,
    normalizeHeartbeatRow
  }
};
