const {
  normalizeString,
  isPlainObject,
  cloneJsonObject,
  hasOnlyKeys,
  isPositiveInteger,
  ok,
  invalid,
  contractError
} = require('./operational-alert-validation');

const TRIGGER_MODES = Object.freeze(['event_driven', 'scheduled']);
const DELIVERY_POLICY_KEYS = Object.freeze([
  'maxAgeSeconds',
  'maxAttempts',
  'cooldownSeconds',
  'aggregationMode',
  'maxItems'
]);

function invalidConfig(reason) {
  return invalid(`operational_alert_rule_${reason}`);
}

function normalizeNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateInventoryConditions(value) {
  if (!isPlainObject(value)) return invalidConfig('conditions_not_object');
  if (!hasOnlyKeys(value, ['daysBefore', 'minimumAvailableQuantity', 'quantityBasis', 'repeatPolicy'])) {
    return invalidConfig('conditions_unknown_key');
  }
  if (!Number.isInteger(value.daysBefore) || value.daysBefore < 1 || value.daysBefore > 365) {
    return invalidConfig('conditions_days_before_invalid');
  }
  const minimumAvailableQuantity = value.minimumAvailableQuantity === undefined
    ? 1
    : normalizeNonNegativeNumber(value.minimumAvailableQuantity);
  if (minimumAvailableQuantity === null) {
    return invalidConfig('conditions_minimum_quantity_invalid');
  }
  const quantityBasis = normalizeString(value.quantityBasis || 'physical');
  if (!['physical', 'commercial'].includes(quantityBasis)) {
    return invalidConfig('conditions_quantity_basis_invalid');
  }
  const repeatPolicy = normalizeString(value.repeatPolicy || 'once_per_threshold');
  if (!['once_per_threshold', 'daily'].includes(repeatPolicy)) {
    return invalidConfig('conditions_repeat_policy_invalid');
  }
  return ok({ daysBefore: value.daysBefore, minimumAvailableQuantity, quantityBasis, repeatPolicy });
}

function validateInventorySchedule(value) {
  if (!isPlainObject(value)) return invalidConfig('schedule_not_object');
  if (!hasOnlyKeys(value, ['frequency', 'sendAt', 'timezone'])) {
    return invalidConfig('schedule_unknown_key');
  }
  const frequency = normalizeString(value.frequency);
  const sendAt = normalizeString(value.sendAt);
  const timezone = normalizeString(value.timezone || 'tenant');
  if (frequency !== 'daily') return invalidConfig('schedule_frequency_invalid');
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(sendAt)) {
    return invalidConfig('schedule_send_at_invalid');
  }
  if (timezone !== 'tenant') return invalidConfig('schedule_timezone_invalid');
  return ok({ frequency, sendAt, timezone });
}

function validateCashConditions(value) {
  if (!isPlainObject(value)) return invalidConfig('conditions_not_object');
  if (!hasOnlyKeys(value, ['minimumAbsoluteDifference', 'onlyWithDifference'])) {
    return invalidConfig('conditions_unknown_key');
  }
  const minimumAbsoluteDifference = value.minimumAbsoluteDifference === undefined
    ? 0
    : normalizeNonNegativeNumber(value.minimumAbsoluteDifference);
  if (minimumAbsoluteDifference === null) {
    return invalidConfig('conditions_minimum_difference_invalid');
  }
  const onlyWithDifference = value.onlyWithDifference === undefined ? false : value.onlyWithDifference;
  if (typeof onlyWithDifference !== 'boolean') {
    return invalidConfig('conditions_only_with_difference_invalid');
  }
  return ok({ minimumAbsoluteDifference, onlyWithDifference });
}

function validateNoSchedule(value) {
  if (!isPlainObject(value)) return invalidConfig('schedule_not_object');
  if (Object.keys(value).length > 0) return invalidConfig('schedule_not_allowed');
  return ok({});
}

const DEFINITIONS = Object.freeze([
  Object.freeze({
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerModesAllowed: Object.freeze(['scheduled']),
    validateConditions: validateInventoryConditions,
    validateSchedule: validateInventorySchedule,
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1
  }),
  Object.freeze({
    eventType: 'cash.session_closed',
    eventVersion: 1,
    triggerModesAllowed: Object.freeze(['event_driven']),
    validateConditions: validateCashConditions,
    validateSchedule: validateNoSchedule,
    formatterKey: 'cash_session_closed',
    formatterVersion: 1
  })
]);

function getOperationalAlertDefinition(eventType, eventVersion) {
  const safeType = normalizeString(eventType);
  return DEFINITIONS.find(
    (item) => item.eventType === safeType && item.eventVersion === eventVersion
  ) || null;
}

