const { DateTime } = require('luxon');
const {
  normalizeDateOnly,
  resolveTenantTimezone
} = require('../utils/inventory-expiration');
const {
  normalizeString,
  normalizeDateTime,
  isPlainObject,
  isPositiveInteger,
  isUuid,
  contractError
} = require('./operational-alert-validation');
const {
  buildOperationalAlertEventDeduplicationKey
} = require('./operational-alert-idempotency');

const INVENTORY_EXPIRY_EVENT_TYPE = 'inventory.lot_expiring';
const INVENTORY_EXPIRY_EVENT_VERSION = 1;
const INVENTORY_EXPIRY_EVENT_ITEM_LIMIT = 250;
const INVENTORY_EXPIRY_FORMATTER_ITEM_LIMIT = 12;
const INVENTORY_EXPIRY_TEMPLATE_CONTRACT = Object.freeze({
  family: 'inventory_lot_expiring',
  templateKey: 'inventory_lot_expiring_v1',
  language: 'es_AR',
  category: 'UTILITY',
  bodyParameterCount: 5,
  variables: Object.freeze(['title', 'summary', 'items', 'overflow', 'footer'])
});

function fail(reason) {
  throw contractError(reason);
}

function parseInstant(value) {
  const normalized = normalizeDateTime(value);
  if (!normalized) fail('inventory_expiry_evaluation_time_invalid');
  return DateTime.fromISO(normalized, { setZone: true }).toUTC();
}

