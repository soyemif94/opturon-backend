const dotenv = require('dotenv');
const { logError, logWarn } = require('../utils/logger');
const { validateConfiguredTokensEncryptionKey } = require('../utils/secret-crypto');

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
  tokensEncryptionKey: String(process.env.TOKENS_ENCRYPTION_KEY || '').trim(),

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
  aiAssistEnabled: parseBoolean(process.env.AI_ASSIST_ENABLED, false),
  aiAssistProvider: String(process.env.AI_ASSIST_PROVIDER || 'openai').trim().toLowerCase(),
  aiAssistApiKey: String(process.env.AI_ASSIST_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
  aiAssistModel: String(process.env.AI_ASSIST_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
  aiAssistTimeoutMs: parsePositiveInt(process.env.AI_ASSIST_TIMEOUT_MS, 8000),
  aiAssistMaxMonthlyCalls: parsePositiveInt(process.env.AI_ASSIST_MAX_MONTHLY_CALLS, 2000),
  aiAssistMaxCallsPerConversation: parsePositiveInt(process.env.AI_ASSIST_MAX_CALLS_PER_CONVERSATION, 50),
  aiAssistSuggestedProdMaxCallsPerConversation: parsePositiveInt(process.env.AI_ASSIST_SUGGESTED_PROD_MAX_CALLS_PER_CONVERSATION, 15),
  aiAssistEnabledClinicIds: parseCsvList(process.env.AI_ASSIST_ENABLED_CLINIC_IDS, []),
  aiAssistDisabledClinicIds: parseCsvList(process.env.AI_ASSIST_DISABLED_CLINIC_IDS, []),
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
  appointmentReminderLeadMinutes: parsePositiveInt(process.env.APPOINTMENT_REMINDER_LEAD_MINUTES, 30),
  appointmentReminderSweepMs: parsePositiveInt(process.env.APPOINTMENT_REMINDER_SWEEP_MS, 60000),
  appointmentReminderClaimTtlMinutes: parsePositiveInt(process.env.APPOINTMENT_REMINDER_CLAIM_TTL_MINUTES, 10),

  googleSpreadsheetId: String(process.env.GOOGLE_SPREADSHEET_ID || '').trim(),
  googleSheetName: String(process.env.GOOGLE_SHEET_NAME || 'Leads').trim(),
  googleServiceAccountEmail: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
  googlePrivateKey: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  portalInternalKey: String(process.env.PORTAL_INTERNAL_KEY || '').trim(),
  resendApiKey: String(process.env.RESEND_API_KEY || '').trim(),
  resetEmailFrom: String(process.env.RESET_EMAIL_FROM || '').trim(),
  portalInvitationEmailFrom: String(process.env.PORTAL_INVITATION_EMAIL_FROM || '').trim(),
  billingEmailFrom: String(process.env.BILLING_EMAIL_FROM || '').trim(),

  mercadoPagoAccessToken: String(process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim(),
  mercadoPagoPublicKey: String(process.env.MERCADO_PAGO_PUBLIC_KEY || '').trim(),
  mercadoPagoWebhookSecret: String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim(),
  mercadoPagoEnvironment: String(process.env.MERCADO_PAGO_ENVIRONMENT || 'production').trim().toLowerCase(),
  opturonPublicAppUrl: String(process.env.OPTURON_PUBLIC_APP_URL || '').trim(),
  opturonApiPublicUrl: String(process.env.OPTURON_API_PUBLIC_URL || '').trim()
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
  if (env.databaseUrl && !env.tokensEncryptionKey) {
    missing.push('TOKENS_ENCRYPTION_KEY (required when DATABASE_URL is configured)');
  }

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

  if (env.tokensEncryptionKey) {
    try {
      validateConfiguredTokensEncryptionKey();
    } catch (error) {
      logError('TOKENS_ENCRYPTION_KEY validation failed', {
        error: error && error.message ? error.message : 'invalid_tokens_encryption_key'
      });
      process.exit(1);
    }
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

