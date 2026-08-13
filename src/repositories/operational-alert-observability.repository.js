const { query } = require('../db/client');
const {
  normalizeString,
  isUuid,
  contractError
} = require('../operational-alerts/operational-alert-validation');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function assertClinicId(clinicId) {
  const safeClinicId = normalizeString(clinicId);
  if (!isUuid(safeClinicId)) {
    throw contractError('operational_alert_observability_clinic_id_invalid');
  }
  return safeClinicId;
}

function toNonNegativeCount(value) {
  const count = Number(value || 0);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * Returns only the delivery states that can make a canary unsafe.  This is
 * deliberately a single tenant-scoped SELECT: it never claims, recovers, or
 * otherwise changes a delivery.
 */
async function getOperationalAlertDeliveryBacklog(clinicId, client = null) {
  const safeClinicId = assertClinicId(clinicId);
  const result = await dbQuery(
    client,
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'sending')::int AS processing,
       COUNT(*) FILTER (WHERE status = 'failed_retryable')::int AS retryable,
       COUNT(*) FILTER (WHERE status = 'unknown_delivery')::int AS "unknownDelivery"
     FROM operational_alert_deliveries
     WHERE "clinicId" = $1::uuid`,
    [safeClinicId]
  );
  const row = result.rows[0] || {};
  return {
    pending: toNonNegativeCount(row.pending),
    processing: toNonNegativeCount(row.processing),
    retryable: toNonNegativeCount(row.retryable),
    unknownDelivery: toNonNegativeCount(row.unknownDelivery)
  };
}

/**
 * Counts active, non-archived rules for a tenant without returning rule data.
 * A canary requires this to be exactly one so a poll cannot send an unrelated
 * operational alert for the same tenant.
 */
async function countEnabledOperationalAlertRules(clinicId, client = null) {
  const safeClinicId = assertClinicId(clinicId);
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::int AS "enabledRuleCount"
     FROM operational_alert_rules
     WHERE "clinicId" = $1::uuid
       AND enabled = TRUE
       AND "archivedAt" IS NULL`,
    [safeClinicId]
  );
  return toNonNegativeCount(result.rows[0] && result.rows[0].enabledRuleCount);
}

module.exports = {
  getOperationalAlertDeliveryBacklog,
  countEnabledOperationalAlertRules,
  __private__: {
    assertClinicId,
    toNonNegativeCount
  }
};
