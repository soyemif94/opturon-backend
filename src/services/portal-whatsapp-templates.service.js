const crypto = require('crypto');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findChannelByIdAndClinicId } = require('../repositories/tenant.repository');
const {
  listWhatsAppTemplatesByClinicId,
  findWhatsAppTemplateByClinicAndKey,
  findWhatsAppTemplateByClinicAndMetaName,
  upsertWhatsAppTemplate,
  withWhatsAppTemplatesTransaction
} = require('../repositories/whatsapp-templates.repository');
const { listTemplateBlueprints, findTemplateBlueprintByKey } = require('../whatsapp/template-blueprints');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_TEMPLATE_LANGUAGE = 'es_AR';
const ALLOWED_TEMPLATE_CATEGORIES = new Set(['UTILITY', 'MARKETING', 'AUTHENTICATION']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeLanguage(value, fallback = DEFAULT_TEMPLATE_LANGUAGE) {
  return normalizeString(value || fallback) || DEFAULT_TEMPLATE_LANGUAGE;
}

function normalizeMetaTemplateStatus(value, fallback = 'pending') {
  const safe = normalizeString(value).toLowerCase();
  if (!safe) return fallback;
  return safe;
}

function summarizeTemplate(record) {
  if (!record) return null;
  return {
    id: record.id,
    clinicId: record.clinicId,
    externalTenantId: record.externalTenantId,
    channelId: record.channelId || null,
    wabaId: record.wabaId,
    templateKey: record.templateKey,
    metaTemplateId: record.metaTemplateId || null,
    metaTemplateName: record.metaTemplateName,
    language: record.language,
    category: record.category,
    status: record.status,
    rejectionReason: record.rejectionReason || null,
    definition: record.definition || null,
    lastSyncedAt: record.lastSyncedAt || null,
    metadata: record.metadata || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null
  };
}

function summarizeBlueprint(blueprint) {
  return {
    key: blueprint.key,
    title: blueprint.title,
    description: blueprint.description,
    category: blueprint.category,
    defaultLanguage: blueprint.defaultLanguage || DEFAULT_TEMPLATE_LANGUAGE,
    version: blueprint.version || 1,
    components: blueprint.components
  };
}

function sanitizeTemplateNamePart(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildMetaTemplateName({ templateKey, language, clinicId }) {
  const safeKey = sanitizeTemplateNamePart(templateKey);
  const safeLanguage = sanitizeTemplateNamePart(language).replace(/_/g, '');
  const clinicSuffix = sanitizeTemplateNamePart(String(clinicId || '').slice(0, 8));
  return [ 'opturon', safeKey, safeLanguage || 'esar', clinicSuffix || 'workspace' ]
    .filter(Boolean)
    .join('_')
    .slice(0, 128);
}

function buildBlueprintMetaComponents(blueprint) {
  return (Array.isArray(blueprint.components) ? blueprint.components : []).map((component) => {
    const next = {
      type: component.type,
      text: component.text
    };
    if (component.example) {
      next.example = component.example;
    }
    return next;
  });
}

function normalizeMetaTemplateRecord(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: item.id ? String(item.id) : null,
    name: item.name ? String(item.name) : null,
    category: item.category ? String(item.category).toUpperCase() : null,
    language: item.language || (item.languages && item.languages[0]) || null,
    status: normalizeMetaTemplateStatus(item.status, 'pending'),
    rejectionReason:
      item.rejected_reason ||
      item.rejection_reason ||
      item.reason ||
      null
  };
}

async function resolvePortalWhatsAppTemplateContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  if (!context.channel?.id) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: context.reason || 'mapped_clinic_without_whatsapp_channel'
    };
  }

  const channel = await findChannelByIdAndClinicId(context.channel.id, context.clinic.id);
  if (!channel) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'whatsapp_channel_not_found'
    };
  }

  if (!channel.wabaId || !channel.accessToken) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'whatsapp_channel_not_ready'
    };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel
  };
}

