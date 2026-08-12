const WHATSAPP_TEMPLATE_CATEGORY_UNKNOWN = 'UNKNOWN';
const WHATSAPP_TEMPLATE_STATUS_UNKNOWN = 'unknown';
const WHATSAPP_TEMPLATE_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TEMPLATE_CATEGORIES = new Set([
  'UTILITY',
  'MARKETING',
  'AUTHENTICATION'
]);

const TEMPLATE_STATUSES = new Map([
  ['PENDING', 'pending'],
  ['IN_REVIEW', 'in_review'],
  ['APPROVED', 'approved'],
  ['REJECTED', 'rejected'],
  ['PAUSED', 'paused'],
  ['DISABLED', 'disabled'],
  ['UNKNOWN', WHATSAPP_TEMPLATE_STATUS_UNKNOWN],
  ['IN_APPEAL', 'in_appeal'],
  ['PENDING_DELETION', 'pending_deletion'],
  ['FLAGGED', 'flagged'],
  ['REINSTATED', 'reinstated']
]);

function normalizeEnumValue(value) {
  return String(value || '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

function normalizeWhatsAppTemplateCategory(value) {
  const normalized = normalizeEnumValue(value);
  return TEMPLATE_CATEGORIES.has(normalized)
    ? normalized
    : WHATSAPP_TEMPLATE_CATEGORY_UNKNOWN;
}

function normalizeWhatsAppTemplateStatus(value) {
  const normalized = normalizeEnumValue(value);
  return TEMPLATE_STATUSES.get(normalized) || WHATSAPP_TEMPLATE_STATUS_UNKNOWN;
}

function isWhatsAppTemplateStatusUsable(value) {
  return normalizeWhatsAppTemplateStatus(value) === 'approved';
}

function normalizeWhatsAppTemplateLanguage(value) {
  return String(value || '').trim();
}

function extractWhatsAppTemplateBodyVariables(components) {
  const bodies = (Array.isArray(components) ? components : []).filter(
    (component) => normalizeEnumValue(component && component.type) === 'BODY'
  );
  if (bodies.length !== 1 || typeof bodies[0].text !== 'string' || !bodies[0].text.trim()) {
    return { ok: false, reason: 'body_component_invalid', variables: [] };
  }

  const text = bodies[0].text;
  const variables = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    const strayClose = text.indexOf('}}', cursor);
    if (open === -1) {
      if (strayClose !== -1) {
        return { ok: false, reason: 'body_placeholder_malformed', variables: [] };
      }
      break;
    }
    if (strayClose !== -1 && strayClose < open) {
      return { ok: false, reason: 'body_placeholder_malformed', variables: [] };
    }

    const close = text.indexOf('}}', open + 2);
    const nestedOpen = text.indexOf('{{', open + 2);
    if (close === -1 || (nestedOpen !== -1 && nestedOpen < close)) {
      return { ok: false, reason: 'body_placeholder_malformed', variables: [] };
    }

    const token = text.slice(open + 2, close);
    if (!token || [...token].some((character) => character < '0' || character > '9')) {
      return { ok: false, reason: 'body_placeholder_invalid', variables: [] };
    }
    const variable = Number(token);
    if (!Number.isSafeInteger(variable) || variable < 1 || String(variable) !== token) {
      return { ok: false, reason: 'body_placeholder_invalid', variables: [] };
    }
    variables.push(variable);
    cursor = close + 2;
  }

  return { ok: true, reason: null, variables };
}

function validateWhatsAppTemplateBodyContract(components, expectedCount) {
  const safeExpectedCount = Number(expectedCount);
  if (!Number.isInteger(safeExpectedCount) || safeExpectedCount < 1) {
    return { ok: false, reason: 'body_parameter_count_invalid', variables: [] };
  }
  const extracted = extractWhatsAppTemplateBodyVariables(components);
  if (!extracted.ok) return extracted;
  if (extracted.variables.length !== safeExpectedCount) {
    return { ok: false, reason: 'body_parameter_count_mismatch', variables: extracted.variables };
  }
  const sequential = extracted.variables.every((variable, index) => variable === index + 1);
  if (!sequential) {
    return { ok: false, reason: 'body_parameter_sequence_mismatch', variables: extracted.variables };
  }
  return { ok: true, reason: null, variables: extracted.variables };
}

function evaluateWhatsAppTemplateSyncFreshness(lastSyncedAt, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Number(options.maxAgeMs)
    : WHATSAPP_TEMPLATE_SYNC_MAX_AGE_MS;
  const syncedAt = lastSyncedAt instanceof Date ? lastSyncedAt : new Date(lastSyncedAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(syncedAt.getTime()) || maxAgeMs < 0) {
    return { fresh: false, reason: 'invalid', ageMs: null, maxAgeMs };
  }
  const ageMs = now.getTime() - syncedAt.getTime();
  if (ageMs < 0) return { fresh: false, reason: 'future', ageMs, maxAgeMs };
  if (ageMs > maxAgeMs) return { fresh: false, reason: 'stale', ageMs, maxAgeMs };
  return { fresh: true, reason: null, ageMs, maxAgeMs };
}

module.exports = {
  WHATSAPP_TEMPLATE_CATEGORY_UNKNOWN,
  WHATSAPP_TEMPLATE_STATUS_UNKNOWN,
  WHATSAPP_TEMPLATE_SYNC_MAX_AGE_MS,
  normalizeWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateStatus,
  isWhatsAppTemplateStatusUsable,
  normalizeWhatsAppTemplateLanguage,
  extractWhatsAppTemplateBodyVariables,
  validateWhatsAppTemplateBodyContract,
  evaluateWhatsAppTemplateSyncFreshness
};
