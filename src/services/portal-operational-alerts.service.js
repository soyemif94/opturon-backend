const { withTransaction } = require('../db/client');
const recipientRepository = require('../repositories/operational-alert-recipients.repository');
const ruleRepository = require('../repositories/operational-alert-rules.repository');
const historyRepository = require('../repositories/operational-alert-admin.repository');
const {
  findClinicByExternalTenantId,
  findChannelById
} = require('../repositories/tenant.repository');
const {
  findStaffUserByIdAndClinicId,
  listStaffUsersByClinicId
} = require('../repositories/staff.repository');
const { findWhatsAppTemplateByClinicAndKey } = require('../repositories/whatsapp-templates.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');
const {
  EVALUATION_OUTCOMES,
  getOperationalAlertDefinition,
  listOperationalAlertDefinitions,
  validateOperationalAlertRuleConfig,
  evaluateOperationalAlertCondition
} = require('../operational-alerts/operational-alert-registry');
const {
  OPERATIONAL_ALERT_TEMPLATE_CONTRACT,
  getOperationalAlertFormatterDescriptor,
  formatOperationalAlertMessage,
  validateOperationalAlertTemplateContract
} = require('../operational-alerts/operational-alert-formatter');
const { isOperationalAlertsEnabled } = require('../operational-alerts/internal-operational-alert-authority');
const {
  normalizeString,
  normalizeNullableString,
  normalizeDateTime,
  isUuid,
  isPlainObject,
  isPositiveInteger
} = require('../operational-alerts/operational-alert-validation');
const {
  maskPhoneE164,
  toRecipientDto,
  toRuleDto,
  toHistoryListDto,
  toHistoryDetailDto
} = require('../operational-alerts/operational-alert-admin-dto');

const RECIPIENT_CREATE_KEYS = Object.freeze([
  'name',
  'phoneE164',
  'roleLabel',
  'areaKeys',
  'staffUserId'
]);
const RECIPIENT_PATCH_KEYS = Object.freeze([
  ...RECIPIENT_CREATE_KEYS,
  'active',
  'expectedVersion'
]);
const CONSENT_KEYS = Object.freeze([
  'status',
  'consentSource',
  'consentedAt',
  'revokedAt',
  'expectedVersion'
]);
const RULE_WRITE_KEYS = Object.freeze([
  'name',
  'eventType',
  'eventVersion',
  'triggerMode',
  'conditions',
  'schedule',
  'deliveryPolicy',
  'channelId',
  'templateKey',
  'templateLanguage',
  'formatterKey',
  'formatterVersion'
]);
const RULE_PATCH_KEYS = Object.freeze([...RULE_WRITE_KEYS, 'expectedConfigVersion']);
const HISTORY_FILTER_KEYS = Object.freeze([
  'eventType',
  'ruleId',
  'status',
  'dateFrom',
  'dateTo',
  'recipientId',
  'page',
  'pageSize'
]);
const INSTANCE_STATUSES = new Set(['pending', 'completed', 'completed_with_errors', 'failed', 'skipped']);
const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;

