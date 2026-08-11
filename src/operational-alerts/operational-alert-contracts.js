const {
  EVENT_TYPE_PATTERN,
  DOMAIN_KEY_PATTERN,
  normalizeString,
  isUuid,
  cloneJsonObject,
  normalizeDateTime,
  isPositiveInteger,
  ok,
  invalid,
  contractError
} = require('./operational-alert-validation');

function validateOperationalAlertEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('operational_alert_event_not_object');
  }

  const eventType = normalizeString(input.eventType);
  if (!EVENT_TYPE_PATTERN.test(eventType)) {
    return invalid('operational_alert_event_type_invalid');
  }

  if (!isPositiveInteger(input.eventVersion)) {
    return invalid('operational_alert_event_version_invalid');
  }

  const clinicId = normalizeString(input.clinicId);
  if (!isUuid(clinicId)) {
    return invalid('operational_alert_event_clinic_id_invalid');
  }

  const entityType = normalizeString(input.entityType);
  if (!DOMAIN_KEY_PATTERN.test(entityType)) {
    return invalid('operational_alert_event_entity_type_invalid');
  }

  const entityId = normalizeString(input.entityId);
  if (!entityId || entityId.length > 300) {
    return invalid('operational_alert_event_entity_id_invalid');
  }

  const occurredAt = normalizeDateTime(input.occurredAt);
  if (!occurredAt) {
    return invalid('operational_alert_event_occurred_at_invalid');
  }

  const payload = cloneJsonObject(input.payload);
  if (!payload) {
    return invalid('operational_alert_event_payload_invalid');
  }

  const deduplicationKey = normalizeString(input.deduplicationKey);
  if (!deduplicationKey || deduplicationKey.length > 500) {
    return invalid('operational_alert_event_deduplication_key_invalid');
  }

  return ok({
    eventType,
    eventVersion: input.eventVersion,
    clinicId,
    entityType,
    entityId,
    occurredAt,
    payload,
    deduplicationKey
  });
}

function assertOperationalAlertEvent(input) {
  const result = validateOperationalAlertEvent(input);
  if (!result.ok) throw contractError(result.reason, result.details);
  return result.value;
}

module.exports = {
  validateOperationalAlertEvent,
  assertOperationalAlertEvent
};
