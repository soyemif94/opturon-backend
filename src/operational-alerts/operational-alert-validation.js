const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const DOMAIN_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableString(value) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeString(value);
  return normalized || null;
}

function isUuid(value) {
  return UUID_PATTERN.test(normalizeString(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonObject(value) {
  if (!isPlainObject(value)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return isPlainObject(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function normalizeDateTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function hasOnlyKeys(value, allowedKeys) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function ok(value) {
  return { ok: true, value };
}

function invalid(reason, details = null) {
  return { ok: false, reason, details };
}

function contractError(reason, details = null) {
  const error = new Error(reason);
  error.code = reason;
  error.details = details;
  return error;
}

module.exports = {
  UUID_PATTERN,
  EVENT_TYPE_PATTERN,
  DOMAIN_KEY_PATTERN,
  normalizeString,
  normalizeNullableString,
  isUuid,
  isPlainObject,
  cloneJsonObject,
  normalizeDateTime,
  isPositiveInteger,
  hasOnlyKeys,
  ok,
  invalid,
  contractError
};