class OperationalAlertsAdminError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.name = 'OperationalAlertsAdminError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, status = 400, details = null) {
  throw new OperationalAlertsAdminError(code, status, details);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function assertPayload(value, allowedKeys, code) {
  if (!isPlainObject(value)) fail(code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${code}_unknown_key`);
  }
  return value;
}

function assertUuid(value, code) {
  const safe = normalizeString(value);
  if (!isUuid(safe)) fail(code);
  return safe;
}

function assertExpectedVersion(value, code) {
  if (!isPositiveInteger(value)) fail(code);
  return Number(value);
}

function translateRepositoryError(error) {
  if (error instanceof OperationalAlertsAdminError) throw error;
  if (error && error.code === '23505') {
    fail('operational_alert_recipient_phone_already_exists', 409);
  }
  if (error && (
    error.code === 'operational_alert_recipient_version_conflict' ||
    error.code === 'operational_alert_rule_version_conflict'
  )) {
    fail(error.code, 409, error.details || null);
  }
  if (error && String(error.code || '').startsWith('operational_alert_')) {
    fail(error.code, 400, error.details || null);
  }
  throw error;
}

async function execute(work) {
  try {
    return await work();
  } catch (error) {
    return translateRepositoryError(error);
  }
}

function requireActor(actor) {
  if (!actor || !isUuid(actor.id)) fail('portal_operational_alerts_actor_required', 403);
  return actor;
}

function buildStaffMap(staff) {
  return new Map((Array.isArray(staff) ? staff : []).map((item) => [String(item.id), item]));
}

function normalizeTemplateIdentity(input) {
  const templateKey = normalizeNullableString(input.templateKey);
  const templateLanguage = normalizeNullableString(input.templateLanguage);
  if (Boolean(templateKey) !== Boolean(templateLanguage)) {
    fail('operational_alert_rule_template_identity_incomplete');
  }
  if (templateLanguage && !TEMPLATE_LANGUAGE_PATTERN.test(templateLanguage)) {
    fail('operational_alert_rule_template_language_invalid');
  }
  return { templateKey, templateLanguage };
}

function normalizeRuleWrite(input) {
  const name = normalizeString(input.name);
  if (!name || name.length > 200) fail('operational_alert_rule_name_invalid');
  const channelId = normalizeNullableString(input.channelId);
  if (channelId && !isUuid(channelId)) fail('operational_alert_rule_channel_id_invalid');
  const template = normalizeTemplateIdentity(input);
  const validation = validateOperationalAlertRuleConfig(input);
  if (!validation.ok) fail(validation.reason);
  return {
    name,
    ...validation.value,
    channelId,
    templateKey: template.templateKey,
    templateLanguage: template.templateLanguage,
    nextEvaluationAt: null
  };
}

function addBlocker(blockers, code, detail = null, objectId = null) {
  const key = `${code}:${objectId || ''}:${detail || ''}`;
  if (blockers.some((item) => item.key === key)) return;
  blockers.push({ key, code, detail, objectId });
}

function finalizeBlockers(blockers) {
  return blockers.map(({ key, ...item }) => item);
}

function buildRuleReadiness(context) {
  const { clinic, rule, associations, recipients, staffById, channel, template } = context;
  const blockers = [];
  const warnings = [];
  const featureEnabled = isOperationalAlertsEnabled(clinic);
  if (!featureEnabled) addBlocker(blockers, 'FEATURE_DISABLED', 'operationalAlertsEnabled is false');
  if (rule.archivedAt) addBlocker(blockers, 'RULE_ARCHIVED', 'rule is archived', rule.id);

  const configValidation = validateOperationalAlertRuleConfig(rule);
  if (!configValidation.ok) addBlocker(blockers, 'INVALID_CONFIGURATION', configValidation.reason, rule.id);
  const definition = getOperationalAlertDefinition(rule.eventType, Number(rule.eventVersion));
  if (!definition) {
    addBlocker(blockers, 'INVALID_CONFIGURATION', 'event type is not registered', rule.id);
  } else if (definition.producerAvailable !== true) {
    addBlocker(blockers, 'PRODUCER_NOT_AVAILABLE', definition.producerStatus, rule.id);
  }

  const formatter = getOperationalAlertFormatterDescriptor(rule.formatterKey, rule.formatterVersion);
  if (!formatter) addBlocker(blockers, 'FORMATTER_MISSING', 'formatter is not registered', rule.id);

  if (!Array.isArray(associations) || associations.length === 0) {
    addBlocker(blockers, 'NO_RECIPIENTS', 'rule has no recipients', rule.id);
  }
  const recipientById = new Map((Array.isArray(recipients) ? recipients : []).map((item) => [String(item.id), item]));
  for (const association of associations || []) {
    const recipient = recipientById.get(String(association.recipientId));
    if (!recipient) {
      addBlocker(blockers, 'RECIPIENT_CHANGED', 'configured recipient no longer exists', association.recipientId);
      continue;
    }
    if (recipient.active !== true) {
      addBlocker(blockers, 'RECIPIENT_INACTIVE', 'recipient is inactive', recipient.id);
    }
    const consentReady = recipient.consentStatus === 'granted'
      && Boolean(normalizeString(recipient.consentSource))
      && Boolean(normalizeDateTime(recipient.consentedAt))
      && !recipient.revokedAt;
    if (!consentReady) {
      addBlocker(
        blockers,
        'RECIPIENT_CONSENT_MISSING',
        recipient.consentStatus === 'granted' ? 'granted consent record is incomplete' : `consent status is ${recipient.consentStatus}`,
        recipient.id
      );
    }
    if (recipient.staffUserId) {
      const staff = staffById.get(String(recipient.staffUserId));
      if (!staff || staff.active !== true || String(staff.clinicId) !== String(clinic.id)) {
        addBlocker(blockers, 'RECIPIENT_INACTIVE', 'linked staff user is missing or inactive', recipient.id);
      }
    }
  }

  if (!rule.channelId) {
    addBlocker(blockers, 'CHANNEL_MISSING', 'rule has no explicit channel', rule.id);
  } else if (!channel) {
    addBlocker(blockers, 'CHANNEL_MISSING', 'configured channel does not exist', rule.channelId);
  } else if (String(channel.clinicId) !== String(clinic.id)) {
    addBlocker(blockers, 'CHANNEL_WRONG_TENANT', 'configured channel belongs to another tenant', rule.channelId);
  } else if (
    normalizeString(channel.provider).toLowerCase() !== 'whatsapp_cloud' ||
    normalizeString(channel.status).toLowerCase() !== 'active' ||
    !normalizeString(channel.phoneNumberId) ||
    !normalizeString(channel.wabaId) ||
    !normalizeString(channel.accessToken)
  ) {
    addBlocker(blockers, 'CHANNEL_INACTIVE', 'WhatsApp channel is inactive or incomplete', rule.channelId);
  }

  if (!rule.templateKey || !rule.templateLanguage) {
    addBlocker(blockers, 'TEMPLATE_MISSING', 'template identity is incomplete', rule.id);
  } else if (!template) {
    addBlocker(blockers, 'TEMPLATE_MISSING', 'template was not found', rule.id);
  } else {
    const templateScopeMatches = channel
      && String(template.clinicId) === String(clinic.id)
      && String(template.channelId || '') === String(rule.channelId || '')
      && String(template.wabaId || '') === String(channel.wabaId || '')
      && normalizeString(template.templateKey) === normalizeString(rule.templateKey)
      && normalizeString(template.language) === normalizeString(rule.templateLanguage);
    if (!templateScopeMatches) {
      addBlocker(blockers, 'TEMPLATE_CONTRACT_MISMATCH', 'template channel or WABA scope does not match', rule.id);
    } else if (normalizeString(template.status).toLowerCase() !== 'approved') {
      addBlocker(blockers, 'TEMPLATE_NOT_APPROVED', 'template status is not approved', rule.id);
    } else if (
      normalizeString(template.category).toUpperCase() !== 'UTILITY' ||
      !normalizeString(template.metaTemplateName) ||
      !isPlainObject(template.metadata) ||
      template.metadata.operationalAlertContract !== OPERATIONAL_ALERT_TEMPLATE_CONTRACT ||
      !formatter ||
      !validateOperationalAlertTemplateContract(template, { metadata: formatter }).ok
    ) {
      addBlocker(blockers, 'TEMPLATE_CONTRACT_MISMATCH', 'template does not satisfy formatter contract', rule.id);
    }
  }

  const safeBlockers = finalizeBlockers(blockers);
  return {
    ready: safeBlockers.length === 0,
    blockers: safeBlockers,
    warnings,
    checks: {
      featureEnabled,
      ruleNotArchived: !rule.archivedAt,
      configurationValid: configValidation.ok === true,
      producerAvailable: Boolean(definition && definition.producerAvailable === true),
      recipientCount: Array.isArray(associations) ? associations.length : 0,
      recipientsReady: !safeBlockers.some((item) => item.code.startsWith('RECIPIENT_') || item.code === 'NO_RECIPIENTS'),
      channelReady: !safeBlockers.some((item) => item.code.startsWith('CHANNEL_')),
      templateReady: !safeBlockers.some((item) => item.code.startsWith('TEMPLATE_')),
      formatterRegistered: Boolean(formatter)
    }
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  withTransaction,
  findClinic: findClinicByExternalTenantId,
  findChannel: findChannelById,
  findStaff: findStaffUserByIdAndClinicId,
  listStaff: listStaffUsersByClinicId,
  findTemplate: findWhatsAppTemplateByClinicAndKey,
  createAudit: createPortalUserAuditEvent,
  createRecipient: recipientRepository.createOperationalAlertRecipient,
  findRecipient: recipientRepository.findOperationalAlertRecipientById,
  listRecipients: recipientRepository.listOperationalAlertRecipients,
  updateRecipient: recipientRepository.updateOperationalAlertRecipient,
  disableRecipient: recipientRepository.disableOperationalAlertRecipient,
  createRule: ruleRepository.createOperationalAlertRule,
  findRule: ruleRepository.findOperationalAlertRuleById,
  listRules: ruleRepository.listOperationalAlertRules,
  updateRule: ruleRepository.updateOperationalAlertRuleConfig,
  enableRule: ruleRepository.enableOperationalAlertRule,
  disableRule: ruleRepository.disableOperationalAlertRule,
  listRuleRecipients: ruleRepository.listOperationalAlertRuleRecipients,
  replaceRuleRecipients: ruleRepository.replaceOperationalAlertRuleRecipients,
  listHistory: historyRepository.listOperationalAlertHistory,
  findHistoryDetail: historyRepository.findOperationalAlertHistoryDetail
});

function createPortalOperationalAlertsService(overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  async function requireClinic(tenantId, client = null) {
    const safeTenantId = normalizeString(tenantId);
    if (!safeTenantId) fail('missing_tenant_id');
    const clinic = await dependencies.findClinic(safeTenantId, client);
    if (!clinic) fail('tenant_mapping_not_found', 404);
    return { tenantId: safeTenantId, clinic };
  }

  async function writeAudit({ tenantId, clinicId, actor, action, payload }, client) {
    const safeActor = requireActor(actor);
    await dependencies.createAudit({
      tenantId,
      clinicId,
      actorUserId: safeActor.id,
      targetUserId: null,
      action,
      payload
    }, client);
  }

  async function validateStaffScope(staffUserId, clinicId, client) {
    if (!staffUserId) return null;
    const staff = await dependencies.findStaff(staffUserId, clinicId, client);
    if (!staff) fail('operational_alert_recipient_staff_user_not_found');
    return staff;
  }

  async function validateChannelScope(channelId, clinicId, client) {
    if (!channelId) return null;
    const channel = await dependencies.findChannel(channelId, client);
    if (!channel) fail('operational_alert_rule_channel_not_found');
    if (String(channel.clinicId) !== String(clinicId)) {
      fail('operational_alert_rule_channel_wrong_tenant');
    }
    return channel;
  }

  async function loadRuleContext(clinic, ruleId, client = null, options = {}) {
    const rule = await dependencies.findRule(ruleId, clinic.id, client, { forUpdate: options.forUpdate === true });
    if (!rule) fail('operational_alert_rule_not_found', 404);
    const associations = await dependencies.listRuleRecipients(rule.id, clinic.id, client);
    const recipients = [];
    for (const association of associations) {
      const recipient = await dependencies.findRecipient(
        association.recipientId,
        clinic.id,
        client,
        { forUpdate: options.forUpdate === true }
      );
      if (recipient) recipients.push(recipient);
    }
    const staff = await dependencies.listStaff(clinic.id, client);
    const channel = rule.channelId ? await dependencies.findChannel(rule.channelId, client) : null;
    const template = rule.templateKey && rule.templateLanguage
      ? await dependencies.findTemplate(clinic.id, rule.templateKey, rule.templateLanguage, client)
      : null;
    return {
      clinic,
      rule,
      associations,
      recipients,
      staffById: buildStaffMap(staff),
      channel,
      template
    };
  }

  async function getEventTypes(tenantId) {
    return execute(async () => {
      await requireClinic(tenantId);
      return { items: listOperationalAlertDefinitions() };
    });
  }

  async function getSettings(tenantId) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      return {
        operationalAlertsEnabled: isOperationalAlertsEnabled(context.clinic),
        mutable: false
      };
    });
  }

  async function listRecipients(tenantId, options = {}) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const limit = Math.max(1, Math.min(500, Number.parseInt(String(options.limit || 100), 10) || 100));
      const [recipients, staff] = await Promise.all([
        dependencies.listRecipients(context.clinic.id, { limit }),
        dependencies.listStaff(context.clinic.id)
      ]);
      const staffById = buildStaffMap(staff);
      return {
        items: recipients.map((recipient) => toRecipientDto(recipient, staffById.get(String(recipient.staffUserId)) || null))
      };
    });
  }

  async function getRecipient(tenantId, recipientId) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const safeRecipientId = assertUuid(recipientId, 'operational_alert_recipient_id_invalid');
      const recipient = await dependencies.findRecipient(safeRecipientId, context.clinic.id);
      if (!recipient) fail('operational_alert_recipient_not_found', 404);
      const staff = recipient.staffUserId
        ? await dependencies.findStaff(recipient.staffUserId, context.clinic.id)
        : null;
      return toRecipientDto(recipient, staff);
    });
  }

  async function createRecipient(tenantId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, RECIPIENT_CREATE_KEYS, 'operational_alert_recipient_create_payload_invalid');
      requireActor(actor);
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const staffUserId = normalizeNullableString(payload.staffUserId);
        if (staffUserId && !isUuid(staffUserId)) fail('operational_alert_recipient_staff_user_id_invalid');
        const staff = await validateStaffScope(staffUserId, context.clinic.id, client);
        const recipient = await dependencies.createRecipient({
          clinicId: context.clinic.id,
          staffUserId,
          name: payload.name,
          phoneE164: payload.phoneE164,
          roleLabel: payload.roleLabel,
          areaKeys: payload.areaKeys,
          active: false,
          consentStatus: 'pending',
          consentSource: null,
          consentedAt: null,
          revokedAt: null
        }, client);
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_recipient_created',
          payload: {
            objectType: 'operational_alert_recipient',
            objectId: recipient.id,
            version: recipient.version,
            active: recipient.active,
            consentStatus: recipient.consentStatus
          }
        }, client);
        return toRecipientDto(recipient, staff);
      });
    });
  }

  async function updateRecipient(tenantId, recipientId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, RECIPIENT_PATCH_KEYS, 'operational_alert_recipient_patch_payload_invalid');
      requireActor(actor);
      const expectedVersion = assertExpectedVersion(
        payload.expectedVersion,
        'operational_alert_recipient_expected_version_invalid'
      );
      const patchKeys = Object.keys(payload).filter((key) => key !== 'expectedVersion');
      if (patchKeys.length === 0) fail('operational_alert_recipient_patch_empty');
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRecipientId = assertUuid(recipientId, 'operational_alert_recipient_id_invalid');
        const current = await dependencies.findRecipient(safeRecipientId, context.clinic.id, client, { forUpdate: true });
        if (!current) fail('operational_alert_recipient_not_found', 404);
        if (hasOwn(payload, 'staffUserId')) {
          const staffUserId = normalizeNullableString(payload.staffUserId);
          if (staffUserId && !isUuid(staffUserId)) fail('operational_alert_recipient_staff_user_id_invalid');
          await validateStaffScope(staffUserId, context.clinic.id, client);
        }
        const patch = Object.fromEntries(patchKeys.map((key) => [key, payload[key]]));
        const recipient = await dependencies.updateRecipient(
          safeRecipientId,
          context.clinic.id,
          patch,
          client,
          { expectedVersion, forceVersionIncrement: true }
        );
        const staff = recipient.staffUserId
          ? await dependencies.findStaff(recipient.staffUserId, context.clinic.id, client)
          : null;
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_recipient_updated',
          payload: {
            objectType: 'operational_alert_recipient',
            objectId: recipient.id,
            version: recipient.version,
            changedFields: patchKeys
          }
        }, client);
        return toRecipientDto(recipient, staff);
      });
    });
  }

  async function disableRecipient(tenantId, recipientId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, ['expectedVersion'], 'operational_alert_recipient_disable_payload_invalid');
      requireActor(actor);
      const expectedVersion = assertExpectedVersion(
        payload.expectedVersion,
        'operational_alert_recipient_expected_version_invalid'
      );
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRecipientId = assertUuid(recipientId, 'operational_alert_recipient_id_invalid');
        const recipient = await dependencies.disableRecipient(
          safeRecipientId,
          context.clinic.id,
          { expectedVersion, forceVersionIncrement: true },
          client
        );
        if (!recipient) fail('operational_alert_recipient_not_found', 404);
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_recipient_disabled',
          payload: {
            objectType: 'operational_alert_recipient',
            objectId: recipient.id,
            version: recipient.version
          }
        }, client);
        return toRecipientDto(recipient, null);
      });
    });
  }

  async function updateRecipientConsent(tenantId, recipientId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, CONSENT_KEYS, 'operational_alert_consent_payload_invalid');
      requireActor(actor);
      const expectedVersion = assertExpectedVersion(
        payload.expectedVersion,
        'operational_alert_recipient_expected_version_invalid'
      );
      const status = normalizeString(payload.status).toLowerCase();
      if (!['granted', 'revoked'].includes(status)) fail('operational_alert_consent_status_invalid');
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRecipientId = assertUuid(recipientId, 'operational_alert_recipient_id_invalid');
        const current = await dependencies.findRecipient(safeRecipientId, context.clinic.id, client, { forUpdate: true });
        if (!current) fail('operational_alert_recipient_not_found', 404);

        let patch;
        if (status === 'granted') {
          const consentSource = normalizeString(payload.consentSource);
          const consentedAt = normalizeDateTime(payload.consentedAt);
          if (!consentSource) fail('operational_alert_consent_source_required');
          if (!consentedAt) fail('operational_alert_consented_at_required');
          if (payload.revokedAt) fail('operational_alert_consent_grant_revoked_at_forbidden');
          patch = {
            consentStatus: 'granted',
            consentSource,
            consentedAt,
            revokedAt: null
          };
        } else {
          const revokedAt = normalizeDateTime(payload.revokedAt);
          if (!revokedAt) fail('operational_alert_revoked_at_required');
          patch = {
            consentStatus: 'revoked',
            consentSource: normalizeNullableString(payload.consentSource) || current.consentSource,
            consentedAt: current.consentedAt,
            revokedAt
          };
        }

        const recipient = await dependencies.updateRecipient(
          safeRecipientId,
          context.clinic.id,
          patch,
          client,
          { expectedVersion, forceVersionIncrement: true }
        );
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_consent_updated',
          payload: {
            objectType: 'operational_alert_recipient',
            objectId: recipient.id,
            version: recipient.version,
            consentStatus: recipient.consentStatus,
            consentSource: recipient.consentSource || null
          }
        }, client);
        const staff = recipient.staffUserId
          ? await dependencies.findStaff(recipient.staffUserId, context.clinic.id, client)
          : null;
        return toRecipientDto(recipient, staff);
      });
    });
  }

  async function listRules(tenantId, options = {}) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const rules = await dependencies.listRules(context.clinic.id, {
        limit: options.limit,
        eventType: options.eventType,
        enabled: typeof options.enabled === 'boolean' ? options.enabled : undefined,
        includeArchived: options.includeArchived === true
      });
      return { items: rules.map((rule) => toRuleDto(rule)) };
    });
  }

  async function getRule(tenantId, ruleId) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
      const rule = await dependencies.findRule(safeRuleId, context.clinic.id);
      if (!rule) fail('operational_alert_rule_not_found', 404);
      const links = await dependencies.listRuleRecipients(rule.id, context.clinic.id);
      return toRuleDto(rule, links);
    });
  }

  async function createRule(tenantId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, RULE_WRITE_KEYS, 'operational_alert_rule_create_payload_invalid');
      requireActor(actor);
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const normalized = normalizeRuleWrite(payload);
        await validateChannelScope(normalized.channelId, context.clinic.id, client);
        const rule = await dependencies.createRule({
          clinicId: context.clinic.id,
          ...normalized,
          enabled: false
        }, client);
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_rule_created',
          payload: {
            objectType: 'operational_alert_rule',
            objectId: rule.id,
            configVersion: rule.configVersion,
            eventType: rule.eventType,
            eventVersion: rule.eventVersion,
            enabled: false
          }
        }, client);
        return toRuleDto(rule, []);
      });
    });
  }

  async function updateRule(tenantId, ruleId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, RULE_PATCH_KEYS, 'operational_alert_rule_patch_payload_invalid');
      requireActor(actor);
      const expectedConfigVersion = assertExpectedVersion(
        payload.expectedConfigVersion,
        'operational_alert_rule_expected_config_version_invalid'
      );
      const patchKeys = Object.keys(payload).filter((key) => key !== 'expectedConfigVersion');
      if (patchKeys.length === 0) fail('operational_alert_rule_patch_empty');
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
        const current = await dependencies.findRule(safeRuleId, context.clinic.id, client, { forUpdate: true });
        if (!current) fail('operational_alert_rule_not_found', 404);
        if (current.enabled) fail('operational_alert_rule_must_be_disabled_before_update', 409);
        const merged = { ...current, ...Object.fromEntries(patchKeys.map((key) => [key, payload[key]])) };
        const normalized = normalizeRuleWrite(merged);
        await validateChannelScope(normalized.channelId, context.clinic.id, client);
        const rule = await dependencies.updateRule(
          safeRuleId,
          context.clinic.id,
          normalized,
          client,
          { expectedConfigVersion, forceVersionIncrement: true }
        );
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_rule_updated',
          payload: {
            objectType: 'operational_alert_rule',
            objectId: rule.id,
            configVersion: rule.configVersion,
            changedFields: patchKeys
          }
        }, client);
        const links = await dependencies.listRuleRecipients(rule.id, context.clinic.id, client);
        return toRuleDto(rule, links);
      });
    });
  }

  async function replaceRuleRecipients(tenantId, ruleId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, ['recipientIds', 'expectedConfigVersion'], 'operational_alert_rule_recipients_payload_invalid');
      requireActor(actor);
      if (!Array.isArray(payload.recipientIds)) fail('operational_alert_rule_recipient_ids_invalid');
      const expectedConfigVersion = assertExpectedVersion(
        payload.expectedConfigVersion,
        'operational_alert_rule_expected_config_version_invalid'
      );
      const recipientIds = payload.recipientIds.map((id) => assertUuid(id, 'operational_alert_rule_recipient_id_invalid'));
      if (new Set(recipientIds).size !== recipientIds.length) {
        fail('operational_alert_rule_recipient_ids_duplicate');
      }
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
        const current = await dependencies.findRule(safeRuleId, context.clinic.id, client, { forUpdate: true });
        if (!current) fail('operational_alert_rule_not_found', 404);
        if (current.enabled) fail('operational_alert_rule_must_be_disabled_before_update', 409);
        for (const recipientId of recipientIds) {
          const recipient = await dependencies.findRecipient(recipientId, context.clinic.id, client);
          if (!recipient) fail('operational_alert_rule_recipient_not_found');
        }
        const links = await dependencies.replaceRuleRecipients(
          safeRuleId,
          context.clinic.id,
          recipientIds,
          client,
          { expectedConfigVersion, validateRecipientScope: true }
        );
        const rule = await dependencies.findRule(safeRuleId, context.clinic.id, client);
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_rule_recipients_updated',
          payload: {
            objectType: 'operational_alert_rule',
            objectId: rule.id,
            configVersion: rule.configVersion,
            recipientIds
          }
        }, client);
        return toRuleDto(rule, links);
      });
    });
  }

  async function getRuleReadiness(tenantId, ruleId) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
      const ruleContext = await loadRuleContext(context.clinic, safeRuleId);
      return {
        ruleId: safeRuleId,
        configVersion: ruleContext.rule.configVersion,
        ...buildRuleReadiness(ruleContext)
      };
    });
  }

  async function enableRule(tenantId, ruleId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, ['expectedConfigVersion'], 'operational_alert_rule_enable_payload_invalid');
      requireActor(actor);
      const expectedConfigVersion = assertExpectedVersion(
        payload.expectedConfigVersion,
        'operational_alert_rule_expected_config_version_invalid'
      );
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
        const ruleContext = await loadRuleContext(context.clinic, safeRuleId, client, { forUpdate: true });
        if (Number(ruleContext.rule.configVersion) !== expectedConfigVersion) {
          fail('operational_alert_rule_version_conflict', 409, {
            expectedConfigVersion,
            currentConfigVersion: Number(ruleContext.rule.configVersion)
          });
        }
        const readiness = buildRuleReadiness(ruleContext);
        if (!readiness.ready) {
          fail('operational_alert_rule_not_ready', 409, readiness);
        }
        const rule = await dependencies.enableRule(
          safeRuleId,
          context.clinic.id,
          client,
          { expectedConfigVersion }
        );
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_rule_enabled',
          payload: {
            objectType: 'operational_alert_rule',
            objectId: rule.id,
            configVersion: rule.configVersion
          }
        }, client);
        return toRuleDto(rule, ruleContext.associations);
      });
    });
  }

  async function disableRule(tenantId, ruleId, payload, actor) {
    return execute(async () => {
      assertPayload(payload, ['expectedConfigVersion'], 'operational_alert_rule_disable_payload_invalid');
      requireActor(actor);
      const expectedConfigVersion = assertExpectedVersion(
        payload.expectedConfigVersion,
        'operational_alert_rule_expected_config_version_invalid'
      );
      return dependencies.withTransaction(async (client) => {
        const context = await requireClinic(tenantId, client);
        const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
        const current = await dependencies.findRule(safeRuleId, context.clinic.id, client, { forUpdate: true });
        if (!current) fail('operational_alert_rule_not_found', 404);
        if (Number(current.configVersion) !== expectedConfigVersion) {
          fail('operational_alert_rule_version_conflict', 409, {
            expectedConfigVersion,
            currentConfigVersion: Number(current.configVersion)
          });
        }
        if (!current.enabled) return toRuleDto(current, await dependencies.listRuleRecipients(current.id, context.clinic.id, client));
        const rule = await dependencies.disableRule(
          safeRuleId,
          context.clinic.id,
          client,
          { expectedConfigVersion }
        );
        await writeAudit({
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actor,
          action: 'operational_alert_rule_disabled',
          payload: {
            objectType: 'operational_alert_rule',
            objectId: rule.id,
            configVersion: rule.configVersion
          }
        }, client);
        return toRuleDto(rule, await dependencies.listRuleRecipients(rule.id, context.clinic.id, client));
      });
    });
  }

  async function previewRule(tenantId, ruleId, payload) {
    return execute(async () => {
      assertPayload(payload, ['payload'], 'operational_alert_rule_preview_payload_invalid');
      if (!isPlainObject(payload.payload)) fail('operational_alert_rule_preview_event_payload_invalid');
      const context = await requireClinic(tenantId);
      const safeRuleId = assertUuid(ruleId, 'operational_alert_rule_id_invalid');
      const ruleContext = await loadRuleContext(context.clinic, safeRuleId);
      const readiness = buildRuleReadiness(ruleContext);
      const evaluation = evaluateOperationalAlertCondition(ruleContext.rule, {
        eventType: ruleContext.rule.eventType,
        eventVersion: ruleContext.rule.eventVersion,
        payload: payload.payload
      });
      if (evaluation.outcome === EVALUATION_OUTCOMES.INVALID_CONFIGURATION) {
        fail('operational_alert_rule_preview_event_payload_invalid', 400, { reason: evaluation.reason });
      }

      let renderedPreview = null;
      if (evaluation.outcome === EVALUATION_OUTCOMES.MATCH) {
        const formatted = formatOperationalAlertMessage({
          schemaVersion: 1,
          rule: {
            id: ruleContext.rule.id,
            eventType: ruleContext.rule.eventType,
            eventVersion: ruleContext.rule.eventVersion,
            formatterKey: ruleContext.rule.formatterKey,
            formatterVersion: ruleContext.rule.formatterVersion,
            templateKey: ruleContext.rule.templateKey,
            templateLanguage: ruleContext.rule.templateLanguage
          },
          event: { material: evaluation.material || {} },
          evaluation: { outcome: evaluation.outcome, reason: evaluation.reason }
        });
        if (formatted.ok) {
          renderedPreview = {
            auditText: formatted.value.auditText,
            components: formatted.value.components
          };
        }
      }

      const recipientById = new Map(ruleContext.recipients.map((recipient) => [String(recipient.id), recipient]));
      return {
        ruleId: ruleContext.rule.id,
        matched: evaluation.outcome === EVALUATION_OUTCOMES.MATCH,
        conditionEvaluation: {
          outcome: evaluation.outcome,
          reason: evaluation.reason
        },
        selectedRecipients: ruleContext.associations.map((association) => {
          const recipient = recipientById.get(String(association.recipientId));
          return {
            id: association.recipientId,
            position: Number(association.position || 0),
            name: recipient ? recipient.name : null,
            phoneMasked: recipient ? maskPhoneE164(recipient.phoneE164) : null,
            active: recipient ? recipient.active === true : false,
            consentStatus: recipient ? recipient.consentStatus : null
          };
        }),
        formatter: {
          key: ruleContext.rule.formatterKey,
          version: Number(ruleContext.rule.formatterVersion)
        },
        template: {
          key: ruleContext.rule.templateKey || null,
          language: ruleContext.rule.templateLanguage || null
        },
        renderedPreview,
        blockers: readiness.blockers,
        warnings: readiness.warnings
      };
    });
  }

  function normalizeHistoryFilters(filters) {
    const input = filters || {};
    if (!isPlainObject(input)) fail('operational_alert_history_filters_invalid');
    if (Object.keys(input).some((key) => !HISTORY_FILTER_KEYS.includes(key))) {
      fail('operational_alert_history_filters_unknown_key');
    }
    const result = {};
    if (input.eventType) result.eventType = normalizeString(input.eventType);
    if (input.ruleId) result.ruleId = assertUuid(input.ruleId, 'operational_alert_history_rule_id_invalid');
    if (input.recipientId) result.recipientId = assertUuid(input.recipientId, 'operational_alert_history_recipient_id_invalid');
    if (input.status) {
      result.status = normalizeString(input.status);
      if (!INSTANCE_STATUSES.has(result.status)) fail('operational_alert_history_status_invalid');
    }
    if (input.dateFrom) {
      result.dateFrom = normalizeDateTime(input.dateFrom);
      if (!result.dateFrom) fail('operational_alert_history_date_from_invalid');
    }
    if (input.dateTo) {
      result.dateTo = normalizeDateTime(input.dateTo);
      if (!result.dateTo) fail('operational_alert_history_date_to_invalid');
    }
    if (result.dateFrom && result.dateTo && new Date(result.dateFrom) > new Date(result.dateTo)) {
      fail('operational_alert_history_date_range_invalid');
    }
    result.page = Math.max(1, Number.parseInt(String(input.page || 1), 10) || 1);
    result.pageSize = Math.max(1, Math.min(100, Number.parseInt(String(input.pageSize || 25), 10) || 25));
    return result;
  }

  async function getHistory(tenantId, filters = {}) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const result = await dependencies.listHistory(context.clinic.id, normalizeHistoryFilters(filters));
      return {
        items: result.items.map(toHistoryListDto),
        pagination: result.pagination
      };
    });
  }

  async function getHistoryDetail(tenantId, instanceId) {
    return execute(async () => {
      const context = await requireClinic(tenantId);
      const safeInstanceId = assertUuid(instanceId, 'operational_alert_history_instance_id_invalid');
      const detail = await dependencies.findHistoryDetail(safeInstanceId, context.clinic.id);
      if (!detail) fail('operational_alert_history_instance_not_found', 404);
      return toHistoryDetailDto(detail);
    });
  }

  return {
    getEventTypes,
    getSettings,
    listRecipients,
    getRecipient,
    createRecipient,
    updateRecipient,
    disableRecipient,
    updateRecipientConsent,
    listRules,
    getRule,
    createRule,
    updateRule,
    replaceRuleRecipients,
    getRuleReadiness,
    enableRule,
    disableRule,
    previewRule,
    getHistory,
    getHistoryDetail
  };
}

const defaultService = createPortalOperationalAlertsService();

module.exports = {
  ...defaultService,
  createPortalOperationalAlertsService,
  OperationalAlertsAdminError,
  __private__: {
    buildRuleReadiness,
    normalizeRuleWrite,
    normalizeTemplateIdentity
  }
};
