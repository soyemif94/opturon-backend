const dotenv = require('dotenv');
const { logError, logWarn } = require('../utils/logger');

dotenv.config();

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

function parsePort(value, defaultPort) {
  const candidate = String(value || defaultPort).trim();
  const parsed = Number(candidate);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(String(value || defaultValue), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function parseCsvList(value, defaultValue = []) {
  const raw = String(value || '').trim();
  if (!raw) {
    return defaultValue.slice();
  }
  return raw
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function resolveWhatsAppGraphVersion() {
  const configuredGraphVersion = String(process.env.WHATSAPP_GRAPH_VERSION || '').trim();
  const configuredApiVersion = String(process.env.WHATSAPP_API_VERSION || '').trim();
  const resolved = String(configuredGraphVersion || configuredApiVersion || 'v25.0').trim();

  return {
    configuredGraphVersion,
    configuredApiVersion,
    resolved,
    usingDefault: !configuredGraphVersion && !configuredApiVersion
  };
}

const whatsAppGraphVersionConfig = resolveWhatsAppGraphVersion();
const resolvedWhatsAppGraphVersion = whatsAppGraphVersionConfig.resolved;

const env = {
  nodeEnv: String(process.env.NODE_ENV || 'development').trim(),
  allowDebug: parseBoolean(process.env.ALLOW_DEBUG, false),
  port: parsePort(process.env.PORT, 3001),
  host: '0.0.0.0',

  metaVerifyToken: String(process.env.META_VERIFY_TOKEN || '').trim(),
  whatsappAccessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
  whatsappPhoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
  whatsappGraphVersion: resolvedWhatsAppGraphVersion,
  whatsappApiVersion: resolvedWhatsAppGraphVersion,
  whatsappDebug: parseBoolean(process.env.WHATSAPP_DEBUG, false),
  debugApiEnabled: parseBoolean(process.env.DEBUG_API_ENABLED, false),
  debugUiEnabled: parseBoolean(process.env.DEBUG_UI_ENABLED, false),
  debugInboxMaxItems: parsePositiveInt(process.env.DEBUG_INBOX_MAX_ITEMS, 200),
  whatsappDebugKey: String(process.env.WHATSAPP_DEBUG_KEY || '').trim(),
  whatsappFromPhone: String(process.env.WHATSAPP_FROM_PHONE || '').trim(),
  whatsappAppId: String(process.env.WHATSAPP_APP_ID || '').trim(),
  whatsappWabaId: String(process.env.WHATSAPP_WABA_ID || '').trim(),

  metaAppSecret: String(process.env.META_APP_SECRET || '').trim(),
  verifySignature: parseBoolean(process.env.VERIFY_SIGNATURE, false),
  whatsappSandboxArNormalize: parseBoolean(process.env.WHATSAPP_SANDBOX_AR_NORMALIZE, false),

  openaiApiKey: String(process.env.OPENAI_API_KEY || '').trim(),
  openaiModel: String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
  aiEnabled: parseBoolean(process.env.AI_ENABLED, false),
  openaiTimeoutMs: parsePositiveInt(process.env.OPENAI_TIMEOUT_MS, 15000),
  aiAllowedStates: parseCsvList(process.env.AI_ALLOWED_STATES, ['READY', 'ASKED_NAME']),
  aiDeniedStates: parseCsvList(process.env.AI_DENIED_STATES, [
    'CONFIRM_APPOINTMENT',
    'ASKED_APPOINTMENT_DATETIME',
    'ASKED_APPOINTMENT_TIMEWINDOW'
  ]),
  aiAllowedJobTypes: parseCsvList(process.env.AI_ALLOWED_JOB_TYPES, ['conversation_reply']),
  aiMaxCallsPerConversationWindow: parsePositiveInt(process.env.AI_MAX_CALLS_PER_CONVERSATION_WINDOW, 5),
  aiWindowMs: parsePositiveInt(process.env.AI_WINDOW_MS, 3600000),
  aiEnabledClinicIds: parseCsvList(process.env.AI_ENABLED_CLINIC_IDS, []),
  aiDisabledClinicIds: parseCsvList(process.env.AI_DISABLED_CLINIC_IDS, []),
  aiEnabledChannelIds: parseCsvList(process.env.AI_ENABLED_CHANNEL_IDS, []),
  aiDisabledChannelIds: parseCsvList(process.env.AI_DISABLED_CHANNEL_IDS, []),
  qaAgendaBypassContactIds: parseCsvList(process.env.QA_AGENDA_BYPASS_CONTACT_IDS, []),
  qaAgendaBypassContactWaIds: parseCsvList(process.env.QA_AGENDA_BYPASS_CONTACT_WA_IDS, []),
  qaAgendaBypassChannelIds: parseCsvList(process.env.QA_AGENDA_BYPASS_CHANNEL_IDS, []),
  autoReplyEnabled: parseBoolean(process.env.AUTO_REPLY_ENABLED, false),
  legacyWebhookAutoReplyEnabled: parseBoolean(process.env.LEGACY_WEBHOOK_AUTO_REPLY_ENABLED, false),

  storageMode: String(process.env.STORAGE_MODE || 'json').trim().toLowerCase(),
  jsonDbPath: String(process.env.JSON_DB_PATH || './data/patients.json').trim(),
  usersDbPath: String(process.env.USERS_DB_PATH || './data/users.json').trim(),
  scheduleDbPath: String(process.env.SCHEDULE_DB_PATH || './data/schedule.json').trim(),
  databaseUrl: String(process.env.DATABASE_URL || '').trim(),
  workerId: String(process.env.WORKER_ID || 'worker-1').trim(),
  workerPollMs: parsePositiveInt(process.env.WORKER_POLL_MS, 1000),
  workerBatchSize: parsePositiveInt(process.env.WORKER_BATCH_SIZE, 10),
  defaultAppointmentDaysAhead: parsePositiveInt(process.env.DEFAULT_APPOINTMENT_DAYS_AHEAD, 7),
  defaultHoldMinutes: parsePositiveInt(process.env.DEFAULT_HOLD_MINUTES, 10),

  googleSpreadsheetId: String(process.env.GOOGLE_SPREADSHEET_ID || '').trim(),
  googleSheetName: String(process.env.GOOGLE_SHEET_NAME || 'Leads').trim(),
  googleServiceAccountEmail: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
  googlePrivateKey: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  portalInternalKey: String(process.env.PORTAL_INTERNAL_KEY || '').trim()
};

function collectEnvValidation() {
  const missing = [];

  if (!env.port) {
    missing.push('PORT (positive integer)');
  }

  if (env.whatsappDebug && !env.whatsappDebugKey) {
    missing.push('WHATSAPP_DEBUG_KEY (required when WHATSAPP_DEBUG=true)');
  }

  const warnings = [];
  if (!env.whatsappAccessToken) warnings.push('WHATSAPP_ACCESS_TOKEN');
  if (!env.whatsappPhoneNumberId) warnings.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!env.metaVerifyToken) warnings.push('META_VERIFY_TOKEN');
  if (!env.databaseUrl) warnings.push('DATABASE_URL');

  return {
    missing,
    warnings,
    ok: missing.length === 0
  };
}

function validateEnvOrExit() {
  const validation = collectEnvValidation();

  if (validation.missing.length > 0) {
    logError('Environment validation failed', {
      missing: validation.missing,
      nodeEnv: env.nodeEnv
    });
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    logWarn('Environment validation warnings', {
      warnings: validation.warnings,
      nodeEnv: env.nodeEnv
    });
  }

  if (!env.metaAppSecret && env.verifySignature) {
    logWarn('VERIFY_SIGNATURE=true but META_APP_SECRET is empty. Signature validation will fail.');
  }

  const configuredGraphVersion = whatsAppGraphVersionConfig.configuredGraphVersion;
  const configuredApiVersion = whatsAppGraphVersionConfig.configuredApiVersion;
  if (
    configuredGraphVersion &&
    configuredApiVersion &&
    configuredGraphVersion !== configuredApiVersion
  ) {
    logWarn('WHATSAPP_GRAPH_VERSION and WHATSAPP_API_VERSION differ. Using WHATSAPP_GRAPH_VERSION as source of truth.', {
      whatsappGraphVersion: configuredGraphVersion,
      whatsappApiVersion: configuredApiVersion,
      resolvedWhatsAppGraphVersion
    });
  }

  if (whatsAppGraphVersionConfig.usingDefault) {
    logWarn('WHATSAPP_GRAPH_VERSION is not configured. Defaulting to v25.0.', {
      resolvedWhatsAppGraphVersion
    });
  }

}

module.exports = {
  ...env,
  collectEnvValidation,
  validateEnvOrExit,
  getWhatsAppGraphVersion: () => resolvedWhatsAppGraphVersion
};

