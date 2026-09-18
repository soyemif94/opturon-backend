const ALLOWED_BOT_TONES = new Set(['amigable', 'profesional', 'calido']);
const ALLOWED_BOT_TREATMENTS = new Set(['vos', 'usted']);
const ALLOWED_BUSINESS_PROFILE_PRESETS = new Set([
  'wholesale_distributor',
  'retail',
  'services',
  'professional',
  'restaurant',
  'real_estate',
  'health_appointments',
  'custom'
]);
const ALLOWED_COMMERCIAL_OBJECTIVES = new Set([
  'order_generation',
  'product_sales',
  'quote',
  'appointments',
  'lead_capture',
  'inquiries',
  'custom'
]);
const ALLOWED_SALES_MODES = new Set(['consultative', 'proactive', 'direct']);
const BUSINESS_INSTRUCTIONS_MAX_LENGTH = 4000;

const DEFAULT_BOT_CONFIG = Object.freeze({
  name: '',
  greetingMessage: '',
  tone: 'amigable',
  treatment: 'vos',
  outOfHoursMessage: '',
  fallbackMessage: '',
  handoffMessage: '',
  businessProfilePreset: null,
  commercialObjective: null,
  salesMode: null,
  businessInstructions: ''
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

function normalizeNullableEnum(value, allowedValues, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback || null;
  const normalized = normalizeString(value).toLowerCase();
  return allowedValues.has(normalized) ? normalized : fallback || null;
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
    handoffMessage: normalizeOptionalText(safe.handoffMessage !== undefined ? safe.handoffMessage : base.handoffMessage, 500),
    businessProfilePreset: normalizeNullableEnum(
      safe.businessProfilePreset !== undefined ? safe.businessProfilePreset : base.businessProfilePreset,
      ALLOWED_BUSINESS_PROFILE_PRESETS,
      normalizeNullableEnum(base.businessProfilePreset, ALLOWED_BUSINESS_PROFILE_PRESETS)
    ),
    commercialObjective: normalizeNullableEnum(
      safe.commercialObjective !== undefined ? safe.commercialObjective : base.commercialObjective,
      ALLOWED_COMMERCIAL_OBJECTIVES,
      normalizeNullableEnum(base.commercialObjective, ALLOWED_COMMERCIAL_OBJECTIVES)
    ),
    salesMode: normalizeNullableEnum(
      safe.salesMode !== undefined ? safe.salesMode : base.salesMode,
      ALLOWED_SALES_MODES,
      normalizeNullableEnum(base.salesMode, ALLOWED_SALES_MODES)
    ),
    businessInstructions: normalizeOptionalText(
      safe.businessInstructions !== undefined ? safe.businessInstructions : base.businessInstructions,
      BUSINESS_INSTRUCTIONS_MAX_LENGTH
    )
  };
}

function validateBotConfig(config = {}) {
  const normalized = normalizeBotConfig(config);
  const errors = {};
  const safe = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

  if (normalized.name && normalized.name.length < 2) {
    errors.name = 'El nombre del bot debe tener al menos 2 caracteres.';
  }

  if (!ALLOWED_BOT_TONES.has(normalized.tone)) {
    errors.tone = 'El tono debe ser amigable, profesional o calido.';
  }

  if (!ALLOWED_BOT_TREATMENTS.has(normalized.treatment)) {
    errors.treatment = 'El tratamiento debe ser vos o usted.';
  }

  if (
    safe.businessProfilePreset !== null &&
    safe.businessProfilePreset !== undefined &&
    safe.businessProfilePreset !== '' &&
    !ALLOWED_BUSINESS_PROFILE_PRESETS.has(normalizeString(safe.businessProfilePreset).toLowerCase())
  ) {
    errors.businessProfilePreset = 'El perfil comercial seleccionado no es valido.';
  }

  if (
    safe.commercialObjective !== null &&
    safe.commercialObjective !== undefined &&
    safe.commercialObjective !== '' &&
    !ALLOWED_COMMERCIAL_OBJECTIVES.has(normalizeString(safe.commercialObjective).toLowerCase())
  ) {
    errors.commercialObjective = 'El objetivo comercial seleccionado no es valido.';
  }

  if (
    safe.salesMode !== null &&
    safe.salesMode !== undefined &&
    safe.salesMode !== '' &&
    !ALLOWED_SALES_MODES.has(normalizeString(safe.salesMode).toLowerCase())
  ) {
    errors.salesMode = 'El estilo comercial seleccionado no es valido.';
  }

  if (normalizeString(safe.businessInstructions).length > BUSINESS_INSTRUCTIONS_MAX_LENGTH) {
    errors.businessInstructions = `Las instrucciones no pueden superar los ${BUSINESS_INSTRUCTIONS_MAX_LENGTH} caracteres.`;
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
  ALLOWED_BUSINESS_PROFILE_PRESETS,
  ALLOWED_COMMERCIAL_OBJECTIVES,
  ALLOWED_SALES_MODES,
  BUSINESS_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_BOT_CONFIG,
  normalizeBotConfig,
  validateBotConfig
};
