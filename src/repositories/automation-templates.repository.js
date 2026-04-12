const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeTemplate(row) {
  return {
    key: row.key,
    name: row.name,
    description: row.description || null,
    category: row.category,
    businessTypes: Array.isArray(row.businessTypes) ? row.businessTypes.filter(Boolean) : [],
    requiredCapabilities: Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities.filter(Boolean) : [],
    defaultEnabled: Boolean(row.defaultEnabled),
    status: row.status || 'active',
    configSchema: row.configSchema && typeof row.configSchema === 'object' && !Array.isArray(row.configSchema) ? row.configSchema : {},
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeTenantTemplate(row) {
  return {
    id: row.id,
    clinicId: row.clinicId,
    externalTenantId: row.externalTenantId || null,
    templateKey: row.templateKey,
    enabled: Boolean(row.enabled),
    config: row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {},
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listAutomationTemplates(client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       key,
       name,
       description,
       category,
       "businessTypes",
       "requiredCapabilities",
       "defaultEnabled",
       status,
       "configSchema",
       metadata,
       "createdAt",
       "updatedAt"
     FROM automation_templates
     ORDER BY category ASC, name ASC`,
    []
  );

  return result.rows.map(normalizeTemplate);
}

async function findAutomationTemplateByKey(templateKey, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       key,
       name,
       description,
       category,
       "businessTypes",
       "requiredCapabilities",
       "defaultEnabled",
       status,
       "configSchema",
       metadata,
       "createdAt",
       "updatedAt"
     FROM automation_templates
     WHERE key = $1
     LIMIT 1`,
    [templateKey]
  );

  return result.rows[0] ? normalizeTemplate(result.rows[0]) : null;
}

async function listTenantAutomationTemplatesByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "externalTenantId",
       "templateKey",
       enabled,
       config,
       metadata,
       "createdAt",
       "updatedAt"
     FROM tenant_automation_templates
     WHERE "clinicId" = $1::uuid
     ORDER BY "createdAt" ASC`,
    [clinicId]
  );

  return result.rows.map(normalizeTenantTemplate);
}

async function findTenantAutomationTemplateByClinicIdAndKey(clinicId, templateKey, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "externalTenantId",
       "templateKey",
       enabled,
       config,
       metadata,
       "createdAt",
       "updatedAt"
     FROM tenant_automation_templates
     WHERE "clinicId" = $1::uuid
       AND "templateKey" = $2
     LIMIT 1`,
    [clinicId, templateKey]
  );

  return result.rows[0] ? normalizeTenantTemplate(result.rows[0]) : null;
}

async function upsertTenantAutomationTemplate(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO tenant_automation_templates (
       "clinicId",
       "externalTenantId",
       "templateKey",
       enabled,
       config,
       metadata,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
     ON CONFLICT ("clinicId", "templateKey")
     DO UPDATE SET
       "externalTenantId" = EXCLUDED."externalTenantId",
       enabled = EXCLUDED.enabled,
       config = EXCLUDED.config,
       metadata = EXCLUDED.metadata,
       "updatedAt" = NOW()
     RETURNING
       id,
       "clinicId",
       "externalTenantId",
       "templateKey",
       enabled,
       config,
       metadata,
       "createdAt",
       "updatedAt"`,
    [
      input.clinicId,
      input.externalTenantId || null,
      input.templateKey,
      input.enabled === true,
      JSON.stringify(input.config || {}),
      JSON.stringify(input.metadata || {})
    ]
  );

  return result.rows[0] ? normalizeTenantTemplate(result.rows[0]) : null;
}

module.exports = {
  listAutomationTemplates,
  findAutomationTemplateByKey,
  listTenantAutomationTemplatesByClinicId,
  findTenantAutomationTemplateByClinicIdAndKey,
  upsertTenantAutomationTemplate
};
