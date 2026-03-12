const { query, withTransaction } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function listWhatsAppTemplatesByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1
     ORDER BY "templateKey" ASC, language ASC, "createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function findWhatsAppTemplateByClinicAndKey(clinicId, templateKey, language, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1
       AND "templateKey" = $2
       AND language = $3
     LIMIT 1`,
    [clinicId, templateKey, language]
  );

  return result.rows[0] || null;
}

async function findWhatsAppTemplateByClinicAndMetaName(clinicId, metaTemplateName, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1
       AND "metaTemplateName" = $2
     LIMIT 1`,
    [clinicId, metaTemplateName]
  );

  return result.rows[0] || null;
}

async function upsertWhatsAppTemplate(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO whatsapp_templates (
      "clinicId",
      "externalTenantId",
      "channelId",
      "wabaId",
      "templateKey",
      "metaTemplateId",
      "metaTemplateName",
      language,
      category,
      status,
      "rejectionReason",
      definition,
      "lastSyncedAt",
      metadata,
      "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
    ON CONFLICT ("clinicId", "templateKey", language)
    DO UPDATE SET
      "externalTenantId" = EXCLUDED."externalTenantId",
      "channelId" = COALESCE(EXCLUDED."channelId", whatsapp_templates."channelId"),
      "wabaId" = EXCLUDED."wabaId",
      "metaTemplateId" = COALESCE(EXCLUDED."metaTemplateId", whatsapp_templates."metaTemplateId"),
      "metaTemplateName" = EXCLUDED."metaTemplateName",
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      "rejectionReason" = EXCLUDED."rejectionReason",
      definition = EXCLUDED.definition,
      "lastSyncedAt" = COALESCE(EXCLUDED."lastSyncedAt", whatsapp_templates."lastSyncedAt"),
      metadata = COALESCE(EXCLUDED.metadata, whatsapp_templates.metadata),
      "updatedAt" = NOW()
    RETURNING id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
              language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"`,
    [
      input.clinicId,
      input.externalTenantId,
      input.channelId || null,
      input.wabaId,
      input.templateKey,
      input.metaTemplateId || null,
      input.metaTemplateName,
      input.language,
      input.category,
      input.status,
      input.rejectionReason || null,
      input.definition,
      input.lastSyncedAt || null,
      input.metadata || null
    ]
  );

  return result.rows[0] || null;
}

async function withWhatsAppTemplatesTransaction(fn) {
  return withTransaction(fn);
}

module.exports = {
  listWhatsAppTemplatesByClinicId,
  findWhatsAppTemplateByClinicAndKey,
  findWhatsAppTemplateByClinicAndMetaName,
  upsertWhatsAppTemplate,
  withWhatsAppTemplatesTransaction
};