function parseSendAt(sendAt) {
  const match = /^(\d{2}):(\d{2})$/.exec(normalizeString(sendAt));
  if (!match) fail('inventory_expiry_schedule_send_at_invalid');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function localScheduleInstant(localDate, sendAt, timezone) {
  const time = parseSendAt(sendAt);
  const date = DateTime.fromISO(localDate, { zone: timezone });
  if (!date.isValid) fail('inventory_expiry_schedule_local_date_invalid');
  const instant = DateTime.fromObject({
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0
  }, { zone: timezone });
  if (!instant.isValid) fail('inventory_expiry_schedule_instant_invalid');
  return instant;
}

function calculateNextDailyScheduleAt({ now, timezone, sendAt }) {
  const nowUtc = parseInstant(now);
  const safeTimezone = resolveTenantTimezone({ timezone });
  const localNow = nowUtc.setZone(safeTimezone);
  let candidate = localScheduleInstant(localNow.toISODate(), sendAt, safeTimezone);
  if (candidate.toMillis() < localNow.toMillis()) {
    candidate = localScheduleInstant(localNow.plus({ days: 1 }).toISODate(), sendAt, safeTimezone);
  }
  return candidate.toUTC().toISO();
}

function buildInventoryExpiryEvaluationContext({ rule, clinic, now }) {
  const nowUtc = parseInstant(now);
  const timezone = resolveTenantTimezone(clinic || {});
  const localNow = nowUtc.setZone(timezone);
  const localDate = localNow.toISODate();
  const daysBefore = Number(rule.conditions.daysBefore);
  const repeatPolicy = normalizeString(rule.conditions.repeatPolicy || 'once_per_threshold');
  const targetDate = DateTime.fromISO(localDate, { zone: 'utc' }).plus({ days: daysBefore }).toISODate();
  const rangeStartDate = repeatPolicy === 'daily' ? localDate : targetDate;
  const nextLocalDate = localNow.plus({ days: 1 }).toISODate();
  const nextEvaluationAt = localScheduleInstant(
    nextLocalDate,
    rule.schedule.sendAt,
    timezone
  ).toUTC().toISO();
  const thresholdIdentity = `days-${daysBefore}-${repeatPolicy}`;

  return {
    evaluatedAt: nowUtc.toISO(),
    localDate,
    timezone,
    daysBefore,
    repeatPolicy,
    quantityBasis: normalizeString(rule.conditions.quantityBasis || 'physical'),
    minimumAvailableQuantity: Number(rule.conditions.minimumAvailableQuantity ?? 1),
    rangeStartDate,
    rangeEndDate: targetDate,
    targetDate,
    thresholdIdentity,
    evaluationWindowKey: localDate,
    nextEvaluationAt
  };
}

function daysBetweenDateOnly(fromISO, toISO) {
  const from = DateTime.fromISO(fromISO, { zone: 'utc' }).startOf('day');
  const to = DateTime.fromISO(toISO, { zone: 'utc' }).startOf('day');
  if (!from.isValid || !to.isValid) return null;
  return Math.round(to.diff(from, 'days').days);
}

function normalizeOptionalText(value, maxLength) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function compareItems(left, right) {
  if (left.expiresAt !== right.expiresAt) return left.expiresAt < right.expiresAt ? -1 : 1;
  const leftName = left.productName.toLowerCase();
  const rightName = right.productName.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  if (left.productName !== right.productName) return left.productName < right.productName ? -1 : 1;
  return left.lotId < right.lotId ? -1 : left.lotId > right.lotId ? 1 : 0;
}

function normalizeDigestItem(row, context) {
  const lotId = normalizeString(row && row.lotId);
  const productId = normalizeString(row && row.productId);
  const productName = normalizeString(row && row.productName);
  const expiresAt = normalizeDateOnly(row && row.expiresAt);
  const relevantQuantity = Number(row && row.relevantQuantity);
  const daysRemaining = expiresAt ? daysBetweenDateOnly(context.localDate, expiresAt) : null;
  if (
    !isUuid(lotId) || !isUuid(productId) || !productName || productName.length > 300 ||
    !expiresAt || !Number.isInteger(daysRemaining) || daysRemaining < 0 ||
    !Number.isFinite(relevantQuantity) || relevantQuantity <= 0 ||
    relevantQuantity < context.minimumAvailableQuantity
  ) {
    return null;
  }
  if (context.repeatPolicy === 'once_per_threshold' && daysRemaining !== context.daysBefore) return null;
  if (context.repeatPolicy === 'daily' && daysRemaining > context.daysBefore) return null;

  return {
    lotId,
    productId,
    productName,
    sku: normalizeOptionalText(row.productSku, 120),
    lotCode: normalizeOptionalText(row.lotNumber, 120),
    expiresAt,
    daysRemaining,
    relevantQuantity,
    supplierName: normalizeOptionalText(row.supplierName, 200),
    locationName: normalizeOptionalText(row.locationName, 200)
  };
}

function buildInventoryExpiryDigest({ rule, context, candidates }) {
  const items = (Array.isArray(candidates && candidates.items) ? candidates.items : [])
    .map((row) => normalizeDigestItem(row, context))
    .filter(Boolean)
    .sort(compareItems)
    .slice(0, INVENTORY_EXPIRY_EVENT_ITEM_LIMIT);
  if (items.length === 0) return null;

  const reportedTotalLots = Number(candidates.totalLots);
  const totalLots = Number.isInteger(reportedTotalLots) && reportedTotalLots >= items.length
    ? reportedTotalLots
    : items.length;
  const snapshotProductCount = new Set(items.map((item) => item.productId)).size;
  const reportedTotalProducts = Number(candidates.totalProducts);
  const totalProducts = Number.isInteger(reportedTotalProducts)
    && reportedTotalProducts >= snapshotProductCount
    && reportedTotalProducts <= totalLots
    ? reportedTotalProducts
    : snapshotProductCount;
  const omittedLots = Math.max(0, totalLots - items.length);
  const payload = {
    evaluatedAt: context.evaluatedAt,
    localDate: context.localDate,
    daysBefore: context.daysBefore,
    quantityBasis: context.quantityBasis,
    minimumAvailableQuantity: context.minimumAvailableQuantity,
    repeatPolicy: context.repeatPolicy,
    configVersion: Number(rule.configVersion),
    thresholdIdentity: context.thresholdIdentity,
    evaluationWindowKey: context.evaluationWindowKey,
    totalLots,
    totalProducts,
    items,
    truncation: {
      itemLimit: INVENTORY_EXPIRY_EVENT_ITEM_LIMIT,
      omittedLots
    }
  };
  const qualifier = [
    `config=${Number(rule.configVersion)}`,
    `threshold=${context.daysBefore}`,
    `policy=${context.repeatPolicy}`,
    `date=${context.localDate}`
  ].join('.');

  return {
    eventType: INVENTORY_EXPIRY_EVENT_TYPE,
    eventVersion: INVENTORY_EXPIRY_EVENT_VERSION,
    entityType: 'operational_alert_rule',
    entityId: rule.id,
    occurredAt: context.evaluatedAt,
    payload,
    deduplicationKey: buildOperationalAlertEventDeduplicationKey({
      eventType: INVENTORY_EXPIRY_EVENT_TYPE,
      entityId: rule.id,
      eventVersion: INVENTORY_EXPIRY_EVENT_VERSION,
      qualifier
    })
  };
}

function normalizeInventoryExpiryDigestPayload(payload, conditions) {
  if (!isPlainObject(payload) || !isPlainObject(payload.truncation) || !Array.isArray(payload.items)) return null;
  const evaluatedAt = normalizeDateTime(payload.evaluatedAt);
  const localDate = normalizeDateOnly(payload.localDate);
  const daysBefore = Number(payload.daysBefore);
  const quantityBasis = normalizeString(payload.quantityBasis);
  const repeatPolicy = normalizeString(payload.repeatPolicy);
  const minimumAvailableQuantity = Number(payload.minimumAvailableQuantity);
  const configVersion = Number(payload.configVersion);
  const totalLots = Number(payload.totalLots);
  const totalProducts = Number(payload.totalProducts);
  const thresholdIdentity = normalizeString(payload.thresholdIdentity);
  const evaluationWindowKey = normalizeString(payload.evaluationWindowKey);
  const itemLimit = Number(payload.truncation.itemLimit);
  const omittedLots = Number(payload.truncation.omittedLots);
  if (
    !evaluatedAt || !localDate || !Number.isInteger(daysBefore) || daysBefore < 1 || daysBefore > 365 ||
    !['physical', 'commercial'].includes(quantityBasis) ||
    !['once_per_threshold', 'daily'].includes(repeatPolicy) ||
    !Number.isFinite(minimumAvailableQuantity) || minimumAvailableQuantity < 0 ||
    !isPositiveInteger(configVersion) || !isPositiveInteger(totalLots) || !isPositiveInteger(totalProducts) ||
    totalProducts > totalLots || !thresholdIdentity || evaluationWindowKey !== localDate ||
    itemLimit !== INVENTORY_EXPIRY_EVENT_ITEM_LIMIT || !Number.isInteger(omittedLots) || omittedLots < 0 ||
    payload.items.length < 1 || payload.items.length > INVENTORY_EXPIRY_EVENT_ITEM_LIMIT ||
    payload.items.length + omittedLots !== totalLots
  ) {
    return null;
  }
  if (
    Number(conditions.daysBefore) !== daysBefore ||
    normalizeString(conditions.quantityBasis || 'physical') !== quantityBasis ||
    Number(conditions.minimumAvailableQuantity ?? 1) !== minimumAvailableQuantity ||
    normalizeString(conditions.repeatPolicy || 'once_per_threshold') !== repeatPolicy
  ) {
    return null;
  }

  const context = { localDate, daysBefore, quantityBasis, repeatPolicy, minimumAvailableQuantity };
  const items = payload.items.map((item) => normalizeDigestItem({
    ...item,
    productSku: item.sku,
    lotNumber: item.lotCode
  }, context));
  if (items.some((item) => !item)) return null;
  const sortedItems = [...items].sort(compareItems);
  if (items.some((item, index) => JSON.stringify(item) !== JSON.stringify(sortedItems[index]))) return null;

  return {
    evaluatedAt,
    localDate,
    daysBefore,
    quantityBasis,
    minimumAvailableQuantity,
    repeatPolicy,
    configVersion,
    thresholdIdentity,
    evaluationWindowKey,
    totalLots,
    totalProducts,
    items,
    truncation: { itemLimit, omittedLots }
  };
}

module.exports = {
  INVENTORY_EXPIRY_EVENT_TYPE,
  INVENTORY_EXPIRY_EVENT_VERSION,
  INVENTORY_EXPIRY_EVENT_ITEM_LIMIT,
  INVENTORY_EXPIRY_FORMATTER_ITEM_LIMIT,
  INVENTORY_EXPIRY_TEMPLATE_CONTRACT,
  calculateNextDailyScheduleAt,
  buildInventoryExpiryEvaluationContext,
  buildInventoryExpiryDigest,
  normalizeInventoryExpiryDigestPayload,
  daysBetweenDateOnly,
  compareItems,
  localScheduleInstant
};