async function listPortalWhatsAppTemplateBlueprints(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const blueprints = listTemplateBlueprints().map(summarizeBlueprint);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    blueprints
  };
}

async function listPortalWhatsAppTemplates(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const templates = await listWhatsAppTemplatesByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    templates: templates.map(summarizeTemplate)
  };
}

async function createTemplateInMeta({ channel, metaTemplateName, blueprint, language, requestId }) {
  const response = await graphClient.request('POST', `/${channel.wabaId}/message_templates`, {
    requestId,
    credentials: {
      accessToken: channel.accessToken,
      phoneNumberId: channel.phoneNumberId
    },
    body: {
      name: metaTemplateName,
      language,
      category: blueprint.category,
      components: buildBlueprintMetaComponents(blueprint)
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: 'meta_template_create_failed',
      detail:
        response.data && response.data.error && response.data.error.message
          ? String(response.data.error.message)
          : `Meta request failed (${response.status || 'unknown'})`,
      status: response.status || null,
      data: response.data || null
    };
  }

  return {
    ok: true,
    metaTemplateId:
      response.data && (response.data.id || response.data.template_id || response.data.message_template_id)
        ? String(response.data.id || response.data.template_id || response.data.message_template_id)
        : null,
    metaTemplateName,
    status: normalizeMetaTemplateStatus(response.data && response.data.status, 'pending'),
    data: response.data || null
  };
}

async function fetchMetaTemplates({ channel, requestId }) {
  const response = await graphClient.request('GET', `/${channel.wabaId}/message_templates`, {
    requestId,
    credentials: {
      accessToken: channel.accessToken,
      phoneNumberId: channel.phoneNumberId
    },
    query: {
      limit: 200,
      fields: 'id,name,status,category,language,rejected_reason'
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: 'meta_templates_sync_failed',
      detail:
        response.data && response.data.error && response.data.error.message
          ? String(response.data.error.message)
          : `Meta request failed (${response.status || 'unknown'})`,
      status: response.status || null,
      data: response.data || null
    };
  }

  return {
    ok: true,
    items: Array.isArray(response.data && response.data.data) ? response.data.data.map(normalizeMetaTemplateRecord).filter(Boolean) : []
  };
}

async function createPortalWhatsAppTemplateFromBlueprint(tenantId, payload) {
  const context = await resolvePortalWhatsAppTemplateContext(tenantId);
  if (!context.ok) {
    return context;
  }

  const templateKey = normalizeString(payload && payload.templateKey).toLowerCase();
  const language = normalizeLanguage(payload && payload.language);
  const blueprint = findTemplateBlueprintByKey(templateKey);

  if (!templateKey) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_template_key' };
  }
  if (!blueprint) {
    return { ok: false, tenantId: context.tenantId, reason: 'template_blueprint_not_found' };
  }
  if (!ALLOWED_TEMPLATE_CATEGORIES.has(String(blueprint.category || '').toUpperCase())) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_template_category' };
  }

  const existing = await findWhatsAppTemplateByClinicAndKey(context.clinic.id, templateKey, language);
  if (existing && ['approved', 'pending', 'in_appeal', 'paused'].includes(normalizeMetaTemplateStatus(existing.status, 'draft'))) {
    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: {
        id: context.channel.id,
        phoneNumberId: context.channel.phoneNumberId,
        wabaId: context.channel.wabaId
      },
      template: summarizeTemplate(existing),
      created: false
    };
  }

  const requestId = `wa_tpl_${crypto.randomUUID()}`;
  const metaTemplateName = buildMetaTemplateName({
    templateKey,
    language,
    clinicId: context.clinic.id
  });

  const created = await createTemplateInMeta({
    channel: context.channel,
    metaTemplateName,
    blueprint,
    language,
    requestId
  });

  if (!created.ok) {
    logWarn('portal_whatsapp_template_create_failed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      templateKey,
      language,
      requestId,
      reason: created.reason,
      detail: created.detail,
      status: created.status
    });
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: created.reason,
      detail: created.detail
    };
  }

  const persisted = await withWhatsAppTemplatesTransaction(async (client) =>
    upsertWhatsAppTemplate(
      {
        clinicId: context.clinic.id,
        externalTenantId: context.tenantId,
        channelId: context.channel.id,
        wabaId: context.channel.wabaId,
        templateKey,
        metaTemplateId: created.metaTemplateId,
        metaTemplateName,
        language,
        category: String(blueprint.category || 'UTILITY').toUpperCase(),
        status: created.status,
        rejectionReason: null,
        definition: {
          blueprint: summarizeBlueprint(blueprint),
          source: 'opturon_blueprint'
        },
        lastSyncedAt: new Date(),
        metadata: {
          requestId,
          graphResponse: created.data || null
        }
      },
      client
    )
  );

  logInfo('portal_whatsapp_template_created', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    templateKey,
    language,
    metaTemplateName,
    status: persisted && persisted.status ? persisted.status : null,
    requestId
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: {
      id: context.channel.id,
      phoneNumberId: context.channel.phoneNumberId,
      wabaId: context.channel.wabaId
    },
    template: summarizeTemplate(persisted),
    created: true
  };
}

