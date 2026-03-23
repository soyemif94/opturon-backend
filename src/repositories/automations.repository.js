const { query } = require('../db/client');

const AUTOMATION_SELECT = `id, "clinicId", "externalTenantId", name, trigger, conditions, actions, enabled, "createdAt", "updatedAt"`;

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeAutomation(row) {
  const conditions = row.conditions && typeof row.conditions === 'object' ? row.conditions : {};
  return {
    id: row.id,
    clinicId: row.clinicId,
    externalTenantId: row.externalTenantId || null,
    name: row.name,
    trigger: row.trigger || {},
    description: typeof conditions.description === 'string' ? conditions.description : null,
    conditions,
    actions: Array.isArray(row.actions) ? row.actions : [],
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listAutomationsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${AUTOMATION_SELECT}
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

async function updateAutomationById(clinicId, automationId, patch, client = null) {
  const updates = [];
  const params = [clinicId, automationId];

  if (Object.prototype.hasOwnProperty.call(patch || {}, 'enabled')) {
    params.push(Boolean(patch.enabled));
    updates.push(`enabled = $${params.length}`);
  }

  if (!updates.length) {
    return null;
  }

  const result = await dbQuery(
    client,
    `UPDATE automations
     SET ${updates.join(', ')},
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING ${AUTOMATION_SELECT}`,
    params
  );

  return result.rows[0] ? normalizeAutomation(result.rows[0]) : null;
}

async function deleteAutomationById(clinicId, automationId, client = null) {
  const result = await dbQuery(
    client,
    `DELETE FROM automations
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING ${AUTOMATION_SELECT}`,
    [clinicId, automationId]
  );

  return result.rows[0] ? normalizeAutomation(result.rows[0]) : null;
}

module.exports = {
  listAutomationsByClinicId,
  createAutomation,
  updateAutomationById,
  deleteAutomationById
};
