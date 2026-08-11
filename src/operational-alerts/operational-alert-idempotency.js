const { normalizeString, isUuid, isPositiveInteger, contractError } = require('./operational-alert-validation');

const KEY_COMPONENT_PATTERN = /^[A-Za-z0-9._=-]+$/;

function assertKeyComponent(value, reason) {
  const normalized = normalizeString(value);
  if (!normalized || !KEY_COMPONENT_PATTERN.test(normalized)) throw contractError(reason);
  return normalized;
}

function buildOperationalAlertEventDeduplicationKey({
  eventType,
  entityId,
  eventVersion,
  qualifier = null
}) {
  const safeEventType = assertKeyComponent(eventType, 'operational_alert_event_key_type_invalid');
  const safeEntityId = assertKeyComponent(entityId, 'operational_alert_event_key_entity_invalid');
  if (!isPositiveInteger(eventVersion)) throw contractError('operational_alert_event_key_version_invalid');
  const safeQualifier = qualifier === null || qualifier === undefined
    ? null
    : assertKeyComponent(qualifier, 'operational_alert_event_key_qualifier_invalid');
  return `${safeEventType}:${safeEntityId}:v${eventVersion}${safeQualifier ? `:${safeQualifier}` : ''}`;
}

function buildOperationalAlertOccurrenceKey({
  eventDeduplicationKey,
  thresholdIdentity = null,
  evaluationWindowKey = null
}) {
  const base = normalizeString(eventDeduplicationKey);
  if (!base || /[\r\n\0]/.test(base)) throw contractError('operational_alert_occurrence_event_key_invalid');
  const threshold = thresholdIdentity === null || thresholdIdentity === undefined
    ? null
    : assertKeyComponent(thresholdIdentity, 'operational_alert_occurrence_threshold_invalid');
  const window = evaluationWindowKey === null || evaluationWindowKey === undefined
    ? null
    : assertKeyComponent(evaluationWindowKey, 'operational_alert_occurrence_window_invalid');
  return `${base}${threshold ? `:threshold=${threshold}` : ''}${window ? `:window=${window}` : ''}`;
}

function buildOperationalAlertDeliveryIdempotencyKey({ instanceId, recipientId, version = 1 }) {
  const safeInstanceId = normalizeString(instanceId);
  const safeRecipientId = normalizeString(recipientId);
  if (!isUuid(safeInstanceId)) throw contractError('operational_alert_delivery_key_instance_invalid');
  if (!isUuid(safeRecipientId)) throw contractError('operational_alert_delivery_key_recipient_invalid');
  if (!isPositiveInteger(version)) throw contractError('operational_alert_delivery_key_version_invalid');
  return `operational_alert:${safeInstanceId}:${safeRecipientId}:v${version}`;
}

module.exports = {
  buildOperationalAlertEventDeduplicationKey,
  buildOperationalAlertOccurrenceKey,
  buildOperationalAlertDeliveryIdempotencyKey
};