function validateDeliveryPolicy(value) {
  if (!isPlainObject(value)) return invalidConfig('delivery_policy_not_object');
  if (!hasOnlyKeys(value, DELIVERY_POLICY_KEYS)) {
    return invalidConfig('delivery_policy_unknown_key');
  }

  const normalized = cloneJsonObject(value);
  if (!normalized) return invalidConfig('delivery_policy_invalid');
  if (
    normalized.maxAgeSeconds !== undefined &&
    (!Number.isInteger(normalized.maxAgeSeconds) || normalized.maxAgeSeconds < 60 || normalized.maxAgeSeconds > 2592000)
  ) {
    return invalidConfig('delivery_policy_max_age_invalid');
  }
  if (
    normalized.maxAttempts !== undefined &&
    (!Number.isInteger(normalized.maxAttempts) || normalized.maxAttempts < 1 || normalized.maxAttempts > 10)
  ) {
    return invalidConfig('delivery_policy_max_attempts_invalid');
  }
  if (
    normalized.cooldownSeconds !== undefined &&
    (!Number.isInteger(normalized.cooldownSeconds) || normalized.cooldownSeconds < 0 || normalized.cooldownSeconds > 2592000)
  ) {
    return invalidConfig('delivery_policy_cooldown_invalid');
  }
  if (
    normalized.aggregationMode !== undefined &&
    !['single_event', 'daily_digest'].includes(normalized.aggregationMode)
  ) {
    return invalidConfig('delivery_policy_aggregation_mode_invalid');
  }
  if (
    normalized.maxItems !== undefined &&
    (!Number.isInteger(normalized.maxItems) || normalized.maxItems < 1 || normalized.maxItems > 100)
  ) {
    return invalidConfig('delivery_policy_max_items_invalid');
  }
  return ok(normalized);
}

function validateOperationalAlertRuleConfig(input) {
  if (!isPlainObject(input)) return invalidConfig('config_not_object');

  const eventType = normalizeString(input.eventType);
  const eventVersion = input.eventVersion;
  if (!isPositiveInteger(eventVersion)) return invalidConfig('event_version_invalid');

  const definition = getOperationalAlertDefinition(eventType, eventVersion);
  if (!definition) return invalidConfig('event_type_unknown');

  const triggerMode = normalizeString(input.triggerMode);
  if (!TRIGGER_MODES.includes(triggerMode) || !definition.triggerModesAllowed.includes(triggerMode)) {
    return invalidConfig('trigger_mode_invalid');
  }

  const conditions = definition.validateConditions(input.conditions);
  if (!conditions.ok) return conditions;

  const schedule = definition.validateSchedule(input.schedule);
  if (!schedule.ok) return schedule;

  const deliveryPolicy = validateDeliveryPolicy(input.deliveryPolicy || {});
  if (!deliveryPolicy.ok) return deliveryPolicy;

  const formatterKey = normalizeString(input.formatterKey || definition.formatterKey);
  const formatterVersion = input.formatterVersion === undefined
    ? definition.formatterVersion
    : input.formatterVersion;
  if (formatterKey !== definition.formatterKey || formatterVersion !== definition.formatterVersion) {
    return invalidConfig('formatter_identity_invalid');
  }

  return ok({
    eventType,
    eventVersion,
    triggerMode,
    conditions: conditions.value,
    schedule: schedule.value,
    deliveryPolicy: deliveryPolicy.value,
    formatterKey,
    formatterVersion
  });
}

function assertOperationalAlertRuleConfig(input) {
  const result = validateOperationalAlertRuleConfig(input);
  if (!result.ok) throw contractError(result.reason, result.details);
  return result.value;
}

function assertRegisteredOperationalAlertEvent(eventType, eventVersion) {
  const definition = getOperationalAlertDefinition(eventType, eventVersion);
  if (!definition) throw contractError('operational_alert_event_type_unknown');
  return definition;
}

function listOperationalAlertDefinitions() {
  return DEFINITIONS.map((item) => ({
    eventType: item.eventType,
    eventVersion: item.eventVersion,
    triggerModesAllowed: [...item.triggerModesAllowed],
    formatterKey: item.formatterKey,
    formatterVersion: item.formatterVersion
  }));
}

module.exports = {
  TRIGGER_MODES,
  getOperationalAlertDefinition,
  listOperationalAlertDefinitions,
  validateOperationalAlertRuleConfig,
  assertOperationalAlertRuleConfig,
  assertRegisteredOperationalAlertEvent
};
