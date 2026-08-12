const { query } = require('../db/client');
const { normalizeString } = require('../operational-alerts/operational-alert-validation');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function buildHistoryScope(clinicId, filters = {}) {
  const params = [clinicId];
  const conditions = ['i."clinicId" = $1::uuid'];

  if (filters.eventType) {
    params.push(normalizeString(filters.eventType));
    conditions.push(`e."eventType" = $${params.length}`);
  }
  if (filters.ruleId) {
    params.push(normalizeString(filters.ruleId));
    conditions.push(`i."ruleId" = $${params.length}::uuid`);
  }
  if (filters.status) {
    params.push(normalizeString(filters.status));
    conditions.push(`i.status = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`e."occurredAt" >= $${params.length}::timestamptz`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`e."occurredAt" <= $${params.length}::timestamptz`);
  }
  if (filters.recipientId) {
    params.push(normalizeString(filters.recipientId));
    conditions.push(`EXISTS (
      SELECT 1
      FROM operational_alert_deliveries recipient_delivery
      WHERE recipient_delivery."clinicId" = i."clinicId"
        AND recipient_delivery."instanceId" = i.id
        AND recipient_delivery."recipientId" = $${params.length}::uuid
    )`);
  }

  return { params, conditions };
}

function normalizeHistoryRow(row) {
  return {
    instanceId: row.instanceId,
    ruleId: row.ruleId,
    ruleName: row.ruleName || null,
    ruleVersion: Number(row.ruleVersion),
    eventId: row.eventId,
    eventType: row.eventType,
    eventVersion: Number(row.eventVersion),
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt || null,
    status: row.status,
    deliverySummary: {
      total: Number(row.deliveryTotal || 0),
      sent: Number(row.deliverySent || 0),
      delivered: Number(row.deliveryDelivered || 0),
      read: Number(row.deliveryRead || 0),
      failed: Number(row.deliveryFailed || 0),
      skipped: Number(row.deliverySkipped || 0),
      unknown: Number(row.deliveryUnknown || 0)
    }
  };
}

async function listOperationalAlertHistory(clinicId, filters = {}, client = null) {
  const page = Math.max(1, Number.parseInt(String(filters.page || 1), 10) || 1);
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(String(filters.pageSize || 25), 10) || 25));
  const scope = buildHistoryScope(clinicId, filters);
  const countResult = await dbQuery(
    client,
    `SELECT COUNT(*)::int AS total
     FROM operational_alert_instances i
     INNER JOIN operational_alert_events e
       ON e.id = i."eventId" AND e."clinicId" = i."clinicId"
     WHERE ${scope.conditions.join(' AND ')}`,
    scope.params
  );

  const rowParams = [...scope.params, pageSize, (page - 1) * pageSize];
  const limitIndex = scope.params.length + 1;
  const offsetIndex = scope.params.length + 2;
  const result = await dbQuery(
    client,
    `SELECT i.id AS "instanceId",
            i."ruleId",
            r.name AS "ruleName",
            i."ruleVersion",
            i."eventId",
            e."eventType",
            e."eventVersion",
            e."occurredAt",
            i."createdAt",
            i."completedAt",
            i.status,
            COUNT(d.id)::int AS "deliveryTotal",
            COUNT(d.id) FILTER (WHERE d.status = 'sent')::int AS "deliverySent",
            COUNT(d.id) FILTER (WHERE d.status = 'delivered')::int AS "deliveryDelivered",
            COUNT(d.id) FILTER (WHERE d.status = 'read')::int AS "deliveryRead",
            COUNT(d.id) FILTER (WHERE d.status IN ('failed_retryable', 'failed_permanent'))::int AS "deliveryFailed",
            COUNT(d.id) FILTER (WHERE d.status = 'skipped')::int AS "deliverySkipped",
            COUNT(d.id) FILTER (WHERE d.status IN ('pending', 'sending', 'unknown_delivery'))::int AS "deliveryUnknown"
     FROM operational_alert_instances i
     INNER JOIN operational_alert_rules r
       ON r.id = i."ruleId" AND r."clinicId" = i."clinicId"
     INNER JOIN operational_alert_events e
       ON e.id = i."eventId" AND e."clinicId" = i."clinicId"
     LEFT JOIN operational_alert_deliveries d
       ON d."instanceId" = i.id AND d."clinicId" = i."clinicId"
     WHERE ${scope.conditions.join(' AND ')}
     GROUP BY i.id, r.name, e.id
     ORDER BY e."occurredAt" DESC, i."createdAt" DESC, i.id DESC
     LIMIT $${limitIndex}::int
     OFFSET $${offsetIndex}::int`,
    rowParams
  );

  return {
    items: result.rows.map(normalizeHistoryRow),
    pagination: {
      page,
      pageSize,
      total: Number(countResult.rows[0] && countResult.rows[0].total || 0)
    }
  };
}

async function findOperationalAlertHistoryDetail(instanceId, clinicId, client = null) {
  const instanceResult = await dbQuery(
    client,
    `SELECT i.id AS "instanceId",
            i."clinicId",
            i."ruleId",
            r.name AS "ruleName",
            i."ruleVersion",
            i."eventId",
            e."eventType",
            e."eventVersion",
            e."entityType",
            e."entityId",
            e."occurredAt",
            i."occurrenceKey",
            i."evaluationWindowKey",
            i."snapshotVersion",
            i.snapshot,
            i.status,
            i."expiresAt",
            i."createdAt",
            i."updatedAt",
            i."completedAt"
     FROM operational_alert_instances i
     INNER JOIN operational_alert_rules r
       ON r.id = i."ruleId" AND r."clinicId" = i."clinicId"
     INNER JOIN operational_alert_events e
       ON e.id = i."eventId" AND e."clinicId" = i."clinicId"
     WHERE i.id = $1::uuid
       AND i."clinicId" = $2::uuid
     LIMIT 1`,
    [instanceId, clinicId]
  );
  const instance = instanceResult.rows[0] || null;
  if (!instance) return null;

  const deliveriesResult = await dbQuery(
    client,
    `SELECT id,
            "recipientId",
            "recipientVersion",
            "channelId",
            status,
            "recipientSnapshot",
            "templateKey",
            "templateLanguage",
            "templateVersion",
            "formatterKey",
            "formatterVersion",
            "attemptCount",
            "resultCode",
            "lastError",
            "sentAt",
            "deliveredAt",
            "readAt",
            "createdAt",
            "updatedAt"
     FROM operational_alert_deliveries
     WHERE "instanceId" = $1::uuid
       AND "clinicId" = $2::uuid
     ORDER BY "createdAt" ASC, id ASC`,
    [instanceId, clinicId]
  );

  return {
    instance,
    deliveries: deliveriesResult.rows
  };
}

module.exports = {
  listOperationalAlertHistory,
  findOperationalAlertHistoryDetail
};
