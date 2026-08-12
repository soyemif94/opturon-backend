const WHATSAPP_TEMPLATE_CATEGORY_UNKNOWN = 'UNKNOWN';
const WHATSAPP_TEMPLATE_STATUS_UNKNOWN = 'unknown';

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

module.exports = {
  WHATSAPP_TEMPLATE_CATEGORY_UNKNOWN,
  WHATSAPP_TEMPLATE_STATUS_UNKNOWN,
  normalizeWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateStatus,
  isWhatsAppTemplateStatusUsable,
  normalizeWhatsAppTemplateLanguage
};
