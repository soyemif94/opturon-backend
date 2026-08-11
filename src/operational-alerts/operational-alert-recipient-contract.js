const {
  normalizeString,
  normalizeNullableString,
  isUuid,
  normalizeDateTime,
  isPositiveInteger,
  ok,
  invalid,
  contractError
} = require('./operational-alert-validation');

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const AREA_KEY_PATTERN = /^[a-z][a-z0-9_.-]*$/;
const CONSENT_STATUSES = Object.freeze(['pending', 'granted', 'revoked']);
const RECIPIENT_MATERIAL_FIELDS = Object.freeze([
  'staffUserId',
  'phoneE164',
  'active',
  'consentStatus',
  'consentSource',
  'consentedAt',
  'revokedAt'
]);

function normalizeAreaKeys(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const normalized = Array.from(
    new Set(value.map((item) => normalizeString(item).toLowerCase()))
  ).sort();

  if (normalized.length > 50 || normalized.some((item) => !AREA_KEY_PATTERN.test(item))) {
    return null;
  }
  return normalized;
}

function validateOperationalAlertRecipient(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('operational_alert_recipient_not_object');
  }

  const clinicId = normalizeString(input.clinicId);
  if (!isUuid(clinicId)) return invalid('operational_alert_recipient_clinic_id_invalid');

  const staffUserId = normalizeNullableString(input.staffUserId);
  if (staffUserId && !isUuid(staffUserId)) {
    return invalid('operational_alert_recipient_staff_user_id_invalid');
  }

  const name = normalizeString(input.name);
  if (!name || name.length > 200) return invalid('operational_alert_recipient_name_invalid');

  const phoneE164 = normalizeString(input.phoneE164);
  if (!E164_PATTERN.test(phoneE164)) return invalid('operational_alert_recipient_phone_invalid');

  const roleLabel = normalizeNullableString(input.roleLabel);
  if (roleLabel && roleLabel.length > 200) {
    return invalid('operational_alert_recipient_role_label_invalid');
  }

  const areaKeys = normalizeAreaKeys(input.areaKeys);
  if (!areaKeys) return invalid('operational_alert_recipient_area_keys_invalid');

  const active = input.active === undefined ? false : input.active;
  if (typeof active !== 'boolean') return invalid('operational_alert_recipient_active_invalid');

  const consentStatus = normalizeString(input.consentStatus || 'pending').toLowerCase();
  if (!CONSENT_STATUSES.includes(consentStatus)) {
    return invalid('operational_alert_recipient_consent_status_invalid');
  }

  const consentSource = normalizeNullableString(input.consentSource);
  const consentedAt = normalizeDateTime(input.consentedAt);
  const revokedAt = normalizeDateTime(input.revokedAt);
  if (input.consentedAt && !consentedAt) return invalid('operational_alert_recipient_consented_at_invalid');
  if (input.revokedAt && !revokedAt) return invalid('operational_alert_recipient_revoked_at_invalid');

  if (consentStatus === 'pending' && (consentedAt || revokedAt)) {
    return invalid('operational_alert_recipient_pending_consent_timestamps_invalid');
  }
  if (consentStatus === 'granted' && (!consentedAt || revokedAt)) {
    return invalid('operational_alert_recipient_granted_consent_timestamps_invalid');
  }
  if (consentStatus === 'revoked' && !revokedAt) {
    return invalid('operational_alert_recipient_revoked_at_required');
  }

  const version = input.version === undefined ? 1 : input.version;
  if (!isPositiveInteger(version)) return invalid('operational_alert_recipient_version_invalid');

  const disabledAt = normalizeDateTime(input.disabledAt);
  if (input.disabledAt && !disabledAt) return invalid('operational_alert_recipient_disabled_at_invalid');

  return ok({
    clinicId,
    staffUserId,
    name,
    phoneE164,
    roleLabel,
    areaKeys,
    active,
    consentStatus,
    consentSource,
    consentedAt,
    revokedAt,
    version,
    disabledAt
  });
}

function assertOperationalAlertRecipient(input) {
  const result = validateOperationalAlertRecipient(input);
  if (!result.ok) throw contractError(result.reason, result.details);
  return result.value;
}

function comparableValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function hasRecipientMaterialChange(current, next) {
  return RECIPIENT_MATERIAL_FIELDS.some(
    (field) => comparableValue(current && current[field]) !== comparableValue(next && next[field])
  );
}

module.exports = {
  E164_PATTERN,
  CONSENT_STATUSES,
  RECIPIENT_MATERIAL_FIELDS,
  normalizeAreaKeys,
  validateOperationalAlertRecipient,
  assertOperationalAlertRecipient,
  hasRecipientMaterialChange
};
