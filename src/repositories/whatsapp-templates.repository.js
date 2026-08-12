const { query, withTransaction } = require('../db/client');
const {
  normalizeWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateStatus,
  normalizeWhatsAppTemplateLanguage
} = require('../whatsapp/whatsapp-template-domain');

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

function hasExactTemplateScope(scope) {
  return Boolean(
    scope
    && String(scope.clinicId || '').trim()
    && String(scope.channelId || '').trim()
    && String(scope.wabaId || '').trim()
    && String(scope.templateKey || '').trim()
    && normalizeWhatsAppTemplateLanguage(scope.language)
  );
}

async function findWhatsAppTemplateByScope(scope, client = null) {
  if (!hasExactTemplateScope(scope)) return null;
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1
       AND "channelId" = $2
       AND "wabaId" = $3
       AND "templateKey" = $4
       AND language = $5
     LIMIT 1`,
    [scope.clinicId, scope.channelId, scope.wabaId, scope.templateKey, scope.language]
  );

  return result.rows[0] || null;
}

async function findApprovedUtilityOrderSummaryTemplate({
  clinicId,
  channelId,
  wabaId,
  language
}, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1::uuid
       AND "channelId" = $2::uuid
       AND "wabaId" = $3
       AND "templateKey" = 'order_summary'
       AND language = $4
       AND UPPER(category) = 'UTILITY'
       AND LOWER(status) = 'approved'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [clinicId, channelId, wabaId, language]
  );

  return result.rows[0] || null;
}

async function findWhatsAppTemplateByProviderIdentity(scope, client = null) {
  if (!scope || !String(scope.metaTemplateName || '').trim() || !hasExactTemplateScope({
    ...scope,
    templateKey: scope.metaTemplateName
  })) {
    return null;
  }
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
            language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"
     FROM whatsapp_templates
     WHERE "clinicId" = $1
       AND "channelId" = $2
       AND "wabaId" = $3
       AND "metaTemplateName" = $4
       AND language = $5
     LIMIT 1`,
    [scope.clinicId, scope.channelId, scope.wabaId, scope.metaTemplateName, scope.language]
  );

  return result.rows[0] || null;
}

async function upsertWhatsAppTemplate(input, client = null) {
  if (!hasExactTemplateScope(input)) {
    throw new Error('whatsapp_template_exact_scope_required');
  }
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
    ON CONFLICT ("clinicId", "channelId", "wabaId", "templateKey", language)
    DO UPDATE SET
      "externalTenantId" = EXCLUDED."externalTenantId",
      "metaTemplateId" = COALESCE(EXCLUDED."metaTemplateId", whatsapp_templates."metaTemplateId"),
      "metaTemplateName" = EXCLUDED."metaTemplateName",
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      "rejectionReason" = EXCLUDED."rejectionReason",
      definition = EXCLUDED.definition,
      "lastSyncedAt" = COALESCE(EXCLUDED."lastSyncedAt", whatsapp_templates."lastSyncedAt"),
      metadata = COALESCE(whatsapp_templates.metadata, '{}'::jsonb)
        || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
      "updatedAt" = NOW()
    RETURNING id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
              language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"`,
    [
      input.clinicId,
      input.externalTenantId,
      input.channelId,
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

async function upsertSyncedWhatsAppTemplate(input, client = null) {
  if (!hasExactTemplateScope(input) || !String(input.metaTemplateName || '').trim()) {
    throw new Error('whatsapp_template_exact_scope_required');
  }
  if (
    !input.providerDefinition
    || typeof input.providerDefinition !== 'object'
    || Array.isArray(input.providerDefinition)
    || !Array.isArray(input.providerDefinition.components)
  ) {
    throw new Error('whatsapp_template_provider_components_required');
  }

  const language = normalizeWhatsAppTemplateLanguage(input.language);
  const category = normalizeWhatsAppTemplateCategory(input.category);
  const status = normalizeWhatsAppTemplateStatus(input.status);
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
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      COALESCE($12::jsonb, '{}'::jsonb)
        || jsonb_build_object('provider', COALESCE($13::jsonb, '{}'::jsonb)),
      $14,
      COALESCE($15::jsonb, '{}'::jsonb)
        || jsonb_build_object('providerSync', COALESCE($16::jsonb, '{}'::jsonb)),
      NOW()
    )
    ON CONFLICT ("clinicId", "channelId", "wabaId", "templateKey", language)
    DO UPDATE SET
      "externalTenantId" = EXCLUDED."externalTenantId",
      "metaTemplateId" = COALESCE(EXCLUDED."metaTemplateId", whatsapp_templates."metaTemplateId"),
      "metaTemplateName" = EXCLUDED."metaTemplateName",
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      "rejectionReason" = EXCLUDED."rejectionReason",
      definition =
        COALESCE(EXCLUDED.definition - 'provider', '{}'::jsonb)
        || COALESCE(whatsapp_templates.definition, '{}'::jsonb)
        || jsonb_build_object('provider', COALESCE(EXCLUDED.definition->'provider', '{}'::jsonb)),
      "lastSyncedAt" = EXCLUDED."lastSyncedAt",
      metadata =
        COALESCE(EXCLUDED.metadata - 'providerSync', '{}'::jsonb)
        || COALESCE(whatsapp_templates.metadata, '{}'::jsonb)
        || jsonb_build_object('providerSync', COALESCE(EXCLUDED.metadata->'providerSync', '{}'::jsonb)),
      "updatedAt" = NOW()
    RETURNING id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey", "metaTemplateId", "metaTemplateName",
              language, category, status, "rejectionReason", definition, "lastSyncedAt", metadata, "createdAt", "updatedAt"`,
    [
      input.clinicId,
      input.externalTenantId,
      input.channelId,
      input.wabaId,
      input.templateKey,
      input.metaTemplateId || null,
      input.metaTemplateName,
      language,
      category,
      status,
      input.rejectionReason || null,
      input.localDefinition || {},
      input.providerDefinition,
      input.lastSyncedAt || new Date(),
      input.localMetadata || {},
      input.providerMetadata || {}
    ]
  );

  return result.rows[0] || null;
}

async function withWhatsAppTemplatesTransaction(fn) {
  return withTransaction(fn);
}

module.exports = {
  listWhatsAppTemplatesByClinicId,
  findWhatsAppTemplateByScope,
  findApprovedUtilityOrderSummaryTemplate,
  findWhatsAppTemplateByProviderIdentity,
  upsertWhatsAppTemplate,
  upsertSyncedWhatsAppTemplate,
  withWhatsAppTemplatesTransaction
};
