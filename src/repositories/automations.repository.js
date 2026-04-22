const { query } = require('../db/client');

const AUTOMATION_SELECT = `id, "clinicId", "externalTenantId", name, trigger, conditions, actions, enabled, "createdAt", "updatedAt"`;

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
    conditions: row.conditions && typeof row.conditions === 'object' ? row.conditions : {},
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

async function countAutomationsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::int AS count
     FROM automations
     WHERE "clinicId" = $1::uuid`,
    [clinicId]
  );

  return Number(result.rows[0] && result.rows[0].count ? result.rows[0].count : 0);
}

async function findAutomationByClinicIdAndName(clinicId, name, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${AUTOMATION_SELECT}
     FROM automations
     WHERE "clinicId" = $1::uuid
       AND LOWER(name) = LOWER($2)
     LIMIT 1`,
    [clinicId, name]
  );

  return result.rows[0] ? normalizeAutomation(result.rows[0]) : null;
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
     RETURNING ${AUTOMATION_SELECT}`,
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

async function updateAutomation(id, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE automations
     SET
       "externalTenantId" = $2,
       name = $3,
       trigger = $4::jsonb,
       conditions = $5::jsonb,
       actions = $6::jsonb,
       enabled = $7,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
     RETURNING ${AUTOMATION_SELECT}`,
    [
      id,
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
  countAutomationsByClinicId,
  findAutomationByClinicIdAndName,
  createAutomation,
  updateAutomation,
  updateAutomationById,
  deleteAutomationById
};