async function syncPortalWhatsAppTemplates(tenantId) {
  const context = await resolvePortalWhatsAppTemplateContext(tenantId);
  if (!context.ok) {
    return context;
  }

  const requestId = `wa_tpl_sync_${crypto.randomUUID()}`;
  const synced = await fetchMetaTemplates({ channel: context.channel, requestId });
  if (!synced.ok) {
    logWarn('portal_whatsapp_templates_sync_failed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: synced.reason,
      detail: synced.detail,
      status: synced.status
    });
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: synced.reason,
      detail: synced.detail
    };
  }

  const blueprintByName = new Map(
    listTemplateBlueprints().map((blueprint) => [
      buildMetaTemplateName({
        templateKey: blueprint.key,
        language: blueprint.defaultLanguage || DEFAULT_TEMPLATE_LANGUAGE,
        clinicId: context.clinic.id
      }),
      blueprint
    ])
  );

  const persisted = [];
  await withWhatsAppTemplatesTransaction(async (client) => {
    for (const item of synced.items) {
      const existing =
        (item.name ? await findWhatsAppTemplateByClinicAndMetaName(context.clinic.id, item.name, client) : null) || null;
      const blueprint = item.name ? blueprintByName.get(item.name) || null : null;
      const templateKey = existing?.templateKey || blueprint?.key || null;
      if (!templateKey || !item.name) {
        continue;
      }

      const saved = await upsertWhatsAppTemplate(
        {
          clinicId: context.clinic.id,
          externalTenantId: context.tenantId,
          channelId: context.channel.id,
          wabaId: context.channel.wabaId,
          templateKey,
          metaTemplateId: item.id || existing?.metaTemplateId || null,
          metaTemplateName: item.name,
          language: normalizeLanguage(item.language, blueprint?.defaultLanguage || existing?.language || DEFAULT_TEMPLATE_LANGUAGE),
          category: String(item.category || blueprint?.category || existing?.category || 'UTILITY').toUpperCase(),
          status: normalizeMetaTemplateStatus(item.status, existing?.status || 'pending'),
          rejectionReason: item.rejectionReason || null,
          definition: existing?.definition || (blueprint ? { blueprint: summarizeBlueprint(blueprint), source: 'opturon_blueprint' } : { source: 'meta_sync' }),
          lastSyncedAt: new Date(),
          metadata: {
            requestId,
            source: 'meta_sync'
          }
        },
        client
      );
      persisted.push(saved);
    }
  });

  logInfo('portal_whatsapp_templates_synced', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    requestId,
    syncedCount: persisted.length
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    templates: persisted.map(summarizeTemplate),
    syncedCount: persisted.length
  };
}

module.exports = {
  listPortalWhatsAppTemplateBlueprints,
  listPortalWhatsAppTemplates,
  createPortalWhatsAppTemplateFromBlueprint,
  syncPortalWhatsAppTemplates
};
