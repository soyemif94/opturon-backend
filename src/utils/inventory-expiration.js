const { DateTime } = require('luxon');

const DEFAULT_TENANT_TIMEZONE = 'America/Argentina/Buenos_Aires';
const DEFAULT_EXPIRATION_ALERT_THRESHOLDS = Object.freeze({
  criticalDays: 3,
  urgentDays: 7,
  warningDays: 15,
  upcomingDays: 30
});

const EXPIRATION_STATUSES = Object.freeze([
  'expired',
  'today',
  'critical',
  'urgent',
  'warning',
  'upcoming',
  'normal',
  'no_expiration'
]);

function normalizeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized.slice(0, 10);
  return null;
}

function normalizeTimezone(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return DEFAULT_TENANT_TIMEZONE;
  return DateTime.now().setZone(candidate).isValid ? candidate : DEFAULT_TENANT_TIMEZONE;
}

function resolveTenantTimezone(clinic = {}) {
  const settings = clinic && typeof clinic.settings === 'object' && !Array.isArray(clinic.settings) ? clinic.settings : {};
  return normalizeTimezone(
    clinic.timezone ||
      settings.timezone ||
      settings.businessTimezone ||
      settings.business?.timezone ||
      settings.businessProfile?.timezone ||
      settings.businessProfile?.businessTimezone
  );
}

function getTenantTodayISO(options = {}) {
  if (options.todayISO && /^\d{4}-\d{2}-\d{2}$/.test(String(options.todayISO))) return String(options.todayISO);
  const timezone = normalizeTimezone(options.timezone);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? DateTime.fromJSDate(options.now) : DateTime.now();
  return now.setZone(timezone).toISODate();
}

function normalizeExpirationAlertThresholds(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const next = {
    criticalDays: Number.parseInt(String(source.criticalDays ?? DEFAULT_EXPIRATION_ALERT_THRESHOLDS.criticalDays), 10),
    urgentDays: Number.parseInt(String(source.urgentDays ?? DEFAULT_EXPIRATION_ALERT_THRESHOLDS.urgentDays), 10),
    warningDays: Number.parseInt(String(source.warningDays ?? DEFAULT_EXPIRATION_ALERT_THRESHOLDS.warningDays), 10),
    upcomingDays: Number.parseInt(String(source.upcomingDays ?? DEFAULT_EXPIRATION_ALERT_THRESHOLDS.upcomingDays), 10)
  };

  for (const key of Object.keys(next)) {
    if (!Number.isInteger(next[key]) || next[key] < 0 || next[key] > 365) {
      const error = new Error('invalid_expiration_alert_thresholds');
      error.reason = 'invalid_expiration_alert_thresholds';
      throw error;
    }
  }

  if (!(next.criticalDays <= next.urgentDays && next.urgentDays <= next.warningDays && next.warningDays <= next.upcomingDays)) {
    const error = new Error('invalid_expiration_alert_threshold_order');
    error.reason = 'invalid_expiration_alert_threshold_order';
    throw error;
  }

  return next;
}

function daysBetweenDateOnly(fromISO, toISO) {
  const from = DateTime.fromISO(fromISO, { zone: 'utc' }).startOf('day');
  const to = DateTime.fromISO(toISO, { zone: 'utc' }).startOf('day');
  if (!from.isValid || !to.isValid) return null;
  return Math.round(to.diff(from, 'days').days);
}

function humanExpirationLabel(daysUntilExpiration, status) {
  if (status === 'no_expiration') return 'Sin fecha de vencimiento';
  if (daysUntilExpiration === 0) return 'Vence hoy';
  if (daysUntilExpiration === 1) return 'Vence manana';
  if (typeof daysUntilExpiration === 'number' && daysUntilExpiration > 1) return `Vence en ${daysUntilExpiration} dias`;
  if (daysUntilExpiration === -1) return 'Vencido hace 1 dia';
  if (typeof daysUntilExpiration === 'number' && daysUntilExpiration < -1) return `Vencido hace ${Math.abs(daysUntilExpiration)} dias`;
  return status;
}

function calculateInventoryExpirationStatus(expiresAt, options = {}) {
  if (options instanceof Date) options = { now: options };
  const normalized = normalizeDateOnly(expiresAt);
  if (!normalized) {
    return { status: 'no_expiration', daysUntilExpiration: null };
  }

  const thresholds = normalizeExpirationAlertThresholds(options.thresholds);
  const todayISO = getTenantTodayISO(options);
  const daysUntilExpiration = daysBetweenDateOnly(todayISO, normalized);
  if (daysUntilExpiration === null) {
    return { status: 'no_expiration', daysUntilExpiration: null };
  }

  let status = 'normal';
  if (daysUntilExpiration < 0) status = 'expired';
  else if (daysUntilExpiration === 0) status = 'today';
  else if (daysUntilExpiration <= thresholds.criticalDays) status = 'critical';
  else if (daysUntilExpiration <= thresholds.urgentDays) status = 'urgent';
  else if (daysUntilExpiration <= thresholds.warningDays) status = 'warning';
  else if (daysUntilExpiration <= thresholds.upcomingDays) status = 'upcoming';

  return {
    status,
    daysUntilExpiration
  };
}

function isStockRelevantLot(lot, options = {}) {
  const status = String(lot?.status || '').toLowerCase();
  if (Number(lot?.availableQuantity || 0) <= 0) return false;
  if (['cancelled', 'depleted'].includes(status)) return false;
  if (status === 'quarantined' && !options.includeQuarantined) return false;
  return true;
}

function expirationStatusRank(status) {
  const ranks = {
    expired: 0,
    today: 1,
    critical: 2,
    urgent: 3,
    warning: 4,
    upcoming: 5,
    normal: 6,
    no_expiration: 7
  };
  return Object.prototype.hasOwnProperty.call(ranks, status) ? ranks[status] : 9;
}

module.exports = {
  DEFAULT_EXPIRATION_ALERT_THRESHOLDS,
  DEFAULT_TENANT_TIMEZONE,
  EXPIRATION_STATUSES,
  calculateInventoryExpirationStatus,
  expirationStatusRank,
  getTenantTodayISO,
  humanExpirationLabel,
  isStockRelevantLot,
  normalizeDateOnly,
  normalizeExpirationAlertThresholds,
  normalizeTimezone,
  resolveTenantTimezone
};
