const { isPlainObject, normalizeString } = require('./operational-alert-validation');

const SENSITIVE_SNAPSHOT_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'token',
  'password',
  'secret',
  'clientsecret',
  'webhooksecret',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'errormetadata',
  'providermessageid',
  'graphresponse',
  'rawpayload'
]);
const PHONE_SNAPSHOT_KEYS = new Set([
  'phone',
  'phonee164',
  'phonenumber',
  'recipientphone',
  'recipientphonee164'
]);

function normalizeSnapshotKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function maskPhoneE164(value) {
  const phone = normalizeString(value);
  if (!phone || phone.length < 6) return null;
  const visiblePrefix = phone.slice(0, Math.min(3, phone.length - 2));
  return `${visiblePrefix}${'*'.repeat(Math.max(3, phone.length - visiblePrefix.length - 2))}${phone.slice(-2)}`;
}

function sanitizeSnapshot(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeSnapshot(item, depth + 1));
  if (!isPlainObject(value)) return null;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeSnapshotKey(key);
    if (SENSITIVE_SNAPSHOT_KEYS.has(normalizedKey)) continue;
    if (PHONE_SNAPSHOT_KEYS.has(normalizedKey)) {
      result[key] = maskPhoneE164(item);
      continue;
    }
    result[key] = sanitizeSnapshot(item, depth + 1);
  }
  return result;
}

function toRecipientDto(recipient, staff = null) {
  if (!recipient) return null;
  return {
    id: recipient.id,
    name: recipient.name,
    phoneE164: recipient.phoneE164,
    roleLabel: recipient.roleLabel || null,
    areaKeys: Array.isArray(recipient.areaKeys) ? [...recipient.areaKeys] : [],
    active: recipient.active === true,
    consent: {
      status: recipient.consentStatus,
      source: recipient.consentSource || null,
      consentedAt: recipient.consentedAt || null,
      revokedAt: recipient.revokedAt || null
    },
    version: Number(recipient.version),
    disabledAt: recipient.disabledAt || null,
    staff: staff
      ? {
          id: staff.id,
          displayName: staff.name || null,
          active: staff.active === true
        }
      : null,
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt
  };
}

function toRuleDto(rule, recipientLinks = null) {
  if (!rule) return null;
  const dto = {
    id: rule.id,
    name: rule.name,
    eventType: rule.eventType,
    eventVersion: Number(rule.eventVersion),
    triggerMode: rule.triggerMode,
    configVersion: Number(rule.configVersion),
    enabled: rule.enabled === true,
    enabledAt: rule.enabledAt || null,
    archivedAt: rule.archivedAt || null,
    conditions: sanitizeSnapshot(rule.conditions || {}),
    schedule: sanitizeSnapshot(rule.schedule || {}),
    deliveryPolicy: sanitizeSnapshot(rule.deliveryPolicy || {}),
    channelId: rule.channelId || null,
    template: {
      key: rule.templateKey || null,
      language: rule.templateLanguage || null
    },
    formatter: {
      key: rule.formatterKey,
      version: Number(rule.formatterVersion)
    },
    nextEvaluationAt: rule.nextEvaluationAt || null,
    lastEvaluatedAt: rule.lastEvaluatedAt || null,
    lastTriggeredAt: rule.lastTriggeredAt || null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt
  };
  if (Array.isArray(recipientLinks)) {
    dto.recipientIds = recipientLinks.map((item) => item.recipientId);
  }
  return dto;
}

function toHistoryListDto(item) {
  return {
    instanceId: item.instanceId,
    rule: {
      id: item.ruleId,
      name: item.ruleName || null,
      version: Number(item.ruleVersion)
    },
    eventType: item.eventType,
    eventVersion: Number(item.eventVersion),
    occurredAt: item.occurredAt,
    createdAt: item.createdAt,
    completedAt: item.completedAt || null,
    status: item.status,
    deliverySummary: { ...(item.deliverySummary || {}) }
  };
}

function toHistoryDetailDto(detail) {
  if (!detail || !detail.instance) return null;
  const instance = detail.instance;
  return {
    instanceId: instance.instanceId,
    rule: {
      id: instance.ruleId,
      name: instance.ruleName || null,
      version: Number(instance.ruleVersion)
    },
    event: {
      id: instance.eventId,
      eventType: instance.eventType,
      eventVersion: Number(instance.eventVersion),
      entityType: instance.entityType,
      entityId: instance.entityId,
      occurredAt: instance.occurredAt
    },
    occurrence: {
      key: instance.occurrenceKey,
      evaluationWindowKey: instance.evaluationWindowKey || null
    },
    snapshotVersion: Number(instance.snapshotVersion),
    snapshot: sanitizeSnapshot(instance.snapshot || {}),
    status: instance.status,
    expiresAt: instance.expiresAt || null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    completedAt: instance.completedAt || null,
    deliveries: (Array.isArray(detail.deliveries) ? detail.deliveries : []).map((delivery) => {
      const recipientSnapshot = isPlainObject(delivery.recipientSnapshot) ? delivery.recipientSnapshot : {};
      return {
        id: delivery.id,
        recipient: {
          id: delivery.recipientId,
          name: normalizeString(recipientSnapshot.name) || null,
          roleLabel: normalizeString(recipientSnapshot.roleLabel) || null,
          phoneMasked: maskPhoneE164(recipientSnapshot.phoneE164),
          version: Number(delivery.recipientVersion)
        },
        channelId: delivery.channelId || null,
        status: delivery.status,
        template: {
          key: delivery.templateKey || null,
          language: delivery.templateLanguage || null,
          version: delivery.templateVersion === null || delivery.templateVersion === undefined
            ? null
            : Number(delivery.templateVersion)
        },
        formatter: {
          key: delivery.formatterKey,
          version: Number(delivery.formatterVersion)
        },
        attemptCount: Number(delivery.attemptCount || 0),
        resultCode: delivery.resultCode || null,
        hasError: Boolean(delivery.lastError),
        sentAt: delivery.sentAt || null,
        deliveredAt: delivery.deliveredAt || null,
        readAt: delivery.readAt || null,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt
      };
    })
  };
}

module.exports = {
  maskPhoneE164,
  sanitizeSnapshot,
  toRecipientDto,
  toRuleDto,
  toHistoryListDto,
  toHistoryDetailDto
};
