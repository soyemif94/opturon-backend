const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    externalTenantId: row.externalTenantId || null,
    templateKey: row.templateKey,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId || null,
    suggestedValue: row.suggestedValue && typeof row.suggestedValue === 'object' && !Array.isArray(row.suggestedValue) ? row.suggestedValue : {},
    appliedValue: row.appliedValue && typeof row.appliedValue === 'object' && !Array.isArray(row.appliedValue) ? row.appliedValue : {},
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: row.createdAt || null
  };
}

async function insertAutomationActionEvent(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO automation_action_events (
       "clinicId",
       "externalTenantId",
       "templateKey",
       action,
       "entityType",
       "entityId",
       "suggestedValue",
       "appliedValue",
       metadata
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING id, "clinicId", "externalTenantId", "templateKey", action, "entityType", "entityId", "suggestedValue", "appliedValue", metadata, "createdAt"`,
    [
      input.clinicId,
      input.externalTenantId || null,
      input.templateKey,
      input.action,
      input.entityType,
      input.entityId || null,
      JSON.stringify(input.suggestedValue || {}),
      JSON.stringify(input.appliedValue || {}),
      JSON.stringify(input.metadata || {})
    ]
  );

  return normalizeEvent(result.rows[0] || null);
}

async function listAutomationActionEventsByClinicAndTemplate(clinicId, templateKey, options = {}, client = null) {
  const safeLimit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "templateKey", action, "entityType", "entityId", "suggestedValue", "appliedValue", metadata, "createdAt"
     FROM automation_action_events
     WHERE "clinicId" = $1::uuid
       AND "templateKey" = $2
     ORDER BY "createdAt" DESC
     LIMIT $3`,
    [clinicId, templateKey, safeLimit]
  );

  return result.rows.map(normalizeEvent);
}

async function getAutomationActionEventSummaryByClinicAndTemplate(clinicId, templateKey, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       COUNT(*)::int AS "totalEvents",
       COUNT(*) FILTER (WHERE action = 'suggestion_applied')::int AS "appliedSuggestions"
     FROM automation_action_events
     WHERE "clinicId" = $1::uuid
       AND "templateKey" = $2`,
    [clinicId, templateKey]
  );

  const row = result.rows[0] || {};
  return {
    totalEvents: Number(row.totalEvents || 0),
    appliedSuggestions: Number(row.appliedSuggestions || 0)
  };
}

module.exports = {
  insertAutomationActionEvent,
  listAutomationActionEventsByClinicAndTemplate,
  getAutomationActionEventSummaryByClinicAndTemplate
};
