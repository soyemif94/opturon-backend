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
const {
  INVENTORY_EXPIRY_TEMPLATE_CONTRACT,
  normalizeInventoryExpiryDigestPayload
} = require('./inventory-lot-expiry-alert');

const TRIGGER_MODES = Object.freeze(['event_driven', 'scheduled']);
const PRODUCER_STATUSES = Object.freeze({
  CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE: 'CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE',
  PRODUCER_AVAILABLE: 'PRODUCER_AVAILABLE'
});
const EVALUATION_OUTCOMES = Object.freeze({
  MATCH: 'MATCH',
  NO_MATCH: 'NO_MATCH',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION'
});
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

function normalizeFixtureText(value, maxLength = 300) {
  const safe = normalizeString(value);
  return safe && safe.length <= maxLength ? safe : null;
}

function evaluateInventoryLotExpiring(config, event) {
  const payload = normalizeInventoryExpiryDigestPayload(event && event.payload, config.conditions);
  if (!payload) {
    return {
      outcome: EVALUATION_OUTCOMES.INVALID_CONFIGURATION,
      reason: 'inventory_lot_expiring_event_payload_invalid'
    };
  }
  return {
    outcome: EVALUATION_OUTCOMES.MATCH,
    reason: 'inventory_lot_expiring_digest_matched',
    thresholdIdentity: payload.thresholdIdentity,
    evaluationWindowKey: payload.evaluationWindowKey,
    material: payload
  };
}

function evaluateCashSessionClosed(config, event) {
  const payload = cloneJsonObject(event && event.payload);
  const sessionId = normalizeFixtureText(payload && payload.sessionId);
  const closedAt = payload && typeof payload.closedAt === 'string'
    && Number.isFinite(new Date(payload.closedAt).getTime())
    ? new Date(payload.closedAt).toISOString()
    : null;
  const currency = normalizeFixtureText(payload && payload.currency, 20);
  const differenceAmount = typeof (payload && payload.differenceAmount) === 'number'
    && Number.isFinite(payload.differenceAmount)
    ? payload.differenceAmount
    : null;

  if (!sessionId || !closedAt || !currency || differenceAmount === null) {
    return {
      outcome: EVALUATION_OUTCOMES.INVALID_CONFIGURATION,
      reason: 'cash_session_closed_event_payload_invalid'
    };
  }

  const absoluteDifference = Math.abs(differenceAmount);
  const matches = absoluteDifference >= config.conditions.minimumAbsoluteDifference
    && (!config.conditions.onlyWithDifference || absoluteDifference > 0);
  return {
    outcome: matches ? EVALUATION_OUTCOMES.MATCH : EVALUATION_OUTCOMES.NO_MATCH,
    reason: matches ? 'cash_session_closed_threshold_matched' : 'cash_session_closed_threshold_not_matched',
    evaluationWindowKey: normalizeFixtureText(payload.evaluationWindowKey, 300),
    material: {
      sessionId,
      closedAt,
      currency,
      differenceAmount
    }
  };
}

