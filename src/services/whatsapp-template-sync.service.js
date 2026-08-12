const crypto = require('crypto');
const {
  findChannelByIdAndClinicId,
  getClinicBusinessProfileById
} = require('../repositories/tenant.repository');
const {
  findWhatsAppTemplateByProviderIdentity,
  upsertSyncedWhatsAppTemplate,
  withWhatsAppTemplatesTransaction
} = require('../repositories/whatsapp-templates.repository');
const { listSyncTemplateBlueprints } = require('../whatsapp/template-blueprints');
const {
  normalizeWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateStatus,
  normalizeWhatsAppTemplateLanguage,
  isWhatsAppTemplateStatusUsable,
  validateWhatsAppTemplateBodyContract
} = require('../whatsapp/whatsapp-template-domain');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const { logInfo, logWarn } = require('../utils/logger');

const META_TEMPLATE_FIELDS = 'id,name,status,category,language,components,rejected_reason';
const META_TEMPLATE_PAGE_LIMIT = 200;
const META_TEMPLATE_MAX_PAGES = 100;

function normalizeString(value) {
  return String(value || '').trim();
}

function cloneJsonValue(value, fallback) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch {
    return fallback;
  }
}

function sanitizeRejectionReason(value) {
  const text = normalizeString(value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return text ? text.slice(0, 1000) : null;
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
  return ['opturon', safeKey, safeLanguage || 'esar', clinicSuffix || 'workspace']
    .filter(Boolean)
    .join('_')
    .slice(0, 128);
}

function providerIdentityKey(name, language) {
  return `${normalizeString(name)}\u0000${normalizeWhatsAppTemplateLanguage(language)}`;
}

function buildBlueprintByProviderIdentity(clinicId) {
  const byIdentity = new Map();
  for (const blueprint of listSyncTemplateBlueprints()) {
    const language = normalizeWhatsAppTemplateLanguage(blueprint.defaultLanguage);
    const name = blueprint.syncOnly
      ? normalizeString(blueprint.metaTemplateName)
      : buildMetaTemplateName({ templateKey: blueprint.key, language, clinicId });
    if (name && language) byIdentity.set(providerIdentityKey(name, language), blueprint);
  }
  return byIdentity;
}

function normalizeMetaTemplateRecord(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const name = normalizeString(item.name);
  const language = normalizeWhatsAppTemplateLanguage(item.language);
  if (!name || !language) return null;
  return {
    id: normalizeString(item.id) || null,
    name,
    language,
    category: normalizeWhatsAppTemplateCategory(item.category),
    status: normalizeWhatsAppTemplateStatus(item.status),
    components: cloneJsonValue(Array.isArray(item.components) ? item.components : [], []),
    rejectionReason: sanitizeRejectionReason(
      item.rejected_reason || item.rejection_reason || item.reason
    )
  };
}

function validateProviderContract(item, blueprint) {
  if (!blueprint) {
    return { valid: false, usable: false, reason: 'sync_blueprint_not_recognized' };
  }
  const expectedName = blueprint.syncOnly
    ? normalizeString(blueprint.metaTemplateName)
    : item.name;
  if (
    item.name !== expectedName ||
    item.language !== normalizeWhatsAppTemplateLanguage(blueprint.defaultLanguage)
  ) {
    return { valid: false, usable: false, reason: 'provider_identity_mismatch' };
  }
  if (normalizeWhatsAppTemplateCategory(item.category) !== normalizeWhatsAppTemplateCategory(blueprint.category)) {
    return { valid: false, usable: false, reason: 'provider_category_mismatch' };
  }

  if (Number.isInteger(Number(blueprint.bodyParameterCount))) {
    const body = validateWhatsAppTemplateBodyContract(
      item.components,
      Number(blueprint.bodyParameterCount)
    );
    if (!body.ok) {
      return { valid: false, usable: false, reason: body.reason };
    }
  }

  const usable = isWhatsAppTemplateStatusUsable(item.status);
  return {
    valid: true,
    usable,
    reason: usable ? null : 'provider_status_not_approved'
  };
}

function extractNextCursor(responseData) {
  const paging = responseData && responseData.paging;
  if (!paging || !paging.next) return { done: true, cursor: null };
  const cursor = normalizeString(paging.cursors && paging.cursors.after);
  if (cursor) return { done: false, cursor };
  try {
    const parsed = new URL(String(paging.next));
    const after = normalizeString(parsed.searchParams.get('after'));
    return after ? { done: false, cursor: after } : { done: false, cursor: null };
  } catch {
    return { done: false, cursor: null };
  }
}

async function fetchAllMetaTemplates({ channel, requestId, dependencies }) {
  const items = [];
  const seenCursors = new Set();
  let after = null;
  let page = 0;

  while (page < META_TEMPLATE_MAX_PAGES) {
    page += 1;
    let response;
    try {
      response = await dependencies.graphRequest(
        'GET',
        `/${encodeURIComponent(channel.wabaId)}/message_templates`,
        {
          requestId,
          credentials: {
            accessToken: channel.accessToken,
            phoneNumberId: channel.phoneNumberId
          },
          query: {
            limit: META_TEMPLATE_PAGE_LIMIT,
            fields: META_TEMPLATE_FIELDS,
            ...(after ? { after } : {})
          }
        }
      );
    } catch {
      return {
        ok: false,
        reason: 'meta_templates_sync_failed',
        status: null,
        errorCategory: 'transient',
        failedPage: page
      };
    }

    if (!response || response.ok !== true) {
      return {
        ok: false,
        reason: 'meta_templates_sync_failed',
        status: response && response.status ? response.status : null,
        errorCategory: normalizeString(response && response.errorCategory) || 'unknown',
        failedPage: page
      };
    }
    if (!response.data || !Array.isArray(response.data.data)) {
      return {
        ok: false,
        reason: 'meta_templates_response_invalid',
        status: response.status || null,
        errorCategory: 'invalid_response',
        failedPage: page
      };
    }

    items.push(...response.data.data);
    const next = extractNextCursor(response.data);
    if (next.done) return { ok: true, items, pages: page };
    if (!next.cursor || seenCursors.has(next.cursor)) {
      return {
        ok: false,
        reason: 'meta_templates_pagination_invalid',
        status: response.status || null,
        errorCategory: 'invalid_response',
        failedPage: page
      };
    }
    seenCursors.add(next.cursor);
    after = next.cursor;
  }

  return {
    ok: false,
    reason: 'meta_templates_pagination_limit_exceeded',
    status: null,
    errorCategory: 'invalid_response',
    failedPage: META_TEMPLATE_MAX_PAGES
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function comparableProviderState(record) {
  if (!record) return null;
  const provider = record.definition && record.definition.provider
    ? record.definition.provider
    : {};
  return {
    id: normalizeString(record.metaTemplateId || provider.id) || null,
    name: normalizeString(record.metaTemplateName || provider.name),
    language: normalizeWhatsAppTemplateLanguage(record.language || provider.language),
    category: normalizeWhatsAppTemplateCategory(record.category || provider.category),
    status: normalizeWhatsAppTemplateStatus(record.status || provider.status),
    rejectionReason: sanitizeRejectionReason(record.rejectionReason || provider.rejectionReason),
    components: cloneJsonValue(provider.components, [])
  };
}

function blueprintLocalDefinition(blueprint) {
  if (!blueprint) return {};
  return {
    source: blueprint.syncOnly ? 'sync_only_blueprint' : 'opturon_blueprint',
    blueprint: cloneJsonValue(blueprint, {})
  };
}

function blueprintLocalMetadata(blueprint) {
  if (!blueprint) return {};
  return {
    ...(blueprint.operationalAlertContract
      ? { operationalAlertContract: blueprint.operationalAlertContract }
      : {}),
    ...(blueprint.formatter ? { formatter: cloneJsonValue(blueprint.formatter, {}) } : {}),
    blueprint: {
      key: blueprint.key,
      version: Number(blueprint.version || 1),
      syncOnly: blueprint.syncOnly === true
    }
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  findChannel: findChannelByIdAndClinicId,
  findClinic: getClinicBusinessProfileById,
  findByProviderIdentity: findWhatsAppTemplateByProviderIdentity,
  upsertSynced: upsertSyncedWhatsAppTemplate,
  withTransaction: withWhatsAppTemplatesTransaction,
  graphRequest: graphClient.request,
  now: () => new Date(),
  requestId: () => `wa_tpl_sync_${crypto.randomUUID()}`,
  logInfo,
  logWarn
});

function createWhatsAppTemplateSyncService(overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  async function syncWhatsAppTemplatesForChannel({ clinicId, channelId } = {}) {
    const safeClinicId = normalizeString(clinicId);
    const safeChannelId = normalizeString(channelId);
    if (!safeClinicId || !safeChannelId) {
      return { ok: false, reason: 'whatsapp_template_sync_scope_required' };
    }

    const [clinic, channel] = await Promise.all([
      dependencies.findClinic(safeClinicId),
      dependencies.findChannel(safeChannelId, safeClinicId)
    ]);
    if (!clinic || normalizeString(clinic.id) !== safeClinicId) {
      return { ok: false, reason: 'whatsapp_template_sync_tenant_not_found' };
    }
    if (!channel || normalizeString(channel.clinicId) !== safeClinicId) {
      return { ok: false, reason: 'whatsapp_channel_not_found' };
    }
    if (normalizeString(channel.provider).toLowerCase() !== 'whatsapp_cloud') {
      return { ok: false, reason: 'whatsapp_channel_provider_invalid' };
    }
    if (
      normalizeString(channel.status).toLowerCase() !== 'active' ||
      !normalizeString(channel.wabaId) ||
      !normalizeString(channel.accessToken)
    ) {
      return { ok: false, reason: 'whatsapp_channel_not_ready' };
    }
    const externalTenantId = normalizeString(clinic.externalTenantId);
    if (!externalTenantId) {
      return { ok: false, reason: 'whatsapp_template_sync_tenant_mapping_missing' };
    }

    const requestId = dependencies.requestId();
    const fetched = await fetchAllMetaTemplates({ channel, requestId, dependencies });
    if (!fetched.ok) {
      dependencies.logWarn('whatsapp_templates_sync_failed', {
        clinicId: safeClinicId,
        channelId: safeChannelId,
        requestId,
        reason: fetched.reason,
        status: fetched.status,
        errorCategory: fetched.errorCategory,
        failedPage: fetched.failedPage
      });
      return {
        ok: false,
        reason: fetched.reason,
        status: fetched.status,
        errorCategory: fetched.errorCategory
      };
    }

    const summary = {
      scanned: fetched.items.length,
      recognized: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      unknown: 0,
      errors: 0
    };
    const blueprintByIdentity = buildBlueprintByProviderIdentity(safeClinicId);
    const normalizedItems = [];
    const seenProviderIdentities = new Set();
    for (const rawItem of fetched.items) {
      const item = normalizeMetaTemplateRecord(rawItem);
      if (!item) {
        summary.errors += 1;
        continue;
      }
      const identity = providerIdentityKey(item.name, item.language);
      if (seenProviderIdentities.has(identity)) {
        summary.errors += 1;
        continue;
      }
      seenProviderIdentities.add(identity);
      normalizedItems.push({ item, blueprint: blueprintByIdentity.get(identity) || null });
    }

    const lastSyncedAt = dependencies.now();
    const templates = [];
    try {
      await dependencies.withTransaction(async (client) => {
        for (const candidate of normalizedItems) {
          const { item, blueprint } = candidate;
          const exactScope = {
            clinicId: safeClinicId,
            channelId: safeChannelId,
            wabaId: normalizeString(channel.wabaId),
            metaTemplateName: item.name,
            language: item.language
          };
          const existing = await dependencies.findByProviderIdentity(exactScope, client);
          const templateKey = normalizeString(existing && existing.templateKey) || normalizeString(blueprint && blueprint.key);
          if (!templateKey) {
            summary.unknown += 1;
            continue;
          }

          summary.recognized += 1;
          const contract = validateProviderContract(item, blueprint);
          const nextProviderState = comparableProviderState({
            metaTemplateId: item.id,
            metaTemplateName: item.name,
            language: item.language,
            category: item.category,
            status: item.status,
            rejectionReason: item.rejectionReason,
            definition: { provider: { components: item.components } }
          });
          const action = !existing
            ? 'inserted'
            : stableJson(comparableProviderState(existing)) === stableJson(nextProviderState)
              ? 'unchanged'
              : 'updated';

          const saved = await dependencies.upsertSynced({
            clinicId: safeClinicId,
            externalTenantId,
            channelId: safeChannelId,
            wabaId: normalizeString(channel.wabaId),
            templateKey,
            metaTemplateId: item.id,
            metaTemplateName: item.name,
            language: item.language,
            category: item.category,
            status: item.status,
            rejectionReason: item.rejectionReason,
            localDefinition: blueprintLocalDefinition(blueprint),
            providerDefinition: {
              id: item.id,
              name: item.name,
              language: item.language,
              category: item.category,
              status: item.status,
              rejectionReason: item.rejectionReason,
              components: item.components
            },
            lastSyncedAt,
            localMetadata: blueprintLocalMetadata(blueprint),
            providerMetadata: {
              source: 'meta_template_list',
              requestId,
              contract
            }
          }, client);
          if (!saved) throw new Error('whatsapp_template_sync_upsert_failed');
          summary[action] += 1;
          templates.push(saved);
        }
      });
    } catch {
      dependencies.logWarn('whatsapp_templates_sync_persist_failed', {
        clinicId: safeClinicId,
        channelId: safeChannelId,
        requestId
      });
      return { ok: false, reason: 'whatsapp_templates_persist_failed' };
    }

    dependencies.logInfo('whatsapp_templates_synced', {
      clinicId: safeClinicId,
      channelId: safeChannelId,
      requestId,
      pages: fetched.pages,
      ...summary
    });
    return {
      ok: true,
      clinicId: safeClinicId,
      channelId: safeChannelId,
      templates,
      summary
    };
  }

  return { syncWhatsAppTemplatesForChannel };
}

const defaultService = createWhatsAppTemplateSyncService();

module.exports = {
  ...defaultService,
  createWhatsAppTemplateSyncService,
  META_TEMPLATE_FIELDS,
  __private__: {
    buildMetaTemplateName,
    normalizeMetaTemplateRecord,
    validateProviderContract,
    extractNextCursor,
    fetchAllMetaTemplates
  }
};
