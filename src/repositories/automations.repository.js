const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeAutomation(row) {
  return {
    id: row.id,
    clinicId: row.clinicId,
    externalTenantId: row.externalTenantId || null,
    name: row.name,
    trigger: row.trigger || {},
    conditions: row.conditions || {},
    actions: Array.isArray(row.actions) ? row.actions : [],
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listAutomationsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", name, trigger, conditions, actions, enabled, "createdAt", "updatedAt"
     FROM automations
     WHERE "clinicId" = $1::uuid
     ORDER BY "createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeAutomation);
}

async function createAutomation(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO automations (
       "clinicId",
       "externalTenantId",
       name,
       trigger,
       conditions,
       actions,
       enabled,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, NOW())
     RETURNING id, "clinicId", "externalTenantId", name, trigger, conditions, actions, enabled, "createdAt", "updatedAt"`,
    [
      input.clinicId,
      input.externalTenantId || null,
      input.name,
      JSON.stringify(input.trigger || {}),
      JSON.stringify(input.conditions || {}),
      JSON.stringify(input.actions || []),
      input.enabled !== false
    ]
  );

  return result.rows[0] ? normalizeAutomation(result.rows[0]) : null;
}

module.exports = {
  listAutomationsByClinicId,
  createAutomation
};