const DEFINITIONS = Object.freeze([
  Object.freeze({
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    displayName: 'Inventory lots nearing expiration',
    displayKey: 'operationalAlerts.eventTypes.inventoryLotExpiring',
    triggerModesAllowed: Object.freeze(['scheduled']),
    conditionsContract: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['daysBefore']),
      properties: Object.freeze({
        daysBefore: Object.freeze({ type: 'integer', minimum: 1, maximum: 365 }),
        minimumAvailableQuantity: Object.freeze({ type: 'number', minimum: 0, default: 1 }),
        quantityBasis: Object.freeze({ type: 'string', enum: Object.freeze(['physical', 'commercial']), default: 'physical' }),
        repeatPolicy: Object.freeze({ type: 'string', enum: Object.freeze(['once_per_threshold', 'daily']), default: 'once_per_threshold' })
      })
    }),
    scheduleContract: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['frequency', 'sendAt']),
      properties: Object.freeze({
        frequency: Object.freeze({ type: 'string', enum: Object.freeze(['daily']) }),
        sendAt: Object.freeze({ type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
        timezone: Object.freeze({ type: 'string', enum: Object.freeze(['tenant']), default: 'tenant' })
      })
    }),
    eventPayloadContract: Object.freeze({
      required: Object.freeze([
        'evaluatedAt',
        'localDate',
        'daysBefore',
        'quantityBasis',
        'minimumAvailableQuantity',
        'repeatPolicy',
        'configVersion',
        'thresholdIdentity',
        'evaluationWindowKey',
        'totalLots',
        'totalProducts',
        'items',
        'truncation'
      ])
    }),
    templateContract: INVENTORY_EXPIRY_TEMPLATE_CONTRACT,
    producerStatus: PRODUCER_STATUSES.PRODUCER_AVAILABLE,
    producerAvailable: true,
    validateConditions: validateInventoryConditions,
    validateSchedule: validateInventorySchedule,
    evaluate: evaluateInventoryLotExpiring,
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1
  }),
  Object.freeze({
    eventType: 'cash.session_closed',
    eventVersion: 1,
    displayName: 'Cash session closed',
    displayKey: 'operationalAlerts.eventTypes.cashSessionClosed',
    triggerModesAllowed: Object.freeze(['event_driven']),
    conditionsContract: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([]),
      properties: Object.freeze({
        minimumAbsoluteDifference: Object.freeze({ type: 'number', minimum: 0, default: 0 }),
        onlyWithDifference: Object.freeze({ type: 'boolean', default: false })
      })
    }),
    scheduleContract: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([]),
      properties: Object.freeze({})
    }),
    eventPayloadContract: Object.freeze({
      required: Object.freeze(['sessionId', 'closedAt', 'currency', 'differenceAmount'])
    }),
    producerStatus: PRODUCER_STATUSES.CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE,
    producerAvailable: false,
    validateConditions: validateCashConditions,
    validateSchedule: validateNoSchedule,
    evaluate: evaluateCashSessionClosed,
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

function evaluateOperationalAlertCondition(rule, event) {
  const configResult = validateOperationalAlertRuleConfig(rule);
  if (!configResult.ok) {
    return {
      outcome: EVALUATION_OUTCOMES.INVALID_CONFIGURATION,
      reason: configResult.reason
    };
  }

  const definition = getOperationalAlertDefinition(configResult.value.eventType, configResult.value.eventVersion);
  if (
    !definition ||
    !event ||
    event.eventType !== definition.eventType ||
    Number(event.eventVersion) !== definition.eventVersion
  ) {
    return {
      outcome: EVALUATION_OUTCOMES.INVALID_CONFIGURATION,
      reason: 'operational_alert_event_rule_contract_mismatch'
    };
  }
  return definition.evaluate(configResult.value, event);
}

function listOperationalAlertDefinitions() {
  return DEFINITIONS.map((item) => ({
    eventType: item.eventType,
    eventVersion: item.eventVersion,
    displayName: item.displayName,
    displayKey: item.displayKey,
    triggerModesAllowed: [...item.triggerModesAllowed],
    conditionsContract: JSON.parse(JSON.stringify(item.conditionsContract)),
    scheduleContract: JSON.parse(JSON.stringify(item.scheduleContract)),
    eventPayloadContract: JSON.parse(JSON.stringify(item.eventPayloadContract)),
    templateContract: item.templateContract ? JSON.parse(JSON.stringify(item.templateContract)) : null,
    formatterKey: item.formatterKey,
    formatterVersion: item.formatterVersion,
    availability: {
      status: item.producerStatus,
      configurable: true,
      readyForProduction: item.producerAvailable === true
    },
    producer: {
      status: item.producerStatus,
      active: item.producerAvailable === true
    }
  }));
}

module.exports = {
  TRIGGER_MODES,
  PRODUCER_STATUSES,
  EVALUATION_OUTCOMES,
  getOperationalAlertDefinition,
  listOperationalAlertDefinitions,
  validateOperationalAlertRuleConfig,
  assertOperationalAlertRuleConfig,
  assertRegisteredOperationalAlertEvent,
  evaluateOperationalAlertCondition
};
