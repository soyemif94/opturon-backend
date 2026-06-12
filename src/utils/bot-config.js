const ALLOWED_BOT_TONES = new Set(['amigable', 'profesional', 'calido']);
const ALLOWED_BOT_TREATMENTS = new Set(['vos', 'usted']);

const DEFAULT_BOT_CONFIG = Object.freeze({
  name: '',
  greetingMessage: '',
  tone: 'amigable',
  treatment: 'vos',
  outOfHoursMessage: '',
  fallbackMessage: '',
  handoffMessage: ''
});

function normalizeString(value) {
  return String(value || '').trim().normalize('NFC');
}

function normalizeOptionalText(value, maxLength) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  return normalized.slice(0, maxLength);
}

function normalizeBotTone(value, fallback = DEFAULT_BOT_CONFIG.tone) {
  const normalized = normalizeString(value).toLowerCase();
  return ALLOWED_BOT_TONES.has(normalized) ? normalized : fallback;
}

function normalizeBotTreatment(value, fallback = DEFAULT_BOT_CONFIG.treatment) {
  const normalized = normalizeString(value).toLowerCase();
  return ALLOWED_BOT_TREATMENTS.has(normalized) ? normalized : fallback;
}

function normalizeBotConfig(rawConfig = {}, fallbackConfig = DEFAULT_BOT_CONFIG) {
  const base = fallbackConfig && typeof fallbackConfig === 'object' ? fallbackConfig : DEFAULT_BOT_CONFIG;
  const safe = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  return {
    name: normalizeOptionalText(safe.name !== undefined ? safe.name : base.name, 80),
    greetingMessage: normalizeOptionalText(safe.greetingMessage !== undefined ? safe.greetingMessage : base.greetingMessage, 500),
    tone: normalizeBotTone(safe.tone !== undefined ? safe.tone : base.tone, normalizeBotTone(base.tone, DEFAULT_BOT_CONFIG.tone)),
    treatment: normalizeBotTreatment(
      safe.treatment !== undefined ? safe.treatment : base.treatment,
      normalizeBotTreatment(base.treatment, DEFAULT_BOT_CONFIG.treatment)
    ),
    outOfHoursMessage: normalizeOptionalText(
      safe.outOfHoursMessage !== undefined ? safe.outOfHoursMessage : base.outOfHoursMessage,
      500
    ),
    fallbackMessage: normalizeOptionalText(safe.fallbackMessage !== undefined ? safe.fallbackMessage : base.fallbackMessage, 500),
    handoffMessage: normalizeOptionalText(safe.handoffMessage !== undefined ? safe.handoffMessage : base.handoffMessage, 500)
  };
}

function validateBotConfig(config = {}) {
  const normalized = normalizeBotConfig(config);
  const errors = {};

  if (normalized.name && normalized.name.length < 2) {
    errors.name = 'El nombre del bot debe tener al menos 2 caracteres.';
  }

  if (!ALLOWED_BOT_TONES.has(normalized.tone)) {
    errors.tone = 'El tono debe ser amigable, profesional o calido.';
  }

  if (!ALLOWED_BOT_TREATMENTS.has(normalized.treatment)) {
    errors.treatment = 'El tratamiento debe ser vos o usted.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: normalized
  };
}

module.exports = {
  ALLOWED_BOT_TONES,
  ALLOWED_BOT_TREATMENTS,
  DEFAULT_BOT_CONFIG,
  normalizeBotConfig,
  validateBotConfig
};
