require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { DateTime } = require('luxon');
const env = require('./config/env');
const { withTransaction } = require('./db/client');
const { logInfo, logWarn, logError } = require('./utils/logger');
const { findChannelById, findPreferredWhatsAppChannelByClinicId } = require('./repositories/tenant.repository');
const { updateClinicBotRuntimeConfigById } = require('./repositories/tenant.repository');
const { findContactById, findContactByIdAndClinicId, updateContact } = require('./repositories/contact.repository');
const {
  findConversationById,
  updateConversationStatus,
  updateConversationStage
} = require('./repositories/conversation.repository');
const { getMessageById } = require('./repositories/message.repository');
const { sendChannelScopedMessage } = require('./whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('./whatsapp/normalize-phone');
const conversationRepo = require('./conversations/conversation.repo');
const { decideReply } = require('./conversations/conversation.engine');
const { parseAppointmentText } = require('./conversations/appointment.parser');
const { listProductsByClinicId, findProductById } = require('./repositories/products.repository');
const { createOrderForClinic, patchOrderStatusForClinic } = require('./services/portal-orders.service');
const { generateReply } = require('./ai/openai.client');
const { buildAiMessages } = require('./ai/context.builder');
const {
  upsertLeadForConversation,
  updateLeadStatus,
  findLeadByConversation,
  assignLead
} = require('./repositories/lead.repository');
const {
  getOrCreateCalendarRules,
  holdSlot,
  bookHeldSlot,
  releaseExpiredHolds,
  getClinic,
  findBookedAppointmentByConversation,
  cancelAppointment
} = require('./repositories/calendar.repository');
const { getDefaultAssignee } = require('./repositories/staff.repository');
const { openHandoff, assignHandoff, getOpenHandoff } = require('./repositories/handoff.repository');
const {
  addEvent,
  findLatestEventByType,
  countRecentEventsByType
} = require('./repositories/conversation-events.repository');
const { claimJobs, markJobDone, requeueOrFailJob } = require('./repositories/job.repository');
const { resolveAutomationReplyForInbound } = require('./services/automation-runtime.service');
const { getAutomationEnablementState } = require('./services/automation-enablement.service');
const { classifyCommerceAiAssist } = require('./services/ai-assist.service');
const {
  suggestClinicAgendaSlots,
  createClinicAgendaBotReservation
} = require('./services/portal-agenda.service');
const { getLoyaltyWhatsAppSnapshotByClinicId } = require('./services/portal-loyalty.service');
const {
  listDueAgendaReminderCandidates,
  claimAgendaItemReminder,
  markAgendaItemReminderSent,
  releaseAgendaItemReminderClaim,
  findLatestActiveAgendaAppointmentByConversation,
  updateAgendaItemById,
  listAgendaItemsByClinicAndRange,
  createAgendaItem
} = require('./repositories/agenda-items.repository');
const {
  buildTransferInstructionsText,
  hasConfiguredTransferData,
  normalizeTransferConfig
} = require('./utils/transfer-config');
const { maybeRunArchivedContactCleanup } = require('./services/contact-archive-cleanup.service');

const WORKER_ID = env.workerId || 'worker-1';
const POLL_MS = Number(env.workerPollMs || 1000);
const BATCH_SIZE = Number(env.workerBatchSize || 10);
const DAYS_AHEAD = Number(env.defaultAppointmentDaysAhead || 7);
const HOLD_MINUTES = Number(env.defaultHoldMinutes || 10);
const AI_ALLOWED_STATES = new Set((env.aiAllowedStates || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
const AI_DENIED_STATES = new Set((env.aiDeniedStates || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
const AI_ALLOWED_JOB_TYPES = new Set((env.aiAllowedJobTypes || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));
const AI_MAX_CALLS_PER_WINDOW = Number(env.aiMaxCallsPerConversationWindow || 5);
const AI_WINDOW_MS = Number(env.aiWindowMs || 3600000);
const AI_ENABLED_CLINIC_IDS = new Set((env.aiEnabledClinicIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_DISABLED_CLINIC_IDS = new Set((env.aiDisabledClinicIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_ENABLED_CHANNEL_IDS = new Set((env.aiEnabledChannelIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_DISABLED_CHANNEL_IDS = new Set((env.aiDisabledChannelIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const QA_AGENDA_BYPASS_CONTACT_IDS = new Set((env.qaAgendaBypassContactIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const QA_AGENDA_BYPASS_CONTACT_WA_IDS = new Set((env.qaAgendaBypassContactWaIds || []).map((s) => normalizeDigitsOnly(s)).filter(Boolean));
const QA_AGENDA_BYPASS_CHANNEL_IDS = new Set((env.qaAgendaBypassChannelIds || []).map((s) => String(s || '').trim()).filter(Boolean));

let stopped = false;
let polling = false;
let processingCount = 0;
let timer = null;
let started = false;
let lastReminderSweepAt = 0;
const aiBudget = new Map();
const APPOINTMENT_REMINDER_LEAD_MINUTES = Number(env.appointmentReminderLeadMinutes || 30);
const APPOINTMENT_REMINDER_SWEEP_MS = Number(env.appointmentReminderSweepMs || 60000);
const APPOINTMENT_REMINDER_CLAIM_TTL_MINUTES = Number(env.appointmentReminderClaimTtlMinutes || 10);
const GENERATED_SALES_BOT_TEMPLATE_KEY = 'generated_sales_bot';

function sanitizeDatabaseUrl(databaseUrl) {
  const raw = String(databaseUrl || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname || 'localhost';
    const port = parsed.port || '5432';
    const dbname = (parsed.pathname || '').replace(/^\//, '') || null;
    return { hostPort: `${host}:${port}`, dbname };
  } catch (error) {
    const match = raw.match(/@([^/]+)\/([^?\s]+)/);
    if (!match) return null;
    return { hostPort: match[1], dbname: match[2] || null };
  }
}

function mergeContextPatches(basePatch, extraPatch) {
  if (!basePatch && !extraPatch) return null;
  if (!basePatch) return extraPatch;
  if (!extraPatch) return basePatch;

  const merged = { ...basePatch, ...extraPatch };
  if (Array.isArray(basePatch.portalTags) || Array.isArray(extraPatch.portalTags)) {
    merged.portalTags = Array.from(
      new Set([...(Array.isArray(basePatch.portalTags) ? basePatch.portalTags : []), ...(Array.isArray(extraPatch.portalTags) ? extraPatch.portalTags : [])])
    );
  }
  return merged;
}

function normalizeText(input) {
  return String(input || '').trim().toLowerCase();
}

function normalizeCommandText(input) {
  return applyBasicConversationalNormalizations(
    String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?]+$/g, '')
    .trim()
  );
}

function applyBasicConversationalNormalizations(text) {
  let normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return '';

  if (/^hol+a+$/.test(normalized) || /^ola+s*$/.test(normalized) || normalized === 'ols') {
    return 'hola';
  }

  if (normalized === 'q tal') return 'que tal';

  normalized = normalized
    .replace(/\bholis+\b/g, 'hola')
    .replace(/\bbuenass+\b/g, 'buenas')
    .replace(/\bgrax\b/g, 'gracias')
    .replace(/\bgrasias\b/g, 'gracias')
    .replace(/\bgraxias\b/g, 'gracias')
    .replace(/\bgraciass+\b/g, 'gracias')
    .replace(/\bpresio(s)?\b/g, 'precio$1')
    .replace(/\btransferecnia\b/g, 'transferencia')
    .replace(/\baseptan\b/g, 'aceptan')
    .replace(/\bqiero\b/g, 'quiero')
    .replace(/\bq\s*onda\b/g, 'que onda')
    .replace(/\bcuant\b/g, 'cuanto')
    .replace(/\binfoo+\b/g, 'info')
    .replace(/\bnesecito\b/g, 'necesito')
    .replace(/\bnesesito\b/g, 'necesito')
    .replace(/\boki+\b/g, 'ok')
    .replace(/\bokey\b/g, 'ok')
    .replace(/\bokei\b/g, 'ok')
    .replace(/\bokay\b/g, 'ok')
    .replace(/\bbuenisim[oa]\b/g, 'buenisimo')
    .replace(/\bbarbaroo+\b/g, 'barbaro')
    .replace(/\bgenia+l+\b/g, 'genial')
    .replace(/\bq\s+/g, 'que ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function normalizeDigitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function parseJobPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error('Invalid JSON payload for job');
    }
  }
  throw new Error('Unsupported job payload format');
}

function sanitizeAiUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return {
    prompt_tokens:
      usage.prompt_tokens !== undefined && usage.prompt_tokens !== null
        ? Number(usage.prompt_tokens)
        : null,
    completion_tokens:
      usage.completion_tokens !== undefined && usage.completion_tokens !== null
        ? Number(usage.completion_tokens)
        : null,
    total_tokens:
      usage.total_tokens !== undefined && usage.total_tokens !== null
        ? Number(usage.total_tokens)
        : null
  };
}

function reserveAiBudget(conversationId) {
  const now = Date.now();
  const key = String(conversationId || '').trim();
  if (!key) {
    return { allowed: false, reason: 'missing_conversation_id', usedCount: 0 };
  }

  const current = aiBudget.get(key);
  if (!current || now - current.windowStartMs > AI_WINDOW_MS) {
    const fresh = { windowStartMs: now, usedCount: 1 };
    aiBudget.set(key, fresh);
    return { allowed: true, usedCount: fresh.usedCount };
  }

  if (current.usedCount >= AI_MAX_CALLS_PER_WINDOW) {
    return { allowed: false, reason: 'rate_limited', usedCount: current.usedCount };
  }

  current.usedCount += 1;
  aiBudget.set(key, current);
  return { allowed: true, usedCount: current.usedCount };
}

function evaluateAiEligibility({ jobType, state }) {
  const normalizedJobType = String(jobType || '').trim().toLowerCase();
  const normalizedState = String(state || '').trim().toUpperCase();

  if (AI_ALLOWED_JOB_TYPES.size > 0 && !AI_ALLOWED_JOB_TYPES.has(normalizedJobType)) {
    return { allowed: false, reason: 'job_type_not_allowed' };
  }

  if (AI_DENIED_STATES.has(normalizedState)) {
    return { allowed: false, reason: 'state_denied' };
  }

  if (AI_ALLOWED_STATES.size > 0 && !AI_ALLOWED_STATES.has(normalizedState)) {
    return { allowed: false, reason: 'state_not_allowed' };
  }

  return { allowed: true, reason: null };
}

function isAiAllowedForScope({ clinicId, channelId }) {
  const safeClinicId = String(clinicId || '').trim();
  const safeChannelId = String(channelId || '').trim();

  if (safeClinicId && AI_DISABLED_CLINIC_IDS.has(safeClinicId)) {
    return { ok: false, reason: 'clinic_denied' };
  }

  if (safeChannelId && AI_DISABLED_CHANNEL_IDS.has(safeChannelId)) {
    return { ok: false, reason: 'channel_denied' };
  }

  if (AI_ENABLED_CLINIC_IDS.size > 0 && (!safeClinicId || !AI_ENABLED_CLINIC_IDS.has(safeClinicId))) {
    return { ok: false, reason: 'clinic_not_allowed' };
  }

  if (AI_ENABLED_CHANNEL_IDS.size > 0 && (!safeChannelId || !AI_ENABLED_CHANNEL_IDS.has(safeChannelId))) {
    return { ok: false, reason: 'channel_not_allowed' };
  }

  return { ok: true, reason: null };
}

function isQaAgendaBypassScope({ contact, channel, contactId, channelId }) {
  const safeContactId = String((contact && contact.id) || contactId || '').trim();
  const safeChannelId = String((channel && channel.id) || channelId || '').trim();
  const safeWaId = normalizeDigitsOnly((contact && (contact.waId || contact.phone)) || '');

  return Boolean(
    (safeContactId && QA_AGENDA_BYPASS_CONTACT_IDS.has(safeContactId)) ||
      (safeWaId && QA_AGENDA_BYPASS_CONTACT_WA_IDS.has(safeWaId)) ||
      (safeChannelId && QA_AGENDA_BYPASS_CHANNEL_IDS.has(safeChannelId))
  );
}

function shouldBypassCommerceForQa({ contact, channel, contactId, channelId, inboundText }) {
  const text = String(inboundText || '').toLowerCase();
  const looksLikeAppointment =
    text.includes('turno') ||
    text.includes('horario') ||
    text.includes('agenda');

  return looksLikeAppointment && isQaAgendaBypassScope({ contact, channel, contactId, channelId });
}

function detectIntent(rawText) {
  const text = normalizeCommandText(rawText);
  const commercialIntent = detectCommercialIntent(text);

  const appointmentWords = /(turno|cita|agenda|sacar turno|reservar|agendar)/i;
  const urgentWords = /(dolor|urgencia|sangrado|inflamado|se me sali[oó]|me duele mucho)/i;
  const pricingWords = /(precio|cuanto|valor|costo|info)/i;
  const humanWords = /(humano|recepcion|llamar|asesor|hablar con una persona|pasame con una persona|quiero una persona)/i;

  if (urgentWords.test(text)) return 'urgent';
  if (commercialIntent.type === 'human_handoff') return 'human';
  if (commercialIntent.type === 'loyalty') return 'loyalty';
  if (commercialIntent.type === 'prices') return 'pricing';
  if (humanWords.test(text)) return 'human';
  if (appointmentWords.test(text)) return 'appointment';
  if (isLoyaltyIntent(text)) return 'loyalty';
  if (pricingWords.test(text)) return 'pricing';
  return 'unknown';
}

function isGreeting(rawText) {
  return isGreetingIntent(rawText);
}

function isAffirmativeIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  if (/^si+i*$/.test(text)) {
    return true;
  }

  const exactMatches = new Set([
    'dale',
    'de una',
    'obvio',
    'claro',
    'ok',
    'joya',
    'genial',
    'perfecto',
    'buenisimo',
    'a ver',
    'aver',
    'haber',
    'quiero',
    'quiero ver',
    'mostrame',
    'contame',
    'decime',
    'segui',
    'explicame',
    'quiero saber',
    'que mas',
    'y despues',
    'como funciona',
    'como seria',
    'mandale'
  ]);

  if (exactMatches.has(text)) {
    return true;
  }

  return (
    text.includes('quiero ver') ||
    text.includes('mostrame') ||
    text.includes('contame') ||
    text.includes('decime') ||
    text.includes('segui') ||
    text.includes('explicame') ||
    text.includes('quiero saber') ||
    text.includes('que mas') ||
    text.includes('y despues') ||
    text.includes('como funciona') ||
    text.includes('como seria')
  );
}

function isNegativeIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    [
      'no',
      'nop',
      'no gracias',
      'paso',
      'ahora no',
      'despues',
      'mas tarde',
      'otro momento',
      'no quiero',
      'no me interesa'
    ].includes(text) ||
    text.includes('no gracias') ||
    text.includes('no me interesa') ||
    text.includes('otro momento')
  );
}

function isClarificationIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  const exactMatches = new Set([
    'cuanto',
    'cuanto sale',
    'precio',
    'que incluye',
    'que trae',
    'como es',
    'como funciona',
    'como seria',
    'no entiendo',
    'no entendi',
    'explicame'
  ]);

  if (exactMatches.has(text)) {
    return true;
  }

  return (
    text.includes('cuanto sale') ||
    text.includes('que incluye') ||
    text.includes('que trae') ||
    text.includes('como funciona') ||
    text.includes('como seria') ||
    text.includes('no entiendo') ||
    text.includes('no entendi') ||
    text.includes('explicame')
  );
}

function isGreetingIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    [
      'hola',
      'buen dia',
      'buenas',
      'que tal',
      'como estas',
      'como andas',
      'holi',
      'holis',
      'hello',
      'buenos dias',
      'buenas tardes',
      'buenas noches',
      'que onda',
      'todo bien'
    ].includes(text) ||
    /^hol+a+$/.test(text)
  );
}

function isThanksIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    [
      'gracias',
      'muchas gracias',
      'mil gracias',
      'joya gracias',
      'perfecto gracias',
      'genial gracias'
    ].includes(text) ||
    text.endsWith(' gracias')
  );
}

function normalizeSemanticIntentText(rawText) {
  return normalizeCommandText(rawText)
    .replace(/[^\w\s]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMERCIAL_OFFER_PATTERNS = [
  /\b(?:quiero|qiero)\s+saber\s+que\s+planes\s+tienen\b/,
  /\bque\s+planes\s+tienen\b/,
  /\bcuales\s+son\s+los\s+planes\b/,
  /\bque\s+ofrecen\b/,
  /\bque\s+incluye\b/,
  /\bque\s+trae\b/,
  /\bcomo\s+funciona\b/,
  /\bcomo\s+trabajan\b/,
  /\bquiero\s+informacion\b/,
  /\bquiero\s+info\b/,
  /\bcontame\s+un\s+poco\b/,
  /\bcontame\s+mas\b/,
  /\bquiero\s+saber\s+mas\b/,
  /\bme\s+contas\b/,
  /\bque\s+manejan\b/,
  /\bquiero\s+ver\s+productos\b/,
  /\bquiero\s+ver\s+planes\b/
];

function buildCommercialIntentSpec({ exact = [], includes = [], patterns = [] }) {
  return {
    exact: new Set(exact.map((item) => normalizeSemanticIntentText(item)).filter(Boolean)),
    includes: includes.map((item) => normalizeSemanticIntentText(item)).filter(Boolean),
    patterns
  };
}

const COMMERCIAL_INTENT_MAP = {
  products: buildCommercialIntentSpec({
    exact: [
      'productos',
      'catalogo',
      'planes',
      'que planes tienen',
      'cuales son los planes',
      'que ofrecen',
      'que incluye',
      'que trae',
      'como funciona',
      'como trabajan',
      'quiero informacion',
      'quiero info',
      'contame un poco',
      'contame mas',
      'quiero saber mas',
      'que venden',
      'que tienen',
      'quiero ver',
      'quiero saber que planes tienen',
      'mostrame cosas',
      'mostrar productos',
      'quiero comprar',
      'quiero ver opciones'
    ],
    includes: [
      'planes',
      'que planes tienen',
      'cuales son los planes',
      'que ofrecen',
      'que incluye',
      'que trae',
      'como funciona',
      'como trabajan',
      'quiero informacion',
      'quiero info',
      'contame un poco',
      'contame mas',
      'quiero saber mas',
      'ver productos',
      'mostrar productos',
      'ver opciones',
      'mostrar opciones',
      'que venden',
      'que tienen',
      'quiero comprar'
    ],
    patterns: COMMERCIAL_OFFER_PATTERNS
  }),
  prices: buildCommercialIntentSpec({
    exact: ['precio', 'precios', 'cuanto sale', 'cuanto cuesta', 'cuanto vale', 'tienen precios', 'costos', 'valor', 'planes y precios'],
    includes: ['precio', 'precios', 'cuanto sale', 'cuanto cuesta', 'cuanto vale', 'costos', 'valor', 'planes y precios']
  }),
  location: buildCommercialIntentSpec({
    exact: ['donde estan', 'ubicacion', 'direccion', 'como llego', 'local', 'donde queda'],
    includes: ['donde estan', 'ubicacion', 'direccion', 'como llego', 'donde queda', 'andan por', 'estan por']
  }),
  hours: buildCommercialIntentSpec({
    exact: ['horario', 'horarios', 'abren hoy', 'a que hora', 'estan abiertos', 'hasta que hora'],
    includes: ['horario', 'horarios', 'abren hoy', 'a que hora', 'estan abiertos', 'hasta que hora', 'abren']
  }),
  payment: buildCommercialIntentSpec({
    exact: [
      'como pago',
      'transferencia',
      'efectivo',
      'tarjeta',
      'alias',
      'cbu',
      'cuotas',
      'mercadopago',
      'mercado pago',
      'formas de pago',
      'medios de pago',
      'como te transfiero',
      'donde te transfiero',
      'como abono',
      'pasame alias',
      'pasame cbu',
      'me pasas alias',
      'me pasas cbu',
      'aceptan transferencia'
    ],
    includes: [
      'como pago',
      'transferencia',
      'efectivo',
      'tarjeta',
      'alias',
      'cbu',
      'cuotas',
      'mercadopago',
      'mercado pago',
      'formas de pago',
      'medios de pago',
      'como te transfiero',
      'te puedo transferir',
      'puedo transferirte',
      'como hago para pagarte',
      'como abono',
      'donde te transfiero',
      'pasame alias',
      'pasame cbu',
      'me pasas alias',
      'me pasas cbu',
      'aceptan transferencia',
      'aceptan transferecnia',
      'pagar por transferencia',
      'pagar en transferencia',
      'te mando comprobante',
      'te envio comprobante',
      'ya transferi',
      'ya pague'
    ],
    patterns: [
      /\bcomo\s+pago\b/,
      /\bformas?\s+de\s+pago\b/,
      /\bmedios?\s+de\s+pago\b/,
      /\bcomo\s+te\s+transfier[oa]\b/,
      /\bte\s+puedo\s+transferir\b/,
      /\bpuedo\s+transferirte\b/,
      /\bcomo\s+hago\s+para\s+pagarte\b/,
      /\bcomo\s+abono\b/,
      /\bdonde\s+te\s+transfier[oa]\b/,
      /\bme\s+pasas\s+(alias|cbu)\b/,
      /\bpasame\s+(alias|cbu)\b/,
      /\bacepta(?:n|s)\s+transf(?:erencia|erecnia)\b/,
      /\bpagar\s+(?:por|en)\s+transf(?:erencia|erecnia)\b/,
      /\b(?:te\s+)?(?:mando|mande|envio|envie)\s+(?:el\s+)?comprobante\b/,
      /\bya\s+(?:transferi|pague)\b/
    ]
  }),
  delivery: buildCommercialIntentSpec({
    exact: ['hacen envios', 'hacen delivery', 'envian', 'envio', 'mandan', 'reparten'],
    includes: ['envio', 'envian', 'delivery', 'mandan', 'reparten'],
    patterns: [/\bhacen\s+(envios|delivery)\b/, /\btienen\s+envios\b/]
  }),
  stock: buildCommercialIntentSpec({
    exact: ['stock', 'tienen stock', 'hay stock', 'disponibilidad', 'disponible', 'tienen disponible'],
    includes: ['stock', 'disponibilidad', 'disponible'],
    patterns: [/\b(tienen|hay)\s+stock\b/, /\bhay\s+disponibilidad\b/, /\besta\s+disponible\b/]
  }),
  promotions: buildCommercialIntentSpec({
    exact: ['promos', 'promociones', 'ofertas', 'descuentos'],
    includes: ['promo', 'promocion', 'oferta', 'descuento']
  }),
    human_handoff: buildCommercialIntentSpec({
      exact: ['quiero hablar con alguien', 'una persona', 'humano', 'quiero un asesor', 'quiero un vendedor'],
      includes: ['hablar con alguien', 'una persona', 'humano', 'hablar con un asesor', 'hablar con un vendedor', 'pasame con un asesor', 'pasame con un vendedor']
    }),
  recommendation: buildCommercialIntentSpec({
    exact: [
      'que recomendas',
      'que me recomendas',
      'cual me recomendas',
      'que plan me recomendas',
      'cual recomendas',
      'cual me conviene',
      'me conviene',
      'que plan me conviene',
      'cual elegirias vos',
      'para mi negocio cual sirve',
      'cual me sirve',
      'que plan me sirve',
      'algo mas barato',
      'algo mas economico',
      'algo mas accesible',
      'que me sugeris'
    ],
    includes: [
      'que recomendas',
      'que me recomendas',
      'cual me recomendas',
      'que plan me recomendas',
      'cual recomendas',
      'cual me conviene',
      'me conviene',
      'que plan me conviene',
      'cual elegirias vos',
      'para mi negocio cual sirve',
      'cual me sirve',
      'que plan me sirve',
      'algo mas barato',
      'algo mas economico',
      'algo mas accesible',
      'que me sugeris',
      'que sugeris',
      'recomendame'
    ],
    patterns: [
      /\bque\s+me\s+recomendas\b/,
      /\bcual\s+me\s+recomendas\b/,
      /\bque\s+plan\s+me\s+recomendas\b/,
      /\bcual\s+me\s+sirve\b/,
      /\bque\s+plan\s+me\s+sirve\b/,
      /\bcual\s+elegirias\s+vos\b/,
      /\bpara\s+mi\s+negocio\s+cual\s+sirve\b/,
      /\bme\s+conviene\b/,
      /\balgo\s+mas\s+(economico|accesible|barato)\b/
    ]
  }),
  loyalty: buildCommercialIntentSpec({
    exact: ['puntos', 'beneficios', 'fidelizacion', 'recompensas'],
    includes: ['puntos', 'beneficios', 'fidelizacion', 'recompensas']
  })
};

const COMMERCIAL_INTENT_PRIORITY = [
  'loyalty',
  'human_handoff',
  'payment',
  'delivery',
  'stock',
  'promotions',
  'recommendation',
  'location',
  'hours',
  'prices',
  'products'
];

function matchesCommercialIntent(text, spec) {
  if (!text || !spec) return false;
  if (spec.exact.has(text)) return true;
  if (spec.includes.some((item) => text.includes(item))) return true;
  if (spec.patterns.some((pattern) => pattern.test(text))) return true;
  return false;
}

function detectCommercialIntent(rawText) {
  const text = normalizeSemanticIntentText(rawText);
  if (!text) {
    return { type: 'unknown' };
  }

  for (const type of COMMERCIAL_INTENT_PRIORITY) {
    if (matchesCommercialIntent(text, COMMERCIAL_INTENT_MAP[type])) {
      return { type };
    }
  }

  return { type: 'unknown' };
}

function isLoyaltyIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  if (
    text === 'puntos' ||
    text === 'mis puntos' ||
    text === 'quiero ver mis puntos' ||
    text === 'estado de fidelizacion' ||
    text === 'mi cuenta'
  ) {
    return true;
  }

  if (
    text.includes('cuantos puntos') ||
    text.includes('cuanto puntos') ||
    text.includes('tengo puntos') ||
    text.includes('ver mis puntos') ||
    text.includes('mis punto') ||
    text.includes('estado de fidel') ||
    text.includes('quiero ver puntos') ||
    text.includes('tengo beneficios') ||
    text.includes('que beneficios') ||
    text.includes('que descuento tengo') ||
    text.includes('que descuent') ||
    text.includes('tengo premios') ||
    text.includes('cuanto acumule') ||
    text.includes('cuanto acumul') ||
    text.includes('mis beneficios') ||
    text.includes('programa de beneficios')
  ) {
    return true;
  }

  if (/\bfideli[sz]a?cion\b/.test(text) || /\bfideliza\b/.test(text)) {
    return true;
  }

  if (
    /\bpremi(os?)?\b/.test(text) ||
    /\bbenefici(os?)?\b/.test(text) ||
    text.includes('mi descuento') ||
    text.includes('tengo descuento') ||
    text.includes('descuento tengo')
  ) {
    return true;
  }

  if (/\bpunts\b/.test(text) || /\bpunto(s)?\b/.test(text)) {
    return true;
  }

  if (text.includes('cuanto tengo') && !/(pagar|sale|precio|costo|valor|cuesta)/.test(text)) {
    return true;
  }

  return false;
}

const BOT_ROUTER_APPOINTMENT_STATES = new Set([
  'ASKED_APPOINTMENT_DATETIME',
  'ASKED_APPOINTMENT_TIMEWINDOW',
  'SELECT_APPOINTMENT_SLOT',
  'CONFIRM_APPOINTMENT',
  'ASKED_APPOINTMENT_NAME',
  'ASKED_APPOINTMENT_NOTE'
]);

const BOT_ROUTER_COMMERCE_STATES = new Set([
  'WAITING_PRODUCT_SELECTION',
  'WAITING_QUANTITY'
]);

const BOT_ROUTER_DEMO_STATES = new Set([
  'DEMO'
]);

function parseClinicSettingsObject(clinic) {
  if (!clinic || typeof clinic !== 'object') return {};
  const raw = clinic.settings;
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveClinicBotMode(clinic) {
  const settings = parseClinicSettingsObject(clinic);
  const candidates = [
    settings && settings.bot && settings.bot.mode,
    settings && settings.botMode,
    settings && settings.whatsapp && settings.whatsapp.botMode,
    settings && settings.portal && settings.portal.botMode
  ];

  for (const value of candidates) {
    const safe = String(value || '').trim().toLowerCase();
    if (safe === 'automatic' || safe === 'sales' || safe === 'agenda') {
      return safe;
    }
    if (safe === 'hybrid') {
      return 'automatic';
    }
  }

  return 'automatic';
}

function hasAgendaContext(safeContext) {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  return Boolean(
    context.appointmentFlowPhase ||
      context.appointmentSelectedSlot ||
      context.appointmentSuggestionsForDate ||
      (Array.isArray(context.appointmentSuggestions) && context.appointmentSuggestions.length > 0)
  );
}

function hasDemoContext(safeContext) {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  const demoStep = Number(context.commerceDemoStep || 0);
  const activationState = String(context.commerceActivationOfferState || '').trim().toLowerCase();
  return (
    activationState === 'demo' ||
    String(context.demoEntrySource || '').trim().length > 0 ||
    (Number.isInteger(demoStep) && demoStep > 0)
  );
}

function isExplicitCommerceTrigger(rawText) {
  const text = normalizeCommandText(rawText);
  const commercialIntent = detectCommercialIntent(text);
  if (!text) return false;

  const triggers = [
    'productos',
    'producto',
    'catalogo',
    'catálogo',
    'comprar',
    'compra',
    'precio',
    'precios',
    'plan',
    'planes',
    'pedido',
    'pedidos'
  ];

  return (
    ['products', 'prices', 'promotions', 'recommendation'].includes(commercialIntent.type) ||
    Boolean(detectBusinessRecommendationContext(text)) ||
    Boolean(detectCommercialSalesContext(text)) ||
    triggers.some((trigger) => text.includes(normalizeCommandText(trigger))) ||
    isPlanComparisonIntent(text) ||
    isPlanRecommendationIntent(text) ||
    isPlanPricingIntent(text)
  );
}

function isCommercialOfferIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return COMMERCIAL_OFFER_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeAgendaIntent({ inboundText, intent, managementIntent }) {
  if (managementIntent) return true;
  if (intent === 'appointment') return true;
  const text = normalizeCommandText(inboundText);
  return (
    text.includes('turno') ||
    text.includes('agenda') ||
    text.includes('horario') ||
    text.includes('reserv') ||
    text.includes('disponib')
  );
}

function normalizeConversationBotDomainOverride(safeContext) {
  const safeValue = String(safeContext && safeContext.botDomainOverride ? safeContext.botDomainOverride : '')
    .trim()
    .toLowerCase();
  if (safeValue === 'agenda' || safeValue === 'commerce') {
    return safeValue;
  }
  return null;
}

function normalizeConversationBotFlowLock(safeContext) {
  const safeValue = String(safeContext && safeContext.botFlowLock ? safeContext.botFlowLock : '')
    .trim()
    .toLowerCase();
  if (safeValue === 'agenda' || safeValue === 'commerce') {
    return safeValue;
  }
  return null;
}

function resolveConversationDomain({ currentState, safeContext }) {
  if (BOT_ROUTER_DEMO_STATES.has(currentState) || hasDemoContext(safeContext)) {
    return 'demo';
  }
  if (BOT_ROUTER_APPOINTMENT_STATES.has(currentState) || hasAgendaContext(safeContext)) {
    return 'agenda';
  }
  if (BOT_ROUTER_COMMERCE_STATES.has(currentState) || hasCommerceContext(safeContext)) {
    return 'commerce';
  }
  return null;
}

function resolveBotDomainRoute({
  clinic,
  currentState,
  safeContext,
  inboundText,
  intent,
  commercialIntentType,
  transferPaymentIntent,
  managementIntent,
  inboundLooksLikeCommerce,
  inboundLooksLikeCommerceCancel
}) {
  const botMode = resolveClinicBotMode(clinic);
  const configuredBotActive = Boolean(getActiveGeneratedBotConfig(clinic));
  const botFlowLock = normalizeConversationBotFlowLock(safeContext);
  const overrideDomain = normalizeConversationBotDomainOverride(safeContext);
  const activeDomain = resolveConversationDomain({ currentState, safeContext });
  const demoIntent = isPublicDemoExperienceIntent(inboundText);
  const demoContextActive = activeDomain === 'demo';
  const agendaIntent = looksLikeAgendaIntent({ inboundText, intent, managementIntent });
  const paymentCommerceIntent = String(commercialIntentType || '').trim().toLowerCase() === 'payment';
  const commercialContextContinuation = Boolean(
    getActiveCommercialPlanContext(safeContext) ||
    getPendingPlanComparisonAction(safeContext) ||
    getActiveCommercialShortMemory(safeContext) ||
    getActiveBusinessRecommendationContext(safeContext) ||
    getActiveCommercialSalesContext(safeContext)
  );
  const followUpCommerceIntent =
    commercialContextContinuation &&
    (
      isCommercialSoftFollowUpIntent(inboundText) ||
      detectCommercialNextStepIntent(inboundText) ||
      isClarificationIntent(inboundText)
    );
  const runtimeConfiguredCommerceIntent =
    configuredBotActive &&
    (
      isGreeting(inboundText) ||
      isConfiguredBotOfferIntent(inboundText) ||
      isConfiguredBotRecommendationIntent(inboundText) ||
      Boolean(parseActiveBotRuntimeEditIntent(inboundText)) ||
      Boolean(transferPaymentIntent)
    );
  const explicitCommerceIntent =
    inboundLooksLikeCommerce ||
    inboundLooksLikeCommerceCancel ||
    paymentCommerceIntent ||
    Boolean(transferPaymentIntent) ||
    followUpCommerceIntent ||
    intent === 'pricing' ||
    isExplicitCommerceTrigger(inboundText) ||
    runtimeConfiguredCommerceIntent;

  if (
    (demoContextActive || demoIntent) &&
    botFlowLock !== 'agenda' &&
    overrideDomain !== 'agenda' &&
    !BOT_ROUTER_APPOINTMENT_STATES.has(currentState) &&
    !hasAgendaContext(safeContext)
  ) {
    return {
      botMode,
      domain: 'demo',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: demoContextActive ? 'demo_context' : 'public_demo_intent'
    };
  }

  if (botFlowLock === 'agenda') {
    return {
      botMode,
      domain: 'agenda',
      allowCommerce: false,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'conversation_flow_lock_agenda'
    };
  }

  if (botFlowLock === 'commerce') {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'conversation_flow_lock_commerce'
    };
  }

  if (overrideDomain === 'agenda') {
    return {
      botMode,
      domain: 'agenda',
      allowCommerce: false,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'conversation_override_agenda'
    };
  }

  if (overrideDomain === 'commerce') {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'conversation_override_commerce'
    };
  }

  if (paymentCommerceIntent || transferPaymentIntent) {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'hybrid_payment_intent'
    };
  }

  if (botMode === 'sales') {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'bot_mode_sales'
    };
  }

  if (botMode === 'agenda') {
    return {
      botMode,
      domain: 'agenda',
      allowCommerce: false,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: agendaIntent ? 'agenda_intent' : 'bot_mode_agenda'
    };
  }

  if (agendaIntent) {
    return {
      botMode,
      domain: 'agenda',
      allowCommerce: false,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'hybrid_agenda_intent'
    };
  }

  if (explicitCommerceIntent) {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'hybrid_explicit_commerce'
    };
  }

  if (activeDomain === 'agenda') {
    return {
      botMode,
      domain: 'agenda',
      allowCommerce: false,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'hybrid_continue_agenda'
    };
  }

  if (activeDomain === 'commerce') {
    return {
      botMode,
      domain: 'commerce',
      allowCommerce: true,
      agendaIntent,
      explicitCommerceIntent,
      activeDomain,
      overrideDomain,
      botFlowLock,
      reason: 'hybrid_continue_commerce'
    };
  }

  return {
    botMode,
    domain: 'neutral',
    allowCommerce: false,
    agendaIntent,
    explicitCommerceIntent,
    activeDomain,
    overrideDomain,
    botFlowLock,
    reason: 'hybrid_neutral'
  };
}

function buildActiveBotDomainPatch({ decisionSource, botRoute, currentState, nextState, safeContext }) {
  const safeDecisionSource = String(decisionSource || '').trim().toLowerCase();
  const safeNextState = String(nextState || '').trim().toUpperCase();

  if (
    safeDecisionSource.startsWith('demo') ||
    botRoute.domain === 'demo' ||
    BOT_ROUTER_DEMO_STATES.has(currentState) ||
    BOT_ROUTER_DEMO_STATES.has(safeNextState) ||
    hasDemoContext(safeContext)
  ) {
    return { activeBotDomain: 'demo' };
  }

  if (safeDecisionSource.startsWith('commerce') || BOT_ROUTER_COMMERCE_STATES.has(safeNextState)) {
    return { activeBotDomain: 'commerce' };
  }

  if (
    botRoute.domain === 'agenda' ||
    safeDecisionSource === 'legacy_appointment_management' ||
    BOT_ROUTER_APPOINTMENT_STATES.has(currentState) ||
    BOT_ROUTER_APPOINTMENT_STATES.has(safeNextState) ||
    hasAgendaContext(safeContext)
  ) {
    return { activeBotDomain: 'agenda' };
  }

  if (botRoute.domain === 'commerce') {
    return { activeBotDomain: 'commerce' };
  }

  return null;
}

function isCommerceEntryIntent(rawText) {
  const text = normalizeCommandText(rawText);
  const commercialIntent = detectCommercialIntent(text);
  if (!text) return false;
  return (
    commercialIntent.type === 'products' ||
    commercialIntent.type === 'prices' ||
    commercialIntent.type === 'payment' ||
    commercialIntent.type === 'human_handoff' ||
    commercialIntent.type === 'recommendation' ||
    commercialIntent.type === 'location' ||
    commercialIntent.type === 'hours' ||
    commercialIntent.type === 'delivery' ||
    commercialIntent.type === 'stock' ||
    commercialIntent.type === 'promotions' ||
    isPlanRecommendationIntent(text) ||
    isPlanPricingIntent(text) ||
    isPlanWorthItIntent(text) ||
    isCommercialOfferIntent(text) ||
    isGreetingIntent(text) ||
    text === 'quiero hacer un pedido' ||
    text === 'quiero comprar' ||
    text === 'productos' ||
    text === 'planes' ||
    text === 'catalogo' ||
    text === 'comprar' ||
    text === 'pedido' ||
    text === 'pedidos'
  );
}

function detectWeakCommercialSignal(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;
  const detectedIntent = detectIntent(text);

  if (detectCommercialIntent(text).type !== 'unknown') return 'known_commercial_intent';
  if (Boolean(parseTransferPaymentIntent(text))) return 'transfer_payment_phrase';
  if (Boolean(detectCommercialPlanObjection(text))) return 'plan_objection_phrase';
  if (isPlanRecommendationIntent(text)) return 'plan_recommendation_phrase';
  if (isPlanComparisonIntent(text)) return 'plan_comparison_phrase';
  if (isPlanWorthItIntent(text)) return 'plan_worth_it_phrase';
  if (isLoyaltyIntent(text)) return 'loyalty_phrase';
  if (detectedIntent === 'appointment') return 'appointment_phrase';
  if (detectedIntent === 'human') return 'human_phrase';
  if (/\b(whatsapp\s+e\s+instagram|whatsapp\s+y\s+instagram)\b/.test(text)) return 'whatsapp_instagram_combo';
  if (/\b(vendo|venden|ventas?)\s+(tambien\s+)?por\b/.test(text)) return 'selling_channel_phrase';
  if (/\b(instagram|compatib(?:le|ilidad)|software|sirve\s+para|me\s+sirve|funciona\s+para|mi\s+negocio|distribuidora|rotiseria|peluqueria|sucursal(?:es)?|vendedores?)\b/.test(text)) {
    return 'product_fit_phrase';
  }
  if (/\b(numero\s+actual\s+de\s+whatsapp|usar\s+mi\s+numero\s+actual|mi\s+numero\s+actual\s+de\s+whatsapp)\b/.test(text)) {
    return 'whatsapp_number_portability_phrase';
  }
  if (/\b(reemplaza\s+a\s+mis\s+vendedores|reemplaza\s+vendedores)\b/.test(text)) {
    return 'seller_replacement_phrase';
  }
  if (/\b(muchos\s+productos|como\s+los\s+cargo|como\s+cargo|cargar\s+productos)\b/.test(text)) {
    return 'catalog_import_phrase';
  }
  if (/\b(plan|planes|precio|precios|producto|productos|negocio|vender|ventas|whatsapp|servicio|catalogo|pago|pagarte|abono|comprobante|aceptan|presupuesto|recomendacion|fidelizacion|recompensa|turno|agenda|asesor|persona)\b/.test(text)) {
    return 'commerce_keyword';
  }
  if (text.includes('quiero') && (text.includes('saber') || text.includes('ver'))) {
    return 'discovery_phrase';
  }

  return null;
}

const COMMERCE_PRODUCTS_PAGE_SIZE = 10;
const COMMERCE_MORE_KEYWORDS = new Set(['mas', 'más', 'ver mas', 'ver más', 'mostrar mas', 'mostrar más', 'siguiente']);
const COMMERCE_UNCATEGORIZED_CATEGORY_ID = '__uncategorized__';
const COMMERCIAL_SHORT_MEMORY_TTL_MS = 10 * 60 * 1000;
const PLAN_PENDING_ACTION_COMPARE_RECOMMENDED = 'compare_recommended_plan';
const PLAN_PENDING_ACTION_COMPARE_CURRENT = 'compare_current_plan_with_plan';

function buildCommerceEligibleProducts(products) {
  return (Array.isArray(products) ? products : []).filter((product) => {
    const status = String(product && product.status ? product.status : '').toLowerCase();
    const stock = Number(product && product.stock ? product.stock : 0);
    return status === 'active' && stock > 0;
  });
}

function buildCommerceCategories(products) {
  const grouped = new Map();
  let uncategorizedCount = 0;

  for (const product of buildCommerceEligibleProducts(products)) {
    const categoryId = String(product && product.categoryId ? product.categoryId : '').trim();
    const categoryName = String(product && product.categoryName ? product.categoryName : '').trim();
    if (!categoryId || !categoryName) {
      uncategorizedCount += 1;
      continue;
    }

    if (!grouped.has(categoryId)) {
      grouped.set(categoryId, {
        categoryId,
        name: categoryName,
        productCount: 0
      });
    }

    grouped.get(categoryId).productCount += 1;
  }

  const categories = Array.from(grouped.values()).sort((left, right) => left.name.localeCompare(right.name, 'es'));

  if (uncategorizedCount > 0) {
    categories.push({
      categoryId: COMMERCE_UNCATEGORIZED_CATEGORY_ID,
      name: 'Otros',
      productCount: uncategorizedCount
    });
  }

  return categories.map((category, index) => ({
    ...category,
    index: index + 1
  }));
}

function buildCommerceCatalogPage(products, { offset = 0, categoryId = null, limit = COMMERCE_PRODUCTS_PAGE_SIZE } = {}) {
  const eligibleProducts = buildCommerceEligibleProducts(products).filter((product) => {
    if (!categoryId) return true;
    if (String(categoryId).trim() === COMMERCE_UNCATEGORIZED_CATEGORY_ID) {
      const currentCategoryId = String(product && product.categoryId ? product.categoryId : '').trim();
      const currentCategoryName = String(product && product.categoryName ? product.categoryName : '').trim();
      return !currentCategoryId || !currentCategoryName;
    }
    return String(product && product.categoryId ? product.categoryId : '').trim() === String(categoryId).trim();
  });
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.max(1, Math.min(20, Number(limit || COMMERCE_PRODUCTS_PAGE_SIZE)));
  const items = eligibleProducts.slice(safeOffset, safeOffset + safeLimit).map((product, index) => ({
    index: safeOffset + index + 1,
    productId: product.id,
    name: product.name,
    price: Number(product.price || 0),
    currency: String(product.currency || 'ARS').toUpperCase() || 'ARS',
    stock: Number(product.stock || 0),
    sku: product.sku || null,
    description: product.description || null,
    image: product.image || null,
    categoryId: product.categoryId || null,
    categoryName: product.categoryName || null
  }));

  const nextOffset = safeOffset + items.length;
  const hasMore = nextOffset < eligibleProducts.length;
  const firstProductWithCategory = eligibleProducts.find((product) => product && product.categoryName);
  const resolvedCategoryName =
    categoryId && String(categoryId).trim() === COMMERCE_UNCATEGORIZED_CATEGORY_ID
      ? 'Otros'
      : categoryId
        ? String(firstProductWithCategory && firstProductWithCategory.categoryName ? firstProductWithCategory.categoryName : '').trim() || null
        : null;

  return {
    items,
    total: eligibleProducts.length,
    offset: safeOffset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
    categoryId: categoryId || null,
    categoryName: resolvedCategoryName
  };
}

function formatCommerceIndex(index) {
  const digits = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return digits[index - 1] || `${index}.`;
}

function buildCatalogProductImageCaption(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const name = String(safeProduct.name || '').trim();
  const price = Number(safeProduct.price || safeProduct.unitPrice || 0);
  const currency = String(safeProduct.currency || 'ARS').trim().toUpperCase() || 'ARS';
  const description = String(safeProduct.description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const shortDescription = description.length > 220 ? `${description.slice(0, 217).trim()}...` : description;
  const lines = [name || 'Producto'];

  if (Number.isFinite(price) && price > 0) {
    lines.push(formatMoney(price, currency));
  }
  if (shortDescription) {
    lines.push(shortDescription);
  }

  return lines.join('\n').slice(0, 1024);
}

function buildCatalogProductImageMessage(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const image = safeProduct.image && typeof safeProduct.image === 'object' && !Array.isArray(safeProduct.image)
    ? safeProduct.image
    : null;
  const link = String(image && image.url ? image.url : '').trim();
  if (!link) return null;

  return {
    type: 'image',
    image: {
      link,
      caption: buildCatalogProductImageCaption(safeProduct)
    },
    productId: safeProduct.id || safeProduct.productId || null
  };
}

function buildCommercialShortMemoryPatch({
  topic = 'catalog',
  categoryId = null,
  lastSuggestedProductId = null,
  recommendationType = 'general',
  lastObjectionType = null,
  lastReplyKey = null
} = {}) {
  return {
    commercialShortMemory: {
      activeAt: new Date().toISOString(),
      topic: String(topic || 'catalog').trim().toLowerCase() || 'catalog',
      categoryId: categoryId ? String(categoryId).trim() : null,
      lastSuggestedProductId: lastSuggestedProductId ? String(lastSuggestedProductId).trim() : null,
      recommendationType: String(recommendationType || 'general').trim().toLowerCase() || 'general',
      lastObjectionType: lastObjectionType ? String(lastObjectionType).trim().toLowerCase() : null,
      lastReplyKey: lastReplyKey ? String(lastReplyKey).trim().toLowerCase() : null
    }
  };
}

function buildBusinessRecommendationContextPatch({
  businessType = null,
  teamSize = null,
  recommendationLevel = null
} = {}) {
  return {
    commercialBusinessContext: {
      activeAt: new Date().toISOString(),
      businessType: businessType ? String(businessType).trim().toLowerCase() : null,
      teamSize: teamSize ? String(teamSize).trim().toLowerCase() : null,
      recommendationLevel: recommendationLevel ? String(recommendationLevel).trim().toLowerCase() : null
    }
  };
}

function buildCommercialSalesContextPatch({
  businessType = null,
  whatsappVolume = null,
  teamSizeSignal = null,
  teamSizeValue = null,
  whatsappAccountTypeSignal = null,
  offerTypeSignal = null,
  channelMixSignal = null,
  painPoints = [],
  lastRecommendedPlan = null,
  lastRecommendationReason = null
} = {}) {
  const normalizedTeamSizeValue = Number.parseInt(String(teamSizeValue || ''), 10);
  return {
    commercialSalesContext: {
      updatedAt: new Date().toISOString(),
      businessType: businessType ? String(businessType).trim().toLowerCase() : null,
      whatsappVolume: whatsappVolume ? String(whatsappVolume).trim().toLowerCase() : null,
      teamSizeSignal: teamSizeSignal ? String(teamSizeSignal).trim().toLowerCase() : null,
      teamSizeValue: Number.isInteger(normalizedTeamSizeValue) && normalizedTeamSizeValue > 0 ? normalizedTeamSizeValue : null,
      whatsappAccountTypeSignal: whatsappAccountTypeSignal ? String(whatsappAccountTypeSignal).trim().toLowerCase() : null,
      offerTypeSignal: offerTypeSignal ? String(offerTypeSignal).trim().toLowerCase() : null,
      channelMixSignal: channelMixSignal ? String(channelMixSignal).trim().toLowerCase() : null,
      painPoints: Array.isArray(painPoints)
        ? [...new Set(painPoints.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 6)
        : [],
      lastRecommendedPlan: lastRecommendedPlan ? String(lastRecommendedPlan).trim() : null,
      lastRecommendationReason: lastRecommendationReason ? String(lastRecommendationReason).trim() : null
    }
  };
}

function buildCommercialPlanContextPatch({
  topic = 'plan_discussion',
  lastDiscussedPlanId = null,
  lastComparedPlanId = null,
  recommendationType = null
} = {}) {
  return {
    commercialPlanContext: {
      activeAt: new Date().toISOString(),
      topic: String(topic || 'plan_discussion').trim().toLowerCase() || 'plan_discussion',
      lastDiscussedPlanId: lastDiscussedPlanId ? String(lastDiscussedPlanId).trim() : null,
      lastComparedPlanId: lastComparedPlanId ? String(lastComparedPlanId).trim() : null,
      recommendationType: recommendationType ? String(recommendationType).trim().toLowerCase() : null
    }
  };
}

function getActiveCommercialPlanContext(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const stored = safeContext.commercialPlanContext && typeof safeContext.commercialPlanContext === 'object'
    ? safeContext.commercialPlanContext
    : null;
  if (!stored) return null;

  const activeAtMs = Date.parse(String(stored.activeAt || ''));
  if (!Number.isFinite(activeAtMs)) return null;
  if (Date.now() - activeAtMs > COMMERCIAL_SHORT_MEMORY_TTL_MS) return null;

  const lastDiscussedPlanId = String(stored.lastDiscussedPlanId || '').trim();
  if (!lastDiscussedPlanId) return null;

  return {
    activeAt: new Date(activeAtMs).toISOString(),
    topic: String(stored.topic || 'plan_discussion').trim().toLowerCase() || 'plan_discussion',
    lastDiscussedPlanId,
    lastComparedPlanId: String(stored.lastComparedPlanId || '').trim() || null,
    recommendationType: String(stored.recommendationType || '').trim().toLowerCase() || null
  };
}

function getActiveBusinessRecommendationContext(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const stored = safeContext.commercialBusinessContext && typeof safeContext.commercialBusinessContext === 'object'
    ? safeContext.commercialBusinessContext
    : null;
  if (!stored) return null;

  const activeAtMs = Date.parse(String(stored.activeAt || ''));
  if (!Number.isFinite(activeAtMs)) return null;
  if (Date.now() - activeAtMs > COMMERCIAL_SHORT_MEMORY_TTL_MS) return null;

  const recommendationLevel = String(stored.recommendationLevel || '').trim().toLowerCase();
  if (!recommendationLevel) return null;

  return {
    activeAt: new Date(activeAtMs).toISOString(),
    businessType: stored.businessType ? String(stored.businessType).trim().toLowerCase() : null,
    teamSize: stored.teamSize ? String(stored.teamSize).trim().toLowerCase() : null,
    recommendationLevel
  };
}

function getActiveCommercialSalesContext(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const stored = safeContext.commercialSalesContext && typeof safeContext.commercialSalesContext === 'object'
    ? safeContext.commercialSalesContext
    : null;
  if (!stored) return null;

  const updatedAtMs = Date.parse(String(stored.updatedAt || ''));
  if (!Number.isFinite(updatedAtMs)) return null;
  if (Date.now() - updatedAtMs > COMMERCIAL_SHORT_MEMORY_TTL_MS) return null;

  const painPoints = Array.isArray(stored.painPoints)
    ? [...new Set(stored.painPoints.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  const businessType = String(stored.businessType || '').trim().toLowerCase() || null;
  const whatsappVolume = String(stored.whatsappVolume || '').trim().toLowerCase() || null;
  const teamSizeSignal = String(stored.teamSizeSignal || '').trim().toLowerCase() || null;
  const teamSizeValueRaw = Number.parseInt(String(stored.teamSizeValue || ''), 10);
  const teamSizeValue = Number.isInteger(teamSizeValueRaw) && teamSizeValueRaw > 0 ? teamSizeValueRaw : null;
  const whatsappAccountTypeSignal = String(stored.whatsappAccountTypeSignal || '').trim().toLowerCase() || null;
  const offerTypeSignal = String(stored.offerTypeSignal || '').trim().toLowerCase() || null;
  const channelMixSignal = String(stored.channelMixSignal || '').trim().toLowerCase() || null;
  const lastRecommendedPlan = String(stored.lastRecommendedPlan || '').trim() || null;
  const lastRecommendationReason = String(stored.lastRecommendationReason || '').trim() || null;

  if (
    !businessType &&
    !whatsappVolume &&
    !teamSizeSignal &&
    !teamSizeValue &&
    !whatsappAccountTypeSignal &&
    !offerTypeSignal &&
    !channelMixSignal &&
    !painPoints.length &&
    !lastRecommendedPlan
  ) {
    return null;
  }

  return {
    updatedAt: new Date(updatedAtMs).toISOString(),
    businessType,
    whatsappVolume,
    teamSizeSignal,
    teamSizeValue,
    whatsappAccountTypeSignal,
    offerTypeSignal,
    channelMixSignal,
    painPoints,
    lastRecommendedPlan,
    lastRecommendationReason
  };
}

function detectBusinessRecommendationContext(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const scoreSignals = (signals) => signals.reduce((total, signal) => total + (text.includes(signal) ? 1 : 0), 0);
  const enterpriseSignals = [
    'distribuidora',
    'mayorista',
    'somos varios vendedores',
    'varios vendedores',
    'varios asesor',
    'equipo comercial',
    'somos varios',
    'varios atendiendo',
    'varias sucursales',
    'mas de una sucursal',
    'más de una sucursal',
    'supervision',
    'supervisión',
    'permisos',
    'roles',
    'personalizacion',
    'personalización'
  ];
  const growthSignals = [
    'tienda de ropa',
    'vendo ropa',
    'local de ropa',
    'indumentaria',
    'accesorios',
    'tienda de accesorios',
    'local de accesorios',
    'local chico',
    'tienda',
    'local',
    'negocio'
  ];
  const starterSignals = [
    'barato',
    'econom',
    'arrancar',
    'empezar',
    'simple',
    'chico',
    'pequeno',
    'pequeño',
    'emprendimiento',
    'para arrancar',
    'quiero algo barato',
    'algo economico',
    'algo económico'
  ];

  const enterpriseScore = scoreSignals(enterpriseSignals);
  const growthScore = scoreSignals(growthSignals);
  const starterScore = scoreSignals(starterSignals);

  if (enterpriseScore >= 2 && enterpriseScore > growthScore && enterpriseScore >= starterScore) {
    return {
      businessType: text.includes('distribuidora') || text.includes('mayorista') ? 'distribution' : 'high_volume',
      teamSize: 'team',
      recommendationLevel: 'enterprise'
    };
  }

  if (starterScore > 0 && starterScore >= growthScore) {
    return {
      businessType: 'starter',
      teamSize: 'small',
      recommendationLevel: 'starter'
    };
  }

  if (growthScore > 0) {
    return {
      businessType: text.includes('ropa') ? 'fashion_retail' : (text.includes('accesorios') ? 'accessories_retail' : 'small_store'),
      teamSize: text.includes('somos varios') ? 'team' : 'small',
      recommendationLevel: 'growth'
    };
  }

  return null;
}

function detectCommercialSalesContext(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const findMatch = (groups) => {
    for (const [value, phrases] of groups) {
      if (phrases.some((phrase) => text.includes(phrase))) {
        return value;
      }
    }
    return null;
  };

  const businessType = findMatch([
    ['fashion_retail', ['tienda de ropa', 'vendo ropa', 'local de ropa', 'indumentaria', 'boutique']],
    ['accessories_retail', ['accesorios', 'bijou', 'bijouterie']],
    ['food_business', ['pastas', 'comida', 'resto', 'restaurant', 'gastronomi', 'cocina']],
    ['beauty_business', ['estetica', 'estética', 'belleza', 'peluquer', 'unas', 'uñas', 'salon', 'salón']],
    ['distribution', ['distribuidora', 'mayorista']],
    ['small_store', ['negocio chico', 'tengo un local', 'tengo una tienda', 'tengo un emprendimiento', 'mi emprendimiento']],
    ['services', ['servicios', 'agencia', 'consultora', 'estudio', 'studio']]
  ]);

  const whatsappVolume = findMatch([
    ['high', ['vendo mucho', 'muchas consultas', 'mucho por whatsapp', 'mucho movimiento', 'me escriben bastante', 'alto volumen', 'muchos mensajes']],
    ['low', ['recien arranco', 'recién arranco', 'estoy arrancando', 'pocos mensajes', 'poquitas consultas', 'arrancando de a poco', 'recien empezando', 'recién empezando']]
  ]);

  const teamSizeSignal = findMatch([
    ['multi_branch', ['varias sucursales', 'tengo sucursales', 'mas de una sucursal', 'más de una sucursal']],
    ['solo', ['soy yo solo', 'soy yo sola', 'atiendo yo', 'estoy solo', 'estoy sola', 'no tengo vendedores', 'sin vendedores', 'no tengo equipo', 'estoy yo solo']],
    ['team', ['tengo vendedores', 'tengo equipo', 'somos varios', 'varios vendedores', 'equipo vendiendo', 'tengo asesores', 'tenemos vendedores', 'tenemos equipo']]
  ]);

  const painSignals = [
    ['lead_loss', ['se me pierden consultas', 'pierdo consultas', 'se me escapan consultas', 'se me pasan consultas']],
    ['follow_up', ['no hago seguimiento', 'me falta seguimiento', 'seguir conversaciones', 'retomar consultas', 'me cuesta seguir consultas', 'me cuesta seguir las consultas', 'seguir consultas']],
    ['response_delay', ['respondo tarde', 'contestamos tarde', 'responder tarde', 'tardo en atender consultas', 'tardo en responder', 'atiendo tarde']],
    ['sales_organization', ['ordenar ventas', 'ordenar whatsapp', 'ordenar consultas', 'ordenar la operacion', 'ordenar la operación', 'mala administracion por whatsapp', 'mala administración por whatsapp', 'caos por whatsapp']],
    ['team_control', ['supervision', 'supervisión', 'control del equipo', 'permisos', 'roles', 'sucursales']],
    ['complex_operation', ['personalizacion', 'personalización', 'integraciones', 'operacion compleja', 'operación compleja']]
  ];
  const painPoints = painSignals
    .filter(([, phrases]) => phrases.some((phrase) => text.includes(phrase)))
    .map(([key]) => key);

  if (!businessType && !whatsappVolume && !teamSizeSignal && !painPoints.length) {
    return null;
  }

  return {
    businessType,
    whatsappVolume,
    teamSizeSignal,
    painPoints
  };
}

function mergeCommercialSalesContext(baseContext, incomingContext = null) {
  const base = baseContext && typeof baseContext === 'object' ? baseContext : {};
  const incoming = incomingContext && typeof incomingContext === 'object' ? incomingContext : {};

  return {
    businessType: incoming.businessType || base.businessType || null,
    whatsappVolume: incoming.whatsappVolume || base.whatsappVolume || null,
    teamSizeSignal: incoming.teamSizeSignal || base.teamSizeSignal || null,
    teamSizeValue: incoming.teamSizeValue || base.teamSizeValue || null,
    whatsappAccountTypeSignal: incoming.whatsappAccountTypeSignal || base.whatsappAccountTypeSignal || null,
    offerTypeSignal: incoming.offerTypeSignal || base.offerTypeSignal || null,
    channelMixSignal: incoming.channelMixSignal || base.channelMixSignal || null,
    painPoints: [...new Set([...(Array.isArray(base.painPoints) ? base.painPoints : []), ...(Array.isArray(incoming.painPoints) ? incoming.painPoints : [])])],
    lastRecommendedPlan: incoming.lastRecommendedPlan || base.lastRecommendedPlan || null,
    lastRecommendationReason: incoming.lastRecommendationReason || base.lastRecommendationReason || null
  };
}

function buildCommercialDiscoveryPendingPatch({
  field,
  sourceIntent = null,
  meta = null
} = {}) {
  const normalizedField = String(field || '').trim().toLowerCase();
  if (!normalizedField) return null;

  return {
    commercialDiscoveryPending: {
      field: normalizedField,
      askedAt: new Date().toISOString(),
      sourceIntent: sourceIntent ? String(sourceIntent).trim().toLowerCase() : null,
      meta: meta && typeof meta === 'object' ? meta : null
    }
  };
}

function clearCommercialDiscoveryPendingPatch() {
  return {
    commercialDiscoveryPending: {
      field: null,
      askedAt: null,
      sourceIntent: null,
      meta: null,
      completedAt: new Date().toISOString()
    }
  };
}

function getActiveCommercialDiscoveryPending(safeContext) {
  const pending = safeContext && safeContext.commercialDiscoveryPending && typeof safeContext.commercialDiscoveryPending === 'object'
    ? safeContext.commercialDiscoveryPending
    : null;
  if (!pending) return null;

  const field = String(pending.field || '').trim().toLowerCase();
  const askedAt = String(pending.askedAt || '').trim();
  const askedAtMs = Date.parse(askedAt);
  if (!field || !askedAt || !Number.isFinite(askedAtMs) || Date.now() - askedAtMs > COMMERCIAL_SHORT_MEMORY_TTL_MS) {
    return null;
  }

  return {
    field,
    askedAt: new Date(askedAtMs).toISOString(),
    sourceIntent: String(pending.sourceIntent || '').trim().toLowerCase() || null,
    meta: pending.meta && typeof pending.meta === 'object' ? pending.meta : null
  };
}

function parseSpelledSmallNumber(text) {
  const safeText = normalizeCommandText(text);
  if (!safeText) return null;

  const wordMap = new Map([
    ['un', 1],
    ['uno', 1],
    ['una', 1],
    ['dos', 2],
    ['tres', 3],
    ['cuatro', 4],
    ['cinco', 5],
    ['seis', 6],
    ['siete', 7],
    ['ocho', 8],
    ['nueve', 9],
    ['diez', 10]
  ]);

  for (const [word, value] of wordMap.entries()) {
    if (new RegExp(`\\b${word}\\b`).test(safeText)) {
      return value;
    }
  }

  return null;
}

function parseCommercialTeamSizeAnswer(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (text === 'mi esposa y yo') {
    return { teamSizeValue: 2, teamSizeSignal: 'team' };
  }

  if (
    text.includes('atiendo yo solo') ||
    text.includes('atiendo yo sola') ||
    text.includes('yo solo') ||
    text.includes('yo sola')
  ) {
    return { teamSizeValue: 1, teamSizeSignal: 'solo' };
  }

  const digitsMatch = text.match(/\b(\d{1,2})\b/);
  const numericValue = digitsMatch ? Number.parseInt(digitsMatch[1], 10) : parseSpelledSmallNumber(text);
  if (Number.isInteger(numericValue) && numericValue > 0) {
    return {
      teamSizeValue: numericValue,
      teamSizeSignal: numericValue === 1 ? 'solo' : 'team'
    };
  }

  if (
    text.includes('una persona') ||
    text.includes('una sola persona') ||
    text.includes('una en atencion') ||
    text.includes('un vendedor')
  ) {
    return { teamSizeValue: 1, teamSizeSignal: 'solo' };
  }

  return null;
}

function parseCommercialWhatsAppAccountTypeAnswer(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (text.includes('whatsapp business') || text === 'business') {
    return 'business';
  }

  if (
    text.includes('numero personal') ||
    text.includes('número personal') ||
    text.includes('whatsapp personal') ||
    text.includes('personal') ||
    text.includes('particular')
  ) {
    return 'personal';
  }

  return null;
}

function parseCommercialOfferTypeAnswer(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;
  if (text === 'productos' || text === 'producto' || text.includes('vendo productos')) return 'products';
  if (text === 'servicios' || text === 'servicio' || text.includes('vendo servicios')) return 'services';
  return null;
}

function parseCommercialChannelMixAnswer(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const hasWhatsApp = text.includes('whatsapp');
  const otherChannelSignals = ['instagram', 'facebook', 'web', 'pagina', 'página', 'mail', 'llamadas', 'telefono', 'teléfono'];
  const hasOtherChannels = otherChannelSignals.some((signal) => text.includes(signal)) || text.includes('otros canales');

  if (hasWhatsApp && hasOtherChannels) return 'multi_channel';
  if (hasWhatsApp && (text.includes('solo') || text.includes('principalmente') || text.includes('nomas') || text.includes('nomas'))) {
    return 'whatsapp_only';
  }
  if (hasWhatsApp) return 'whatsapp_only';
  if (hasOtherChannels) return 'multi_channel';

  return null;
}

function buildTeamSizeLead(teamSizeValue, teamSizeSignal) {
  if (Number.isInteger(teamSizeValue) && teamSizeValue > 0) {
    return teamSizeValue === 1
      ? 'Con 1 persona atendiendo consultas'
      : `Con ${teamSizeValue} personas atendiendo consultas`;
  }

  return teamSizeSignal === 'solo'
    ? 'Si hoy atendés vos solo'
    : 'Si hoy ya tienen más de una persona atendiendo consultas';
}

function buildSellerReplacementDiscoveryFollowUp({ teamSizeValue = null, teamSizeSignal = null } = {}) {
  return [
    'Perfecto 😊',
    '',
    `${buildTeamSizeLead(teamSizeValue, teamSizeSignal)}, Opturon puede ayudarles a ordenar mejor los mensajes y evitar que se pierdan oportunidades cuando hay varias conversaciones al mismo tiempo.`,
    '',
    '¿Hoy las consultas les llegan principalmente por WhatsApp o también usan otros canales?'
  ].join('\n');
}

function buildWhatsAppAccountTypeDiscoveryFollowUp(accountTypeSignal) {
  const detail = accountTypeSignal === 'business'
    ? 'Si ya usan WhatsApp Business, normalmente el objetivo es mantener continuidad con el número y ordenar mejor la atención sin arrancar de cero.'
    : 'Si hoy atienden desde un número personal, el siguiente paso suele ser ordenar mejor la atención y evaluar la transición sin perder continuidad con los clientes.';

  return [
    'Perfecto 😊',
    '',
    detail,
    '',
    '¿Hoy reciben consultas solo por WhatsApp o también por Instagram u otros canales?'
  ].join('\n');
}

function buildOfferTypeDiscoveryFollowUp(offerTypeSignal) {
  const detail = offerTypeSignal === 'services'
    ? 'Si vendés servicios, Opturon puede ayudarte a ordenar mejor las consultas, responder más parejo y dar seguimiento sin depender de acordarse de cada conversación.'
    : 'Si vendés productos, Opturon puede ayudarte a responder más parejo, ordenar consultas y dar seguimiento cuando alguien pregunta pero no compra en el momento.';

  return [
    'Perfecto 😊',
    '',
    detail,
    '',
    '¿Hoy las consultas te llegan principalmente por WhatsApp o también usan otros canales?'
  ].join('\n');
}

function buildChannelMixDiscoveryFollowUp(channelMixSignal, sourceIntent = null) {
  const detail = channelMixSignal === 'multi_channel'
    ? 'Cuando entran consultas por más de un canal, ordenar conversaciones y seguimiento suele hacer una diferencia grande.'
    : 'Cuando la mayor parte entra por WhatsApp, ordenar la atención y el seguimiento desde ahí ya puede mejorar mucho la operación.';

  const nextQuestion = sourceIntent === 'channel_compatibility'
    ? '¿Hoy cuántas personas atienden esas consultas?'
    : '¿Hoy vendés productos o servicios?';

  return [
    'Perfecto 😊',
    '',
    detail,
    '',
    nextQuestion
  ].join('\n');
}

function resolveCommercialDiscoveryPendingReply({
  pending,
  inboundText,
  effectiveSalesContext
}) {
  const currentSalesContext = effectiveSalesContext && typeof effectiveSalesContext === 'object' ? effectiveSalesContext : {};
  if (!pending || !pending.field) return null;

  if (pending.field === 'team_size') {
    const teamAnswer = parseCommercialTeamSizeAnswer(inboundText);
    if (!teamAnswer) return null;

    return {
      type: 'recommendation',
      replyText: buildSellerReplacementDiscoveryFollowUp(teamAnswer),
      contextPatch: mergeContextPatches(
        buildCommercialSalesContextPatch({
          ...currentSalesContext,
          teamSizeSignal: teamAnswer.teamSizeSignal,
          teamSizeValue: teamAnswer.teamSizeValue
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'channel_mix',
          sourceIntent: pending.sourceIntent || 'seller_replacement'
        })
      )
    };
  }

  if (pending.field === 'whatsapp_account_type') {
    const accountTypeSignal = parseCommercialWhatsAppAccountTypeAnswer(inboundText);
    if (!accountTypeSignal) return null;

    return {
      type: 'recommendation',
      replyText: buildWhatsAppAccountTypeDiscoveryFollowUp(accountTypeSignal),
      contextPatch: mergeContextPatches(
        buildCommercialSalesContextPatch({
          ...currentSalesContext,
          whatsappAccountTypeSignal: accountTypeSignal
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'channel_mix',
          sourceIntent: pending.sourceIntent || 'whatsapp_number_portability'
        })
      )
    };
  }

  if (pending.field === 'offer_type') {
    const offerTypeSignal = parseCommercialOfferTypeAnswer(inboundText);
    if (!offerTypeSignal) return null;

    return {
      type: 'recommendation',
      replyText: buildOfferTypeDiscoveryFollowUp(offerTypeSignal),
      contextPatch: mergeContextPatches(
        buildCommercialSalesContextPatch({
          ...currentSalesContext,
          offerTypeSignal
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'channel_mix',
          sourceIntent: pending.sourceIntent || 'channel_compatibility'
        })
      )
    };
  }

  if (pending.field === 'channel_mix') {
    const channelMixSignal = parseCommercialChannelMixAnswer(inboundText);
    if (!channelMixSignal) return null;

    return {
      type: 'recommendation',
      replyText: buildChannelMixDiscoveryFollowUp(channelMixSignal, pending.sourceIntent),
      contextPatch: mergeContextPatches(
        buildCommercialSalesContextPatch({
          ...currentSalesContext,
          channelMixSignal
        }),
        pending.sourceIntent === 'channel_compatibility'
          ? buildCommercialDiscoveryPendingPatch({
            field: 'team_size',
            sourceIntent: pending.sourceIntent
          })
          : clearCommercialDiscoveryPendingPatch()
      )
    };
  }

  return null;
}

function deriveBusinessRecommendationContextFromSalesContext(salesContext) {
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : null;
  if (!safeContext) return null;

  const painPoints = Array.isArray(safeContext.painPoints) ? safeContext.painPoints : [];
  const isHighVolume = safeContext.whatsappVolume === 'high';
  const isLowVolume = safeContext.whatsappVolume === 'low';
  const hasTeam = safeContext.teamSizeSignal === 'team' || safeContext.teamSizeSignal === 'multi_branch';
  const isMultiBranch = safeContext.teamSizeSignal === 'multi_branch';
  const isSolo = safeContext.teamSizeSignal === 'solo';
  const isDistribution = safeContext.businessType === 'distribution';
  const hasControlSignals = painPoints.includes('team_control') || painPoints.includes('complex_operation');
  const hasGrowthPains = painPoints.includes('lead_loss') || painPoints.includes('follow_up') || painPoints.includes('response_delay') || painPoints.includes('sales_organization');

  let starterScore = 0;
  let growthScore = 0;
  let enterpriseScore = 0;

  if (isLowVolume) starterScore += 2;
  if (isSolo) starterScore += 1;
  if (!painPoints.length) starterScore += 1;

  if (safeContext.businessType && safeContext.businessType !== 'distribution') growthScore += 1;
  if (isHighVolume) growthScore += 2;
  if (hasGrowthPains) growthScore += 3;
  if (isSolo) growthScore += 1;
  if (hasTeam) growthScore += 1;

  if (isDistribution) enterpriseScore += 4;
  if (isMultiBranch) enterpriseScore += 4;
  if (safeContext.teamSizeSignal === 'team') enterpriseScore += 2;
  if (hasControlSignals) enterpriseScore += 3;
  if (isHighVolume && hasTeam) enterpriseScore += 1;

  if (enterpriseScore >= 5 && enterpriseScore > growthScore) {
    return {
      businessType: safeContext.businessType || (isDistribution ? 'distribution' : 'high_volume'),
      teamSize: hasTeam ? 'team' : 'small',
      recommendationLevel: 'enterprise'
    };
  }

  if (starterScore >= 3 && starterScore >= growthScore && enterpriseScore === 0) {
    return {
      businessType: safeContext.businessType || 'starter',
      teamSize: 'small',
      recommendationLevel: 'starter'
    };
  }

  if (growthScore > 0 || safeContext.businessType || painPoints.length || hasTeam) {
    return {
      businessType: safeContext.businessType || 'small_store',
      teamSize: hasTeam ? 'team' : 'small',
      recommendationLevel: 'growth'
    };
  }

  return null;
}

function hasMinimumSalesContextForRecommendation(salesContext) {
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : null;
  if (!safeContext) return false;

  const signalCount = [
    safeContext.businessType,
    safeContext.whatsappVolume,
    safeContext.teamSizeSignal,
    Array.isArray(safeContext.painPoints) && safeContext.painPoints.length ? 'pain' : null
  ].filter(Boolean).length;

  return (
    signalCount >= 2 ||
    safeContext.whatsappVolume === 'high' ||
    safeContext.teamSizeSignal === 'team' ||
    safeContext.teamSizeSignal === 'multi_branch'
  );
}

function getActiveCommercialShortMemory(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const memory = safeContext.commercialShortMemory && typeof safeContext.commercialShortMemory === 'object'
    ? safeContext.commercialShortMemory
    : null;
  if (!memory) return null;

  const activeAtMs = Date.parse(String(memory.activeAt || ''));
  if (!Number.isFinite(activeAtMs)) return null;
  if (Date.now() - activeAtMs > COMMERCIAL_SHORT_MEMORY_TTL_MS) return null;

  const topic = String(memory.topic || '').trim().toLowerCase();
  const lastSuggestedProductId = String(memory.lastSuggestedProductId || '').trim();
  if (!topic || !lastSuggestedProductId) return null;

  return {
    activeAt: new Date(activeAtMs).toISOString(),
    topic,
    categoryId: memory.categoryId ? String(memory.categoryId).trim() : null,
    lastSuggestedProductId,
    recommendationType: String(memory.recommendationType || 'general').trim().toLowerCase() || 'general',
    lastObjectionType: memory.lastObjectionType ? String(memory.lastObjectionType).trim().toLowerCase() : null,
    lastReplyKey: memory.lastReplyKey ? String(memory.lastReplyKey).trim().toLowerCase() : null
  };
}

function isCommercialShortMemoryProtectedIntent(input) {
  const text = normalizeCommandText(input);
  if (!text) return false;

  const commercialIntent = detectCommercialIntent(text);
  if (['products', 'prices', 'payment', 'loyalty', 'promotions', 'location', 'hours', 'delivery', 'human_handoff'].includes(commercialIntent.type)) {
    return true;
  }

  return (
    text.includes('turno') ||
    text.includes('agenda') ||
    text.includes('transferencia') ||
    text.includes('comprobante') ||
    text.includes('factura')
  );
}

function resolveCommercialShortMemoryFollowUpType(input) {
  const text = normalizeCommandText(input);
  if (!text || isCommercialShortMemoryProtectedIntent(text)) return null;

  if (
    text === 'a ver' ||
    text === 'y' ||
    text === 'y?' ||
    text === 'otra' ||
    text === 'otra opcion' ||
    text === 'otra opción' ||
    text === 'otra recomendacion' ||
    text === 'otra recomendación' ||
    text === 'mostrame otra' ||
    text === 'mostrame otra opcion' ||
    text === 'mostrame otra opción' ||
    text === 'tenes otra' ||
    text === 'tenés otra'
  ) {
    return 'another';
  }

  if (
    text.includes('mas barato') ||
    text.includes('más barato') ||
    text.includes('mas econom') ||
    text.includes('más econom') ||
    text.includes('algo barato')
  ) {
    return 'cheaper';
  }

  if (
    text.includes('mas premium') ||
    text.includes('más premium') ||
    text.includes('algo premium') ||
    text.includes('algo mejor') ||
    text.includes('mejorcito') ||
    text.includes('subir un poco')
  ) {
    return 'better';
  }

  if (text.includes('parecido')) {
    return 'similar';
  }

  if (
    text.includes('cual recomendas') ||
    text.includes('cuál recomendás') ||
    text.includes('cual te gusta mas') ||
    text.includes('cuál te gusta más')
  ) {
    return 'recommend';
  }

  return null;
}

function normalizeProductRecommendationType(product, orderedProducts = []) {
  const safeProducts = Array.isArray(orderedProducts) ? orderedProducts : [];
  const productId = String(product && (product.id || product.productId) ? (product.id || product.productId) : '').trim();
  const index = safeProducts.findIndex((item) => String(item && (item.id || item.productId) ? (item.id || item.productId) : '').trim() === productId);
  if (index <= 0) return 'starter';
  if (index >= safeProducts.length - 1) return 'premium';
  return 'growth';
}

function buildCommercialShortMemoryProductReply(product, followUpType) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const priceLine = formatMoney(safeProduct.price, safeProduct.currency);
  const description = String(safeProduct.description || '').trim();
  const shortDescription = description.length > 140 ? `${description.slice(0, 137).trim()}...` : description;

  const introByType = {
    cheaper: 'Si querés algo más económico, esta puede ir muy bien 😊',
    better: 'Si querés subir un poco, esta opción está muy buena 😊',
    similar: 'Tengo otra opción parecida que te puede servir 😊',
    recommend: 'De lo que venimos viendo, esta es de las que más me gusta 😊',
    another: 'Te muestro otra opción que también te puede servir 😊'
  };

  return [
    introByType[followUpType] || introByType.another,
    '',
    `${safeProduct.name || 'Este producto'} — ${priceLine}`,
    shortDescription || null,
    '',
    'Si querés, te cuento más o te muestro otra opción.'
  ].filter(Boolean).join('\n');
}

function selectPlanFromShortMemory(products, memory, followUpType) {
  const plans = getOrderedPlanProducts(products);
  if (!plans.length) return null;

  const currentIndex = Math.max(0, plans.findIndex((product) => String(product.id || product.productId || '').trim() === memory.lastSuggestedProductId));
  if (followUpType === 'recommend') {
    return findPlanByNeedHint(plans, 'growth') || plans[currentIndex] || plans[0];
  }
  if (followUpType === 'cheaper') {
    return plans[currentIndex - 1] || null;
  }
  if (followUpType === 'better') {
    return plans[currentIndex + 1] || null;
  }
  if (followUpType === 'another' || followUpType === 'similar') {
    return plans[currentIndex + 1] || plans[currentIndex - 1] || null;
  }
  return null;
}

function selectProductFromShortMemory(products, memory, followUpType) {
  const filteredProducts = buildCommerceEligibleProducts(products)
    .filter((product) => {
      if (!memory.categoryId) return true;
      if (memory.categoryId === COMMERCE_UNCATEGORIZED_CATEGORY_ID) {
        return !String(product && product.categoryId ? product.categoryId : '').trim();
      }
      return String(product && product.categoryId ? product.categoryId : '').trim() === memory.categoryId;
    })
    .sort((left, right) => {
      const priceDiff = Number(left.price || 0) - Number(right.price || 0);
      if (priceDiff !== 0) return priceDiff;
      return String(left.name || '').localeCompare(String(right.name || ''), 'es');
    });

  if (!filteredProducts.length) return null;

  const currentIndex = filteredProducts.findIndex((product) => String(product.id || product.productId || '').trim() === memory.lastSuggestedProductId);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentProduct = filteredProducts[safeIndex] || null;

  if (followUpType === 'recommend') {
    return filteredProducts[Math.min(1, filteredProducts.length - 1)] || filteredProducts[0];
  }

  if (followUpType === 'cheaper') {
    return filteredProducts[safeIndex - 1] || null;
  }

  if (followUpType === 'better') {
    return filteredProducts[safeIndex + 1] || null;
  }

  if (followUpType === 'another' || followUpType === 'similar') {
    return filteredProducts[safeIndex + 1] || filteredProducts[safeIndex - 1] || filteredProducts.find((product) => String(product.id || product.productId || '').trim() !== memory.lastSuggestedProductId) || null;
  }

  return currentProduct;
}

function formatWholeNumber(value) {
  const amount = Number(value || 0);
  try {
    return new Intl.NumberFormat('es-AR', {
      maximumFractionDigits: 0
    }).format(amount);
  } catch (error) {
    return String(Math.round(amount));
  }
}

function getClinicBusinessProfile(clinic) {
  const settings = parseClinicSettingsObject(clinic);
  return settings && settings.businessProfile && typeof settings.businessProfile === 'object'
    ? settings.businessProfile
    : {};
}

function normalizeBusinessProfileText(value) {
  return String(value || '').trim();
}

const INTELLIGENT_FALLBACK_TTL_MS = 15 * 60 * 1000;

function getIntelligentFallbackState(safeContext) {
  const count = Number.parseInt(String(safeContext && safeContext.intelligentFallbackCount ? safeContext.intelligentFallbackCount : 0), 10);
  const activeAt = String(safeContext && safeContext.intelligentFallbackAt ? safeContext.intelligentFallbackAt : '').trim();
  const timestamp = Date.parse(activeAt);
  if (!Number.isInteger(count) || count <= 0) {
    return { count: 0, active: false };
  }
  if (!activeAt || !Number.isFinite(timestamp) || Date.now() - timestamp > INTELLIGENT_FALLBACK_TTL_MS) {
    return { count: 0, active: false };
  }
  return { count, active: true };
}

function buildIntelligentFallbackReply(safeContext) {
  const fallbackState = getIntelligentFallbackState(safeContext);
  const nextCount = fallbackState.active ? fallbackState.count + 1 : 1;
  const inboundText = arguments.length > 1 ? arguments[1] : '';
  const looksCommercial = hasWeakCommercialSignal(inboundText) ||
    String(safeContext && safeContext.activeBotDomain ? safeContext.activeBotDomain : '').trim().toLowerCase() === 'commerce' ||
    Boolean(getActiveCommercialDiscoveryPending(safeContext)) ||
    Boolean(getActiveCommercialShortMemory(safeContext)) ||
    Boolean(getActiveCommercialPlanContext(safeContext)) ||
    Boolean(getPendingPlanComparisonAction(safeContext));
  const softLead = pickTextVariant(`fallback_soft:${normalizeCommandText(inboundText)}`, looksCommercial
    ? [
      'No estoy seguro de haberte entendido del todo 😅',
      'Se me mezcló un poco lo último 😅',
      'No terminé de agarrar bien la idea 😅'
    ]
    : [
      'Creo que no te entendí del todo 😅',
      'Se me mezcló un poco lo último 😅',
      'No terminé de agarrar bien la idea 😅'
    ]);
  const softReply = looksCommercial
    ? [
      softLead,
      '',
      'Si querés, puedo ayudarte con planes, catálogo, precios, pagos o recomendarte algo según tu negocio.',
      '',
      'Contame qué necesitás y seguimos.'
    ].join('\n')
    : [
      softLead,
      '',
      'Puedo ayudarte con productos, precios, fidelización, turnos, pagos o hablar con alguien del equipo.',
      '',
      'Decime qué necesitás y te doy una mano.'
    ].join('\n');
  const guidedReply = looksCommercial
    ? [
      'Vamos de nuevo y lo saco rápido 😊',
      '',
      'Podés decirme algo como:',
      '- ver planes o productos',
      '- consultar precios',
      '- recomendarme una opción',
      '- pagar por transferencia',
      '- hablar con una persona'
    ].join('\n')
    : [
      'Todavía no logré entender bien qué necesitás 🤔',
      '',
      'Podés decirme algo como:',
      '- ver productos',
      '- consultar precios',
      '- turnos, fidelización u horarios',
      '- hablar con alguien'
    ].join('\n');

  return {
    replyText: nextCount >= 2 ? guidedReply : softReply,
    contextPatch: {
      intelligentFallbackCount: Math.min(nextCount, 2),
      intelligentFallbackAt: new Date().toISOString()
    }
  };
}

const LOYALTY_FOLLOW_UP_TTL_MS = 10 * 60 * 1000;
const LOYALTY_OFFERED_ACTION_RECOMMEND_REWARD = 'loyalty_recommend_reward';

function getContactFirstName(contact) {
  const safeName = String((contact && (contact.name || contact.fullName)) || '').trim();
  if (!safeName) return null;
  return safeName.split(/\s+/).filter(Boolean)[0] || safeName;
}

function buildLoyaltyContextPatch(snapshot, mode = 'offered_summary', pendingOfferedAction = null) {
  const nextReward = snapshot && snapshot.nextReward && typeof snapshot.nextReward === 'object'
    ? snapshot.nextReward
    : null;
  const availableReward = snapshot && snapshot.availableReward && typeof snapshot.availableReward === 'object'
    ? snapshot.availableReward
    : null;
  const highlightedReward = availableReward || nextReward || null;

  return {
    loyaltyFollowUpMode: mode,
    loyaltyFollowUpActiveAt: new Date().toISOString(),
    pendingOfferedAction: pendingOfferedAction && typeof pendingOfferedAction === 'object'
      ? pendingOfferedAction
      : null,
    loyaltyHighlightedReward: highlightedReward
      ? {
        id: highlightedReward.id || null,
        name: highlightedReward.name || null,
        pointsCost: Number(highlightedReward.pointsCost || 0)
      }
      : null
  };
}

function isRecentLoyaltyFollowUpContext(safeContext) {
  const activeAt = String(safeContext && safeContext.loyaltyFollowUpActiveAt ? safeContext.loyaltyFollowUpActiveAt : '').trim();
  if (!activeAt) return false;
  const timestamp = Date.parse(activeAt);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= LOYALTY_FOLLOW_UP_TTL_MS;
}

function isLoyaltyFollowUpIntent(rawText) {
  return isAffirmativeIntent(rawText) || isClarificationIntent(rawText);
}

function normalizeLooseIntentText(rawText) {
  return normalizeCommandText(rawText)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPendingOfferedActionIntent(rawText, pendingActionType = null) {
  const looseText = normalizeLooseIntentText(rawText);
  if (!looseText) return false;
  if (isAffirmativeIntent(looseText) || isClarificationIntent(looseText)) {
    return true;
  }

  if (pendingActionType !== LOYALTY_OFFERED_ACTION_RECOMMEND_REWARD) {
    return false;
  }

  const exactMatches = new Set([
    'dale a ver',
    'joya decime',
    'si mostrame',
    'ok dale',
    'decime cual',
    'cual me conviene',
    'cual conviene',
    'quiero ver'
  ]);

  if (exactMatches.has(looseText)) {
    return true;
  }

  return (
    (looseText.includes('a ver') && (looseText.includes('dale') || looseText.includes('ok') || looseText.includes('joya') || /^si\b/.test(looseText))) ||
    (looseText.includes('decime') && looseText.includes('cual')) ||
    (looseText.includes('mostrame') && (looseText.includes('si') || looseText.includes('dale') || looseText.includes('ok'))) ||
    (looseText.includes('cual') && looseText.includes('conviene'))
  );
}

function isPendingPlanComparisonIntent(rawText) {
  const looseText = normalizeLooseIntentText(rawText);
  if (!looseText) return false;
  if (isAffirmativeIntent(looseText) || isClarificationIntent(looseText)) {
    return true;
  }

  const exactMatches = new Set([
    'a ver dale',
    'joya',
    'contame',
    'decime',
    'si',
    'quiero ver',
    'cual es la diferencia',
    'comparalos'
  ]);
  if (exactMatches.has(looseText)) {
    return true;
  }

  return (
    looseText.includes('cual es la diferencia') ||
    looseText.includes('comparalos') ||
    looseText.includes('contame') ||
    looseText.includes('decime') ||
    hasPlanComparisonSemanticCue(looseText) ||
    (looseText.includes('quiero') && looseText.includes('ver'))
  );
}

function getPendingLoyaltyOfferedAction(safeContext) {
  const pending = safeContext && safeContext.pendingOfferedAction && typeof safeContext.pendingOfferedAction === 'object'
    ? safeContext.pendingOfferedAction
    : null;
  if (!pending) return null;

  const type = String(pending.type || '').trim();
  if (![LOYALTY_OFFERED_ACTION_EXPLAIN_PROGRAM, LOYALTY_OFFERED_ACTION_RECOMMEND_REWARD].includes(type)) return null;

  const activeAt = String(pending.activeAt || '').trim();
  const timestamp = Date.parse(activeAt);
  if (!activeAt || !Number.isFinite(timestamp) || Date.now() - timestamp > LOYALTY_FOLLOW_UP_TTL_MS) {
    return null;
  }

  return {
    type,
    activeAt
  };
}

function getPendingPlanComparisonAction(safeContext) {
  const pending = safeContext && safeContext.pendingOfferedAction && typeof safeContext.pendingOfferedAction === 'object'
    ? safeContext.pendingOfferedAction
    : null;
  if (!pending) return null;

  const type = String(pending.type || '').trim();
  if (![PLAN_PENDING_ACTION_COMPARE_RECOMMENDED, PLAN_PENDING_ACTION_COMPARE_CURRENT].includes(type)) return null;

  const activeAt = String(pending.activeAt || '').trim();
  const timestamp = Date.parse(activeAt);
  if (!activeAt || !Number.isFinite(timestamp) || Date.now() - timestamp > COMMERCIAL_SHORT_MEMORY_TTL_MS) {
    return null;
  }

  return {
    type,
    activeAt,
    currentPlanId: String(pending.currentPlanId || '').trim() || null,
    comparisonPlanId: String(pending.comparisonPlanId || '').trim() || null,
    recommendedPlanId: String(pending.recommendedPlanId || '').trim() || null,
    comparedPlanId: String(pending.comparedPlanId || '').trim() || null,
    recommendationLevel: String(pending.recommendationLevel || '').trim().toLowerCase() || null
  };
}

function normalizeLoyaltyRewardLabel(name) {
  const safeName = String(name || '').trim();
  if (!safeName) return 'un beneficio disponible';
  return safeName.replace(/\s+/g, ' ').replace(/\s*\.\s*$/g, '');
}

function buildLoyaltyRewardHighlight(snapshot) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const availableReward = safeSnapshot.availableReward && typeof safeSnapshot.availableReward === 'object'
    ? safeSnapshot.availableReward
    : null;
  const nextReward = safeSnapshot.nextReward && typeof safeSnapshot.nextReward === 'object'
    ? safeSnapshot.nextReward
    : null;
  const reward = availableReward || nextReward || null;
  if (!reward) return [];

  const labelPrefix = availableReward ? '🎁 Beneficio disponible ahora:' : '🎁 Primer beneficio disponible:';
  return [
    labelPrefix,
    normalizeLoyaltyRewardLabel(reward.name),
    `Disponible desde *${formatWholeNumber(reward.pointsCost)} puntos*.`
  ];
}

function buildLoyaltyProgramExplanationReply({ contact, snapshot }) {
  const firstName = getContactFirstName(contact);
  const greeting = firstName ? `¡Buenísimo, ${firstName}! 😊` : '¡Buenísimo! 😊';
  const lines = [
    greeting,
    '',
    'Los puntos se acumulan automáticamente con tus compras.',
    '',
    '🎁 Cuanto más acumulás, mejores beneficios podés aprovechar.',
    '💳 Cada compra válida va sumando puntos en tu cuenta.',
    '🏆 Cuando llegás a los objetivos disponibles, podés canjear recompensas.'
  ];

  const rewardLines = buildLoyaltyRewardHighlight(snapshot);
  if (rewardLines.length) {
    lines.push('', ...rewardLines);
  }

  lines.push('', 'Si querés, también puedo decirte qué beneficio te conviene alcanzar primero.');
  return lines.join('\n');
}

function buildLoyaltyRecommendedRewardReply({ contact, snapshot }) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const summary = safeSnapshot.summary && typeof safeSnapshot.summary === 'object' ? safeSnapshot.summary : {};
  const rewards = Array.isArray(safeSnapshot.rewards)
    ? safeSnapshot.rewards.filter((reward) => reward && typeof reward === 'object')
    : [];
  const availableReward = safeSnapshot.availableReward && typeof safeSnapshot.availableReward === 'object'
    ? safeSnapshot.availableReward
    : null;
  const nextReward = safeSnapshot.nextReward && typeof safeSnapshot.nextReward === 'object'
    ? safeSnapshot.nextReward
    : null;
  const currentPoints = Number(summary.currentPoints || 0);
  const firstName = getContactFirstName(contact);
  const greeting = firstName ? `Te conviene arrancar por este, ${firstName}:` : 'Te conviene arrancar por este:';

  if (rewards.length === 1) {
    const onlyReward = rewards[0];
    return [
      `El beneficio mas cercano para alcanzar primero es *${normalizeLoyaltyRewardLabel(onlyReward.name)}*.`,
      `Disponible desde *${formatWholeNumber(onlyReward.pointsCost)} puntos*.`
    ].join('\n');
  }

  if (availableReward) {
    return [
      greeting,
      '',
      `🎁 *${normalizeLoyaltyRewardLabel(availableReward.name)}*`,
      `Ya lo tenés disponible con tus *${formatWholeNumber(currentPoints)} puntos* actuales.`,
      '',
      'Si querés, después también te cuento cómo seguir acumulando más.'
    ].join('\n');
  }

  if (nextReward) {
    const missingPoints = Math.max(0, Number(nextReward.pointsCost || 0) - currentPoints);
    return [
      greeting,
      '',
      `🎁 *${normalizeLoyaltyRewardLabel(nextReward.name)}*`,
      `Es el primer beneficio que te queda más cerca y se canjea desde *${formatWholeNumber(nextReward.pointsCost)} puntos*.`,
      `Hoy te faltan *${formatWholeNumber(missingPoints)} puntos* para alcanzarlo.`,
      '',
      'Si querés, también te explico cómo sumar esos puntos más rápido.'
    ].join('\n');
  }

  return [
    firstName ? `Todavía no veo un beneficio claro para recomendarte, ${firstName}.` : 'Todavía no veo un beneficio claro para recomendarte.',
    '',
    'Apenas haya recompensas activas o sigas sumando puntos, te puedo orientar con cuál conviene alcanzar primero.'
  ].join('\n');
}

function buildLoyaltyWhatsAppReply({ contact, snapshot }) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const summary = safeSnapshot.summary && typeof safeSnapshot.summary === 'object' ? safeSnapshot.summary : {};
  const program = safeSnapshot.program && typeof safeSnapshot.program === 'object' ? safeSnapshot.program : {};
  const availableReward = safeSnapshot.availableReward && typeof safeSnapshot.availableReward === 'object'
    ? safeSnapshot.availableReward
    : null;
  const nextReward = safeSnapshot.nextReward && typeof safeSnapshot.nextReward === 'object'
    ? safeSnapshot.nextReward
    : null;
  const firstName = getContactFirstName(contact);
  const greeting = firstName ? `¡Hola ${firstName}! 😊` : '¡Hola! 😊';
  const currentPoints = Number(summary.currentPoints || 0);
  const hasProgramEnabled = program.enabled === true;
  const lines = [greeting];

  if (!hasProgramEnabled) {
    lines.push(
      '',
      'Ahora mismo no veo un programa de beneficios activo para este negocio.',
      'Si querés, igual te ayudo con productos, precios o con una persona del equipo.'
    );
    return lines.join('\n');
  }

  if (!safeSnapshot.enrolled && currentPoints <= 0) {
    lines.push(
      '',
      'Todavía no registrás puntos acumulados en tu cuenta.',
      '',
      'En tu próxima compra ya podés empezar a sumar puntos y aprovechar beneficios.'
    );

    const rewardLines = buildLoyaltyRewardHighlight(safeSnapshot);
    if (rewardLines.length) {
      lines.push('', ...rewardLines);
    }

    lines.push('', 'Si querés, también te cuento cómo funciona el programa.');
    return lines.join('\n');
  }

  lines.push('', `Tenés actualmente *${formatWholeNumber(currentPoints)} puntos acumulados*.`);

  if (availableReward) {
    lines.push('', '✨ Ya tenés un beneficio disponible para usar.');
    lines.push(...buildLoyaltyRewardHighlight(safeSnapshot));
  } else if (currentPoints > 0) {
    lines.push('', '✨ Seguís sumando puntos en tu cuenta.');
  }

  if (!availableReward && nextReward) {
    const missingPoints = Math.max(0, Number(nextReward.pointsCost || 0) - currentPoints);
    lines.push('', `📈 Te faltan *${formatWholeNumber(missingPoints)} puntos* para canjear *${nextReward.name}*.`);
  } else if (!availableReward && !nextReward) {
    lines.push('', 'Por ahora no veo beneficios activos para canjear, pero tus puntos siguen guardados.');
  }

  lines.push('', '¿Querés que te cuente cómo sumar más puntos?');
  return lines.join('\n');
}

async function resolveLoyaltyDecision({ clinic, conversation, contact, inboundText }) {
  if (!isLoyaltyIntent(inboundText)) {
    return null;
  }

  const nextState = conversation && conversation.state && String(conversation.state).toUpperCase() !== 'NEW'
    ? conversation.state
    : 'READY';

  if (!clinic || !clinic.id || !contact || !contact.id) {
    return {
      replyText: [
        '¡Hola! 😊',
        '',
        'No pude encontrar tu cuenta de beneficios con este número todavía.',
        'Si querés, en tu próxima compra te ayudamos a empezar a sumar puntos.'
      ].join('\n'),
      newState: nextState,
      contextPatch: null
    };
  }

  const snapshot = await getLoyaltyWhatsAppSnapshotByClinicId(clinic.id, contact.id);
  return {
    replyText: buildLoyaltyWhatsAppReply({ contact, snapshot }),
    newState: nextState,
    contextPatch: buildLoyaltyContextPatch(snapshot, 'offered_summary')
  };
}

async function resolveLoyaltyFollowUpDecision({ clinic, conversation, contact, inboundText, safeContext }) {
  if (!clinic || !clinic.id || !contact || !contact.id) {
    return null;
  }
  if (!isRecentLoyaltyFollowUpContext(safeContext)) {
    return null;
  }
  if (
    isCommerceEntryIntent(inboundText) ||
    isExplicitCommerceTrigger(inboundText) ||
    looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) ||
    parseTransferPaymentIntent(inboundText)
  ) {
    return null;
  }

  const pendingOfferedAction = getPendingLoyaltyOfferedAction(safeContext);
  const followUpIntentDetected = pendingOfferedAction
    ? isPendingOfferedActionIntent(inboundText, pendingOfferedAction.type)
    : isLoyaltyFollowUpIntent(inboundText);
  if (!followUpIntentDetected) {
    return null;
  }

  const snapshot = await getLoyaltyWhatsAppSnapshotByClinicId(clinic.id, contact.id);
  if (
    pendingOfferedAction &&
    pendingOfferedAction.type === LOYALTY_OFFERED_ACTION_RECOMMEND_REWARD
  ) {
    return {
      replyText: buildLoyaltyRecommendedRewardReply({ contact, snapshot }),
      newState: conversation.state || 'READY',
      contextPatch: buildLoyaltyContextPatch(snapshot, 'offered_action_completed', {
        type: null,
        activeAt: null,
        completedAt: new Date().toISOString()
      })
    };
  }

  if (String(safeContext && safeContext.loyaltyFollowUpMode ? safeContext.loyaltyFollowUpMode : '').trim() !== 'offered_summary') {
    return null;
  }

  return {
    replyText: buildLoyaltyProgramExplanationReply({ contact, snapshot }),
    newState: conversation.state || 'READY',
    contextPatch: buildLoyaltyContextPatch(snapshot, 'explained_program', {
      type: LOYALTY_OFFERED_ACTION_RECOMMEND_REWARD,
      activeAt: new Date().toISOString()
    })
  };
}

function isPlanProduct(product) {
  if (!product) return false;
  const name = String(product.nameSnapshot || product.name || '').toLowerCase();
  const sku = String(product.skuSnapshot || product.sku || '').toUpperCase();

  return name.includes('plan') || sku.startsWith('PLAN');
}

function isPlanCatalog(products) {
  if (!Array.isArray(products) || products.length === 0) return false;
  const planCount = products.filter(isPlanProduct).length;
  return planCount >= Math.ceil(products.length * 0.6);
}

function getOrderedPlanProducts(products) {
  const safeProducts = Array.isArray(products) ? products.filter(isPlanProduct) : [];
  if (!safeProducts.length) return [];

  const ordered = [];
  const usedIds = new Set();
  const groups = [
    ['inicial', 'start', 'starter'],
    ['crecimiento', 'grow', 'growth'],
    ['empresa', 'pro', 'enterprise']
  ];

  for (const group of groups) {
    const matched = safeProducts.find((product) => {
      const name = normalizeCommandText(product && product.name ? product.name : '');
      const sku = normalizeCommandText(product && product.sku ? product.sku : '');
      return group.some((keyword) => name.includes(keyword) || sku.includes(keyword));
    });

    if (matched && !usedIds.has(String(matched.id || matched.productId || ''))) {
      usedIds.add(String(matched.id || matched.productId || ''));
      ordered.push(matched);
    }
  }

  const remaining = safeProducts
    .filter((product) => !usedIds.has(String(product.id || product.productId || '')))
    .sort((left, right) => Number(left.price || 0) - Number(right.price || 0));

  return [...ordered, ...remaining];
}

function extractPlanDescription(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const descriptionLines = String(safeProduct.description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    headline: descriptionLines[0] || 'Es una gran opción para empezar a automatizar ventas con Opturon.',
    featureLines: descriptionLines.slice(1, 4)
  };
}

function resolvePlanProfile(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const normalizedName = normalizeCommandText(safeProduct.name || '');
  const { headline, featureLines } = extractPlanDescription(safeProduct);

  if (normalizedName.includes('inicial') || normalizedName.includes('starter') || normalizedName.includes('start')) {
    return {
      shortDescription: 'Para empezar a ordenar WhatsApp y no perder consultas.',
      problemSolved: 'respondes de forma improvisada y todavia no tienes un sistema comercial claro',
      result: 'centralizar conversaciones, responder mejor y empezar a seguir oportunidades sin depender de memoria ni planillas',
      featureLines: [
        '1 canal de WhatsApp',
        'bandeja de mensajes con contexto',
        'catalogo simple',
        'bot de atencion inicial y respuestas automaticas'
      ],
      usersLabel: '1 cuenta principal + accesos para tu equipo segun el plan',
      controlLevel: 'Control operativo inicial'
    };
  }

  if (normalizedName.includes('crecimiento') || normalizedName.includes('growth') || normalizedName.includes('grow')) {
    return {
      shortDescription: 'Para vender con seguimiento real y operacion diaria mas ordenada.',
      problemSolved: 'ya tienes consultas y ventas por WhatsApp, pero falta seguimiento comercial serio',
      result: 'trabajar con seguimiento visible y una operacion comercial mucho mas clara',
      featureLines: [
        'bot de ventas mas completo',
        'categorias y catalogo mas armado',
        'toma de pedidos',
        'seguimiento de conversaciones desde el panel'
      ],
      usersLabel: '1 cuenta principal + accesos para trabajar en equipo segun el plan',
      controlLevel: 'Control comercial diario'
    };
  }

  if (normalizedName.includes('empresa') || normalizedName.includes('pro') || normalizedName.includes('enterprise')) {
    return {
      shortDescription: 'Para equipos con mas volumen, supervision y necesidad de personalizacion.',
      problemSolved: 'ya necesitas mas control, mas soporte y una operacion mejor acompañada',
      result: 'escalar con mas trazabilidad, supervision y una base mas fuerte para el equipo',
      featureLines: [
        'mayor personalizacion',
        'soporte prioritario',
        'integraciones avanzadas a medida',
        'setup mas acompañado'
      ],
      usersLabel: '1 cuenta principal + equipo ampliado segun el plan',
      controlLevel: 'Control operativo alto'
    };
  }

  return {
    shortDescription: headline,
    problemSolved: 'quieres ordenar ventas y seguimiento por WhatsApp',
    result: 'trabajar con una operacion mas clara y un proceso comercial mejor guiado',
    featureLines,
    usersLabel: '1 cuenta principal + accesos para tu equipo segun el plan',
    controlLevel: 'Control operativo segun configuracion'
  };
}

function buildPlanCatalogLine(product) {
  const profile = resolvePlanProfile(product);
  const safeProduct = product && typeof product === 'object' ? product : {};
  const safeName = String(safeProduct.name || 'Plan').trim() || 'Plan';
  const safePrice = Number(safeProduct.price || 0);
  const lineParts = [];

  if (Number.isFinite(safePrice) && safePrice > 0) {
    lineParts.push(`${safeName} — ${formatMoney(safePrice, safeProduct.currency)}`);
  } else {
    lineParts.push(safeName);
  }

  const shortDescription = String(profile && profile.shortDescription ? profile.shortDescription : '').trim();
  if (shortDescription) {
    lineParts.push(`   ${shortDescription}`);
  }

  return lineParts.join('\n');
}

function buildPlanSalesCta(text = 'Si querés, te recomiendo uno según lo que buscás o te muestro el que más te convenga.') {
  return text;
}

function buildPlanOfferReply(products) {
  const orderedPlans = getOrderedPlanProducts(products);
  if (!orderedPlans.length) {
    return 'Puedo ayudarte con los planes de Opturon, pero ahora mismo no encuentro planes activos para mostrarte.';
  }

  return [
    '¡Sí! Te cuento 😊',
    '',
    ...orderedPlans.slice(0, 3).map((product) => buildPlanCatalogLine(product)),
    '',
    'Si querés, también te paso precios más en detalle o te recomiendo cuál miraría yo para tu negocio.'
  ].join('\n');
}

function isPlanComparisonIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return [
    'cual me conviene',
    'cuál me conviene',
    'que plan me conviene',
    'qué plan me conviene',
    'cual recomendas',
    'cuál recomendás',
    'cual recomiendan',
    'que cambia entre planes',
    'qué cambia entre planes',
    'que diferencia hay',
    'qué diferencia hay',
    'que plan me sirve',
    'qué plan me sirve',
    'que cambia',
    'qué cambia'
  ].some((pattern) => text.includes(normalizeCommandText(pattern)));
}

function resolvePlanNeedHint(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    text.includes('algo simple') ||
    text.includes('recien empiezo') ||
    text.includes('recién empiezo') ||
    text.includes('empezar simple') ||
    text.includes('plan inicial') ||
    text.includes('econom') ||
    text.includes('barato') ||
    text.includes('accesible') ||
    text.includes('basico') ||
    text.includes('básico')
  ) {
    return 'starter';
  }

  if (
    text.includes('vender mas') ||
    text.includes('vender más') ||
    text.includes('automatizar mejor') ||
    text.includes('algo mejor') ||
    text.includes('mejorcito') ||
    text.includes('mas completo') ||
    text.includes('más completo') ||
    text.includes('quiero crecer')
  ) {
    return 'growth';
  }

  if (
    text.includes('premium') ||
    text.includes('empresa') ||
    text.includes('personalizado') ||
    text.includes('integraciones') ||
    text.includes('soporte prioritario') ||
    text.includes('a medida')
  ) {
    return 'enterprise';
  }

  return null;
}

function isPlanRecommendationIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return Boolean(resolvePlanNeedHint(text)) || [
    'cual me conviene',
    'cuál me conviene',
    'me conviene',
    'que plan me conviene',
    'qué plan me conviene',
    'cual recomendas',
    'cual me recomendas',
    'que me recomendas',
    'que plan me recomendas',
    'cuál recomendás',
    'cual elegirias vos',
    'cuál elegirías vos',
    'para mi negocio cual sirve',
    'para mi negocio cuál sirve',
    'para mi negocio que plan va',
    'para mi negocio qué plan va',
    'cual recomiendan',
    'cual me sirve',
    'que plan me sirve',
    'qué plan me sirve'
  ].some((pattern) => text.includes(normalizeCommandText(pattern)));
}

function isPlanPricingIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    text.includes('cuanto sale') ||
    text.includes('cuánto sale') ||
    text.includes('precio') ||
    text.includes('precios') ||
    text.includes('planes y precios') ||
    text.includes('costos') ||
    text.includes('valor') ||
    text.includes('costo') ||
    text.includes('que incluye') ||
    text.includes('qué incluye') ||
    text.includes('incluye cada uno')
  );
}

function findPlanByNeedHint(products, needHint) {
  const orderedPlans = getOrderedPlanProducts(products);
  if (!orderedPlans.length) return null;

  if (needHint === 'starter') {
    return orderedPlans.find((product) => normalizeCommandText(product.name || '').includes('inicial')) || orderedPlans[0];
  }

  if (needHint === 'growth') {
    return orderedPlans.find((product) => normalizeCommandText(product.name || '').includes('crecimiento')) || orderedPlans[1] || orderedPlans[0];
  }

  if (needHint === 'enterprise') {
    return orderedPlans.find((product) => normalizeCommandText(product.name || '').includes('empresa')) || orderedPlans[orderedPlans.length - 1];
  }

  return null;
}

function findReferencedPlan(products, rawText) {
  const orderedPlans = getOrderedPlanProducts(products);
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const exact = orderedPlans.find((product) => text.includes(normalizeCommandText(product.name || '')));
  if (exact) return exact;

  const namedTokens = orderedPlans.map((product) => {
    const normalizedName = normalizeCommandText(product.name || '');
    const remainder = normalizedName.replace(/\bplan\b/g, '').trim();
    return {
      product,
      normalizedName,
      remainder
    };
  });

  return namedTokens.find((entry) => entry.remainder && text.includes(entry.remainder))?.product || null;
}

function findReferencedPlans(products, rawText) {
  const orderedPlans = getOrderedPlanProducts(products);
  const text = normalizeCommandText(rawText);
  if (!text) return [];

  return orderedPlans
    .map((product) => {
      const normalizedName = normalizeCommandText(product.name || '');
      const remainder = normalizedName.replace(/\bplan\b/g, '').trim();
      const directIndex = normalizedName ? text.indexOf(normalizedName) : -1;
      const remainderIndex = remainder ? text.indexOf(remainder) : -1;
      const firstIndex = directIndex >= 0 ? directIndex : remainderIndex;
      return {
        product,
        firstIndex
      };
    })
    .filter((entry) => entry.firstIndex >= 0)
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((entry) => entry.product);
}

function isContextualPlanReferenceIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return [
    'ese',
    'ese plan',
    'mostrame ese',
    'mostrame ese plan',
    'quiero ver ese',
    'quiero ver ese plan',
    'ver ese plan',
    'a ver ese plan'
  ].includes(text);
}

function isPlanDirectDetailIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    text.includes('mostrame') ||
    text.includes('mostrar') ||
    text.includes('quiero ver') ||
    text.includes('ver el plan') ||
    text.includes('ver plan') ||
    text.includes('a ver') ||
    text.includes('detalle') ||
    text.includes('ese plan')
  );
}

function isContextualPlanQuestionIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    text.includes('que tiene') ||
    text.includes('qué tiene') ||
    text.includes('que incluye') ||
    text.includes('qué incluye') ||
    text.includes('que ofrece') ||
    text.includes('qué ofrece') ||
    text.includes('que trae') ||
    text.includes('qué trae') ||
    text.includes('vale la pena') ||
    text.includes('que gano') ||
    text.includes('qué gano') ||
    text === 'y el otro' ||
    text === 'y crecimiento' ||
    text === 'y empresa' ||
    text.includes('que cambia') ||
    text.includes('qué cambia') ||
    text.includes('que diferencia hay') ||
    text.includes('qué diferencia hay')
  );
}

function isPlanWorthItIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return (
    text.includes('vale la pena') ||
    text === 'me conviene' ||
      text.includes('me sirve') ||
      text.includes('sirve para mi')
  );
}

function isCurrentMessageAskingForPlanRecommendation(rawText, commercialIntent = null, detectedSalesContext = null) {
  const text = normalizeCommandText(rawText);
  const safeCommercialIntent = commercialIntent && typeof commercialIntent === 'object' ? commercialIntent : {};
  const safeDetectedSalesContext = detectedSalesContext && typeof detectedSalesContext === 'object' ? detectedSalesContext : null;
  if (!text) return false;

  if (safeCommercialIntent.type === 'recommendation') {
    return true;
  }

  if (
    isPlanRecommendationIntent(text) ||
    isPlanComparisonIntent(text) ||
    isPlanVsPlanIntent(text) ||
    isRecommendationWhyFollowUpIntent(text) ||
    isPlanWorthItIntent(text) ||
    hasPlanComparisonSemanticCue(text) ||
    isContextualPlanQuestionIntent(text)
  ) {
    return true;
  }

  const mentionsPlanByName = /\b(plan|planes|inicial|crecimiento|empresa)\b/.test(text);
  const asksToChoose = (
    text.includes('cual') ||
    text.includes('cuál') ||
    text.includes('eleg') ||
    text.includes('elijo') ||
    text.includes('conviene') ||
    text.includes('recomend') ||
    text.includes('usar') ||
    text.includes('sirve mas') ||
    text.includes('sirve más')
  );
  if (mentionsPlanByName && asksToChoose) {
    return true;
  }

  if (!safeDetectedSalesContext) {
    return false;
  }

  const hasBusinessSizingSignals = Boolean(
    safeDetectedSalesContext.businessType ||
    safeDetectedSalesContext.whatsappVolume ||
    safeDetectedSalesContext.teamSizeSignal ||
    (Array.isArray(safeDetectedSalesContext.painPoints) && safeDetectedSalesContext.painPoints.length)
  );
  const asksForWhatToUse = (
    text.includes('que plan') ||
    text.includes('qué plan') ||
    text.includes('cual uso') ||
    text.includes('cuál uso') ||
    text.includes('que uso') ||
    text.includes('qué uso') ||
    text.includes('cual elijo') ||
    text.includes('cuál elijo') ||
    text.includes('que plan elijo') ||
    text.includes('qué plan elijo') ||
    text.includes('me conviene') ||
    text.includes('recomend') ||
    text.includes('sirve mas') ||
    text.includes('sirve más')
  );

  return hasBusinessSizingSignals && asksForWhatToUse;
}

function isRecommendationWhyFollowUpIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    text.includes('por que me recomendarias eso') ||
    text.includes('por qué me recomendarías eso') ||
    text.includes('por que me recomendarias ese') ||
    text.includes('por qué me recomendarías ese') ||
      text.includes('por que me recomendaste eso') ||
      text.includes('por qué me recomendaste eso') ||
      text.includes('por que me recomendarias') ||
      text.includes('por qué me recomendarías') ||
      text.includes('por que ese plan') ||
      text.includes('por qué ese plan') ||
      text.includes('por que crecimiento') ||
      text.includes('por qué crecimiento') ||
      text.includes('por que empresa') ||
      text.includes('por qué empresa') ||
      text.includes('por que crecimiento y no inicial') ||
      text.includes('por qué crecimiento y no inicial') ||
      text.includes('por que empresa y no crecimiento') ||
      text.includes('por qué empresa y no crecimiento') ||
      text.includes('por que eso') ||
      text.includes('por qué eso') ||
      text === 'y eso' ||
      text === 'y eso?' ||
      text === 'por' ||
      text === 'por?' ||
      text.includes('como llegaste a eso') ||
      text.includes('como llegaste a esa recomendacion') ||
      text.includes('cómo llegaste a eso') ||
      text.includes('cómo llegaste a esa recomendación')
  );
}

function hasPlanComparisonSemanticCue(rawText) {
  const text = normalizeLooseIntentText(rawText);
  if (!text) return false;

  return (
    text.includes('diferenc') ||
    text.includes('compar') ||
    text.includes(' versus ') ||
    text.includes(' vs ') ||
    text.startsWith('vs ') ||
    text.endsWith(' vs') ||
    text.includes(' contra ') ||
    text.includes(' entre ') ||
    text.includes(' uno y otro ') ||
    text.endsWith(' uno y otro') ||
    text.includes('cual me conviene') ||
    text.includes('cual conviene') ||
    text.includes('conviene mas') ||
    text.includes('vale la pena') ||
    text.includes('que cambia') ||
    text.includes('que gana') ||
    text.includes('que gano') ||
    (text.includes('que tiene') && text.includes('que no tenga')) ||
    (text.includes('me explic') && text.includes('diferenc'))
  );
}

function isPlanVsPlanIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return (
    text.includes(' y no ') ||
    text.includes(' mejor que ') ||
    text.includes(' diferencia hay entre ') ||
    text.includes(' cual me conviene mas') ||
    text.includes(' cuál me conviene más') ||
    text.includes(' con mi negocio cual elegirias') ||
    text.includes(' con mi negocio cuál elegirías') ||
    text.includes(' empresa es mejor que crecimiento') ||
    text.includes(' crecimiento es mejor que inicial') ||
    hasPlanComparisonSemanticCue(text)
  );
}

function findPlanByContext(products, safeContext) {
  const suggestedId = String(safeContext && safeContext.commerceSuggestedProductId ? safeContext.commerceSuggestedProductId : '').trim();
  const suggestedName = String(safeContext && safeContext.commerceSuggestedProductName ? safeContext.commerceSuggestedProductName : '').trim();
  const orderedPlans = getOrderedPlanProducts(products);

  if (suggestedId) {
    const byId = orderedPlans.find((product) => String(product.id || product.productId || '').trim() === suggestedId);
    if (byId) return byId;
  }

  if (suggestedName) {
    const normalizedSuggestedName = normalizeCommandText(suggestedName);
    const byName = orderedPlans.find((product) => normalizeCommandText(product.name || '') === normalizedSuggestedName);
    if (byName) return byName;
  }

  return null;
}

function buildPlanComparisonReply(products) {
  const orderedPlans = getOrderedPlanProducts(products);
  if (!orderedPlans.length) {
    return 'Puedo ayudarte a comparar los planes de Opturon, pero ahora mismo no encuentro planes activos para mostrarte.';
  }

  const starterPlan = findPlanByNeedHint(orderedPlans, 'starter');
  const growthPlan = findPlanByNeedHint(orderedPlans, 'growth');
  const enterprisePlan = findPlanByNeedHint(orderedPlans, 'enterprise');

  return [
    'Te lo resumo simple 👇',
    '',
    ...orderedPlans.slice(0, 3).map((product) => {
      const profile = resolvePlanProfile(product);
      return `• ${product.name} — ${formatMoney(product.price, product.currency)}: ${profile.shortDescription}`;
    }),
    '',
    starterPlan ? `${starterPlan.name}: si querés arrancar simple y ordenar WhatsApp.` : null,
    growthPlan ? `${growthPlan.name}: si ya te entran consultas y querés seguimiento real.` : null,
    enterprisePlan ? `${enterprisePlan.name}: si ya necesitás más control, equipo o personalización.` : null,
    '',
    'Si querés, te digo cuál miraría yo según tu momento.'
  ].filter(Boolean).join('\n');
}

function buildPlanRecommendationReply(product, salesContext = null, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const profile = resolvePlanProfile(safeProduct);
  const reason = buildRecommendationReasonSummary(safeProduct, salesContext, allPlans);
  const topFeatures = Array.isArray(profile.featureLines) ? profile.featureLines.slice(0, 2) : [];

  return [
    `Yo miraría ${safeProduct.name || 'este plan'}.`,
    '',
    `¿Por qué? Porque ${reason}.`,
    topFeatures.length ? `Lo más útil acá suele ser: ${topFeatures.join(' + ')}.` : profile.shortDescription,
    '',
    'Si querés, te cuento la diferencia con otro plan.'
  ].join('\n');
}

function detectCommercialPlanObjection(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    text.includes('busco algo mas barato') ||
    text.includes('busco algo más barato') ||
    text.includes('quiero algo mas barato') ||
    text.includes('quiero algo más barato') ||
    text.includes('algo mas barato') ||
    text.includes('algo más barato') ||
    text.includes('algo mas economico') ||
    text.includes('algo más económico') ||
    text.includes('algo mas accesible') ||
    text.includes('algo más accesible')
  ) {
    return 'cheaper_option';
  }

  if (
    text.includes('no llego') ||
    text.includes('no me da') ||
    text.includes('se me va') ||
    text.includes('se me complica') ||
    text.includes('no me alcanza')
  ) {
    return 'budget_limit';
  }

  if (
    text.includes('ta caro') ||
    text.includes('es caro') ||
    text.includes('parece caro') ||
    text.includes('me parece caro') ||
    text.includes('muy caro') ||
    text.includes('medio caro') ||
    text.includes('mmm caro') ||
    text.includes('sale mucho') ||
    text.includes('mas barato') ||
    text.includes('más barato') ||
    text.includes('mas economico') ||
    text.includes('más económico') ||
    text.includes('mas accesible') ||
    text.includes('más accesible') ||
    text === 'caro'
  ) {
    return 'price_high';
  }

  if (
    text.includes('solo quiero ordenar whatsapp') ||
    text.includes('solo quiero ordenar') ||
    text.includes('ordenar whatsapp')
  ) {
    return 'order_whatsapp';
  }

  if (
    text.includes('recien empiezo') ||
    text.includes('recién empiezo') ||
    text.includes('estoy arrancando') ||
    text.includes('arranco recien') ||
    text.includes('arranco recién')
  ) {
    return 'starting';
  }

  if (
    text.includes('lo voy a pensar') ||
    text.includes('dejame pensarlo') ||
    text.includes('déjame pensarlo') ||
    text.includes('mas adelante') ||
    text.includes('más adelante') ||
    text.includes('despues lo veo') ||
    text.includes('después lo veo')
  ) {
    return 'later';
  }

  if (
    text.includes('tengo que consultarlo') ||
    text.includes('tengo que verlo') ||
    text.includes('lo tengo que ver') ||
    text.includes('lo tengo que consultar')
  ) {
    return 'consulting';
  }

  if (
    text.includes('uso excel') ||
    text.includes('me manejo con excel') ||
    text.includes('trabajo con excel')
  ) {
    return 'excel_existing';
  }

  if (
    text.includes('uso whatsapp normal') ||
    text.includes('me manejo con whatsapp normal') ||
    text.includes('ya uso whatsapp normal')
  ) {
    return 'whatsapp_manual';
  }

  if (
    text.includes('ya tengo crm') ||
    text.includes('uso un crm') ||
    text.includes('ya usamos crm') ||
    text.includes('ya tengo un crm')
  ) {
    return 'crm_existing';
  }

  return null;
}

function detectCommercialNextStepIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    text === 'me interesa' ||
    text === 'quiero contratar' ||
    text === 'quiero comprar' ||
    text === 'quiero arrancar' ||
    text === 'quiero ese plan' ||
    text === 'me convenciste' ||
    text === 'avancemos' ||
    text === 'como sigo' ||
    text === 'como hago' ||
    text === 'como hago para contratar'
  ) {
    return 'advance';
  }

  if (
    text.includes('me interesa') ||
    text.includes('quiero contratar') ||
    text.includes('quiero comprar') ||
    text.includes('quiero arrancar') ||
    text.includes('quiero ese plan') ||
    text.includes('me convenciste') ||
    text.includes('avancemos') ||
    text.includes('como sigo') ||
    text.includes('como hago para contratar')
  ) {
    return 'advance';
  }

  return null;
}

function buildBusinessContextPlanRecommendationReply(product, businessContext, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const safeContext = businessContext && typeof businessContext === 'object' ? businessContext : {};
  const enterprisePlan = findPlanByNeedHint(allPlans, 'enterprise');

  if (safeContext.recommendationLevel === 'enterprise') {
    return [
      `Por el volumen que me comentás, probablemente te convenga más el ${safeProduct.name || 'Plan Empresa'} 😊`,
      '',
      'Está pensado para equipos, supervisión y operación más intensa.',
      '',
      'Si querés, también te cuento la diferencia con los otros planes.'
    ].join('\n');
  }

  if (safeContext.recommendationLevel === 'starter') {
    return [
      `Si querés arrancar simple y económico, el ${safeProduct.name || 'Plan Inicial'} puede ser una buena opción 😊`,
      '',
      'Te deja ordenar WhatsApp y empezar con una base prolija sin irte a algo más grande de entrada.',
      '',
      'Si querés, también te cuento cuándo conviene pasar al siguiente plan.'
    ].join('\n');
  }

  return [
    `Por lo que me contás, creo que el ${safeProduct.name || 'Plan Crecimiento'} puede irte muy bien 😊`,
    '',
    'Te ayuda a ordenar WhatsApp, responder más rápido y hacer seguimiento de clientes sin perder consultas.',
    '',
    enterprisePlan
      ? `Si querés, también te cuento la diferencia con el ${enterprisePlan.name}.`
      : 'Si querés, también te cuento la diferencia con el plan más completo.'
  ].join('\n');
}

function buildSalesDiscoveryQuestion() {
  return 'Depende un poco de tu operación 😊 ¿Hoy estás arrancando, ya recibís muchas consultas por WhatsApp o tenés un equipo vendiendo?';
}

function buildAiAssistFeatureContextPatch({ safeContext, effectiveSalesContext, derivedBusinessContext }) {
  return {
    ...(effectiveSalesContext && hasMinimumSalesContextForRecommendation(effectiveSalesContext)
      ? buildCommercialSalesContextPatch(effectiveSalesContext)
      : {}),
    ...(derivedBusinessContext
      ? buildBusinessRecommendationContextPatch(derivedBusinessContext)
      : {}),
    ...(getActiveCommercialShortMemory(safeContext)
      ? buildCommercialShortMemoryPatch({
        topic: 'plans',
        lastSuggestedProductId: getActiveCommercialShortMemory(safeContext).lastSuggestedProductId || null,
        recommendationType: getActiveCommercialShortMemory(safeContext).recommendationType || null,
        lastReplyKey: 'feature_fit_followup'
      })
      : {})
  };
}

function scopeSalesContextByIntent(intent, salesContext = {}) {
  const safeIntent = String(intent || '').trim().toLowerCase();
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};

  if (safeIntent === 'seller_replacement') {
    return {
      teamSizeSignal: safeContext.teamSizeSignal || null
    };
  }

  if (safeIntent === 'whatsapp_number_portability') {
    return {};
  }

  if (safeIntent === 'catalog_import_fit') {
    return {};
  }

  if (safeIntent === 'industry_fit') {
    return {
      businessType: safeContext.businessType || null,
      whatsappVolume: safeContext.whatsappVolume || null,
      teamSizeSignal: safeContext.teamSizeSignal || null
    };
  }

  if (safeIntent === 'feature_fit') {
    return {
      teamSizeSignal: safeContext.teamSizeSignal || null
    };
  }

  if (safeIntent === 'channel_compatibility') {
    return {
      whatsappVolume: safeContext.whatsappVolume || null
    };
  }

  return {};
}

function buildChannelCompatibilityReply(effectiveSalesContext = {}, derivedBusinessContext = null) {
  const scopedContext = scopeSalesContextByIntent('channel_compatibility', effectiveSalesContext);
  const businessLead = describeSalesContextShort(scopedContext);
  const businessLine = businessLead
    ? `Si hoy trabajás con ${businessLead}, te ayuda a ordenar mejor las consultas y no perder oportunidades.`
    : 'Te ayuda a ordenar mejor las consultas, responder más rápido y dar seguimiento sin perder oportunidades.';

  return [
    'Sí, te puede servir 😊',
    '',
    'Si hoy recibís consultas por WhatsApp y también por Instagram, Opturon te ayuda a ordenar conversaciones, hacer seguimiento y responder con más claridad.',
    '',
    businessLine,
    '',
    derivedBusinessContext
      ? '¿Vendés productos o servicios?'
      : '¿Hoy vendés productos o servicios?'
  ].join('\n');
}

function buildWhatsAppNumberPortabilityReply() {
  return [
    'Sí, en muchos casos se puede trabajar con tu número actual 😊',
    '',
    'La idea es que no tengas que arrancar de cero si ya venís atendiendo por WhatsApp.',
    'Eso ayuda a mantener la continuidad con tus clientes y a ordenar mejor las conversaciones desde el mismo canal.',
    '',
    '¿Hoy atendés desde un número personal o desde WhatsApp Business?'
  ].join('\n');
}

function buildSellerReplacementReply(effectiveSalesContext = {}) {
  const scopedContext = scopeSalesContextByIntent('seller_replacement', effectiveSalesContext);
  const contextLead = describeSalesContextShort(scopedContext);
  return [
    'No, no busca reemplazar a tu equipo 😊',
    '',
    'La idea es que el sistema se encargue de tareas repetitivas para que los vendedores puedan enfocarse en atender mejor y cerrar más ventas.',
    'Sirve para ordenar consultas, seguimiento y derivación, sin sacar a la persona del proceso cuando hace falta.',
    '',
    contextLead
      ? `En un esquema como ${contextLead}, suele sumar mucho más por organización y velocidad de respuesta.`
      : 'Suele sumar mucho más por organización y velocidad de respuesta que por reemplazo.',
    '',
    '¿Cuántas personas atienden hoy las consultas?'
  ].join('\n');
}

function buildIndustryFitReply(inboundText, effectiveSalesContext = {}) {
  const text = normalizeCommandText(inboundText);
  const explicitBusinessType = normalizeAiAssistBusinessType(text);
  const scopedContext = scopeSalesContextByIntent('industry_fit', effectiveSalesContext);
  const businessType = explicitBusinessType || scopedContext.businessType || null;
  const label = (
    businessType === 'food_business' ? 'una rotisería o negocio de comida' :
      businessType === 'beauty_business' ? 'una peluquería o negocio de estética' :
        businessType === 'distribution' ? 'una distribuidora' :
          businessType === 'fashion_retail' ? 'un negocio de ropa' :
            businessType === 'services' ? 'un negocio de servicios' :
              'ese tipo de negocio'
  );

  return [
    `Sí, puede servir perfectamente para ${label} 😊`,
    '',
    'Cuando tenés muchas consultas, pedidos o reservas, ayuda a ordenar las conversaciones y darle seguimiento a cada cliente sin perder tiempo.',
    'También te permite responder más parejo y mantener más control sobre lo que entra cada día.',
    '',
    businessType === 'food_business'
      ? '¿Cómo manejan hoy los pedidos?'
      : businessType === 'beauty_business'
        ? '¿Cómo organizan hoy los turnos y las consultas?'
        : businessType === 'distribution'
          ? '¿Hoy las consultas las atiende una sola persona o ya tienen equipo?'
          : '¿Cómo manejan hoy las consultas en tu negocio?'
  ].join('\n');
}

function buildFeatureFitReply(inboundText, effectiveSalesContext = {}) {
  const text = normalizeCommandText(inboundText);
  const scopedContext = scopeSalesContextByIntent('feature_fit', effectiveSalesContext);

  if (text.includes('sucursal')) {
    return [
      'Sí, puede acompañar una operación con más de una sucursal 😊',
      '',
      'Cuando hay más de un punto de atención, lo importante es ordenar mejor las conversaciones, el seguimiento y quién toma cada caso.',
      'Eso ayuda a que el equipo trabaje más claro y a que no se pierdan consultas por el camino.',
      '',
      '¿Hoy manejan todo desde un solo número o cada sucursal atiende por separado?'
    ].join('\n');
  }

  const contextLead = describeSalesContextShort(scopedContext);
  return [
    'Sí, puede servirte 😊',
    '',
    contextLead
      ? `Si ${contextLead}, te ayuda a ordenar mejor consultas, seguimiento y operación comercial.`
      : 'La idea es ayudarte a ordenar consultas, seguimiento y operación comercial de una forma más simple.',
    '',
    '¿Qué parte te gustaría ordenar primero: consultas, seguimiento o catálogo?'
  ].join('\n');
}

function buildCatalogImportFitReply() {
  return [
    'Sí, no hace falta cargar todo manualmente uno por uno 😊',
    '',
    'Hay formas de agilizar la incorporación del catálogo para que el proceso sea mucho más rápido y ordenado.',
    'La idea es que puedas empezar a trabajar sin trabarte con una carga eterna desde el día uno.',
    '',
    '¿Aproximadamente cuántos productos manejás hoy?'
  ].join('\n');
}

function inferWeakSignalChannels(inboundText) {
  const text = normalizeCommandText(inboundText);
  const channels = [];
  if (text.includes('whatsapp')) channels.push('whatsapp');
  if (text.includes('instagram')) channels.push('instagram');
  return channels;
}

function inferWeakSignalReplyIntent(inboundText, signal) {
  const text = normalizeCommandText(inboundText);
  const safeSignal = String(signal || '').trim().toLowerCase();
  const explicitBusinessType = normalizeAiAssistBusinessType(text);

  if (safeSignal === 'whatsapp_number_portability_phrase' || text.includes('numero actual de whatsapp')) {
    return 'whatsapp_number_portability';
  }
  if (safeSignal === 'seller_replacement_phrase' || text.includes('reemplaza') || text.includes('vendedores')) {
    return 'seller_replacement';
  }
  if (safeSignal === 'catalog_import_phrase' || text.includes('muchos productos') || text.includes('como los cargo') || text.includes('cargar productos')) {
    return 'catalog_import_fit';
  }
  if (explicitBusinessType) {
    return 'industry_fit';
  }
  if (
    text.includes('rotiseria') ||
    text.includes('rotisería') ||
    text.includes('peluquer') ||
    text.includes('distribuidora') ||
    text.includes('sirve para') ||
    text.includes('funciona para')
  ) {
    return 'industry_fit';
  }
  if (text.includes('instagram') || text.includes('compatible') || text.includes('compatibilidad') || text.includes('software')) {
    return 'channel_compatibility';
  }
  return 'feature_fit';
}

function shouldUseWeakSignalCommercialFallback(aiAssistInvocation, aiAssistResult) {
  if (!aiAssistInvocation || aiAssistInvocation.ok !== true) return false;
  if (aiAssistInvocation.reason !== 'commercial_weak_signal') return false;
  if (!aiAssistResult || aiAssistResult.ok === true) return false;
  const reason = String(aiAssistResult.reason || '').trim().toLowerCase();
  if (!reason) return false;
  return (
    reason.startsWith('ai_assist_timeout_') ||
    reason.startsWith('ai_assist_provider_failed_') ||
    reason.startsWith('ai_assist_invalid_') ||
    reason.startsWith('ai_assist_provider_not_supported') ||
    aiAssistResult.failed === true
  );
}

function buildWeakSignalCommercialFallback({ inboundText, safeContext, signal }) {
  const currentSalesContext = getActiveCommercialSalesContext(safeContext);
  const effectiveSalesContext = buildAiAssistSalesContext({
    businessType: normalizeAiAssistBusinessType(inboundText),
    teamSize: normalizeAiAssistTeamSizeSignal(inboundText),
    channels: inferWeakSignalChannels(inboundText)
  }, currentSalesContext);
  const derivedBusinessContext =
    deriveBusinessRecommendationContextFromSalesContext(effectiveSalesContext) ||
    getActiveBusinessRecommendationContext(safeContext);
  const replyIntent = inferWeakSignalReplyIntent(inboundText, signal);
  const contextPatch = buildAiAssistFeatureContextPatch({
    safeContext,
    effectiveSalesContext,
    derivedBusinessContext
  });

  if (replyIntent === 'channel_compatibility') {
    return {
      type: 'recommendation',
      source: 'weak_signal_timeout_fallback',
      replyText: buildChannelCompatibilityReply(effectiveSalesContext, derivedBusinessContext),
      contextPatch: mergeContextPatches(
        contextPatch,
        buildCommercialDiscoveryPendingPatch({
          field: 'offer_type',
          sourceIntent: 'channel_compatibility'
        })
      )
    };
  }

  if (replyIntent === 'whatsapp_number_portability') {
    return {
      type: 'recommendation',
      source: 'weak_signal_timeout_fallback',
      replyText: buildWhatsAppNumberPortabilityReply(),
      contextPatch: mergeContextPatches(
        contextPatch,
        buildCommercialDiscoveryPendingPatch({
          field: 'whatsapp_account_type',
          sourceIntent: 'whatsapp_number_portability'
        })
      )
    };
  }

  if (replyIntent === 'seller_replacement') {
    return {
      type: 'recommendation',
      source: 'weak_signal_timeout_fallback',
      replyText: buildSellerReplacementReply(effectiveSalesContext),
      contextPatch: mergeContextPatches(
        contextPatch,
        buildCommercialDiscoveryPendingPatch({
          field: 'team_size',
          sourceIntent: 'seller_replacement'
        })
      )
    };
  }

  if (replyIntent === 'industry_fit') {
    return {
      type: 'recommendation',
      source: 'weak_signal_timeout_fallback',
      replyText: buildIndustryFitReply(inboundText, effectiveSalesContext),
      contextPatch
    };
  }

  if (replyIntent === 'catalog_import_fit') {
    return {
      type: 'recommendation',
      source: 'weak_signal_timeout_fallback',
      replyText: buildCatalogImportFitReply(),
      contextPatch
    };
  }

  return {
    type: 'recommendation',
    source: 'weak_signal_timeout_fallback',
    replyText: buildFeatureFitReply(inboundText, effectiveSalesContext),
    contextPatch
  };
}

function normalizeAiAssistBusinessType(value) {
  const text = normalizeCommandText(value);
  if (!text) return null;

  if (text.includes('distribuidora') || text.includes('mayorista')) return 'distribution';
  if (text.includes('ropa') || text.includes('indumentaria') || text.includes('boutique')) return 'fashion_retail';
  if (text.includes('accesorios') || text.includes('bijou')) return 'accessories_retail';
  if (text.includes('rotiseria') || text.includes('rotisería') || text.includes('comida') || text.includes('gastronomi')) return 'food_business';
  if (text.includes('estetica') || text.includes('estética') || text.includes('belleza') || text.includes('salon') || text.includes('peluquer')) return 'beauty_business';
  if (text.includes('servicio') || text.includes('agencia') || text.includes('consultora') || text.includes('estudio')) return 'services';
  if (text.includes('negocio') || text.includes('tienda') || text.includes('local') || text.includes('emprendimiento')) return 'small_store';

  return null;
}

function normalizeAiAssistTeamSizeSignal(value) {
  const text = normalizeCommandText(value);
  if (!text) return null;

  if (
    text.includes('sucursal') ||
    text.includes('dos sucursales') ||
    text.includes('varias sucursales') ||
    text.includes('multi')
  ) {
    return 'multi_branch';
  }

  if (
    text.includes('vendedores') ||
    text.includes('equipo') ||
    text.includes('varios') ||
    text.includes('asesores')
  ) {
    return 'team';
  }

  if (
    text.includes('small') ||
    text.includes('pocos vendedores') ||
    text.includes('poco equipo') ||
    text.includes('equipo chico')
  ) {
    return 'team';
  }

  if (
    text.includes('solo') ||
    text.includes('yo') ||
    text.includes('arranco solo') ||
    text.includes('arranco sola')
  ) {
    return 'solo';
  }

  return null;
}

const SAFE_LOW_CONFIDENCE_AI_ASSIST_REPLY_INTENTS = new Set([
  'channel_compatibility',
  'whatsapp_number_portability',
  'seller_replacement',
  'industry_fit',
  'feature_fit',
  'catalog_import_fit'
]);

function canUseSafeLowConfidenceAiAssistDecision(aiAssistDecision) {
  const decision = aiAssistDecision && typeof aiAssistDecision === 'object' ? aiAssistDecision : null;
  if (!decision) return false;
  if (decision.confidence === 0) return false;
  if (decision.confidence >= 0.62) return true;
  if (decision.confidence <= 0.45) return false;
  if (decision.routingDecision !== 'use_existing_commerce_reply') return false;
  return SAFE_LOW_CONFIDENCE_AI_ASSIST_REPLY_INTENTS.has(String(decision.suggestedReplyIntent || '').trim());
}

function normalizeAiAssistPainPoints(entities = {}) {
  const currentTool = normalizeCommandText(entities.currentTool);
  const stage = normalizeCommandText(entities.stage);
  const channels = Array.isArray(entities.channels) ? entities.channels.map((item) => normalizeCommandText(item)).filter(Boolean) : [];
  const explicitPainPoints = Array.isArray(entities.painPoints)
    ? entities.painPoints.map((item) => normalizeCommandText(item)).filter(Boolean)
    : [];
  const painPoints = new Set();

  if (currentTool.includes('excel')) painPoints.add('sales_organization');
  if (currentTool.includes('whatsapp')) painPoints.add('follow_up');
  if (currentTool.includes('crm')) painPoints.add('complex_operation');
  if (stage.includes('arranco') || stage.includes('empiezo')) painPoints.add('sales_organization');
  if (channels.includes('instagram') && channels.includes('whatsapp')) {
    painPoints.add('follow_up');
    painPoints.add('sales_organization');
  }

  for (const point of explicitPainPoints) {
    if (point.includes('seguimiento') || point.includes('follow')) painPoints.add('follow_up');
    if (point.includes('organizacion') || point.includes('organización') || point.includes('orden')) painPoints.add('sales_organization');
    if (point.includes('control') || point.includes('roles') || point.includes('sucursales')) painPoints.add('team_control');
    if (point.includes('integracion') || point.includes('integración')) painPoints.add('complex_operation');
    if (point.includes('respuesta')) painPoints.add('response_delay');
  }

  return [...painPoints];
}

function buildAiAssistSalesContext(entities = {}, currentContext = null) {
  const baseContext = currentContext && typeof currentContext === 'object' ? currentContext : {};
  const businessType = normalizeAiAssistBusinessType(entities.businessType) || baseContext.businessType || null;
  const teamSizeSignal = normalizeAiAssistTeamSizeSignal(entities.teamSize) || baseContext.teamSizeSignal || null;
  const stage = normalizeCommandText(entities.stage);
  const channels = Array.isArray(entities.channels) ? entities.channels.map((item) => normalizeCommandText(item)).filter(Boolean) : [];
  const whatsappVolume =
    stage.includes('arranco') || stage.includes('empiezo')
      ? 'low'
      : (teamSizeSignal === 'team' || teamSizeSignal === 'multi_branch' || channels.length >= 2)
        ? 'high'
        : baseContext.whatsappVolume || null;
  const painPoints = [...new Set([...(Array.isArray(baseContext.painPoints) ? baseContext.painPoints : []), ...normalizeAiAssistPainPoints(entities)])];

  return {
    businessType,
    whatsappVolume,
    teamSizeSignal,
    painPoints,
    lastRecommendedPlan: baseContext.lastRecommendedPlan || null,
    lastRecommendationReason: baseContext.lastRecommendationReason || null
  };
}

function shouldInvokeAiAssist({
  botRoute,
  intent,
  commercialIntent,
  transferPaymentIntent,
  inboundText,
  safeContext
}) {
  const text = normalizeCommandText(inboundText);
  if (!text) return { ok: false, reason: 'empty_message' };
  if (isGreetingIntent(text) || isThanksIntent(text) || isAffirmativeIntent(text) || isNegativeIntent(text)) {
    return { ok: false, reason: 'trivial_message' };
  }
  if (transferPaymentIntent) return { ok: false, reason: 'payment_transfer_flow' };
  if (isLoyaltyIntent(text)) return { ok: false, reason: 'loyalty_flow' };
  if (looksLikeAgendaIntent({ inboundText: text, intent, managementIntent: detectTurnManagementIntent(text) })) {
    return { ok: false, reason: 'agenda_flow' };
  }
  if (intent === 'appointment' || intent === 'human' || intent === 'loyalty' || intent === 'pricing') {
    return { ok: false, reason: `strong_intent_${intent}` };
  }
  if (commercialIntent && commercialIntent.type && commercialIntent.type !== 'unknown') {
    return { ok: false, reason: `strong_commercial_intent_${commercialIntent.type}` };
  }
  if (
    /\b(como te transfiero|te mando comprobante|quiero un turno|ver productos|cuantos puntos tengo|quiero hablar con una persona)\b/.test(text)
  ) {
    return { ok: false, reason: 'critical_phrase_blocked' };
  }

  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  const hasCommerceContext = Boolean(
    (botRoute && (botRoute.domain === 'commerce' || botRoute.domain === 'demo')) ||
    String(context.activeBotDomain || '').trim().toLowerCase() === 'commerce' ||
    getActiveCommercialSalesContext(context) ||
    getActiveBusinessRecommendationContext(context) ||
    getActiveCommercialPlanContext(context)
  );
  const weakCommercialSignal = detectWeakCommercialSignal(text);

  if (!weakCommercialSignal && !hasCommerceContext) {
    return { ok: false, reason: 'no_commercial_signal' };
  }

  return {
    ok: true,
    reason: hasCommerceContext ? 'commercial_low_confidence_with_context' : 'commercial_weak_signal',
    signal: weakCommercialSignal
  };
}

async function resolveAiAssistDecision({
  clinic,
  conversation,
  inboundText,
  aiDecision,
  safeContext
}) {
  const decision = aiDecision && typeof aiDecision === 'object' ? aiDecision : null;
  if (!decision || decision.routingDecision === 'fallback_current') {
    return null;
  }

  const currentSalesContext = getActiveCommercialSalesContext(safeContext);
  const effectiveSalesContext = buildAiAssistSalesContext(decision.entities || {}, currentSalesContext);
  const derivedBusinessContext =
    deriveBusinessRecommendationContextFromSalesContext(effectiveSalesContext) ||
    getActiveBusinessRecommendationContext(safeContext);
  const clinicProducts = await listProductsByClinicId(conversation.clinicId);
  const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
  const recommendationMap = {
    recommend_plan_starter: 'starter',
    recommend_plan_growth: 'growth',
    recommend_plan_enterprise: 'enterprise'
  };

  const buildBasePatch = (product = null, extra = {}) => ({
    ...buildCommercialSalesContextPatch({
      ...effectiveSalesContext,
      lastRecommendedPlan: product ? product.name : effectiveSalesContext.lastRecommendedPlan,
      lastRecommendationReason: decision.reason || effectiveSalesContext.lastRecommendationReason || null
    }),
    ...(derivedBusinessContext
      ? buildBusinessRecommendationContextPatch(derivedBusinessContext)
      : {}),
    ...(product
      ? buildCommercialPlanContextPatch({
        topic: 'ai_assist',
        lastDiscussedPlanId: product.id || product.productId || null,
        recommendationType: normalizeProductRecommendationType(product, orderedPlans)
      })
      : {}),
    ...(product
      ? buildCommercialShortMemoryPatch({
        topic: 'plans',
        lastSuggestedProductId: product.id || product.productId || null,
        recommendationType: normalizeProductRecommendationType(product, orderedPlans),
        lastReplyKey: normalizeCommandText(decision.suggestedReplyIntent)
      })
      : {}),
    ...extra
  });

  if (decision.routingDecision === 'ask_clarifying_question') {
    return {
      type: 'recommendation',
      replyText: buildSalesDiscoveryQuestion(),
      contextPatch: buildBasePatch(null)
    };
  }

  if (decision.suggestedReplyIntent === 'compare_plans') {
    return {
      type: 'recommendation',
      replyText: buildPlanComparisonReply(orderedPlans),
      contextPatch: buildBasePatch(null)
    };
  }

  if (
    decision.suggestedReplyIntent === 'recommend_plan_by_business_context' ||
    decision.suggestedReplyIntent === 'explain_business_fit'
  ) {
    if (!orderedPlans.length) return null;
    const plan = derivedBusinessContext
      ? findPlanByBusinessRecommendationContext(orderedPlans, derivedBusinessContext)
      : null;
    if (!plan) {
      return {
        type: 'recommendation',
        replyText: buildSalesDiscoveryQuestion(),
        contextPatch: buildBasePatch(null)
      };
    }
    return {
      type: 'recommendation',
      replyText: buildBusinessContextPlanRecommendationReply(plan, derivedBusinessContext, orderedPlans),
      contextPatch: buildBasePatch(plan)
    };
  }

  if (recommendationMap[decision.suggestedReplyIntent]) {
    const plan = findPlanByNeedHint(orderedPlans, recommendationMap[decision.suggestedReplyIntent]);
    if (!plan) return null;
    return {
      type: 'recommendation',
      replyText: derivedBusinessContext
        ? buildBusinessContextPlanRecommendationReply(plan, derivedBusinessContext, orderedPlans)
        : buildPlanRecommendationReply(plan, effectiveSalesContext, orderedPlans),
      contextPatch: buildBasePatch(plan)
    };
  }

  const objectionMap = {
    handle_objection_price: 'price_high',
    handle_objection_starting: 'starting',
    handle_objection_excel: 'excel_existing',
    handle_objection_whatsapp_manual: 'whatsapp_manual',
    handle_objection_crm_existing: 'crm_existing',
    handle_objection_later: 'later',
    handle_objection_consulting: 'consulting'
  };
  if (objectionMap[decision.suggestedReplyIntent]) {
    const fallbackPlan =
      resolveRecentCommercialPlan(orderedPlans, effectiveSalesContext, getActiveCommercialPlanContext(safeContext), getActiveCommercialShortMemory(safeContext)) ||
      (derivedBusinessContext ? findPlanByBusinessRecommendationContext(orderedPlans, derivedBusinessContext) : null) ||
      findPlanByNeedHint(orderedPlans, derivedBusinessContext ? derivedBusinessContext.recommendationLevel : 'growth');
    if (!fallbackPlan) {
      return {
        type: 'recommendation',
        replyText: buildSalesDiscoveryQuestion(),
        contextPatch: buildBasePatch(null)
      };
    }
    const objectionReply = buildCommercialPlanObjectionReply(
      objectionMap[decision.suggestedReplyIntent],
      fallbackPlan,
      effectiveSalesContext,
      orderedPlans,
      inboundText,
      { isRepeated: false }
    );
    if (!objectionReply) return null;
    const targetPlan = objectionReply.targetPlan || fallbackPlan;
    return {
      type: 'recommendation',
      replyText: objectionReply.replyText,
      contextPatch: buildBasePatch(targetPlan, buildCommercialShortMemoryPatch({
        topic: 'plans',
        lastSuggestedProductId: targetPlan.id || targetPlan.productId || null,
        recommendationType: normalizeProductRecommendationType(targetPlan, orderedPlans),
        lastObjectionType: objectionMap[decision.suggestedReplyIntent],
        lastReplyKey: objectionReply.replyKey
      }))
    };
  }

  if (decision.suggestedReplyIntent === 'channel_compatibility') {
    return {
      type: 'recommendation',
      replyText: buildChannelCompatibilityReply(effectiveSalesContext, derivedBusinessContext),
      contextPatch: mergeContextPatches(
        buildAiAssistFeatureContextPatch({
          safeContext,
          effectiveSalesContext,
          derivedBusinessContext
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'offer_type',
          sourceIntent: 'channel_compatibility'
        })
      )
    };
  }

  if (decision.suggestedReplyIntent === 'whatsapp_number_portability') {
    return {
      type: 'recommendation',
      replyText: buildWhatsAppNumberPortabilityReply(),
      contextPatch: mergeContextPatches(
        buildAiAssistFeatureContextPatch({
          safeContext,
          effectiveSalesContext,
          derivedBusinessContext
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'whatsapp_account_type',
          sourceIntent: 'whatsapp_number_portability'
        })
      )
    };
  }

  if (decision.suggestedReplyIntent === 'seller_replacement') {
    return {
      type: 'recommendation',
      replyText: buildSellerReplacementReply(effectiveSalesContext),
      contextPatch: mergeContextPatches(
        buildAiAssistFeatureContextPatch({
          safeContext,
          effectiveSalesContext,
          derivedBusinessContext
        }),
        buildCommercialDiscoveryPendingPatch({
          field: 'team_size',
          sourceIntent: 'seller_replacement'
        })
      )
    };
  }

  if (decision.suggestedReplyIntent === 'industry_fit') {
    return {
      type: 'recommendation',
      replyText: buildIndustryFitReply(inboundText, effectiveSalesContext),
      contextPatch: buildAiAssistFeatureContextPatch({
        safeContext,
        effectiveSalesContext,
        derivedBusinessContext
      })
    };
  }

  if (decision.suggestedReplyIntent === 'feature_fit') {
    return {
      type: 'recommendation',
      replyText: buildFeatureFitReply(inboundText, effectiveSalesContext),
      contextPatch: buildAiAssistFeatureContextPatch({
        safeContext,
        effectiveSalesContext,
        derivedBusinessContext
      })
    };
  }

  if (decision.suggestedReplyIntent === 'catalog_import_fit') {
    return {
      type: 'recommendation',
      replyText: buildCatalogImportFitReply(),
      contextPatch: buildAiAssistFeatureContextPatch({
        safeContext,
        effectiveSalesContext,
        derivedBusinessContext
      })
    };
  }

  if (
    decision.suggestedReplyIntent === 'general_commerce_followup' ||
    decision.suggestedReplyIntent === 'implementation_followup'
  ) {
    return {
      type: 'recommendation',
      replyText: buildSalesDiscoveryQuestion(),
      contextPatch: buildBasePatch(null)
    };
  }

  return null;
}

function pickTextVariant(seed, options) {
  const safeOptions = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!safeOptions.length) return '';
  const safeSeed = String(seed || '').trim();
  const score = safeSeed.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
  return safeOptions[Math.abs(score) % safeOptions.length];
}

function hasWeakCommercialSignal(rawText) {
  return Boolean(detectWeakCommercialSignal(rawText));
}

function isCommercialSoftFollowUpIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return [
    'dale',
    'joya',
    'ok',
    'perfecto',
    'buenisimo',
    'de una',
    'piola',
    'copado',
    'a ver',
    'contame',
    'explicame',
    'decime',
    'segui',
    'seguir'
  ].includes(text);
}

function detectCommercialIndecisionIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    text === 'no se' ||
    text.includes('estoy viendo') ||
    text.includes('dejame verlo') ||
    text.includes('tengo que verlo')
  ) {
    return 'indecision';
  }

  return null;
}

function buildCommercialGreetingReply(safeContext, rawText = '') {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  const hasOngoingCommercialFlow = Boolean(
    getActiveCommercialPlanContext(context) ||
    getPendingPlanComparisonAction(context) ||
    getActiveCommercialShortMemory(context) ||
    (context.activeBotDomain && String(context.activeBotDomain).trim().toLowerCase() === 'commerce')
  );
  const greeting = pickTextVariant(`commercial_greeting:${context.activeBotDomain || 'neutral'}:${normalizeCommandText(rawText)}`, [
    '¡Hola! 😊',
    '¡Buenas! 👋',
    '¡Qué tal! 😊'
  ]);

  return hasOngoingCommercialFlow
    ? [
      greeting,
      'Seguimos con eso si querés. Te puedo recomendar una opción, comparar planes o dejarte el siguiente paso para avanzar.'
    ].join('\n')
    : [
      greeting,
      'Contame qué estás buscando y te doy una mano. Si querés, también te muestro planes, precios o te recomiendo una opción.'
    ].join('\n');
}

function buildCommercialIndecisionReply(safeContext, rawText = '') {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  const hasPlanContext = Boolean(getActiveCommercialPlanContext(context) || getPendingPlanComparisonAction(context));
  const lead = pickTextVariant(`commercial_indecision:${context.activeBotDomain || 'neutral'}:${normalizeCommandText(rawText)}`, [
    'Tranqui 😊',
    'Obvio, está bien pensarlo 😊',
    'Dale, miralo con calma 😊'
  ]);

  return hasPlanContext
    ? [
      lead,
      'Si querés, te lo bajo simple: te digo cuál te conviene más y en qué caso elegiría una opción más liviana.'
    ].join('\n')
    : [
      lead,
      'Si querés, te ayudo a bajar la decisión: te puedo mostrar precios, recomendarte algo simple o comparar opciones.'
    ].join('\n');
}

function buildCommercialThanksReply(safeContext) {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  const hasOngoingCommercialFlow = Boolean(
    getActiveCommercialPlanContext(context) ||
    getPendingPlanComparisonAction(context) ||
    getActiveCommercialShortMemory(context) ||
    getActiveBusinessRecommendationContext(context) ||
    getActiveCommercialSalesContext(context)
  );

  return hasOngoingCommercialFlow
    ? '¡De nada! Si querés, seguimos por acá y te ayudo a avanzar con la opción que veníamos viendo.'
    : '¡De nada! Si querés, seguí por acá cuando quieras y te doy una mano.';
}

function buildPaymentMethodsReply({ paymentMethods, transferConfig, activePlanName = null }) {
  const safePaymentMethods = String(paymentMethods || '').trim();
  const lines = [];

  if (safePaymentMethods) {
    lines.push(`Formas de pago: ${safePaymentMethods}.`);
  }

  if (hasConfiguredTransferData(transferConfig)) {
    lines.push(
      activePlanName
        ? `Si querés avanzar con ${activePlanName}, también te puedo pasar los datos de transferencia por acá.`
        : 'Si querés avanzar, también te puedo pasar los datos de transferencia por acá.'
    );
  }

  if (!lines.length) {
    return 'Todavía no tengo medios de pago cargados para mostrarte por acá. Si querés, te paso con alguien del equipo.';
  }

  return lines.join('\n\n');
}

function buildStockAvailabilityReply(product) {
  const safeProduct = product && typeof product === 'object' ? product : null;
  if (!safeProduct) {
    return 'Puedo revisar stock real desde el catálogo. Decime cuál producto o plan querés consultar y te digo la disponibilidad.';
  }

  const stock = Number(safeProduct.stock || 0);
  if (stock > 0) {
    return `${safeProduct.name} tiene stock disponible ahora mismo 😊`;
  }

  return `${safeProduct.name} no tiene stock disponible en este momento. Si querés, te muestro otra opción.`;
}

function describeSalesContextShort(salesContext) {
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const parts = [];

  if (safeContext.businessType === 'fashion_retail') parts.push('tu tienda de ropa');
  if (safeContext.businessType === 'accessories_retail') parts.push('tu negocio de accesorios');
  if (safeContext.businessType === 'food_business') parts.push('tu negocio de comida');
  if (safeContext.businessType === 'beauty_business') parts.push('tu negocio de estética');
  if (safeContext.businessType === 'distribution') parts.push('tu distribuidora');
  if (safeContext.businessType === 'services') parts.push('tu negocio de servicios');
  if (safeContext.whatsappVolume === 'high') parts.push('ya tenés bastante movimiento por WhatsApp');
  if (safeContext.whatsappVolume === 'low') parts.push('todavía estás arrancando con poco volumen');
  if (safeContext.teamSizeSignal === 'solo') parts.push('hoy lo manejás vos');
  if (safeContext.teamSizeSignal === 'team') parts.push('ya tenés equipo vendiendo');
  if (safeContext.teamSizeSignal === 'multi_branch') parts.push('ya manejás varias sucursales o más de un frente');

  return parts.slice(0, 2).join(' y ');
}

function buildSalesContextMomentLine(salesContext) {
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const businessLabel = (
    safeContext.businessType === 'fashion_retail' ? 'tenés una tienda de ropa' :
      safeContext.businessType === 'accessories_retail' ? 'tenés un negocio de accesorios' :
        safeContext.businessType === 'food_business' ? 'tenés un negocio de comida' :
          safeContext.businessType === 'beauty_business' ? 'tenés un negocio de estética' :
            safeContext.businessType === 'distribution' ? 'manejás una distribuidora' :
              safeContext.businessType === 'services' ? 'tenés un negocio de servicios' :
                null
  );
  const volumeLabel = (
    safeContext.whatsappVolume === 'high' ? 'ya hay bastante movimiento por WhatsApp' :
      safeContext.whatsappVolume === 'low' ? 'todavía estás arrancando con poco volumen' :
        null
  );

  if (businessLabel && volumeLabel) return `${businessLabel} y ${volumeLabel}`;
  return businessLabel || volumeLabel || null;
}

function buildRecommendationReasonSummary(product, salesContext, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const normalizedName = normalizeCommandText(safeProduct.name || '');
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const painPoints = Array.isArray(safeContext.painPoints) ? safeContext.painPoints : [];
  const enterprisePlan = findPlanByNeedHint(allPlans, 'enterprise');

  if (normalizedName.includes('inicial')) {
    return 'te alcanza para empezar a ordenar WhatsApp sin irte a una operación más grande de entrada';
  }

  if (normalizedName.includes('empresa')) {
    return safeContext.teamSizeSignal === 'multi_branch' || safeContext.teamSizeSignal === 'team'
      ? 'ya necesitás más control, más equipo y una operación más acompañada'
      : 'solo vale la pena cuando ya tenés más equipo, más volumen o necesitás algo más personalizado';
  }

  if (painPoints.includes('lead_loss') || painPoints.includes('follow_up')) {
    return 'ordenás seguimiento y evitás que se pierdan consultas u oportunidades';
  }

  if (safeContext.whatsappVolume === 'high') {
    return 'ordenás seguimiento y no te quedás solo en responder mensajes cuando ya hay bastante movimiento por WhatsApp';
  }

  if (enterprisePlan && String(enterprisePlan.id || enterprisePlan.productId || '') === String(safeProduct.id || safeProduct.productId || '')) {
    return 'ya estás en un momento donde más control, soporte y personalización empiezan a pesar de verdad';
  }

  return 'te da una operación comercial más ordenada sin irte directo al plan más grande';
}

function findLowerPlan(products, product) {
  const orderedPlans = getOrderedPlanProducts(products);
  const currentId = String(product && (product.id || product.productId) ? (product.id || product.productId) : '').trim();
  const currentIndex = orderedPlans.findIndex((item) => String(item.id || item.productId || '').trim() === currentId);
  if (currentIndex <= 0) return null;
  return orderedPlans[currentIndex - 1] || null;
}

function buildHumanSalesRecommendationReply(product, salesContext, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const contextLead = buildSalesContextMomentLine(safeContext);
  const normalizedName = normalizeCommandText(safeProduct.name || '');
  const enterprisePlan = findPlanByNeedHint(allPlans, 'enterprise');
  const starterPlan = findPlanByNeedHint(allPlans, 'starter');
  const reason = buildRecommendationReasonSummary(safeProduct, safeContext, allPlans);

  if (normalizedName.includes('inicial')) {
    return [
      `Por lo que me contás, yo arrancaría por ${safeProduct.name || 'Plan Inicial'}.`,
      '',
      `Hoy me cierra más eso porque ${reason}.`,
      'Te deja ordenar WhatsApp sin meter estructura de más de entrada.',
      '',
      'Si después crecés, ahí sí miramos el siguiente.'
    ].join('\n');
  }

  if (normalizedName.includes('empresa')) {
    return [
      `Por lo que me contás, yo miraría ${safeProduct.name || 'Plan Empresa'}.`,
      '',
      `Te lo diría por esto: ${reason}.`,
      'Acá el salto ya pasa por control, soporte y una operación más acompañada.',
      '',
      starterPlan
        ? `Si todavía no estás en ese punto, te va a rendir más ${starterPlan.name} o el plan del medio.`
        : 'Si todavía no estás en ese punto, probablemente un plan más chico te rinda mejor.'
    ].join('\n');
  }

  return [
    `Por lo que me contás, yo miraría ${safeProduct.name || 'Plan Crecimiento'}.`,
    '',
    contextLead
      ? `Si hoy ${contextLead}, lo que más pesa es no perder seguimiento.`
      : 'Si ya te entran consultas por WhatsApp, lo que más pesa es no perder seguimiento.',
    '',
    `Por eso te lo marco: ${reason}.`,
    '',
    enterprisePlan
      ? `${enterprisePlan.name} lo dejaría para cuando necesites más equipo, más control o algo más personalizado.`
      : 'El plan más grande lo dejaría para cuando tengas más equipo, más control o necesites algo más personalizado.'
  ].join('\n');
}

function buildRecommendationWhyReply(product, salesContext, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const savedReason = String(safeContext.lastRecommendationReason || '').trim();
  const comparedPlan = findLowerPlan(allPlans, safeProduct) || findPlanByNeedHint(allPlans, 'starter');

  return [
    savedReason
      ? `Te lo dije por esto: ${savedReason}.`
      : `Te lo dije por esto: ${buildRecommendationReasonSummary(safeProduct, safeContext, allPlans)}.`,
    '',
    `${safeProduct.name || 'Ese plan'} me cierra más para tu momento.`,
    comparedPlan && String(comparedPlan.id || comparedPlan.productId || '').trim() !== String(safeProduct.id || safeProduct.productId || '').trim()
      ? `Si querés, te lo comparo rápido con ${comparedPlan.name || 'el plan anterior'}.`
      : 'Si querés, te digo también en qué caso me iría por otro.'
  ].join('\n');
}

function buildPlanWorthItReply(product, salesContext, allPlans = []) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const safeContext = salesContext && typeof salesContext === 'object' ? salesContext : {};
  const orderedPlans = getOrderedPlanProducts(allPlans);
  const recommendedPlan = deriveBusinessRecommendationContextFromSalesContext(safeContext)
    ? findPlanByBusinessRecommendationContext(orderedPlans, deriveBusinessRecommendationContextFromSalesContext(safeContext))
    : null;
  const currentIndex = orderedPlans.findIndex((item) => String(item.id || item.productId || '') === String(safeProduct.id || safeProduct.productId || ''));
  const recommendedIndex = recommendedPlan
    ? orderedPlans.findIndex((item) => String(item.id || item.productId || '') === String(recommendedPlan.id || recommendedPlan.productId || ''))
    : -1;

  if (recommendedPlan && currentIndex === recommendedIndex) {
    return [
      `Sí, para tu caso ${safeProduct.name || 'ese plan'} tiene sentido.`,
      '',
      `El valor está en que ${buildRecommendationReasonSummary(safeProduct, safeContext, orderedPlans)}.`
    ].join('\n');
  }

  if (recommendedPlan && currentIndex < recommendedIndex) {
    return [
      `${safeProduct.name || 'Ese plan'} puede servirte, pero para tu momento yo lo veo corto.`,
      '',
      `Si ya ${describeSalesContextShort(safeContext) || 'tenés movimiento por WhatsApp'}, miraría más ${recommendedPlan.name || 'el plan siguiente'} por seguimiento y orden.`
    ].join('\n');
  }

  if (recommendedPlan && currentIndex > recommendedIndex) {
    return [
      'Puede valer la pena más adelante, pero no lo pondría como primer paso.',
      '',
      `${safeProduct.name || 'Ese plan'} tiene sentido cuando ya necesitás más control o más personalización. Para tu momento, veo más lógico ${recommendedPlan.name || 'un plan más intermedio'}.`
    ].join('\n');
  }

  return [
    `Sí, ${safeProduct.name || 'ese plan'} puede valer la pena si hoy el objetivo es ${resolvePlanProfile(safeProduct).result}.`,
    '',
    'Si querés, te digo rápido en qué caso iría por ese y en cuál no.'
  ].join('\n');
}

function resolveCommercialObjectionTargetPlan(objectionType, recommendedPlan, allPlans = []) {
  const safePlan = recommendedPlan && typeof recommendedPlan === 'object' ? recommendedPlan : null;
  if (!safePlan) return null;

  const orderedPlans = getOrderedPlanProducts(allPlans);
  const lowerPlan = findLowerPlan(orderedPlans, safePlan);
  const starterPlan = findPlanByNeedHint(orderedPlans, 'starter');
  const growthPlan = findPlanByNeedHint(orderedPlans, 'growth');
  const normalizedName = normalizeCommandText(safePlan.name || '');

  if (objectionType === 'cheaper_option' || objectionType === 'budget_limit') {
    return lowerPlan || starterPlan || safePlan;
  }

  if (objectionType === 'starting' || objectionType === 'order_whatsapp') {
    return starterPlan || lowerPlan || safePlan;
  }

  if (objectionType === 'price_high' && normalizedName.includes('empresa')) {
    return growthPlan || starterPlan || lowerPlan || safePlan;
  }

  return safePlan;
}

function buildCommercialPlanObjectionReply(
  objectionType,
  recommendedPlan,
  salesContext,
  allPlans = [],
  rawText = '',
  options = {}
) {
  const safePlan = recommendedPlan && typeof recommendedPlan === 'object' ? recommendedPlan : null;
  if (!safePlan) return null;

  const orderedPlans = getOrderedPlanProducts(allPlans);
  const lowerPlan = findLowerPlan(orderedPlans, safePlan);
  const starterPlan = findPlanByNeedHint(orderedPlans, 'starter');
  const growthPlan = findPlanByNeedHint(orderedPlans, 'growth');
  const normalizedName = normalizeCommandText(safePlan.name || '');
  const targetPlan = resolveCommercialObjectionTargetPlan(objectionType, safePlan, orderedPlans) || safePlan;
  const isRepeated = options && options.isRepeated === true;
  const priceLead = pickTextVariant(`commercial_price_objection:${safePlan.name || 'plan'}:${normalizeCommandText(rawText)}`, [
    'Te entiendo 😊',
    'Sí, puede sentirse alto si hoy querés arrancar más liviano 😊',
    'Obvio, si hoy querés cuidar inversión hay que mirarlo fino 😊'
  ]);
  const repeatedLead = pickTextVariant(`commercial_repeated_objection:${safePlan.name || 'plan'}:${normalizeCommandText(rawText)}`, [
    'Sí, ahí cambia la jugada 😊',
    'Tal cual, si lo mirás por ese lado conviene simplificar 😊',
    'De una, ahí yo no insistiría con lo mismo 😊'
  ]);
  const contextLead = pickTextVariant(`commercial_context_objection:${safePlan.name || 'plan'}:${normalizeCommandText(rawText)}`, [
    'Perfecto, con ese contexto yo lo bajaría un cambio.',
    'Sí, con ese punto cambia bastante la recomendación.',
    'Bien, ahí ya lo pensaría más simple.'
  ]);
  const lead = isRepeated ? repeatedLead : priceLead;
  const targetPlanId = String(targetPlan && (targetPlan.id || targetPlan.productId) ? (targetPlan.id || targetPlan.productId) : '').trim() || normalizeCommandText(targetPlan && targetPlan.name ? targetPlan.name : 'plan');
  const replyKey = `${String(objectionType || 'objection').trim().toLowerCase()}:${targetPlanId}`;
  const targetChanged = String(targetPlanId) !== String(safePlan && (safePlan.id || safePlan.productId) ? (safePlan.id || safePlan.productId) : normalizeCommandText(safePlan && safePlan.name ? safePlan.name : 'plan'));

  if (objectionType === 'cheaper_option') {
    const nextUpgradePlan = String(safePlan.id || safePlan.productId || '').trim() !== String(targetPlan.id || targetPlan.productId || '').trim()
      ? safePlan
      : (growthPlan && String(growthPlan.id || growthPlan.productId || '').trim() !== String(targetPlan.id || targetPlan.productId || '').trim()
        ? growthPlan
        : null);
    return {
      replyKey,
      targetPlan,
      replyText: [
        lead,
        '',
        targetChanged
          ? `Si querés bajar inversión, yo miraría ${targetPlan.name || 'el plan más liviano'}.`
          : `${safePlan.name || 'Ese plan'} ya es la opción más liviana que te puedo recomendar hoy.`,
        targetChanged
          ? 'Te deja ordenar lo básico sin saltar de entrada a una estructura más grande.'
          : 'Si incluso así hoy no te cierra, probablemente convenga esperar a tener un poco más de movimiento.',
        '',
        targetChanged
          ? `Después, si empezás a tener más volumen o necesitás más seguimiento, podés subir a ${nextUpgradePlan && nextUpgradePlan.name ? nextUpgradePlan.name : 'un plan más completo'}.`
          : 'Y cuando tenga sentido por volumen o seguimiento, ahí sí damos el salto.'
      ].join('\n')
    };
  }

  if (objectionType === 'budget_limit') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        lead,
        '',
        targetChanged
          ? `Si hoy no llegás cómodo, arrancaría con ${targetPlan.name || 'un plan más chico'}.`
          : `Si hoy no llegás cómodo, no te empujaría a ${safePlan.name || 'ese plan'} de entrada.`,
        'La idea es que la herramienta te ordene, no que te apriete la inversión.',
        '',
        targetChanged
          ? 'Después, cuando haya más movimiento, subís con más sentido.'
          : 'Si más adelante cambia el momento, ahí lo revisamos de nuevo.'
      ].join('\n')
    };
  }

  if (objectionType === 'price_high') {
    if (normalizedName.includes('empresa')) {
      return {
        replyKey,
        targetPlan,
        replyText: [
          lead,
          '',
          'Empresa es para cuando ya necesitás más equipo, control o personalización.',
          '',
          growthPlan
            ? `Si querés algo más equilibrado, miraría ${growthPlan.name}; y si querés cuidar inversión al máximo, ${starterPlan ? starterPlan.name : 'Inicial'}.`
            : `Si querés algo más equilibrado, miraría un plan intermedio; y si querés cuidar inversión al máximo, ${starterPlan ? starterPlan.name : 'Inicial'}.`
        ].join('\n')
      };
    }

    if (normalizedName.includes('crecimiento')) {
      return {
        replyKey,
        targetPlan,
        replyText: [
          lead,
          '',
          starterPlan
            ? `Si hoy querés cuidar inversión, arrancaría con ${starterPlan.name}.`
            : 'Si hoy querés cuidar inversión, arrancaría por el plan más simple.',
          'Te ordena WhatsApp sin irte a un plan más grande.',
          '',
          'Después, si empezás a perder consultas o necesitás seguimiento, ahí sí subís a Crecimiento.'
        ].join('\n')
      };
    }

    if (starterPlan && String(safePlan.id || safePlan.productId || '').trim() === String(starterPlan.id || starterPlan.productId || '').trim()) {
      return {
        replyKey,
        targetPlan,
        replyText: [
          lead,
          '',
          `${starterPlan.name} ya es la opción más económica para empezar a ordenar WhatsApp.`,
          'Si incluso así hoy no te cierra, probablemente te convenga esperar a tener un poco más de movimiento antes de sumar una herramienta así.',
          '',
          'Si querés evaluar tu caso puntual, también te puedo pasar con una persona del equipo.'
        ].join('\n')
      };
    }

    return {
      replyKey,
      targetPlan,
      replyText: [
        lead,
        '',
        lowerPlan && starterPlan && String(lowerPlan.id || lowerPlan.productId || '').trim() === String(starterPlan.id || starterPlan.productId || '').trim()
          ? `Si hoy querés cuidar inversión, arrancaría con ${lowerPlan.name || 'Plan Inicial'}.`
          : `Si hoy querés cuidar inversión, podés bajar a ${lowerPlan ? (lowerPlan.name || 'un plan más chico') : 'un plan más simple'}.`,
        lowerPlan && starterPlan && String(lowerPlan.id || lowerPlan.productId || '').trim() === String(starterPlan.id || starterPlan.productId || '').trim()
          ? 'Te ordena WhatsApp sin irte a un plan más grande.'
          : 'La idea es no pasarte de estructura antes de que realmente lo necesites.',
        '',
        lowerPlan
          ? 'Después, cuando ya tenga sentido por seguimiento, volumen o equipo, subís desde ahí.'
          : 'Si más adelante necesitás más seguimiento, más control o más volumen, ahí sí tiene sentido subir.'
      ].join('\n')
    };
  }

  if (objectionType === 'starting' || objectionType === 'order_whatsapp') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        contextLead,
        '',
        `Si hoy la idea es ${objectionType === 'order_whatsapp' ? 'ordenar WhatsApp' : 'arrancar simple'}, miraría primero ${targetPlan.name || 'el plan inicial'}.`,
        'Después, cuando ya necesites más seguimiento o más volumen, ahí sí pasaría al plan siguiente.'
      ].join('\n')
    };
  }

  if (objectionType === 'later') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        isRepeated ? 'Sí, obvio 😊' : 'Dale, cero presión 😊',
        '',
        'Tiene sentido pensarlo con calma.',
        `Si querés, te lo dejo resumido así: ${targetPlan.name || safePlan.name || 'ese plan'} te sirve cuando querés ordenar WhatsApp sin perder seguimiento.`,
        '',
        'Y si preferís, después volvés y lo retomamos desde ahí.'
      ].join('\n')
    };
  }

  if (objectionType === 'consulting') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        isRepeated ? 'De una 😊' : 'Obvio, consultalo tranquilo 😊',
        '',
        `Para que lo expliques fácil: ${targetPlan.name || safePlan.name || 'ese plan'} apunta a ordenar WhatsApp, hacer mejor seguimiento y no perder consultas.`,
        '',
        'Si querés, también te dejo la diferencia con el plan anterior para que lo tengas más claro.'
      ].join('\n')
    };
  }

  if (objectionType === 'excel_existing') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        contextLead,
        '',
        'Si hoy te manejás con Excel, no está mal.',
        `La diferencia con ${targetPlan.name || safePlan.name || 'este plan'} es que no te quedás sólo en anotar: también te ayuda a seguir conversaciones y ordenar respuestas.`,
        '',
        'Por eso suele rendir cuando Excel ya empieza a quedar corto para vender.'
      ].join('\n')
    };
  }

  if (objectionType === 'whatsapp_manual') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        contextLead,
        '',
        'Si hoy usás WhatsApp normal, perfecto: de hecho esto apunta a ordenar justamente eso.',
        `Lo que cambia con ${targetPlan.name || safePlan.name || 'este plan'} es el seguimiento, el orden y no depender de acordarte todo a mano.`,
        '',
        'Si hoy todavía te alcanza WhatsApp solo, arrancaría por algo simple y después ves si subir.'
      ].join('\n')
    };
  }

  if (objectionType === 'crm_existing') {
    return {
      replyKey,
      targetPlan,
      replyText: [
        isRepeated ? 'Sí, ahí cambia bastante 😊' : 'Perfecto, eso ya me da contexto 😊',
        '',
        'Si ya tenés CRM, no te diría que cambies porque sí.',
        `Lo que habría que mirar es si ${targetPlan.name || safePlan.name || 'este plan'} te resuelve mejor el seguimiento comercial por WhatsApp o la operación del equipo.`,
        '',
        'Si querés, te ayudo a comparar eso más fino.'
      ].join('\n')
    };
  }

  return null;
}

function buildComparisonLead(primaryPlan, secondaryPlan) {
  const options = [
    'Te cuento la diferencia simple 😊',
    'Para verlo fácil 😊',
    'Depende de tu momento 😊',
    'En criollo 😊'
  ];
  const seed = `${primaryPlan && primaryPlan.name ? primaryPlan.name : ''}|${secondaryPlan && secondaryPlan.name ? secondaryPlan.name : ''}`;
  const score = seed.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
  return options[score % options.length];
}

function buildPlanComparisonOfferedAction(recommendedPlan, comparedPlan, businessContext) {
  if (!recommendedPlan || !comparedPlan) return null;
  return {
    type: PLAN_PENDING_ACTION_COMPARE_RECOMMENDED,
    activeAt: new Date().toISOString(),
    recommendedPlanId: String(recommendedPlan.id || recommendedPlan.productId || '').trim() || null,
    comparedPlanId: String(comparedPlan.id || comparedPlan.productId || '').trim() || null,
    recommendationLevel: businessContext && businessContext.recommendationLevel
      ? String(businessContext.recommendationLevel).trim().toLowerCase()
      : null
  };
}

function buildCurrentPlanComparisonOfferedAction(currentPlan, comparisonPlan, recommendationType = null) {
  if (!currentPlan || !comparisonPlan) return null;
  return {
    type: PLAN_PENDING_ACTION_COMPARE_CURRENT,
    activeAt: new Date().toISOString(),
    currentPlanId: String(currentPlan.id || currentPlan.productId || '').trim() || null,
    comparisonPlanId: String(comparisonPlan.id || comparisonPlan.productId || '').trim() || null,
    recommendationType: recommendationType ? String(recommendationType).trim().toLowerCase() : null
  };
}

function resolveRecommendedPlanForCommercialFollowUp(products, salesContext, planContext = null) {
  const orderedPlans = getOrderedPlanProducts(products);
  const fromSales = findPlanByStoredId(orderedPlans, salesContext && salesContext.lastRecommendedPlan);
  if (fromSales) return fromSales;
  return findPlanByStoredId(orderedPlans, planContext && planContext.lastDiscussedPlanId);
}

function resolvePlanFromCommercialShortMemory(products, memory) {
  if (!memory || String(memory.topic || '').trim().toLowerCase() !== 'plans') return null;
  return findPlanByStoredId(products, memory.lastSuggestedProductId);
}

function resolveRecentCommercialPlan(products, salesContext, planContext = null, shortMemory = null) {
  const fromFollowUp = resolveRecommendedPlanForCommercialFollowUp(products, salesContext, planContext);
  if (fromFollowUp) return fromFollowUp;
  return resolvePlanFromCommercialShortMemory(products, shortMemory);
}

function findPlanByStoredId(products, storedId) {
  const safeId = String(storedId || '').trim();
  if (!safeId) return null;
  return getOrderedPlanProducts(products).find((product) => String(product.id || product.productId || '').trim() === safeId) || null;
}

function findCatalogItemByStoredId(products, storedId) {
  const safeId = String(storedId || '').trim();
  if (!safeId) return null;
  return (Array.isArray(products) ? products : []).find((product) => String(product && (product.id || product.productId) ? (product.id || product.productId) : '').trim() === safeId) || null;
}

function chooseLogicalComparisonItem(items, currentItem, preferredItemId = null) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const currentId = String(currentItem && (currentItem.id || currentItem.productId) ? (currentItem.id || currentItem.productId) : '').trim();
  if (!currentId || !safeItems.length) return null;

  const preferred = preferredItemId ? findCatalogItemByStoredId(safeItems, preferredItemId) : null;
  if (preferred && String(preferred.id || preferred.productId || '').trim() !== currentId) {
    return preferred;
  }

  if (isPlanProduct(currentItem)) {
    const orderedPlans = getOrderedPlanProducts(safeItems);
    const currentName = normalizeCommandText(currentItem.name || '');
    if (currentName.includes('inicial')) {
      return findPlanByNeedHint(orderedPlans, 'growth');
    }
    if (currentName.includes('empresa')) {
      return findPlanByNeedHint(orderedPlans, 'growth') || findPlanByNeedHint(orderedPlans, 'starter');
    }
    if (currentName.includes('crecimiento')) {
      return findPlanByNeedHint(orderedPlans, 'enterprise') || findPlanByNeedHint(orderedPlans, 'starter');
    }
  }

  const currentCategoryId = String(currentItem && currentItem.categoryId ? currentItem.categoryId : '').trim();
  const sameCategory = safeItems.find((item) => {
    const itemId = String(item && (item.id || item.productId) ? (item.id || item.productId) : '').trim();
    if (!itemId || itemId === currentId) return false;
    if (!currentCategoryId) return false;
    return String(item && item.categoryId ? item.categoryId : '').trim() === currentCategoryId;
  });
  if (sameCategory) return sameCategory;

  return safeItems.find((item) => String(item && (item.id || item.productId) ? (item.id || item.productId) : '').trim() !== currentId) || null;
}

function buildRecommendedPlanComparisonReply(recommendedPlan, comparedPlan, businessContext, salesContext = null) {
  const recommended = recommendedPlan && typeof recommendedPlan === 'object' ? recommendedPlan : {};
  const compared = comparedPlan && typeof comparedPlan === 'object' ? comparedPlan : {};
  const recommendedProfile = resolvePlanProfile(recommended);
  const comparedProfile = resolvePlanProfile(compared);
  const recommendationLevel = String(businessContext && businessContext.recommendationLevel ? businessContext.recommendationLevel : '').trim().toLowerCase();
  const contextLead = buildSalesContextMomentLine(salesContext);

  const closingLine = recommendationLevel === 'growth'
    ? `Yo hoy iría con ${recommended.name || 'Plan Crecimiento'}. ${compared.name || 'El otro plan'} lo dejaría para cuando ya pida más control o más equipo.`
    : `Hoy veo más lógico ${recommended.name || 'este plan'} para lo que me contaste.`;

  return [
    buildComparisonLead(recommended, compared),
    '',
    contextLead
      ? `${recommended.name || 'Este plan'} te cierra más si hoy ${contextLead}.`
      : `${recommended.name || 'Este plan'} te cierra más si hoy ${recommendedProfile.problemSolved}.`,
    '',
    `${compared.name || 'El otro plan'} lo miraría si ${comparedProfile.problemSolved}.`,
    '',
    closingLine
  ].join('\n');
}

function buildContextualPlanComparisonReply(primaryPlan, secondaryPlan, businessContext = null, salesContext = null) {
  const primary = primaryPlan && typeof primaryPlan === 'object' ? primaryPlan : {};
  const secondary = secondaryPlan && typeof secondaryPlan === 'object' ? secondaryPlan : {};
  const primaryProfile = resolvePlanProfile(primary);
  const secondaryProfile = resolvePlanProfile(secondary);
  const recommendationLevel = String(businessContext && businessContext.recommendationLevel ? businessContext.recommendationLevel : '').trim().toLowerCase();
  const contextLead = buildSalesContextMomentLine(salesContext);

  const closingLine = (
    recommendationLevel === 'growth' &&
    normalizeCommandText(primary.name || '').includes('crecimiento') &&
    normalizeCommandText(secondary.name || '').includes('inicial')
  )
    ? `Si ya hay movimiento por WhatsApp, yo sí pondría antes ${primary.name || 'Crecimiento'} que ${secondary.name || 'Inicial'}.`
    : (
      recommendationLevel === 'growth' &&
      normalizeCommandText(primary.name || '').includes('empresa') &&
      normalizeCommandText(secondary.name || '').includes('crecimiento')
    )
      ? `${primary.name || 'Empresa'} tiene más sentido cuando ya necesitás más equipo, más control o una operación bastante más personalizada. ${secondary.name || 'Crecimiento'} está muy bien si todavía querés ordenar la operación sin irte directo al plan más grande.`
      : `Hoy veo más alineado ${primary.name || 'este plan'} si tu foco principal es ${primaryProfile.result}.`;

  return [
    buildComparisonLead(primary, secondary),
    '',
    contextLead
      ? `${secondary.name || 'El otro plan'} puede servir si hoy ${contextLead}, pero todavía sin dar el salto siguiente.`
      : `${secondary.name || 'El otro plan'} sirve si hoy ${secondaryProfile.problemSolved}.`,
    '',
    `${primary.name || 'Este plan'} conviene más cuando querés ${primaryProfile.result}.`,
    '',
    closingLine
  ].join('\n');
}

function buildSafeContextualPlanReply(product, contextPlan = null) {
  return buildCatalogItemDetailReply(product, contextPlan);
}

function isCatalogItemDetailIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  if (hasPlanComparisonSemanticCue(text)) return false;

  return (
    text.includes('que tiene') ||
    text.includes('qué tiene') ||
    text.includes('que incluye') ||
    text.includes('qué incluye') ||
    text.includes('que ofrece') ||
    text.includes('qué ofrece') ||
    text.includes('que trae') ||
    text.includes('qué trae') ||
    text.includes('quiero saber') ||
    text.includes('detalle')
  );
}

function buildCatalogItemDetailReply(item, comparedItem = null) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const name = String(safeItem.name || '').trim() || 'Este producto';
  const description = String(safeItem.description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const summary = description.length > 320 ? `${description.slice(0, 317).trim()}...` : description;
  const lines = [`${name}${Number(safeItem.price || 0) > 0 ? ` — ${formatMoney(safeItem.price, safeItem.currency)}` : ''}`];

  if (summary) {
    lines.push('', summary);
  } else if (isPlanProduct(safeItem)) {
    const profile = resolvePlanProfile(safeItem);
    lines.push('', profile.shortDescription, '', `Te conviene si hoy ${profile.problemSolved}.`);
  }

  logInfo('catalog_item_detail_reply_built', {
    itemId: safeItem.id || safeItem.productId || null,
    itemName: name,
    isPlanProduct: isPlanProduct(safeItem),
    hasComparedItem: Boolean(comparedItem && (comparedItem.id || comparedItem.productId)),
    comparedItemId: comparedItem && (comparedItem.id || comparedItem.productId) ? (comparedItem.id || comparedItem.productId) : null,
    recommendationTrigger: false,
    compareTriggerCandidate: Boolean(comparedItem && (comparedItem.id || comparedItem.productId)),
    pendingOfferedActionWillBeSet: isPlanProduct(safeItem)
  });

  return lines.join('\n');
}

function summarizePendingOfferedActionForLog(value) {
  const safeValue = value && typeof value === 'object' ? value : null;
  if (!safeValue) return null;

  return {
    type: safeValue.type || null,
    currentPlanId: safeValue.currentPlanId || safeValue.recommendedPlanId || null,
    comparisonPlanId: safeValue.comparisonPlanId || safeValue.comparedPlanId || null,
    activeAt: safeValue.activeAt || null,
    completedAt: safeValue.completedAt || null
  };
}

function summarizeVisibleReplyForLog({ replyText = '', outboundMedia = null, sendTextWithMedia = true }) {
  const safeReplyText = String(replyText || '').trim();
  const safeOutboundMedia = Array.isArray(outboundMedia) ? outboundMedia.filter(Boolean) : [];
  const safeSendTextWithMedia = sendTextWithMedia !== false;
  const visibleReplyCount = safeOutboundMedia.length > 0
    ? (safeSendTextWithMedia ? safeOutboundMedia.length + (safeReplyText ? 1 : 0) : safeOutboundMedia.length)
    : (safeReplyText ? 1 : 0);

  return {
    visibleReplyCount,
    hasMedia: safeOutboundMedia.length > 0,
    mediaCount: safeOutboundMedia.length,
    sendTextWithMedia: safeSendTextWithMedia,
    hasReplyText: Boolean(safeReplyText)
  };
}

function buildCatalogItemDetailContextPatch(item, comparedItem, eligibleProducts) {
  const safeItem = item && typeof item === 'object' ? item : null;
  if (!safeItem) return null;

  const safeEligibleProducts = Array.isArray(eligibleProducts) ? eligibleProducts.filter(Boolean) : [];
  const orderedPlans = getOrderedPlanProducts(safeEligibleProducts);
  const itemId = safeItem.id || safeItem.productId || null;

  return {
    ...buildCommercialShortMemoryPatch({
      topic: isPlanProduct(safeItem) ? 'plans' : 'catalog',
      categoryId: safeItem.categoryId || null,
      lastSuggestedProductId: itemId,
      recommendationType: isPlanProduct(safeItem) ? normalizeProductRecommendationType(safeItem, orderedPlans) : 'general'
    }),
    ...(isPlanProduct(safeItem)
      ? {
        ...buildCommercialPlanContextPatch({
          topic: 'plan_detail',
          lastDiscussedPlanId: itemId,
          lastComparedPlanId: comparedItem && (comparedItem.id || comparedItem.productId),
          recommendationType: normalizeProductRecommendationType(safeItem, orderedPlans)
        }),
        pendingOfferedAction: buildCurrentPlanComparisonOfferedAction(
          safeItem,
          comparedItem,
          normalizeProductRecommendationType(safeItem, orderedPlans)
        )
      }
      : null)
  };
}

function buildPlanDetailReply(product, { includePrice = true, includeFeatures = true } = {}) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const profile = resolvePlanProfile(safeProduct);

  return [
    `${safeProduct.name || 'Este plan'}${includePrice ? ` cuesta ${formatMoney(safeProduct.price, safeProduct.currency)}` : ''}.`,
    '',
    `Te conviene si hoy ${profile.problemSolved}.`,
    '',
    `Con este plan podes ${profile.result}.`,
    '',
    ...(includeFeatures && profile.featureLines.length
      ? [
          'Incluye:',
          ...profile.featureLines.map((line) => `- ${line}`),
          `- Usuarios: ${profile.usersLabel}`,
          `- Nivel de control: ${profile.controlLevel}`,
          ''
        ]
      : []),
    'Si queres avanzar, escribi "confirmar" y seguimos con la contratacion.',
    'Si quieres comparar, escribi Plan Inicial, Plan Crecimiento o Plan Empresa.'
  ].join('\n');
}

function buildCommerceCategoriesReply(categories) {
  if (!categories.length) {
    return 'Hola 👋\n\n¡Bienvenido! Te ayudo a armar tu pedido por aca.\n\nEn este momento no tenemos categorias activas con productos disponibles.';
  }

  return [
    'Hola 👋',
    '',
    '¡Bienvenido! Te ayudo a armar tu pedido por aca.',
    '',
    'Estas son nuestras categorias disponibles:',
    '',
    ...categories.map((category) => `${formatCommerceIndex(category.index)} ${category.name}`),
    '',
    'Escribi el numero o el nombre de la categoria que queres ver 👇'
  ].join('\n');
}

function buildCommerceCatalogReply(page) {
  const products = page && Array.isArray(page.items) ? page.items : [];
  const planCatalog = isPlanCatalog(products);
  if (!products.length) {
    return planCatalog
      ? 'Hola 👋\n\nTe ayudo a elegir el plan ideal de Opturon.\n\nEn este momento no tenemos planes disponibles para mostrarte por WhatsApp.'
      : 'Hola 👋\n\n¡Bienvenido! Te ayudo a armar tu pedido por aca.\n\nEn este momento no tenemos productos disponibles para pedir por WhatsApp.';
  }

  const lines = [
    'Hola 👋',
    '',
    planCatalog
      ? 'Te ayudo a elegir el plan ideal de Opturon.'
      : '¡Bienvenido! Te ayudo a armar tu pedido por aca.',
    '',
    page && page.categoryName
      ? planCatalog
        ? `Estos son los planes disponibles de ${page.categoryName}:`
        : `Estos son algunos productos disponibles de ${page.categoryName}:`
      : planCatalog
        ? 'Estos son nuestros planes disponibles:'
        : 'Estos son algunos de nuestros productos disponibles:',
    '',
    ...products.map((product) => planCatalog
      ? buildPlanCatalogLine(product)
      : `${formatCommerceIndex(product.index)} ${product.name} — ${formatMoney(product.price, product.currency)}`),
    '',
    'Podes:',
    planCatalog
      ? '- escribir el numero del plan que queres elegir'
      : '- escribir el numero del producto que queres agregar',
    ...(page && page.hasMore ? [planCatalog ? '- escribir "más" para seguir viendo planes' : '- escribir "más" para seguir viendo productos'] : []),
    ...(page && page.categoryId ? ['- escribir "0" o "volver" para ver categorias'] : []),
    planCatalog
      ? '- escribir "confirmar" para avanzar con la contratacion'
      : '- escribir "confirmar" para cerrar tu pedido',
    planCatalog
      ? '- escribir "productos" para ver los planes otra vez'
      : '- escribir "productos" para ver el catalogo otra vez',
    planCatalog
      ? '- escribir "deshacer" para cambiar tu eleccion'
      : '- escribir "deshacer" para quitar el ultimo producto agregado',
    planCatalog
      ? '- escribir "cancelar" para frenar la contratacion'
      : '- escribir "cancelar" para anular la compra'
  ];

  return lines.join('\n');
}

function parseCommerceSelection(rawText, max) {
  const text = normalizeCommandText(rawText);
  const match = text.match(/^(\d{1,2})$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return null;
  }
  return value;
}

function parseCommerceMultiSelection(rawText, max) {
  const text = normalizeCommandText(rawText);
  if (!text) return [];

  const normalized = text
    .replace(/\sy\s/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  const seen = new Set();
  const selections = [];

  for (const chunk of normalized.split(/[,\s]+/)) {
    const value = Number(chunk);
    if (!/^\d{1,2}$/.test(chunk)) continue;
    if (!Number.isInteger(value) || value < 1 || value > max) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    selections.push(value);
  }

  return selections;
}

function isCommerceMoreIntent(rawText) {
  return COMMERCE_MORE_KEYWORDS.has(normalizeCommandText(rawText));
}

function isCommerceBackToCategoriesIntent(rawText) {
  const text = normalizeCommandText(rawText);
  return (
    text === '0' ||
    text === 'volver' ||
    text === 'ver categorias' ||
    text === 'ver categoryias' ||
    text === 'categorias' ||
    text === 'categorias otra vez' ||
    text === 'atras'
  );
}

function isRelistPlansCommand(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return [
    'planes',
    'ver planes',
    'planes otra vez',
    'productos',
    'ver productos'
  ].includes(text);
}

function parseCommerceCategorySelection(rawText, categories) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const text = normalizeCommandText(rawText);
  if (!text || !safeCategories.length) return null;

  const numericSelection = parseCommerceSelection(text, safeCategories.length);
  if (numericSelection) {
    return safeCategories.find((category) => category.index === numericSelection) || null;
  }

  return (
    safeCategories.find((category) => normalizeCommandText(category.name) === text) ||
    safeCategories.find((category) => normalizeCommandText(category.name).includes(text)) ||
    null
  );
}

function parseCommerceQuantity(rawText) {
  const text = normalizeCommandText(rawText);
  const match = text.match(/^(\d{1,3})$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseCommerceNaturalOrder(rawText) {
  let text = normalizeCommandText(rawText);
  if (!text) return null;

  text = text
    .replace(/^(quiero|quisiera|agrega|agrega me|agregame|agrega un|agrega una|agrega unos|agrega unas|agrega dos|agrega tres|agrega cuatro|agrega cinco|agrega seis|agrega siete|agrega ocho|agrega nueve|agrega diez|agrega \d+|agrega)\b/g, 'agrega')
    .trim();

  text = text.replace(/^(agrega|agrega|agregame|agregame|agregá|suma|suma me|sumame|sumá|pone|poneme|dame|mandame|manda|llevo|necesito)\s+/g, '');
  text = text.replace(/^(por favor\s+)/g, '').trim();
  if (!text) return null;

  const quantityWords = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10
  };

  const parts = text.split(' ').filter(Boolean);
  if (!parts.length) return null;

  let quantity = 1;
  let nameStartIndex = 0;
  const firstPart = parts[0];

  if (/^\d{1,3}$/.test(firstPart)) {
    quantity = Number(firstPart);
    nameStartIndex = 1;
  } else if (quantityWords[firstPart]) {
    quantity = quantityWords[firstPart];
    nameStartIndex = 1;
  }

  const nameParts = parts
    .slice(nameStartIndex)
    .filter((part) => !['de', 'del'].includes(part) || parts.slice(nameStartIndex).length === 1);
  const productName = nameParts.join(' ').trim();

  if (!productName || !Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  return {
    quantity,
    productName
  };
}

function normalizeCommerceProductLookupName(value) {
  const normalized = normalizeCommandText(value)
    .replace(/[()]/g, ' ')
    .replace(/\b(de|del|la|las|el|los|un|una|unos|unas)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
      return token;
    });

  return tokens.join(' ').trim();
}

function findProductByName(products, rawName) {
  const safeProducts = Array.isArray(products) ? products : [];
  const targetName = normalizeCommerceProductLookupName(rawName);
  if (!targetName) return null;

  let bestMatch = null;
  let bestScore = 0;
  const targetTokens = new Set(targetName.split(' ').filter(Boolean));

  for (const product of safeProducts) {
    const productName = normalizeCommerceProductLookupName(product && product.name ? product.name : '');
    if (!productName) continue;

    let score = 0;
    if (productName === targetName) {
      score = 100;
    } else if (productName.includes(targetName) || targetName.includes(productName)) {
      score = 85;
    } else {
      const productTokens = new Set(productName.split(' ').filter(Boolean));
      const sharedTokens = Array.from(targetTokens).filter((token) => productTokens.has(token)).length;
      if (sharedTokens > 0) {
        score = sharedTokens * 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return bestScore >= 40 ? bestMatch : null;
}

function isCommerceCancelIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return (
    text === 'cancelar' ||
    text === 'cancelar pedido' ||
    text === 'anular' ||
    text === 'anular pedido' ||
    text === 'quiero cancelar el pedido' ||
    text === 'quiero anular el pedido'
  );
}

function isCommerceConfirmIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'confirmar' || text === 'confirmar pedido';
}

function isCommerceUndoIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'deshacer' || text === 'borrar ultimo' || text === 'quitar ultimo';
}

function isCommerceViewCartIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'ver carrito' || text === 'carrito' || text === 'mi pedido';
}

function isCommerceClearCartIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'vaciar carrito' || text === 'borrar carrito' || text === 'limpiar carrito';
}

function isCommerceHelpIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'ayuda' || text === 'menu' || text === 'opciones';
}

function parseCommerceRemoveCartItemIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const match = text.match(/^(quitar|eliminar)\s+(\d{1,2})$/);
  if (!match) return null;

  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }

  return index;
}

function hasCommerceContext(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  return Boolean(
    (Array.isArray(safeContext.commerceCatalog) && safeContext.commerceCatalog.length > 0) ||
    (Array.isArray(safeContext.commerceCategories) && safeContext.commerceCategories.length > 0) ||
    (Array.isArray(safeContext.commerceCartItems) && safeContext.commerceCartItems.length > 0) ||
    (safeContext.commerceSelectedProduct && typeof safeContext.commerceSelectedProduct === 'object') ||
    safeContext.commerceCategorySelection === true
  );
}

function buildCommerceResetPatch(extra = {}) {
  return {
    activeBotDomain: null,
    commerceCatalog: null,
    commerceCategories: null,
    commerceCategorySelection: null,
    commerceActiveCategoryId: null,
    commerceActiveCategoryName: null,
    commerceCatalogOffset: null,
    commerceCatalogNextOffset: null,
    commerceCatalogTotal: null,
    commerceSelectedProduct: null,
    commerceLastAddedItem: null,
    commerceSuggestedProductId: null,
    commerceSuggestedProductName: null,
    commerceActivationOfferState: null,
    commerceActivationChoice: null,
    commerceDemoStep: null,
    ...extra
  };
}

function normalizeCommerceCartItems(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const rawItems = Array.isArray(safeContext.commerceCartItems) ? safeContext.commerceCartItems : [];

  return rawItems
    .map((item) => ({
      productId: String(item && item.productId ? item.productId : '').trim() || null,
      name: String(item && item.name ? item.name : '').trim(),
      price: Number(item && item.price ? item.price : 0),
      currency: String(item && item.currency ? item.currency : 'ARS').trim().toUpperCase() || 'ARS',
      quantity: Number.parseInt(String(item && item.quantity ? item.quantity : 0), 10)
    }))
    .filter((item) => item.productId && item.name && Number.isInteger(item.quantity) && item.quantity > 0);
}

function mergeCommerceCartItem(cartItems, product, quantity) {
  const safeCart = Array.isArray(cartItems) ? cartItems : [];
  const normalizedQuantity = Number.parseInt(String(quantity || 0), 10);
  const productId = String(product && (product.productId || product.id) ? (product.productId || product.id) : '').trim();
  if (!productId || !Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    return safeCart;
  }

  const nextItems = safeCart.map((item) => ({ ...item }));
  const existingIndex = nextItems.findIndex((item) => String(item.productId || '') === productId);
  const nextItem = {
    productId,
    name: String(product.name || '').trim(),
    price: Number(product.price || 0),
    currency: String(product.currency || 'ARS').trim().toUpperCase() || 'ARS',
    quantity: normalizedQuantity
  };

  if (existingIndex >= 0) {
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      name: nextItem.name,
      price: nextItem.price,
      currency: nextItem.currency,
      quantity: Number(nextItems[existingIndex].quantity || 0) + normalizedQuantity
    };
    return nextItems;
  }

  nextItems.push(nextItem);
  return nextItems;
}

function removeLastAddedCommerceCartItem(cartItems, lastAddedItem) {
  const safeCart = Array.isArray(cartItems) ? cartItems.map((item) => ({ ...item })) : [];
  const productId = String(lastAddedItem && lastAddedItem.productId ? lastAddedItem.productId : '').trim();
  const quantity = Number.parseInt(String(lastAddedItem && lastAddedItem.quantity ? lastAddedItem.quantity : 0), 10);
  if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
    return safeCart;
  }

  const existingIndex = safeCart.findIndex((item) => String(item.productId || '') === productId);
  if (existingIndex < 0) {
    return safeCart;
  }

  const currentQuantity = Number.parseInt(String(safeCart[existingIndex].quantity || 0), 10);
  if (!Number.isInteger(currentQuantity) || currentQuantity <= quantity) {
    safeCart.splice(existingIndex, 1);
    return safeCart;
  }

  safeCart[existingIndex] = {
    ...safeCart[existingIndex],
    quantity: currentQuantity - quantity
  };
  return safeCart;
}

function removeCommerceCartItemByIndex(cartItems, index) {
  const safeCart = Array.isArray(cartItems) ? cartItems.map((item) => ({ ...item })) : [];
  if (!Number.isInteger(index) || index < 1 || index > safeCart.length) {
    return safeCart;
  }

  safeCart.splice(index - 1, 1);
  return safeCart;
}

function buildCommerceCartItemLines(cartItems, { numbered = false } = {}) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  return safeItems.map((item, index) => {
    const prefix = numbered ? `${index + 1}. ` : '• ';
    return `${prefix}${item.name} ×${item.quantity}`;
  });
}

function buildCommerceCartReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const planCatalog = isPlanCatalog(safeItems);
  const subtotal = safeItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const currency = safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  return [
    planCatalog ? 'Plan agregado 👍' : 'Agregado al carrito 👍',
    '',
    planCatalog ? 'Tu eleccion actual es:' : 'Tu carrito ahora tiene:',
    ...buildCommerceCartItemLines(safeItems),
    `• ${planCatalog ? 'Valor del plan' : 'Total parcial'}: ${formatMoney(subtotal, currency)}`,
    '',
    'Podés:',
    planCatalog ? '- escribir otro número si querés elegir un plan distinto' : '- escribir otro número de producto para seguir agregando',
    planCatalog ? '- escribir "más" para seguir viendo planes' : '- escribir "más" para seguir viendo productos',
    planCatalog ? '- escribir "confirmar" para avanzar con la contratación' : '- escribir "confirmar" para cerrar el pedido',
    planCatalog ? '- escribir "productos" para ver los planes otra vez' : '- escribir "productos" para ver el catálogo otra vez',
    planCatalog ? '- escribir "deshacer" para cambiar tu elección' : '- escribir "deshacer" para quitar el ultimo producto agregado',
    planCatalog ? '- escribir "cancelar" para frenar la contratación' : '- escribir "cancelar" para anular la compra'
  ].join('\n');
}

function buildPlanSelectionReply(product) {
  return buildPlanDetailReply(product);
}

function buildCommerceUndoReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];

  if (!safeItems.length) {
    return [
      'Listo 👍',
      '',
      'Saque el ultimo producto agregado.',
      '',
      'Tu carrito quedó vacío por ahora.',
      'Si querés, escribí "productos" y te muestro el catálogo de nuevo, o mandame otro número para seguir.'
    ].join('\n');
  }

  return [
    'Listo 👍',
    '',
    'Saque el ultimo producto agregado.',
    '',
    'Tu carrito ahora tiene:',
    ...buildCommerceCartItemLines(safeItems),
    '',
    'Podes:',
    '- escribir otro numero de producto',
    '- escribir "más" para seguir viendo productos',
    '- escribir "confirmar"',
    '- escribir "productos"',
    '- escribir "cancelar"'
  ].join('\n');
}

function buildCommerceOrderConfirmation(order, cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const planCatalog = isPlanCatalog(safeItems);
  const currency = order && order.currency ? order.currency : safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  if (planCatalog) {
    return [
      'Perfecto 🙌',
      '',
      'Ya dejamos tu plan listo.',
      '',
      'Resumen:',
      ...buildCommerceCartItemLines(safeItems),
      '',
      `Valor: ${formatMoney(Number(order && order.total ? order.total : 0), currency)}`,
      '',
      'Ahora vamos a activarlo para que empieces a usar Opturon.',
      '',
      'Podemos seguir de estas formas:',
      '',
      '1️⃣ Lo activamos juntos paso a paso ahora',
      '2️⃣ Te muestro cómo funciona con una demo rápida',
      '3️⃣ Te contacta alguien del equipo para ayudarte',
      '',
      'Escribí 1, 2 o 3 y seguimos.'
    ].join('\n');
  }

  return [
    'Perfecto 🙌',
    '',
    'Tu pedido ya quedó registrado.',
    '',
    'Resumen:',
    ...buildCommerceCartItemLines(safeItems),
    '',
    `Total: ${formatMoney(Number(order && order.total ? order.total : 0), currency)}`,
    '',
    'En breve te confirmamos la preparación.'
  ].join('\n');
}

function buildCommerceEmptyCartReply() {
  return 'Tu carrito está vacío por ahora. Si querés, escribí "productos" y te muestro el catálogo para seguir.';
}

function buildCommerceCartSummaryReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  if (!safeItems.length) {
    return buildCommerceEmptyCartReply();
  }

  const subtotal = safeItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const currency = safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  return [
    'Tu carrito ahora tiene:',
    '',
    ...buildCommerceCartItemLines(safeItems, { numbered: true }),
    '',
    `Total estimado: ${formatMoney(subtotal, currency)}`,
    '',
    'Podés:',
    '- escribir otro número de producto para seguir agregando',
    '- escribir "más" para seguir viendo productos',
    '- escribir "confirmar" para cerrar el pedido',
    '- escribir "productos" para ver el catálogo',
    '- escribir "deshacer" para quitar lo último agregado',
    '- escribir "quitar 1" o "eliminar 1" para sacar un producto puntual',
    '- escribir "vaciar carrito" para borrar todo',
    '- escribir "cancelar" para anular la compra'
  ].join('\n');
}

function buildCommerceCartClearedReply() {
  return [
    'Listo 👍',
    'Vacié tu carrito.',
    '',
    'Si querés, escribí "productos" y arrancamos de nuevo con el catálogo.'
  ].join('\n');
}

function buildCommerceAlreadyEmptyCartReply() {
  return 'Tu carrito ya está vacío 😊 Si querés, escribí "productos" y te vuelvo a mostrar el catálogo.';
}

function buildCommerceHelpReply({ currentState, cartItems }) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const hasCart = safeItems.length > 0;
  const isWaitingQuantity = currentState === 'WAITING_QUANTITY';

  const lines = [
    'Te ayudo con tu pedido 👇',
    '',
    'Podés:'
  ];

  if (isWaitingQuantity) {
    lines.push('- escribir cuántas unidades querés del producto que elegiste');
  } else {
    lines.push('- escribir el número de un producto para agregarlo');
  }

  lines.push(`- escribir "productos" para ver el catálogo otra vez`);
  lines.push(`- escribir "más" para seguir viendo productos`);

  if (hasCart) {
    lines.push('- escribir "ver carrito" para revisar tu pedido');
    lines.push('- escribir "confirmar" para cerrar la compra');
    lines.push('- escribir "vaciar carrito" para borrar todo');
  } else {
    lines.push('- escribir "ver carrito" para revisar tu pedido cuando agregues productos');
  }

  lines.push('- escribir "deshacer" para quitar lo último agregado');
  lines.push('- escribir "cancelar" para anular la compra');

  return lines.join('\n');
}

function buildCommerceAlreadyConfirmedReply(lastOrderId) {
  const orderLabel = String(lastOrderId || '').trim();
  return orderLabel
    ? `Tu plan ya quedó registrado con la referencia ${orderLabel}. Si querés revisar los planes otra vez, escribí "productos".`
    : 'Tu plan ya quedó registrado. Si querés revisar los planes otra vez, escribí "productos".';
}

function parsePostConfirmationOption(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'opcion 1') return '1';
  if (normalized === '2' || normalized === 'opcion 2') return '2';
  if (normalized === '3' || normalized === 'opcion 3') return '3';
  return null;
}

function buildPostConfirmationFallbackReply() {
  return [
    'Seguimos con la activación 👇',
    '',
    '1️⃣ Lo activamos juntos paso a paso ahora',
    '2️⃣ Te muestro cómo funciona con una demo rápida',
    '3️⃣ Te contacta alguien del equipo para ayudarte',
    '',
    'Escribí 1, 2 o 3 y seguimos.'
  ].join('\n');
}

function buildPostConfirmationOptionReply(option) {
  if (option === '1') return null;

  if (option === '2') {
    return null;
  }

  return [
    'Perfecto.',
    '',
    'Te va a contactar alguien del equipo para ayudarte con la activación y resolver cualquier duda.',
    '',
    'Mientras tanto, si querés, también puedo mostrarte los planes otra vez o seguir por acá.'
  ].join('\n');
}

function getDemoStageKey(step) {
  const safeStep = Number.isInteger(step) && step > 0 ? step : 1;
  if (safeStep <= 1) return 'demo_step_1';
  if (safeStep === 2) return 'demo_step_2';
  if (safeStep === 3) return 'demo_step_3';
  if (safeStep === 4) return 'demo_step_4';
  return 'demo_close';
}

function buildDemoExperienceReply(step) {
  const safeStep = Number.isInteger(step) && step > 0 ? step : 1;

  if (safeStep === 1) {
    return [
      'Perfecto 🙌',
      '',
      'Hagamos una mini demo guiada de Opturon por WhatsApp.',
      '',
      'Problema real: entran consultas, nadie sabe quién responde y muchas oportunidades se enfrían.',
      '',
      'Cliente:',
      '"Hola, quiero info y precios"',
      '',
      'Escribí solo "seguir" y te muestro la primera respuesta.'
    ].join('\n');
  }

  if (safeStep === 2) {
    return [
      'Opturon responde al instante y ordena la conversacion 👇',
      '',
      'Bot:',
      '"Hola 👋 Te ayudo rapido.',
      '',
      '1️⃣ Quiero precios',
      '2️⃣ Quiero que me contacten',
      '3️⃣ Quiero ver opciones"',
      '',
      'Al mismo tiempo, la consulta queda guardada con contexto, responsable y estado de seguimiento.',
      '',
      'Escribí solo "seguir" y avanzamos.'
    ].join('\n');
  }

  if (safeStep === 3) {
    return [
      'Cliente:',
      '"Quiero precios y que me contacten mañana"',
      '',
      'Opturon no solo responde: también deja anotado el siguiente paso para que la consulta no se pierda.',
      '',
      'Escribí solo "seguir" y te muestro qué ve tu equipo.'
    ].join('\n');
  }

  if (safeStep === 4) {
    return [
      'Esto ve tu equipo adentro de Opturon:',
      '',
      '- consulta asignada a una persona del equipo',
      '- estado del seguimiento visible',
      '- seguimiento con fecha y nota',
      '- alertas si queda pendiente o sin atender',
      '',
      'Así cada persona sabe qué hacer y quien supervisa puede detectar atrasos sin depender de memoria ni planillas.',
      '',
      'Escribí solo "seguir" para ver el cierre.'
    ].join('\n');
  }

  return [
    'En resumen, Opturon te ayuda a:',
    '- responder mas rapido',
    '- ordenar respuestas y seguimientos',
    '- evitar consultas frias',
    '- supervisar la operacion con mas control',
    '',
    'Si querés avanzar ahora, elegí una opción:',
    '',
    '1️⃣ Que te contacte un asesor',
    '2️⃣ Recibir los datos para pagar y avanzar',
    '',
    'Responde 1 o 2 y seguimos.'
  ].join('\n');
}

function buildDemoCommercialCloseReply() {
  return [
    'Perfecto 🙌',
    '',
    'Con esto ya tengo lo necesario para que el equipo comercial entienda tu caso y te acompañe bien.',
    '',
    'Podemos seguir por dos caminos:',
    '',
    '1️⃣ Que te contacte un asesor',
    '2️⃣ Recibir los datos para pagar y avanzar',
    '',
    'Responde 1 o 2 y seguimos.'
  ].join('\n');
}

function parseDemoCommercialCloseOption(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;

  if (
    normalized === '1' ||
    normalized.includes('asesor') ||
    normalized.includes('contact') ||
    normalized.includes('humano') ||
    normalized.includes('persona') ||
    normalized.includes('equipo')
  ) {
    return 'advisor';
  }

  if (
    normalized === '2' ||
    normalized.includes('pagar') ||
    normalized.includes('pago') ||
    normalized.includes('transferencia') ||
    normalized.includes('alias') ||
    normalized.includes('cbu') ||
    normalized.includes('avanzar') ||
    normalized.includes('activar')
  ) {
    return 'payment';
  }

  return null;
}

function findPlanByCommercialPlanContext(products, safeContext, rawText = '') {
  const orderedPlans = getOrderedPlanProducts(products);
  const planContext = getActiveCommercialPlanContext(safeContext);
  if (!planContext || !orderedPlans.length) return null;

  const referencedPlan = findReferencedPlan(orderedPlans, rawText);
  if (referencedPlan) return referencedPlan;

  const text = normalizeCommandText(rawText);
  if (text === 'y el otro' && planContext.lastComparedPlanId) {
    return findPlanByStoredId(orderedPlans, planContext.lastComparedPlanId);
  }

  return findPlanByStoredId(orderedPlans, planContext.lastDiscussedPlanId);
}

function findPlanByBusinessRecommendationContext(products, businessContext) {
  const safeContext = businessContext && typeof businessContext === 'object' ? businessContext : null;
  if (!safeContext || !safeContext.recommendationLevel) return null;
  return findPlanByNeedHint(products, safeContext.recommendationLevel);
}

function isDemoCommercialOnboardingContext(safeContext) {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  return String(context.demoEntrySource || '').trim().toLowerCase() === 'public_demo_whatsapp';
}

function resolveClinicTimezone(clinic) {
  const timezone = String(clinic && clinic.timezone ? clinic.timezone : '').trim() || 'America/Argentina/Buenos_Aires';
  return DateTime.now().setZone(timezone).isValid ? timezone : 'America/Argentina/Buenos_Aires';
}

function buildDemoLeadSummary({ conversation, contact, onboarding, action }) {
  const safeOnboarding = getOnboardingData({ onboarding });
  const source = 'demo_whatsapp';
  const capturedAt = new Date().toISOString();
  const contactName = String((contact && contact.name) || '').trim() || null;
  const contactPhone = String((contact && (contact.whatsappPhone || contact.phone || contact.waId)) || '').trim() || null;
  const summaryLines = [
    'Consulta desde demo de WhatsApp',
    `Acción solicitada: ${action === 'payment' ? 'pago / avanzar con el plan' : 'hablar con un asesor'}`,
    contactName ? `Nombre/contacto: ${contactName}` : null,
    contactPhone ? `WhatsApp: ${contactPhone}` : null,
    safeOnboarding.businessType ? `Tipo de negocio: ${safeOnboarding.businessType}` : null,
    safeOnboarding.mainOffer ? `Rubro/oferta: ${safeOnboarding.mainOffer}` : null,
    safeOnboarding.goal ? `Objetivo principal: ${safeOnboarding.goal}` : null,
    safeOnboarding.channel ? `Usa WhatsApp: ${safeOnboarding.channel}` : null
  ].filter(Boolean);

  return {
    source,
    capturedAt,
    action,
    conversationId: conversation && conversation.id ? conversation.id : null,
    contact: {
      id: contact && contact.id ? contact.id : null,
      name: contactName,
      phone: contactPhone
    },
    onboarding: safeOnboarding,
    summaryText: summaryLines.join('\n')
  };
}

function buildDemoAdvisorFollowUpDescription(summary) {
  return [
    'Seguimiento comercial solicitado desde demo WhatsApp.',
    '',
    summary && summary.summaryText ? summary.summaryText : 'Consulta desde demo de WhatsApp',
    '',
    'Acción sugerida: contactar hoy para avanzar con asesoramiento comercial.'
  ].join('\n');
}

async function findExistingDemoAdvisorAgendaFollowUp({ clinicId, conversationId, contactId, date }) {
  const items = await listAgendaItemsByClinicAndRange(clinicId, date, date);
  return items.find((item) => {
    if (!item || item.status === 'cancelled') return false;
    if (item.type !== 'follow_up') return false;
    if (item.origin !== 'demo_whatsapp') return false;
    if (item.commercialActionType !== 'follow_up') return false;
    if (conversationId && item.conversationId === conversationId) return true;
    if (contactId && item.contactId === contactId) return true;
    return false;
  }) || null;
}

async function ensureDemoAdvisorAgendaFollowUp({ conversation, contact, summary, clinic }) {
  const timezone = resolveClinicTimezone(clinic);
  const now = DateTime.now().setZone(timezone);
  const date = now.toISODate();
  const nextActionAt = now.toUTC().toISO();
  const existing = await findExistingDemoAdvisorAgendaFollowUp({
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    contactId: contact && contact.id ? contact.id : null,
    date
  });

  if (existing) {
    return {
      created: false,
      item: existing
    };
  }

  const item = await createAgendaItem({
    clinicId: conversation.clinicId,
    date,
    startAt: null,
    endAt: null,
    contactId: contact && contact.id ? contact.id : null,
    conversationId: conversation.id,
    assignedUserId: null,
    assignedUserName: 'Antonella / asesor comercial',
    type: 'follow_up',
    title: 'Contactar lead de demo WhatsApp',
    description: buildDemoAdvisorFollowUpDescription(summary),
    status: 'pending',
    commercialActionType: 'follow_up',
    commercialOutcome: 'proposal_requested',
    origin: 'demo_whatsapp',
    location: 'WhatsApp',
    resultNote: null,
    nextStepNote: 'Contactar al lead y avanzar asesoramiento comercial.',
    nextActionAt
  });

  return {
    created: true,
    item
  };
}

async function recordDemoCommercialLead({ conversation, contact, onboarding, action, clinic = null }) {
  const summary = buildDemoLeadSummary({ conversation, contact, onboarding, action });
  let agendaFollowUp = null;
  if (action === 'advisor') {
    agendaFollowUp = await ensureDemoAdvisorAgendaFollowUp({
      conversation,
      contact,
      summary,
      clinic
    });
  }

  await addEvent({
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    type: action === 'payment' ? 'DEMO_PAYMENT_INTENT' : 'DEMO_ADVISOR_REQUESTED',
    data: {
      ...summary,
      agendaFollowUp: agendaFollowUp
        ? {
          created: agendaFollowUp.created,
          id: agendaFollowUp.item && agendaFollowUp.item.id ? agendaFollowUp.item.id : null
        }
        : null
    }
  });
  return {
    ...summary,
    agendaFollowUp: agendaFollowUp
      ? {
        created: agendaFollowUp.created,
        id: agendaFollowUp.item && agendaFollowUp.item.id ? agendaFollowUp.item.id : null
      }
      : null
  };
}

function buildDemoAdvisorReply(summary) {
  return [
    'Perfecto.',
    '',
    'Ya dejé registrada tu consulta para que un asesor te contacte con contexto.',
    '',
    'Resumen:',
    summary && summary.summaryText ? summary.summaryText : 'Consulta desde demo de WhatsApp',
    '',
    'En breve te contactamos para avanzar.'
  ].join('\n');
}

function buildDemoPaymentReply(transferConfig) {
  if (!hasConfiguredTransferData(transferConfig)) {
    return [
      'Perfecto. Ya dejé registrada tu intención de avanzar con el pago.',
      '',
      'Ahora mismo no tengo datos de transferencia configurados para pasarte por acá.',
      'Te va a contactar una persona del equipo para indicarte el siguiente paso.'
    ].join('\n');
  }

  return [
    buildTransferInstructionsReply(transferConfig),
    '',
    'Después de pagar, mandame el comprobante por acá y lo dejamos registrado para revisión.'
  ].join('\n');
}

async function recordTransferPaymentIntent({ conversation, contact, selectedPlan = null, source = 'whatsapp_payment', status = 'payment_requested' }) {
  await addEvent({
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    type: source === 'demo_whatsapp' ? 'DEMO_PAYMENT_INTENT' : 'TRANSFER_PAYMENT_INTENT',
    data: {
      source,
      status,
      capturedAt: new Date().toISOString(),
      conversationId: conversation.id,
      contact: {
        id: contact && contact.id ? contact.id : null,
        name: contact && contact.name ? contact.name : null,
        phone: contact && (contact.whatsappPhone || contact.phone || contact.waId)
          ? (contact.whatsappPhone || contact.phone || contact.waId)
          : null
      },
      selectedPlan
    }
  });
}

function isDemoAdvanceIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return [
    'seguir',
    'segui',
    'sigo',
    'ok',
    'dale',
    'perfecto',
    'joya',
    'buenisimo',
    'barbaro',
    'continuar',
    'continua',
    'siguiente',
    'si',
    'genial',
    'mostrame',
    'mostrame mas',
    'vamos',
    'avanza',
    'avanzar'
  ].includes(normalized);
}

function isDemoActivateIntent(input) {
  const normalized = normalizeCommandText(input);
  return [
    'activar',
    'activar ahora',
    'quiero activar',
    'lo activamos',
    'seguir con la activacion'
  ].includes(normalized);
}

function isDemoBackIntent(input) {
  const normalized = normalizeCommandText(input);
  return normalized === 'volver' || normalized === 'volver atras';
}

function isDemoHumanIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return [
    'humano',
    'persona',
    'asesor',
    'equipo',
    'hablar con humano',
    'hablar con una persona',
    'quiero hablar con alguien'
  ].includes(normalized);
}

function isPublicDemoExperienceIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  const legacyMatch = [
    'quiero una demo guiada por whatsapp',
    'vengo desde la demo web',
    'quiero una demo guiada',
    'demo guiada por whatsapp',
    'vengo desde la demo'
  ].some((pattern) => text.includes(pattern));
  if (legacyMatch) return true;

  const asksToTrySystem = text.includes('quiero probar el sistema');
  const mentionsWhatsApp = text.includes('whatsapp');
  const mentionsGuidedDemoContext =
    text.includes('flujo real') ||
    text.includes('verlo en accion') ||
    text.includes('verlo en acc') ||
    text.includes('ver como funciona');

  return asksToTrySystem && mentionsWhatsApp && mentionsGuidedDemoContext;
}

function getOnboardingStageKey(step) {
  const safeStep = Number.isInteger(step) && step > 0 ? step : 1;
  if (safeStep <= 1) return 'onboarding_step_1';
  if (safeStep === 2) return 'onboarding_step_2';
  if (safeStep === 3) return 'onboarding_step_3';
  if (safeStep === 4) return 'onboarding_step_4';
  return 'onboarding_complete';
}

function buildOnboardingReply(step) {
  const safeStep = Number.isInteger(step) && step > 0 ? step : 1;

  if (safeStep === 1) {
    return [
      'Perfecto 🙌',
      '',
      'Vamos a configurar lo básico para que empieces a usar Opturon.',
      '',
      'Es rápido, en 1 minuto lo dejamos listo.',
      '',
      '¿A qué tipo de negocio lo vas a aplicar?',
      '',
      'Por ejemplo:',
      '- tienda online',
      '- restaurante',
      '- servicios',
      '- otro'
    ].join('\n');
  }

  if (safeStep === 2) {
    return [
      '¿Qué vendés principalmente?',
      '',
      'Por ejemplo:',
      '- ropa',
      '- comida',
      '- servicios profesionales',
      '- otro'
    ].join('\n');
  }

  if (safeStep === 3) {
    return [
      '¿Qué te gustaría lograr con el bot?',
      '',
      'Por ejemplo:',
      '- vender más',
      '- responder más rápido',
      '- automatizar consultas',
      '- otro'
    ].join('\n');
  }

  if (safeStep === 4) {
    return [
      '¿Vas a usar principalmente WhatsApp para responder clientes?',
      '',
      'Podés responder:',
      '- sí',
      '- no'
    ].join('\n');
  }

  return [
    'Perfecto 🙌',
    '',
    'Con esto ya tenemos lo básico para empezar.',
    '',
    'En el siguiente paso podemos:',
    '',
    '1️⃣ Configurar tu bot inicial',
    '2️⃣ Cargar tus productos o servicios',
    '3️⃣ Conectar tu WhatsApp',
    '',
    'Decime cómo querés seguir y lo hacemos.'
  ].join('\n');
}

function normalizeOnboardingChannel(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;
  if (['si', 'sí', 's', 'yes'].includes(normalized)) return 'si';
  if (['no', 'n'].includes(normalized)) return 'no';
  return normalized;
}

function getOnboardingData(context) {
  const onboarding = context && context.onboarding && typeof context.onboarding === 'object'
    ? context.onboarding
    : {};

  return {
    businessType: String(onboarding.businessType || '').trim() || null,
    mainOffer: String(onboarding.mainOffer || '').trim() || null,
    goal: String(onboarding.goal || '').trim() || null,
    channel: String(onboarding.channel || '').trim() || null
  };
}

function detectOnboardingFlowType(onboarding) {
  const businessType = normalizeCommandText(onboarding && onboarding.businessType ? onboarding.businessType : '');
  const mainOffer = normalizeCommandText(onboarding && onboarding.mainOffer ? onboarding.mainOffer : '');

  if (businessType.includes('restaurante') || businessType.includes('comida') || mainOffer.includes('comida')) {
    return 'restaurant';
  }

  if (
    businessType.includes('servicio') ||
    businessType.includes('consult') ||
    businessType.includes('agencia') ||
    mainOffer.includes('servicio')
  ) {
    return 'services';
  }

  if (
    businessType.includes('tienda') ||
    businessType.includes('online') ||
    businessType.includes('ecommerce') ||
    businessType.includes('shop') ||
    mainOffer.includes('ropa') ||
    mainOffer.includes('producto')
  ) {
    return 'store';
  }

  return 'generic';
}

function parseOnboardingCompleteOption(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;

  if (normalized === '1' || normalized.includes('configurar tu bot') || normalized.includes('bot inicial')) return '1';
  if (normalized === '2' || normalized.includes('cargar productos') || normalized.includes('cargar servicios')) return '2';
  if (normalized === '3' || normalized.includes('conectar whatsapp') || normalized.includes('conectar whatsapp')) return '3';
  if (normalized.includes('adapt')) return 'adapt';
  return null;
}

function parseGeneratedBotEditIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;

  if (
    normalized.includes('adaptalo a mi negocio') ||
    normalized.includes('adáptalo a mi negocio') ||
    normalized.includes('adaptalo al negocio') ||
    normalized.includes('lo adaptamos') ||
    normalized.includes('adapt') ||
    normalized.includes('mi negocio')
  ) {
    return 'business';
  }

  if (normalized.includes('mas formal') || normalized.includes('más formal') || normalized.includes('formal')) {
    return 'formal';
  }

  if (normalized.includes('mas vendedor') || normalized.includes('más vendedor') || normalized.includes('vendedor')) {
    return 'sales';
  }

  if (
    normalized.includes('mas simple') ||
    normalized.includes('más simple') ||
    normalized.includes('mas corto') ||
    normalized.includes('más corto') ||
    normalized.includes('simple')
  ) {
    return 'simple';
  }

  if (
    normalized.includes('cambiar bienvenida') ||
    normalized.includes('cambia la bienvenida') ||
    normalized.includes('cambiá la bienvenida') ||
    normalized.includes('bienvenida') ||
    normalized.includes('no digas te ayudo')
  ) {
    return 'welcome';
  }

  if (
    normalized.includes('mensaje final') ||
    normalized.includes('cambiar cierre') ||
    normalized.includes('cambiá el mensaje final')
  ) {
    return 'closing';
  }

  return null;
}

function buildGeneratedBotPreviewHelpReply() {
  return [
    'Podemos seguir de estas formas:',
    '',
    '1️⃣ Configurar tu bot inicial',
    '2️⃣ Cargar tus productos o servicios',
    '3️⃣ Conectar tu WhatsApp',
    '',
    'Si queres ajustar el bot que te mostre, tambien podes escribir:',
    '- "mas vendedor"',
    '- "mas formal"',
    '- "mas simple"',
    '- "cambiar bienvenida"',
    '- "cambia el mensaje final"'
  ].join('\n');
}

function isOnboardingProductsIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return (
    normalized.includes('cargar productos') ||
    normalized.includes('cargar servicios') ||
    normalized.includes('agregar productos') ||
    normalized.includes('agregar servicios') ||
    normalized.includes('catalogo') ||
    normalized.includes('catálogo')
  );
}

function isOnboardingNextStepIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return (
    normalized.includes('como seguimos') ||
    normalized.includes('cómo seguimos') ||
    normalized.includes('que sigue') ||
    normalized.includes('qué sigue') ||
    normalized.includes('siguiente paso') ||
    normalized === 'seguir'
  );
}

function parseActiveBotRuntimeEditIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return null;

  if (
    normalized === 'lo adaptamos' ||
    normalized.includes('adaptalo a mi negocio') ||
    normalized.includes('adáptalo a mi negocio') ||
    normalized.includes('adaptalo al negocio')
  ) {
    return 'business';
  }

  if (
    normalized === 'mas formal' ||
    normalized === 'más formal' ||
    normalized.includes('ponelo mas formal') ||
    normalized.includes('ponelo más formal') ||
    normalized.includes('hacelo mas formal') ||
    normalized.includes('hacelo más formal')
  ) {
    return 'formal';
  }

  if (
    normalized === 'mas vendedor' ||
    normalized === 'más vendedor' ||
    normalized.includes('ponelo mas vendedor') ||
    normalized.includes('ponelo más vendedor') ||
    normalized.includes('hacelo mas vendedor') ||
    normalized.includes('hacelo más vendedor')
  ) {
    return 'sales';
  }

  if (
    normalized === 'mas simple' ||
    normalized === 'más simple' ||
    normalized === 'mas corto' ||
    normalized === 'más corto' ||
    normalized.includes('ponelo mas simple') ||
    normalized.includes('ponelo más simple') ||
    normalized.includes('hacelo mas simple') ||
    normalized.includes('hacelo más simple')
  ) {
    return 'simple';
  }

  if (
    normalized.includes('cambiar bienvenida') ||
    normalized.includes('cambia la bienvenida') ||
    normalized.includes('cambiá la bienvenida') ||
    normalized.includes('no digas te ayudo')
  ) {
    return 'welcome';
  }

  if (
    normalized.includes('cambiá el mensaje final') ||
    normalized.includes('cambia el mensaje final') ||
    normalized.includes('cambiar cierre')
  ) {
    return 'closing';
  }

  return null;
}

function isGeneratedBotActivationIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return [
    'usarlo',
    'activarlo',
    'dejarlo asi',
    'dejarlo así',
    'guardar este',
    'quiero este'
  ].includes(normalized);
}

function resolveGeneratedPreviewEditMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['business', 'formal', 'sales', 'simple', 'welcome', 'closing'].includes(normalized)
    ? normalized
    : 'default';
}

function buildInitialBotFlowFromOnboarding(onboarding, options = {}) {
  const safeOnboarding = onboarding && typeof onboarding === 'object' ? onboarding : {};
  const editMode = resolveGeneratedPreviewEditMode(options && options.editMode ? options.editMode : 'default');
  const type = detectOnboardingFlowType(safeOnboarding);
  const offer = String(safeOnboarding.mainOffer || 'tus productos o servicios').trim();
  const goal = String(safeOnboarding.goal || 'responder rápido y vender mejor').trim();
  const businessType = String(safeOnboarding.businessType || 'tu negocio').trim();

  let customerOpening = '"Hola, qué opciones tenés?"';
  let botWelcome = 'Hola 👋 Te ayudo.';
  let customerNeed = '"Busco algo económico"';
  let botRecommendation = 'Si querés algo para empezar, te puedo recomendar una opción simple y conveniente.\n\n¿Querés que te muestre algunas alternativas?';
  let summary = `Flujo base para ${businessType}: responde, recomienda y ayuda a cerrar conversaciones iniciales.`;

  if (type === 'store') {
    customerOpening = '"Hola, qué tenés?"';
    botWelcome = `Hola 👋 Te ayudo.\n\nTenemos ${offer} disponible.\n\nSi buscás algo puntual, decime qué tipo necesitás y te recomiendo opciones.`;
    botRecommendation = 'Si querés algo para empezar, te puedo recomendar algunas opciones accesibles que están funcionando bien.\n\n¿Querés que te muestre algunas?';
    summary = `Flujo base para tienda: muestra ${offer}, orienta por necesidad y empuja una recomendación simple.`;
  } else if (type === 'restaurant') {
    customerOpening = '"Hola, qué tienen hoy?"';
    botWelcome = `Hola 👋 Te ayudo.\n\nHoy podés consultar ${offer} y te recomiendo según lo que tengas ganas de pedir.\n\nSi querés algo puntual, decime y te oriento.`;
    botRecommendation = 'Si buscás algo económico, te puedo sugerir opciones accesibles que salen muy bien.\n\n¿Querés que te muestre algunas?';
    summary = `Flujo base para restaurante: responde rápido, orienta el pedido y empuja el cierre.`;
  } else if (type === 'services') {
    customerOpening = '"Hola, qué servicio ofrecen?"';
    botWelcome = `Hola 👋 Te ayudo.\n\nOfrecemos ${offer}.\n\nContame qué necesitás y te digo qué opción te conviene más.`;
    botRecommendation = 'Si querés empezar simple, te recomiendo una opción inicial para avanzar sin fricción.\n\n¿Querés que te cuente cómo sería?';
    summary = `Flujo base para servicios: detecta la consulta, recomienda una opción y propone avanzar.`;
  }

  if (editMode === 'business') {
    botWelcome = `${botWelcome}\n\nEstá pensado para ${businessType} y enfocado en ${offer}.`;
    botRecommendation = `${botRecommendation}\n\nLa idea es que el cliente entienda rápido qué ofrecés y avance sin fricción.`;
    summary = `${summary} Ajustado con más foco en ${businessType} y en ${offer}.`;
  } else if (editMode === 'formal') {
    botWelcome = type === 'generic'
      ? 'Hola, gracias por escribirnos. Estoy para ayudarte.'
      : `Hola, gracias por escribirnos.\n\nPuedo orientarte con ${offer} y ayudarte a encontrar la opción más conveniente.`;
    botRecommendation = 'Puedo sugerirte una alternativa adecuada para empezar de forma conveniente.\n\nSi querés, te comparto algunas opciones.';
    summary = `${summary} Ajustado con un tono más profesional.`;
  } else if (editMode === 'sales') {
    botRecommendation = 'Te puedo recomendar una opción de entrada que funciona muy bien y deja encaminada la compra.\n\nSi querés, te muestro las mejores alternativas ahora mismo.';
    summary = `${summary} Ajustado con un enfoque más orientado a cierre.`;
  } else if (editMode === 'simple') {
    botWelcome = type === 'generic'
      ? 'Hola 👋 Te ayudo.'
      : `Hola 👋 Te ayudo con ${offer}.`;
    botRecommendation = 'Te recomiendo una opción simple para empezar.\n\n¿Querés verla?';
    summary = `${summary} Ajustado con un estilo más corto y directo.`;
  } else if (editMode === 'welcome') {
    botWelcome = `Hola 👋 Bienvenido. Estoy para ayudarte con ${offer}.`;
    summary = `${summary} Ajustado con una bienvenida nueva.`;
  } else if (editMode === 'closing') {
    botRecommendation = 'Si querés, te puedo orientar con una recomendación puntual y dejar encaminado el siguiente paso.\n\n¿Querés que avancemos?';
    summary = `${summary} Ajustado con un cierre nuevo.`;
  }

  const introByEditMode = editMode === 'business'
    ? 'Perfecto 🙌\n\nLo adapté más a tu negocio.'
    : editMode === 'formal'
      ? 'Listo 🙌\n\nTe lo dejé con un tono más profesional.'
      : editMode === 'sales'
        ? 'Perfecto 🙌\n\nTe lo rehice con un enfoque más orientado a cierre.'
        : editMode === 'simple'
          ? 'Listo 🙌\n\nTe lo simplifiqué para que se sienta más directo.'
          : editMode === 'welcome'
            ? 'Perfecto 🙌\n\nTe cambié la bienvenida.'
            : editMode === 'closing'
              ? 'Perfecto 🙌\n\nTe ajusté el mensaje final.'
            : 'Listo 🙌\n\nTe armé una primera versión de tu bot.';

  return {
    type,
    summary,
    generatedAt: new Date().toISOString(),
    lastEditMode: editMode === 'default' ? null : editMode,
    text: [
      introByEditMode,
      '',
      'Así respondería a un cliente:',
      '',
      'Cliente:',
      customerOpening,
      '',
      'Bot:',
      `"${botWelcome}"`,
      '',
      'Cliente:',
      customerNeed,
      '',
      'Bot:',
      `"${botRecommendation}"`,
      '',
      '---',
      '',
      'Este flujo ya está pensado para:',
      '- responder rápido',
      '- guiar al cliente',
      '- empujar la venta',
      '',
      `Objetivo base: ${goal}.`,
      '',
      'Ahora podemos seguir con:',
      '- "lo adaptamos"',
      '- "más formal"',
      '- "más vendedor"',
      '- "más simple"',
      '- "cambiar bienvenida"',
      '- "cambiá el mensaje final"',
      '- "cargar productos"',
      '- "conectar WhatsApp"'
    ].join('\n')
  };
}

function buildEditedBotPreview(previousPreview, onboarding, editMode) {
  return buildInitialBotFlowFromOnboarding(onboarding, { editMode });
}

function getGeneratedBotTone(generatedPreview) {
  const lastEditMode = resolveGeneratedPreviewEditMode(generatedPreview && generatedPreview.lastEditMode ? generatedPreview.lastEditMode : '');
  if (lastEditMode === 'formal' || lastEditMode === 'sales' || lastEditMode === 'simple') {
    return lastEditMode;
  }
  return 'default';
}

function buildExecutableBotConfigFromPreview(onboardingData, generatedPreview) {
  const onboarding = onboardingData && typeof onboardingData === 'object' ? onboardingData : {};
  const preview = generatedPreview && typeof generatedPreview === 'object' ? generatedPreview : {};
  const type = String(preview.type || detectOnboardingFlowType(onboarding)).trim() || 'generic';
  const businessType = String(onboarding.businessType || 'tu negocio').trim();
  const offer = String(onboarding.mainOffer || 'tus productos o servicios').trim();
  const tone = getGeneratedBotTone(preview);
  const editMode = resolveGeneratedPreviewEditMode(preview.lastEditMode);

  let welcomeMessage = 'Hola 👋 Te ayudo.';
  let offerDescription = `Tenemos ${offer} disponible.`;
  let recommendationMessage = 'Si querés algo para empezar, te puedo recomendar una opción simple y conveniente.';
  let closingCta = 'Si querés, te muestro algunas opciones.';

  if (type === 'store') {
    welcomeMessage = tone === 'formal'
      ? 'Hola, gracias por escribirnos. Estoy para ayudarte.'
      : tone === 'simple'
          ? `Hola 👋 Te ayudo con ${offer}.`
          : 'Hola 👋 Te ayudo.';
    offerDescription = editMode === 'business'
      ? `Tenemos ${offer} disponible para ${businessType}. Decime qué tipo buscás y te oriento.`
      : `Tenemos ${offer} disponible. Si buscás algo puntual, decime qué tipo necesitás y te recomiendo opciones.`;
    recommendationMessage = tone === 'sales'
      ? 'Te puedo recomendar una opción de entrada que funciona muy bien y deja encaminada la compra.'
      : tone === 'formal'
        ? 'Puedo sugerirte una alternativa adecuada para empezar de forma conveniente.'
        : tone === 'simple'
          ? 'Te recomiendo una opción simple para empezar.'
          : 'Si querés algo para empezar, te puedo recomendar algunas opciones accesibles que están funcionando bien.';
    closingCta = tone === 'sales'
      ? 'Si querés, te muestro las mejores alternativas ahora mismo.'
      : tone === 'formal'
        ? 'Si querés, te comparto algunas opciones.'
        : tone === 'simple'
          ? '¿Querés verla?'
          : '¿Querés que te muestre algunas?';
  } else if (type === 'restaurant') {
    welcomeMessage = tone === 'formal'
      ? 'Hola, gracias por escribirnos. Estoy para ayudarte.'
      : 'Hola 👋 Te ayudo.';
    offerDescription = `Hoy podés consultar ${offer} y te recomiendo según lo que tengas ganas de pedir.`;
    recommendationMessage = tone === 'sales'
      ? 'Te puedo sugerir opciones accesibles que salen muy bien y ayudan a cerrar el pedido rápido.'
      : tone === 'simple'
        ? 'Te puedo sugerir una opción simple y accesible.'
        : 'Si buscás algo económico, te puedo sugerir opciones accesibles que salen muy bien.';
    closingCta = tone === 'simple' ? '¿Querés verla?' : '¿Querés que te muestre algunas?';
  } else if (type === 'services') {
    welcomeMessage = tone === 'formal'
      ? 'Hola, gracias por escribirnos. Estoy para ayudarte.'
      : 'Hola 👋 Te ayudo.';
    offerDescription = `Ofrecemos ${offer}. Contame qué necesitás y te digo qué opción te conviene más.`;
    recommendationMessage = tone === 'sales'
      ? 'Te recomiendo una opción inicial para avanzar hoy mismo y dejar resuelta la consulta.'
      : tone === 'simple'
        ? 'Te recomiendo una opción simple para empezar.'
        : 'Si querés empezar simple, te recomiendo una opción inicial para avanzar sin fricción.';
    closingCta = tone === 'simple' ? '¿Querés verla?' : '¿Querés que te cuente cómo sería?';
  } else {
    welcomeMessage = tone === 'formal'
      ? 'Hola, gracias por escribirnos. Estoy para ayudarte.'
      : 'Hola 👋 Te ayudo.';
    offerDescription = `Te puedo orientar con ${offer}.`;
    recommendationMessage = tone === 'simple'
      ? 'Te recomiendo una opción simple para empezar.'
      : 'Si querés algo para empezar, te puedo recomendar una opción simple y conveniente.';
    closingCta = tone === 'simple' ? '¿Querés verla?' : '¿Querés que te muestre algunas alternativas?';
  }

  if (editMode === 'welcome') {
    welcomeMessage = `Hola 👋 Bienvenido. Estoy para ayudarte con ${offer}.`;
  }

  if (editMode === 'closing') {
    closingCta = '¿Querés que avancemos con una recomendación puntual?';
  }

  return {
    templateKey: GENERATED_SALES_BOT_TEMPLATE_KEY,
    enabled: true,
    type,
    tone,
    businessType,
    welcomeMessage,
    offerDescription,
    recommendationMessage,
    closingCta
  };
}

function inferOfferFromRuntimeConfig(onboardingData, config) {
  const onboarding = onboardingData && typeof onboardingData === 'object' ? onboardingData : {};
  if (String(onboarding.mainOffer || '').trim()) {
    return String(onboarding.mainOffer).trim();
  }

  const offerDescription = String(config && config.offerDescription ? config.offerDescription : '').trim();
  const extracted = offerDescription.match(/(?:Tenemos|Ofrecemos)\s+(.+?)\s+(?:disponible|y te|\.|$)/i);
  if (extracted && extracted[1]) {
    return extracted[1].trim();
  }

  return 'tus productos o servicios';
}

function buildEditedActiveBotConfig(currentConfig, onboardingData, editMode) {
  const config = currentConfig && typeof currentConfig === 'object' ? currentConfig : null;
  if (!config) return null;

  const onboarding = onboardingData && typeof onboardingData === 'object' ? onboardingData : {};
  const businessType = String(onboarding.businessType || config.businessType || 'tu negocio').trim();
  const offer = inferOfferFromRuntimeConfig(onboarding, config);
  const type = String(config.type || detectOnboardingFlowType(onboarding)).trim() || 'generic';
  const tone = editMode === 'formal' || editMode === 'sales' || editMode === 'simple'
    ? editMode
    : String(config.tone || 'default').trim().toLowerCase() || 'default';

  const nextConfig = {
    ...config,
    enabled: true,
    type,
    tone,
    businessType
  };

  if (editMode === 'formal') {
    nextConfig.welcomeMessage = 'Hola, gracias por escribirnos. Estoy para ayudarte.';
    nextConfig.recommendationMessage = type === 'services'
      ? 'Puedo sugerirte una alternativa adecuada para avanzar con una propuesta conveniente.'
      : 'Puedo sugerirte una alternativa adecuada para empezar de forma conveniente.';
    nextConfig.closingCta = 'Si querés, te comparto algunas opciones.';
  } else if (editMode === 'sales') {
    nextConfig.recommendationMessage = type === 'services'
      ? 'Te recomiendo una opción inicial que deja encaminado el avance y ayuda a cerrar la consulta.'
      : 'Te puedo recomendar una opción de entrada que funciona muy bien y deja encaminada la compra.';
    nextConfig.closingCta = 'Si querés, te muestro las mejores alternativas ahora mismo.';
  } else if (editMode === 'simple') {
    nextConfig.welcomeMessage = type === 'services' || type === 'store' || type === 'restaurant'
      ? `Hola 👋 Te ayudo con ${offer}.`
      : 'Hola 👋 Te ayudo.';
    nextConfig.recommendationMessage = 'Te recomiendo una opción simple para empezar.';
    nextConfig.closingCta = '¿Querés verla?';
  } else if (editMode === 'business') {
    nextConfig.offerDescription = type === 'services'
      ? `Ofrecemos ${offer} para ${businessType}. Contame qué necesitás y te digo qué opción te conviene más.`
      : `Tenemos ${offer} disponible para ${businessType}. Decime qué tipo buscás y te oriento.`;
    const businessTail = 'La idea es que el cliente entienda rápido qué ofrecés y avance sin fricción.';
    const currentRecommendation = String(nextConfig.recommendationMessage || '').trim();
    nextConfig.recommendationMessage = currentRecommendation.includes(businessTail)
      ? currentRecommendation
      : `${currentRecommendation}\n\n${businessTail}`.trim();
  } else if (editMode === 'welcome') {
    nextConfig.welcomeMessage = `Hola 👋 Bienvenido. Estoy para ayudarte con ${offer}.`;
  } else if (editMode === 'closing') {
    nextConfig.closingCta = '¿Querés que avancemos con una recomendación puntual?';
  } else {
    return null;
  }

  return nextConfig;
}

function buildActiveBotEditReply(updatedConfig, editIntent) {
  const editLabel = editIntent === 'formal'
    ? 'más formal'
    : editIntent === 'sales'
      ? 'más vendedor'
      : editIntent === 'simple'
        ? 'más simple'
        : editIntent === 'business'
          ? 'más adaptado a tu negocio'
          : editIntent === 'welcome'
            ? 'con una bienvenida nueva'
            : 'con un cierre nuevo';

  return [
    'Perfecto 🙌',
    '',
    `Ya actualicé tu bot activo y quedó ${editLabel}.`,
    '',
    'Así va a responder ahora:',
    `- Bienvenida: ${updatedConfig.welcomeMessage}`,
    `- Presentación: ${updatedConfig.offerDescription}`,
    `- Recomendación: ${updatedConfig.recommendationMessage}`,
    `- Cierre: ${updatedConfig.closingCta}`
  ].join('\n');
}

function getActiveGeneratedBotConfig(clinic) {
  const settings = parseClinicSettingsObject(clinic);
  const config = settings && settings.bot && settings.bot.runtimeConfig && typeof settings.bot.runtimeConfig === 'object'
    ? settings.bot.runtimeConfig
    : null;
  if (!config || config.enabled !== true) return null;
  if (String(config.templateKey || '').trim() !== GENERATED_SALES_BOT_TEMPLATE_KEY) return null;
  return config;
}

function getClinicTransferConfig(clinic) {
  const settings = parseClinicSettingsObject(clinic);
  const config = settings && settings.bot && settings.bot.transferConfig && typeof settings.bot.transferConfig === 'object'
    ? settings.bot.transferConfig
    : null;
  if (!config || config.enabled !== true) return null;
  return normalizeTransferConfig(config, true);
}

async function buildSafeCommercialIntentReply({ clinic, conversation, inboundText }) {
  const commercialIntent = detectCommercialIntent(inboundText);
  const normalizedText = normalizeCommandText(inboundText);
  const transferPaymentIntent = parseTransferPaymentIntent(inboundText);
  const nextStepIntent = detectCommercialNextStepIntent(inboundText);
  const isCommerceEntry = isCommerceEntryIntent(inboundText);
  const safeContext = conversation && conversation.context && typeof conversation.context === 'object'
    ? conversation.context
    : {};
  const activeCommercialDiscoveryPending = getActiveCommercialDiscoveryPending(safeContext);
  const activeShortMemory = getActiveCommercialShortMemory(safeContext);
  const pendingPlanComparison = getPendingPlanComparisonAction(safeContext);
  const activePlanContext = getActiveCommercialPlanContext(safeContext);
  const currentBusinessContext = detectBusinessRecommendationContext(inboundText);
  const activeSalesContext = getActiveCommercialSalesContext(safeContext);
  const detectedSalesContext = detectCommercialSalesContext(inboundText);
  const effectiveSalesContext = mergeCommercialSalesContext(activeSalesContext, detectedSalesContext);
  const storedBusinessContext = getActiveBusinessRecommendationContext(safeContext);
  const effectiveBusinessContext =
    deriveBusinessRecommendationContextFromSalesContext(effectiveSalesContext) ||
    currentBusinessContext ||
    storedBusinessContext;
  const planObjectionType = detectCommercialPlanObjection(inboundText);
  const indecisionIntent = detectCommercialIndecisionIntent(inboundText);
  const hasEffectiveSalesSignals = Boolean(
    effectiveSalesContext && (
      effectiveSalesContext.businessType ||
      effectiveSalesContext.whatsappVolume ||
      effectiveSalesContext.teamSizeSignal ||
      effectiveSalesContext.teamSizeValue ||
      effectiveSalesContext.whatsappAccountTypeSignal ||
      effectiveSalesContext.offerTypeSignal ||
      effectiveSalesContext.channelMixSignal ||
      (Array.isArray(effectiveSalesContext.painPoints) && effectiveSalesContext.painPoints.length) ||
      effectiveSalesContext.lastRecommendedPlan ||
      effectiveSalesContext.lastRecommendationReason
    )
  );
  const businessProfile = getClinicBusinessProfile(clinic);
  const address = normalizeBusinessProfileText(businessProfile.address);
  const openingHours = normalizeBusinessProfileText(businessProfile.openingHours);
  const deliveryZones = normalizeBusinessProfileText(businessProfile.deliveryZones);
  const paymentMethods = normalizeBusinessProfileText(businessProfile.paymentMethods);
  const transferConfig = getClinicTransferConfig(clinic);
  const pendingBeforeLog = summarizePendingOfferedActionForLog(safeContext.pendingOfferedAction);
  const isAgendaLike = looksLikeAgendaIntent({
    inboundText,
    intent: detectIntent(inboundText),
    managementIntent: detectTurnManagementIntent(inboundText)
  });

  if (
    activeCommercialDiscoveryPending &&
    !transferPaymentIntent &&
    !isLoyaltyIntent(inboundText) &&
    !isAgendaLike &&
    normalizeCommandText(inboundText) !== 'cancelar'
  ) {
    const discoveryReply = resolveCommercialDiscoveryPendingReply({
      pending: activeCommercialDiscoveryPending,
      inboundText,
      effectiveSalesContext
    });
    if (discoveryReply) {
      return discoveryReply;
    }
  }

  if (
    isGreetingIntent(inboundText) &&
    !transferPaymentIntent &&
    !isLoyaltyIntent(inboundText) &&
    !isAgendaLike
  ) {
    return {
      type: 'greeting',
      replyText: buildCommercialGreetingReply(safeContext, inboundText)
    };
  }

  if (
    indecisionIntent &&
    !planObjectionType &&
    !activePlanContext &&
    !(activeShortMemory && activeShortMemory.topic === 'plans') &&
    !hasEffectiveSalesSignals &&
    !transferPaymentIntent &&
    !isLoyaltyIntent(inboundText) &&
    !isAgendaLike
  ) {
    return {
      type: 'recommendation',
      replyText: buildCommercialIndecisionReply(safeContext, inboundText)
    };
  }

  if (
    isThanksIntent(inboundText) &&
    !transferPaymentIntent &&
    !isLoyaltyIntent(inboundText) &&
    !isAgendaLike
  ) {
    return {
      type: 'thanks',
      replyText: buildCommercialThanksReply(safeContext)
    };
  }

  if (isCatalogItemDetailIntent(inboundText)) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const matchedItem = findReferencedPlan(eligibleProducts, inboundText) || findProductByName(eligibleProducts, inboundText);

    if (matchedItem) {
      const preferredComparedItemId = activePlanContext && activePlanContext.lastComparedPlanId
        ? activePlanContext.lastComparedPlanId
        : null;
      const comparedItem = chooseLogicalComparisonItem(eligibleProducts, matchedItem, preferredComparedItemId);
      const result = {
        type: 'products',
        replyText: buildCatalogItemDetailReply(matchedItem, comparedItem),
        outboundMedia: [buildCatalogProductImageMessage(matchedItem)].filter(Boolean),
        sendTextWithMedia: false,
        contextPatch: buildCatalogItemDetailContextPatch(matchedItem, comparedItem, eligibleProducts)
      };
      logInfo('commercial_reply_trace', {
        stage: 'catalog_item_detail',
        inboundText: normalizedText,
        matchedIntent: commercialIntent.type,
        matchedItemId: matchedItem.id || matchedItem.productId || null,
        pendingOfferedActionBefore: pendingBeforeLog,
        pendingOfferedActionAfter: summarizePendingOfferedActionForLog(result.contextPatch && result.contextPatch.pendingOfferedAction),
        ...summarizeVisibleReplyForLog(result)
      });
      return result;
    }
  }

  if (
    (activePlanContext || (activeShortMemory && activeShortMemory.topic === 'plans')) &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isPlanWorthItIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const discussedPlan = findReferencedPlan(orderedPlans, inboundText) ||
      findPlanByCommercialPlanContext(orderedPlans, safeContext, inboundText) ||
      resolveRecentCommercialPlan(orderedPlans, effectiveSalesContext, activePlanContext, activeShortMemory);

    if (discussedPlan) {
      return {
        type: 'recommendation',
        replyText: buildPlanWorthItReply(discussedPlan, effectiveSalesContext || {}, orderedPlans),
        contextPatch: {
          ...buildCommercialPlanContextPatch({
            topic: 'plan_value',
            lastDiscussedPlanId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
            lastComparedPlanId: activePlanContext && activePlanContext.lastComparedPlanId,
            recommendationType: normalizeProductRecommendationType(discussedPlan, orderedPlans)
          }),
          ...(hasEffectiveSalesSignals ? buildCommercialSalesContextPatch(effectiveSalesContext) : {}),
          ...(activeShortMemory && activeShortMemory.topic === 'plans'
            ? buildCommercialShortMemoryPatch({
              topic: 'plans',
              lastSuggestedProductId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
              recommendationType: normalizeProductRecommendationType(discussedPlan, orderedPlans)
            })
            : {}),
          pendingOfferedAction: {
            type: null,
            activeAt: null,
            completedAt: new Date().toISOString()
          }
        }
      };
    }
  }

  if (
    planObjectionType &&
    (effectiveSalesContext || activePlanContext || (activeShortMemory && activeShortMemory.topic === 'plans')) &&
    !isCatalogItemDetailIntent(inboundText) &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const referencedPlan = findReferencedPlan(orderedPlans, inboundText);
    const recommendedPlan = referencedPlan || resolveRecentCommercialPlan(orderedPlans, effectiveSalesContext, activePlanContext, activeShortMemory);

    if (recommendedPlan) {
      const objectionReply = buildCommercialPlanObjectionReply(
        planObjectionType,
        recommendedPlan,
        effectiveSalesContext || {},
        orderedPlans,
        inboundText,
        {
          isRepeated: Boolean(
            activeShortMemory &&
            activeShortMemory.lastObjectionType === planObjectionType &&
            activeShortMemory.lastSuggestedProductId &&
            String(activeShortMemory.lastSuggestedProductId).trim() === String(recommendedPlan.id || recommendedPlan.productId || '').trim()
          )
        }
      );
      if (objectionReply) {
        const resolvedPlan = objectionReply.targetPlan || recommendedPlan;
        return {
          type: 'recommendation',
          replyText: objectionReply.replyText,
          contextPatch: {
            ...(hasEffectiveSalesSignals ? buildCommercialSalesContextPatch(effectiveSalesContext) : {}),
            ...buildCommercialPlanContextPatch({
              topic: 'plan_objection',
              lastDiscussedPlanId: resolvedPlan && (resolvedPlan.id || resolvedPlan.productId),
              lastComparedPlanId: activePlanContext && activePlanContext.lastComparedPlanId,
              recommendationType: normalizeProductRecommendationType(resolvedPlan, orderedPlans)
            }),
            ...(activeShortMemory && activeShortMemory.topic === 'plans'
              ? buildCommercialShortMemoryPatch({
                topic: 'plans',
                lastSuggestedProductId: resolvedPlan && (resolvedPlan.id || resolvedPlan.productId),
                recommendationType: normalizeProductRecommendationType(resolvedPlan, orderedPlans),
                lastObjectionType: planObjectionType,
                lastReplyKey: objectionReply.replyKey
              })
              : {})
          }
        };
      }
    }
  }

  if (
    (activeSalesContext || activePlanContext) &&
    detectedSalesContext &&
    !hasPlanComparisonSemanticCue(inboundText) &&
    !isPlanWorthItIntent(inboundText) &&
    !isRecommendationWhyFollowUpIntent(inboundText) &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    effectiveBusinessContext &&
    hasMinimumSalesContextForRecommendation(effectiveSalesContext)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const orderedPlans = getOrderedPlanProducts(eligibleProducts);
    const suggestedPlan = findPlanByBusinessRecommendationContext(orderedPlans, effectiveBusinessContext);
    const comparedPlan = effectiveBusinessContext.recommendationLevel === 'growth'
      ? findPlanByNeedHint(orderedPlans, 'enterprise')
      : null;

    if (suggestedPlan) {
      const recommendationReason = buildRecommendationReasonSummary(suggestedPlan, effectiveSalesContext, orderedPlans);
      return {
        type: 'recommendation',
        replyText: [
          'Ahí me queda más claro 😊',
          '',
          buildHumanSalesRecommendationReply(suggestedPlan, effectiveSalesContext, orderedPlans)
        ].join('\n'),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_recommendation',
            lastDiscussedPlanId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialSalesContextPatch({
            ...effectiveSalesContext,
            lastRecommendedPlan: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastRecommendationReason: recommendationReason
          }),
          pendingOfferedAction: buildPlanComparisonOfferedAction(suggestedPlan, comparedPlan, effectiveBusinessContext),
          ...buildBusinessRecommendationContextPatch(effectiveBusinessContext)
        }
      };
    }
  }

  if (
    pendingPlanComparison &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isPendingPlanComparisonIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const referencedPlans = hasPlanComparisonSemanticCue(inboundText)
      ? findReferencedPlans(orderedPlans, inboundText)
      : [];
    const defaultRecommendedPlan = findPlanByStoredId(
      orderedPlans,
      pendingPlanComparison.currentPlanId || pendingPlanComparison.recommendedPlanId
    );
    const defaultComparedPlan = findPlanByStoredId(
      orderedPlans,
      pendingPlanComparison.comparisonPlanId || pendingPlanComparison.comparedPlanId
    );
    const recommendedPlan = referencedPlans[0] || defaultRecommendedPlan;
    const comparedPlan = referencedPlans[1] || (referencedPlans[0] ? defaultRecommendedPlan : defaultComparedPlan);

    if (recommendedPlan && comparedPlan) {
      const result = {
        type: 'recommendation',
        replyText: pendingPlanComparison.type === PLAN_PENDING_ACTION_COMPARE_CURRENT
          ? buildContextualPlanComparisonReply(recommendedPlan, comparedPlan, effectiveBusinessContext || pendingPlanComparison, effectiveSalesContext)
          : buildRecommendedPlanComparisonReply(recommendedPlan, comparedPlan, effectiveBusinessContext || pendingPlanComparison, effectiveSalesContext),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: recommendedPlan && (recommendedPlan.id || recommendedPlan.productId),
            recommendationType: normalizeProductRecommendationType(recommendedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_comparison',
            lastDiscussedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            lastComparedPlanId: recommendedPlan && (recommendedPlan.id || recommendedPlan.productId),
            recommendationType: normalizeProductRecommendationType(recommendedPlan, orderedPlans)
          }),
          ...(effectiveSalesContext && hasMinimumSalesContextForRecommendation(effectiveSalesContext)
            ? buildCommercialSalesContextPatch({
              ...effectiveSalesContext,
              lastRecommendedPlan: recommendedPlan && (recommendedPlan.id || recommendedPlan.productId),
              lastRecommendationReason: buildRecommendationReasonSummary(recommendedPlan, effectiveSalesContext, orderedPlans)
            })
            : null),
          pendingOfferedAction: {
            type: null,
            activeAt: null,
            completedAt: new Date().toISOString()
          }
        }
      };
      logInfo('commercial_reply_trace', {
        stage: 'pending_plan_comparison',
        inboundText: normalizedText,
        matchedIntent: commercialIntent.type,
        pendingOfferedActionBefore: pendingBeforeLog,
        pendingOfferedActionAfter: summarizePendingOfferedActionForLog(result.contextPatch && result.contextPatch.pendingOfferedAction),
        ...summarizeVisibleReplyForLog(result)
      });
      return result;
    }
  }

  if (
    (activePlanContext || (activeShortMemory && activeShortMemory.topic === 'plans') || hasEffectiveSalesSignals) &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isCommercialSoftFollowUpIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const discussedPlan =
      findPlanByCommercialPlanContext(orderedPlans, safeContext, inboundText) ||
      resolveRecentCommercialPlan(orderedPlans, effectiveSalesContext, activePlanContext, activeShortMemory);
    const comparedPlan = activePlanContext
      ? findPlanByStoredId(orderedPlans, activePlanContext.lastComparedPlanId)
      : null;

    if (discussedPlan) {
      return {
        type: 'recommendation',
        replyText: [
          pickTextVariant(`commercial_follow_up:${normalizedText}`, [
            'Dale 😊',
            'Obvio 😊',
            'Buenísimo 😊'
          ]),
          '',
          buildSafeContextualPlanReply(discussedPlan, comparedPlan)
        ].join('\n'),
        outboundMedia: [buildCatalogProductImageMessage(discussedPlan)].filter(Boolean),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
            recommendationType: normalizeProductRecommendationType(discussedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_detail',
            lastDiscussedPlanId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: activePlanContext && activePlanContext.recommendationType
          })
        }
      };
    }

    if (!hasMinimumSalesContextForRecommendation(effectiveSalesContext)) {
      return {
        type: 'recommendation',
        replyText: buildSalesDiscoveryQuestion(),
        contextPatch: detectedSalesContext ? buildCommercialSalesContextPatch(effectiveSalesContext) : null
      };
    }
  }

  if (
    activePlanContext &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isPlanVsPlanIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const referencedPlans = findReferencedPlans(orderedPlans, inboundText);
    const primaryPlan = referencedPlans[0] || findPlanByCommercialPlanContext(orderedPlans, safeContext, inboundText);
    const secondaryPlan = referencedPlans[1]
      || findPlanByStoredId(orderedPlans, activePlanContext.lastComparedPlanId)
      || findPlanByNeedHint(orderedPlans, 'starter');

      if (primaryPlan && secondaryPlan && String(primaryPlan.id || primaryPlan.productId || '').trim() !== String(secondaryPlan.id || secondaryPlan.productId || '').trim()) {
        const result = {
          type: 'recommendation',
          replyText: buildContextualPlanComparisonReply(primaryPlan, secondaryPlan, effectiveBusinessContext || activePlanContext, effectiveSalesContext),
          contextPatch: {
            ...buildCommercialShortMemoryPatch({
              topic: 'plans',
              lastSuggestedProductId: primaryPlan && (primaryPlan.id || primaryPlan.productId),
              recommendationType: normalizeProductRecommendationType(primaryPlan, orderedPlans)
          }),
            ...buildCommercialPlanContextPatch({
              topic: 'plan_comparison',
              lastDiscussedPlanId: primaryPlan && (primaryPlan.id || primaryPlan.productId),
              lastComparedPlanId: secondaryPlan && (secondaryPlan.id || secondaryPlan.productId),
              recommendationType: normalizeProductRecommendationType(primaryPlan, orderedPlans)
            }),
            ...(effectiveSalesContext && hasMinimumSalesContextForRecommendation(effectiveSalesContext)
              ? buildCommercialSalesContextPatch({
                ...effectiveSalesContext,
                lastRecommendedPlan: primaryPlan && (primaryPlan.id || primaryPlan.productId),
                lastRecommendationReason: buildRecommendationReasonSummary(primaryPlan, effectiveSalesContext, orderedPlans)
              })
              : null),
            pendingOfferedAction: {
              type: null,
              activeAt: null,
              completedAt: new Date().toISOString()
            }
        }
      };
      logInfo('commercial_plan_vs_plan_trace', {
        inboundText: normalizedText,
        whyEntered: 'active_plan_context_and_plan_vs_plan_intent',
        primaryPlanId: primaryPlan.id || primaryPlan.productId || null,
        secondaryPlanId: secondaryPlan.id || secondaryPlan.productId || null,
        pendingBefore: pendingBeforeLog,
        pendingAfter: summarizePendingOfferedActionForLog(result.contextPatch && result.contextPatch.pendingOfferedAction),
        ...summarizeVisibleReplyForLog(result)
      });
      return result;
    }
  }

  if (
    activePlanContext &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isContextualPlanQuestionIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const discussedPlan = findPlanByCommercialPlanContext(orderedPlans, safeContext, inboundText);
    const comparedPlan = findPlanByStoredId(orderedPlans, activePlanContext.lastComparedPlanId);

    if (discussedPlan) {
      const nextComparedPlan = chooseLogicalComparisonItem(
        orderedPlans,
        discussedPlan,
        activePlanContext.lastComparedPlanId || activePlanContext.lastDiscussedPlanId
      );
      const result = {
        type: 'recommendation',
        replyText: buildSafeContextualPlanReply(discussedPlan, nextComparedPlan),
        outboundMedia: [buildCatalogProductImageMessage(discussedPlan)].filter(Boolean),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
            recommendationType: normalizeProductRecommendationType(discussedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_detail',
            lastDiscussedPlanId: discussedPlan && (discussedPlan.id || discussedPlan.productId),
            lastComparedPlanId: nextComparedPlan && (nextComparedPlan.id || nextComparedPlan.productId),
            recommendationType: activePlanContext.recommendationType
          }),
          pendingOfferedAction: buildCurrentPlanComparisonOfferedAction(
            discussedPlan,
            nextComparedPlan,
            activePlanContext.recommendationType
          )
        }
      };
      logInfo('commercial_reply_trace', {
        stage: 'contextual_plan_question',
        inboundText: normalizedText,
        matchedIntent: commercialIntent.type,
        pendingOfferedActionBefore: pendingBeforeLog,
        pendingOfferedActionAfter: summarizePendingOfferedActionForLog(result.contextPatch && result.contextPatch.pendingOfferedAction),
        ...summarizeVisibleReplyForLog(result)
      });
      return result;
    }
  }

  if (
    effectiveSalesContext &&
    (effectiveSalesContext.lastRecommendedPlan || (activePlanContext && activePlanContext.lastDiscussedPlanId)) &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isRecommendationWhyFollowUpIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const recommendedPlan = resolveRecommendedPlanForCommercialFollowUp(orderedPlans, effectiveSalesContext, activePlanContext);

    if (recommendedPlan) {
      return {
        type: 'recommendation',
        replyText: buildRecommendationWhyReply(recommendedPlan, effectiveSalesContext, orderedPlans),
        contextPatch: buildCommercialSalesContextPatch(effectiveSalesContext)
      };
    }
  }

  if (
    !activePlanContext &&
    !pendingPlanComparison &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    isPlanVsPlanIntent(inboundText)
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));

    const referencedPlans = findReferencedPlans(orderedPlans, inboundText);
    const primaryPlan = referencedPlans[0] || null;
    const secondaryPlan = referencedPlans[1] || null;

    if (
      primaryPlan &&
      secondaryPlan &&
      String(primaryPlan.id || primaryPlan.productId || '').trim() !== String(secondaryPlan.id || secondaryPlan.productId || '').trim()
    ) {
      return {
        type: 'recommendation',
        replyText: buildContextualPlanComparisonReply(primaryPlan, secondaryPlan, null, effectiveSalesContext)
      };
    }
  }

  if (
    !activePlanContext &&
    !pendingPlanComparison &&
    !isCatalogItemDetailIntent(inboundText) &&
    !isCommerceEntry &&
    !looksLikeAgendaIntent({ inboundText, intent: detectIntent(inboundText), managementIntent: detectTurnManagementIntent(inboundText) }) &&
    !parseTransferPaymentIntent(inboundText) &&
    normalizeCommandText(inboundText) !== 'cancelar' &&
    !isLoyaltyIntent(inboundText) &&
    (isPlanComparisonIntent(inboundText) || hasPlanComparisonSemanticCue(inboundText))
  ) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));

    if (orderedPlans.length) {
      const suggestedPlan = findPlanByNeedHint(orderedPlans, 'growth') || orderedPlans[0];
      const comparedPlan = findPlanByNeedHint(orderedPlans, 'enterprise');
      return {
        type: 'recommendation',
        replyText: buildPlanComparisonReply(orderedPlans),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_comparison',
            lastDiscussedPlanId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          pendingOfferedAction: buildCurrentPlanComparisonOfferedAction(
            suggestedPlan,
            comparedPlan,
            normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          )
        }
      };
    }
  }

  if (commercialIntent.type === 'products' || commercialIntent.type === 'prices') {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const orderedPlans = getOrderedPlanProducts(eligibleProducts);

    if (isPlanCatalog(eligibleProducts) && orderedPlans.length) {
      const suggestedPlan = findPlanByNeedHint(orderedPlans, 'growth') || orderedPlans[0];
      const comparedPlan = findPlanByNeedHint(orderedPlans, 'enterprise');
      return {
        type: commercialIntent.type,
        replyText: commercialIntent.type === 'prices'
          ? buildPlanComparisonReply(orderedPlans)
          : buildPlanOfferReply(orderedPlans),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: commercialIntent.type === 'prices' ? 'plan_comparison' : 'plan_catalog',
            lastDiscussedPlanId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...(comparedPlan
            ? {
              pendingOfferedAction: buildCurrentPlanComparisonOfferedAction(
                suggestedPlan,
                comparedPlan,
                normalizeProductRecommendationType(suggestedPlan, orderedPlans)
              )
            }
            : null)
        }
      };
    }
  }

  if (commercialIntent.type === 'payment' && !transferPaymentIntent) {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
    const contextualPlan =
      resolveExistingPaymentPlan(safeContext, orderedPlans) ||
      findPlanByCommercialPlanContext(orderedPlans, safeContext, inboundText) ||
      resolveRecentCommercialPlan(orderedPlans, effectiveSalesContext, activePlanContext, activeShortMemory);

    return {
      type: commercialIntent.type,
      replyText: buildPaymentMethodsReply({
        paymentMethods,
        transferConfig,
        activePlanName: contextualPlan && contextualPlan.name ? contextualPlan.name : null
      }),
      contextPatch: contextualPlan
        ? {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: contextualPlan.id || contextualPlan.productId,
            recommendationType: normalizeProductRecommendationType(contextualPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: nextStepIntent ? 'plan_checkout' : 'payment_methods',
            lastDiscussedPlanId: contextualPlan.id || contextualPlan.productId,
            lastComparedPlanId: activePlanContext && activePlanContext.lastComparedPlanId,
            recommendationType: normalizeProductRecommendationType(contextualPlan, orderedPlans)
          })
        }
        : null
    };
  }

  if (commercialIntent.type === 'location') {
    return {
      type: commercialIntent.type,
      replyText: address
        ? `Estamos en ${address} 😊\n\nSi querés, también puedo ayudarte con productos, precios o cualquier consulta.`
        : 'Todavía no tengo una dirección cargada para este comercio. Si querés, te puedo pasar con alguien del equipo.'
    };
  }

  if (commercialIntent.type === 'hours') {
    const looksLikeSimpleHoursRange = /^(de\s*)?\d/.test(openingHours.toLowerCase()) && !/(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)/i.test(openingHours);
    return {
      type: commercialIntent.type,
      replyText: openingHours
        ? (
          normalizedText.includes('hoy') && looksLikeSimpleHoursRange
            ? `Hoy estamos atendiendo ${openingHours} 😊\n\nSi querés, también puedo ayudarte con productos, precios o cualquier consulta.`
            : `Nuestros horarios son:\n${openingHours} 😊\n\nSi querés, también puedo ayudarte con productos, precios o cualquier consulta.`
        )
        : 'Todavía no tengo horarios cargados. Si querés, te puedo pasar con alguien del equipo para confirmarlo.'
    };
  }

  if (commercialIntent.type === 'delivery') {
    return {
      type: commercialIntent.type,
      replyText: deliveryZones
        ? `Sí 😊 Hacemos envíos.\n\n${deliveryZones}\n\nSi querés, también puedo mostrarte productos o ayudarte a elegir.`
        : 'No tengo confirmado si este comercio hace envíos. Si querés, te paso con alguien del equipo.'
    };
  }

  if (commercialIntent.type === 'stock') {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const referencedProduct =
      findReferencedPlan(eligibleProducts, inboundText) ||
      findProductByName(eligibleProducts, inboundText) ||
      findCatalogItemByStoredId(eligibleProducts, safeContext && safeContext.commerceSuggestedProductId) ||
      resolvePlanFromCommercialShortMemory(eligibleProducts, activeShortMemory);

    return {
      type: commercialIntent.type,
      replyText: buildStockAvailabilityReply(referencedProduct)
    };
  }

  if (commercialIntent.type === 'promotions') {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const promotedProducts = buildCommerceEligibleProducts(clinicProducts)
      .filter((product) => Number(product && product.discountPercentage ? product.discountPercentage : 0) > 0)
      .sort((left, right) => Number(right.discountPercentage || 0) - Number(left.discountPercentage || 0))
      .slice(0, 3);

    return {
      type: commercialIntent.type,
      replyText: promotedProducts.length
        ? [
            'Tenemos algunas promos disponibles 😊',
            '',
            ...promotedProducts.map((product) => `- ${product.name}: ${formatWholeNumber(product.discountPercentage)}% off`),
            '',
            'Si querés, también te muestro el catálogo completo.'
          ].join('\n')
        : 'Por ahora no veo promociones cargadas, pero puedo mostrarte productos o ayudarte a encontrar algo.'
    };
  }

  if (commercialIntent.type === 'human_handoff') {
    return {
      type: commercialIntent.type,
      replyText: 'Claro 😊 Te paso con alguien del equipo para que te ayude mejor.',
      triggerHandoff: true
    };
  }

  if (commercialIntent.type === 'recommendation') {
    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const orderedPlans = getOrderedPlanProducts(eligibleProducts);

    if (isPlanCatalog(eligibleProducts) && orderedPlans.length) {
      if (!effectiveBusinessContext && !hasMinimumSalesContextForRecommendation(effectiveSalesContext)) {
        return {
          type: commercialIntent.type,
          replyText: buildSalesDiscoveryQuestion(),
          contextPatch: detectedSalesContext ? buildCommercialSalesContextPatch(effectiveSalesContext) : null
        };
      }

      const comparedPlan = effectiveBusinessContext && effectiveBusinessContext.recommendationLevel === 'growth'
        ? findPlanByNeedHint(orderedPlans, 'enterprise')
        : null;
      const suggestedPlan = effectiveBusinessContext
        ? findPlanByBusinessRecommendationContext(orderedPlans, effectiveBusinessContext)
        : (findPlanByNeedHint(orderedPlans, 'growth') || orderedPlans[0]);
      const recommendationReason = buildRecommendationReasonSummary(suggestedPlan, effectiveSalesContext, orderedPlans);
      return {
        type: commercialIntent.type,
        replyText: effectiveBusinessContext
          ? buildHumanSalesRecommendationReply(suggestedPlan, effectiveSalesContext, orderedPlans)
          : buildPlanRecommendationReply(suggestedPlan, effectiveSalesContext, orderedPlans),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_recommendation',
            lastDiscussedPlanId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialSalesContextPatch({
            ...effectiveSalesContext,
            lastRecommendedPlan: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastRecommendationReason: recommendationReason
          }),
          pendingOfferedAction: buildPlanComparisonOfferedAction(suggestedPlan, comparedPlan, effectiveBusinessContext),
          ...(effectiveBusinessContext ? buildBusinessRecommendationContextPatch(effectiveBusinessContext) : null)
        }
      };
    }

    return {
      type: commercialIntent.type,
      replyText: 'Contame un poco tu negocio y te recomiendo el plan que mejor te puede servir 😊'
    };
  }

  if (effectiveBusinessContext) {
    if (!isCurrentMessageAskingForPlanRecommendation(inboundText, commercialIntent, detectedSalesContext)) {
      logInfo('commercial_recommendation_context_skipped', {
        inboundText: normalizedText,
        commercialIntentType: commercialIntent.type || 'unknown',
        hasDetectedSalesContext: Boolean(detectedSalesContext),
        recommendationLevel: effectiveBusinessContext.recommendationLevel || null,
        businessType: effectiveBusinessContext.businessType || null
      });
      return null;
    }

    const clinicProducts = await listProductsByClinicId(conversation.clinicId);
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const orderedPlans = getOrderedPlanProducts(eligibleProducts);
    const suggestedPlan = findPlanByBusinessRecommendationContext(orderedPlans, effectiveBusinessContext);
    const comparedPlan = effectiveBusinessContext.recommendationLevel === 'growth'
      ? findPlanByNeedHint(orderedPlans, 'enterprise')
      : null;

    if (suggestedPlan) {
      const recommendationReason = buildRecommendationReasonSummary(suggestedPlan, effectiveSalesContext, orderedPlans);
      return {
        type: 'recommendation',
        replyText: buildHumanSalesRecommendationReply(suggestedPlan, effectiveSalesContext, orderedPlans),
        contextPatch: {
          ...buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialPlanContextPatch({
            topic: 'plan_recommendation',
            lastDiscussedPlanId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastComparedPlanId: comparedPlan && (comparedPlan.id || comparedPlan.productId),
            recommendationType: normalizeProductRecommendationType(suggestedPlan, orderedPlans)
          }),
          ...buildCommercialSalesContextPatch({
            ...effectiveSalesContext,
            lastRecommendedPlan: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
            lastRecommendationReason: recommendationReason
          }),
          pendingOfferedAction: buildPlanComparisonOfferedAction(suggestedPlan, comparedPlan, effectiveBusinessContext),
          ...buildBusinessRecommendationContextPatch(effectiveBusinessContext)
        }
      };
    }

    return {
      type: 'recommendation',
      replyText: 'Contame un poco tu negocio y te recomiendo el plan que mejor te puede servir 😊',
      contextPatch: buildBusinessRecommendationContextPatch(effectiveBusinessContext)
    };
  }

  return null;
}

async function buildCommercialShortMemoryReply({ clinic, conversation, inboundText }) {
  const safeContext = conversation && conversation.context && typeof conversation.context === 'object'
    ? conversation.context
    : {};
  if (getPendingLoyaltyOfferedAction(safeContext)) return null;
  const memory = getActiveCommercialShortMemory(safeContext);
  const followUpType = resolveCommercialShortMemoryFollowUpType(inboundText);
  if (!memory || !followUpType) return null;

  const clinicProducts = await listProductsByClinicId(conversation.clinicId);
  const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
  if (!eligibleProducts.length) return null;

  if (memory.topic === 'plans' && isPlanCatalog(eligibleProducts)) {
    const suggestedPlan = selectPlanFromShortMemory(eligibleProducts, memory, followUpType);
    if (!suggestedPlan) {
      return {
        replyText: followUpType === 'cheaper'
          ? 'Por ahora no veo un plan más económico dentro de las opciones que veníamos viendo. Si querés, te comparo los planes o te recomiendo el que más te convenga.'
          : 'Por ahora no veo una alternativa mejor dentro de las opciones que veníamos viendo. Si querés, te comparo los planes o te recomiendo el que más te convenga.',
        contextPatch: buildCommercialShortMemoryPatch({
          topic: 'plans',
          lastSuggestedProductId: memory.lastSuggestedProductId,
          recommendationType: memory.recommendationType
        })
      };
    }

    const introByType = {
      cheaper: 'Si querés algo más accesible, mirá esta opción 😊',
      better: 'Si querés subir un poco, te recomiendo esta 😊',
      similar: 'Tengo otra opción parecida que te puede servir 😊',
      recommend: 'De lo que venimos viendo, esta es de las más convenientes 😊',
      another: 'Te muestro otra opción que también puede ir muy bien 😊'
    };

    return {
      replyText: [
        introByType[followUpType] || introByType.another,
        '',
        buildPlanRecommendationReply(suggestedPlan, null, getOrderedPlanProducts(eligibleProducts))
      ].join('\n'),
      outboundMedia: [buildCatalogProductImageMessage(suggestedPlan)].filter(Boolean),
      newState: 'WAITING_PRODUCT_SELECTION',
      contextPatch: {
        commerceSuggestedProductId: String(suggestedPlan.id || suggestedPlan.productId || '').trim() || null,
        commerceSuggestedProductName: suggestedPlan.name ? String(suggestedPlan.name) : null,
        ...buildCommercialShortMemoryPatch({
          topic: 'plans',
          lastSuggestedProductId: suggestedPlan && (suggestedPlan.id || suggestedPlan.productId),
          recommendationType: normalizeProductRecommendationType(suggestedPlan, getOrderedPlanProducts(eligibleProducts))
        })
      }
    };
  }

  const suggestedProduct = selectProductFromShortMemory(eligibleProducts, memory, followUpType);
  if (!suggestedProduct) {
    return {
      replyText: followUpType === 'cheaper'
        ? 'Por ahora no veo una opción más barata dentro de lo que veníamos viendo. Si querés, te muestro el catálogo o buscamos otra categoría.'
        : 'Por ahora no encuentro otra opción clara dentro de lo que veníamos viendo. Si querés, te muestro el catálogo o buscamos algo parecido.',
      contextPatch: buildCommercialShortMemoryPatch({
        topic: memory.topic,
        categoryId: memory.categoryId,
        lastSuggestedProductId: memory.lastSuggestedProductId,
        recommendationType: memory.recommendationType
      })
    };
  }

  const eligibleOrderedProducts = buildCommerceEligibleProducts(clinicProducts)
    .filter((product) => {
      if (!memory.categoryId) return true;
      if (memory.categoryId === COMMERCE_UNCATEGORIZED_CATEGORY_ID) {
        return !String(product && product.categoryId ? product.categoryId : '').trim();
      }
      return String(product && product.categoryId ? product.categoryId : '').trim() === memory.categoryId;
    })
    .sort((left, right) => Number(left.price || 0) - Number(right.price || 0));

  return {
    replyText: buildCommercialShortMemoryProductReply(suggestedProduct, followUpType),
    outboundMedia: [buildCatalogProductImageMessage(suggestedProduct)].filter(Boolean),
    newState: 'WAITING_PRODUCT_SELECTION',
    contextPatch: {
      commerceSuggestedProductId: String(suggestedProduct.id || suggestedProduct.productId || '').trim() || null,
      commerceSuggestedProductName: suggestedProduct.name ? String(suggestedProduct.name) : null,
      ...buildCommercialShortMemoryPatch({
        topic: 'catalog',
        categoryId: suggestedProduct.categoryId || memory.categoryId || null,
        lastSuggestedProductId: suggestedProduct && (suggestedProduct.id || suggestedProduct.productId),
        recommendationType: normalizeProductRecommendationType(suggestedProduct, eligibleOrderedProducts)
      })
    }
  };
}

function parseTransferPaymentIntent(input) {
  const text = normalizeCommandText(input);
  if (!text) return null;

  const proofNoticePatterns = [
    /\bya\s+pague\b/,
    /\bya\s+transferi\b/,
    /\bhice\s+(?:la\s+)?transferencia\b/,
    /\blisto(?:,\s*)?\s+pagado\b/,
    /\blisto(?:,\s*)?\s+transferido\b/,
    /\bpagado\b/,
    /\b(?:te\s+)?(?:mando|mande|envio|envie)\s+(?:el\s+)?comprobante\b/
  ];
  if (proofNoticePatterns.some((pattern) => pattern.test(text))) {
    return 'proof_notice';
  }

  const transferRequestPatterns = [
    /\bquiero\s+pagar\b/,
    /\bavanzar\s+con\s+el\s+pago\b/,
    /\bpasar\s+al\s+pago\b/,
    /\bseguir\s+con\s+el\s+pago\b/,
    /\bcontratar\b/,
    /\bquiero\s+contratar\b/,
    /\bcomo\s+te\s+transfier[oa]\b/,
    /\bte\s+puedo\s+transferir\b/,
    /\bpuedo\s+transferirte\b/,
    /\bcomo\s+hago\s+para\s+pagarte\b/,
    /\bcomo\s+abono\b/,
    /\bdonde\s+te\s+transfier[oa]\b/,
    /\bme\s+pasas\s+(cbu|alias)\b/,
    /\bpasame\s+(cbu|alias)\b/,
    /\bcomo\s+hago\s+el\s+pago\b/,
    /\bcomo\s+pago\b/,
    /\bformas?\s+de\s+pago\b/,
    /\bmedios?\s+de\s+pago\b/,
    /\bacepta(?:n|s)\s+transf(?:erencia|erecnia)\b/,
    /\bpuedo\s+pagar\s+por\s+transf(?:erencia|erecnia)\b/,
    /\blo\s+puedo\s+pagar\s+por\s+transf(?:erencia|erecnia)\b/,
    /\bpagar\s+(?:por|en)\s+transf(?:erencia|erecnia)\b/,
    /\btransferencia\b/,
    /\btransferecnia\b/
  ];
  if (transferRequestPatterns.some((pattern) => pattern.test(text))) {
    return 'request';
  }

  return null;
}

function isTransferInstructionsRequestIntent(input) {
  const text = normalizeCommandText(input);
  if (!text) return false;

  return [
    /\bcomo\s+te\s+transfier[oa]\b/,
    /\bte\s+puedo\s+transferir\b/,
    /\bpuedo\s+transferirte\b/,
    /\bcomo\s+hago\s+para\s+pagarte\b/,
    /\bcomo\s+abono\b/,
    /\bdonde\s+te\s+transfier[oa]\b/,
    /\bme\s+pasas\s+(cbu|alias)\b/,
    /\bpasame\s+(cbu|alias)\b/,
    /\bacepta(?:n|s)\s+transf(?:erencia|erecnia)\b/,
    /\bpuedo\s+pagar\s+por\s+transf(?:erencia|erecnia)\b/,
    /\blo\s+puedo\s+pagar\s+por\s+transf(?:erencia|erecnia)\b/,
    /\bcomo\s+pago\b/,
    /\bformas?\s+de\s+pago\b/,
    /\bmedios?\s+de\s+pago\b/
  ].some((pattern) => pattern.test(text));
}

function buildPaymentPlanCatalogReply(planProducts) {
  const plans = getOrderedPlanProducts(planProducts);
  if (!plans.length) {
    return [
      'Perfecto. Queres avanzar con el pago.',
      '',
      'Ahora mismo no encuentro planes activos para elegir por WhatsApp.',
      'Te va a contactar un asesor para indicarte el siguiente paso.'
    ].join('\n');
  }

  return [
    'Perfecto. Para avanzar con el pago, primero elegi el plan:',
    '',
    ...plans.map((plan, index) => `${index + 1}. ${plan.name} - ${formatMoney(plan.price, plan.currency)}`),
    '',
    'Responde con el numero del plan o con el nombre.'
  ].join('\n');
}

function normalizePaymentPlan(product) {
  if (!product || typeof product !== 'object') return null;
  const productId = String(product.id || product.productId || '').trim();
  const name = String(product.name || '').trim();
  if (!productId || !name) return null;
  return {
    productId,
    name,
    price: Number(product.price || 0),
    currency: String(product.currency || 'ARS').trim().toUpperCase() || 'ARS',
    sku: product.sku || null
  };
}

function parsePaymentPlanSelection(rawText, planProducts) {
  const plans = getOrderedPlanProducts(planProducts);
  if (!plans.length) return null;
  const numericSelection = parseCommerceSelection(rawText, plans.length);
  if (numericSelection) {
    return normalizePaymentPlan(plans[numericSelection - 1]);
  }

  const referencedPlan = findReferencedPlan(plans, rawText);
  return normalizePaymentPlan(referencedPlan);
}

function resolveExistingPaymentPlan(safeContext, planProducts) {
  const transferContext = safeContext && safeContext.transferPayment && typeof safeContext.transferPayment === 'object'
    ? safeContext.transferPayment
    : null;
  const selectedPlan = transferContext && transferContext.selectedPlan ? normalizePaymentPlan(transferContext.selectedPlan) : null;
  if (selectedPlan) return selectedPlan;

  const cartItems = normalizeCommerceCartItems(safeContext);
  const cartPlan = cartItems.find((item) => isPlanProduct(item));
  if (cartPlan) return normalizePaymentPlan(cartPlan);

  const suggestedProductId = String(safeContext && safeContext.commerceSuggestedProductId ? safeContext.commerceSuggestedProductId : '').trim();
  if (suggestedProductId) {
    const plans = getOrderedPlanProducts(planProducts);
    return normalizePaymentPlan(plans.find((plan) => String(plan.id || plan.productId || '').trim() === suggestedProductId));
  }

  return null;
}

function buildTransferInstructionsWithPlanReply(transferConfig, selectedPlan) {
  if (!hasConfiguredTransferData(transferConfig)) {
    return [
      'Perfecto. Ya dejé registrada tu intención de avanzar con el pago.',
      selectedPlan ? `Plan elegido: ${selectedPlan.name} - ${formatMoney(selectedPlan.price, selectedPlan.currency)}` : null,
      '',
      'Ahora mismo no tengo datos de transferencia configurados para pasarte por acá.',
      'Te va a contactar una persona del equipo para indicarte el siguiente paso.'
    ].filter(Boolean).join('\n');
  }

  return [
    selectedPlan ? `Plan elegido: ${selectedPlan.name} - ${formatMoney(selectedPlan.price, selectedPlan.currency)}` : null,
    '',
    buildTransferInstructionsReply(transferConfig),
    '',
    'Después de pagar, mandame el comprobante por acá. Una persona del equipo lo revisa y seguimos con el alta.'
  ].filter((line) => line !== null).join('\n');
}

function buildTransferPaymentFollowUpDescription({ selectedPlan, proofMetadata, source }) {
  return [
    'Pago por transferencia informado por WhatsApp.',
    '',
    `Origen: ${source || 'whatsapp_payment'}`,
    selectedPlan ? `Plan: ${selectedPlan.name} - ${formatMoney(selectedPlan.price, selectedPlan.currency)}` : null,
    proofMetadata && proofMetadata.type ? `Comprobante/adjunto: ${proofMetadata.type}` : null,
    proofMetadata && proofMetadata.filename ? `Archivo: ${proofMetadata.filename}` : null,
    '',
    'Estado: pendiente de validacion humana.',
    'Accion sugerida: revisar comprobante/contactar al cliente y continuar activacion/instalacion.'
  ].filter(Boolean).join('\n');
}

async function findExistingTransferPaymentFollowUp({ clinicId, conversationId, contactId, date }) {
  const items = await listAgendaItemsByClinicAndRange(clinicId, date, date);
  return items.find((item) => {
    if (!item || item.status === 'cancelled') return false;
    if (item.type !== 'follow_up') return false;
    if (item.origin !== 'transfer_payment') return false;
    if (item.commercialActionType !== 'follow_up') return false;
    if (conversationId && item.conversationId === conversationId) return true;
    if (contactId && item.contactId === contactId) return true;
    return false;
  }) || null;
}

async function ensureTransferPaymentValidationFollowUp({ conversation, contact, selectedPlan, proofMetadata, source, clinic }) {
  const timezone = resolveClinicTimezone(clinic);
  const now = DateTime.now().setZone(timezone);
  const date = now.toISODate();
  const nextActionAt = now.toUTC().toISO();
  const existing = await findExistingTransferPaymentFollowUp({
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    contactId: contact && contact.id ? contact.id : null,
    date
  });

  if (existing) {
    return {
      created: false,
      item: existing
    };
  }

  const item = await createAgendaItem({
    clinicId: conversation.clinicId,
    date,
    startAt: null,
    endAt: null,
    contactId: contact && contact.id ? contact.id : null,
    conversationId: conversation.id,
    assignedUserId: null,
    assignedUserName: 'Antonella / asesor comercial',
    type: 'follow_up',
    title: 'Validar pago informado por transferencia',
    description: buildTransferPaymentFollowUpDescription({ selectedPlan, proofMetadata, source }),
    status: 'pending',
    commercialActionType: 'follow_up',
    commercialOutcome: 'proposal_requested',
    origin: 'transfer_payment',
    location: 'WhatsApp',
    resultNote: null,
    nextStepNote: 'Validar pago informado y continuar activacion/instalacion.',
    nextActionAt
  });

  return {
    created: true,
    item
  };
}

async function recordTransferPaymentReported({ conversation, contact, transferContext, selectedPlan = null, proofMetadata = null, source = 'whatsapp_payment', clinic = null }) {
  const normalizedPlan = normalizePaymentPlan(selectedPlan || (transferContext && transferContext.selectedPlan));
  const reportedAt = new Date().toISOString();
  const agendaFollowUp = await ensureTransferPaymentValidationFollowUp({
    conversation,
    contact,
    selectedPlan: normalizedPlan,
    proofMetadata,
    source,
    clinic
  });

  await addEvent({
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    type: 'TRANSFER_PAYMENT_REPORTED',
    data: {
      source,
      status: 'payment_reported',
      reportedAt,
      awaitingHumanValidation: true,
      conversationId: conversation.id,
      contact: {
        id: contact && contact.id ? contact.id : null,
        name: contact && contact.name ? contact.name : null,
        phone: contact && (contact.whatsappPhone || contact.phone || contact.waId)
          ? (contact.whatsappPhone || contact.phone || contact.waId)
          : null
      },
      selectedPlan: normalizedPlan,
      proofMetadata,
      agendaFollowUp: {
        created: agendaFollowUp.created,
        id: agendaFollowUp.item && agendaFollowUp.item.id ? agendaFollowUp.item.id : null
      }
    }
  });

  return {
    selectedPlan: normalizedPlan,
    reportedAt,
    agendaFollowUp: {
      created: agendaFollowUp.created,
      id: agendaFollowUp.item && agendaFollowUp.item.id ? agendaFollowUp.item.id : null
    }
  };
}

function isInboundPaymentProofMessage(inboundMessage) {
  if (!inboundMessage || typeof inboundMessage !== 'object') return false;
  const type = String(inboundMessage.type || '').trim().toLowerCase();
  return type === 'image' || type === 'document';
}

function extractPaymentProofMetadata(inboundMessage) {
  if (!inboundMessage || typeof inboundMessage !== 'object') return null;
  const raw = inboundMessage.raw && typeof inboundMessage.raw === 'object' ? inboundMessage.raw : {};
  const message = raw.message && typeof raw.message === 'object' ? raw.message : {};
  const type = String(inboundMessage.type || '').trim().toLowerCase();
  const media = type === 'document'
    ? (message.document && typeof message.document === 'object' ? message.document : {})
    : (message.image && typeof message.image === 'object' ? message.image : {});

  return {
    messageId: inboundMessage.id || null,
    providerMessageId: inboundMessage.waMessageId || inboundMessage.providerMessageId || null,
    type: type || null,
    mediaId: media.id || null,
    mimeType: media.mime_type || null,
    sha256: media.sha256 || null,
    caption: media.caption || null,
    filename: media.filename || null
  };
}

function buildTransferInstructionsReply(transferConfig) {
  return buildTransferInstructionsText(transferConfig);
}

function buildTransferMissingConfigReply() {
  return [
    'Todavía no tengo datos de transferencia configurados para pasarte por acá.',
    '',
    'Si querés, alguien del equipo puede ayudarte a completar el pago.'
  ].join('\n');
}

function buildTransferProofRequestReply() {
  return [
    'Perfecto.',
    '',
    'Mandame la foto o el archivo del comprobante y lo dejo registrado para revisión.'
  ].join('\n');
}

function buildTransferPendingValidationReply() {
  return [
    'Perfecto, ya dejé registrado que informaste el pago.',
    '',
    'Ahora lo tiene que revisar una persona del equipo.',
    'A la brevedad te vamos a escribir para continuar con la puesta en marcha.'
  ].join('\n');
}

function buildTransferPendingStatusReply() {
  return [
    'Tu pago informado ya quedó registrado.',
    '',
    'Por ahora sigue pendiente de revisión. A la brevedad una persona del equipo te va a contactar para continuar.'
  ].join('\n');
}

function buildTransferHelpReply(transferConfig) {
  if (hasConfiguredTransferData(transferConfig)) {
    return 'Si querés, te paso alias/CBU para transferir o podés mandarme el comprobante si ya pagaste.';
  }

  return buildTransferMissingConfigReply();
}

function isConfiguredBotOfferIntent(input) {
  const text = normalizeCommandText(input);
  return text.includes('que tenes') || text.includes('qué tenés') || text.includes('que opciones') || text.includes('qué opciones');
}

function isConfiguredBotRecommendationIntent(input) {
  const text = normalizeCommandText(input);
  return text.includes('econom') || text.includes('barato') || text.includes('accesible');
}

function buildBotWelcomeReply(config) {
  return `${config.welcomeMessage}\n\n${config.offerDescription}\n\n${config.closingCta}`;
}

function buildBotOfferReply(config) {
  return `${config.offerDescription}\n\n${config.closingCta}`;
}

function buildBotRecommendationReply(config) {
  return `${config.recommendationMessage}\n\n${config.closingCta}`;
}

function resolveConfiguredSalesBotReply({ clinic, inboundText, currentState, safeContext }) {
  const config = getActiveGeneratedBotConfig(clinic);
  if (!config) return null;

  const activeBotDomain = String(safeContext && safeContext.activeBotDomain ? safeContext.activeBotDomain : '').trim().toLowerCase();
  if (activeBotDomain === 'agenda') return null;
  if (!['READY', 'NEW', 'IDLE'].includes(String(currentState || '').toUpperCase())) return null;

  if (isGreeting(inboundText)) {
    return {
      replyText: buildBotWelcomeReply(config),
      newState: 'READY',
      newStage: 'offering',
      contextPatch: { activeBotDomain: 'commerce' }
    };
  }

  if (isConfiguredBotOfferIntent(inboundText)) {
    return {
      replyText: buildBotOfferReply(config),
      newState: 'READY',
      newStage: 'offering',
      contextPatch: { activeBotDomain: 'commerce' }
    };
  }

  if (isConfiguredBotRecommendationIntent(inboundText)) {
    return {
      replyText: buildBotRecommendationReply(config),
      newState: 'READY',
      newStage: 'offering',
      contextPatch: { activeBotDomain: 'commerce' }
    };
  }

  return null;
}

function isRecentCommerceOrder(lastOrderAt) {
  if (!lastOrderAt) return false;
  const parsedAt = Date.parse(String(lastOrderAt));
  if (!Number.isFinite(parsedAt)) return false;
  return Date.now() - parsedAt <= 2 * 60 * 1000;
}

function buildCommerceRemovedCartItemReply(cartItems, removedItem) {
  const removedName = removedItem && removedItem.name ? removedItem.name : 'ese producto';
  const safeItems = Array.isArray(cartItems) ? cartItems : [];

  if (!safeItems.length) {
    return [
      'Listo 👍',
      `Quité ${removedName} de tu carrito.`,
      '',
      'Tu carrito quedó vacío por ahora.',
      'Si querés, te muestro el catálogo de nuevo o te ayudo a buscar otra opción.'
    ].join('\n');
  }

  return [
    'Listo 👍',
    `Quité ${removedName} de tu carrito.`,
    '',
    buildCommerceCartSummaryReply(safeItems)
  ].join('\n');
}

async function resolveCommerceCartAddition({
  conversation,
  catalogFromContext,
  cartItems,
  quantity,
  productId,
  onStockFailureState = 'WAITING_PRODUCT_SELECTION',
  onStockFailureContextPatch = null
}) {
  const latestProduct = await findProductById(productId, conversation.clinicId);
  if (!latestProduct || String(latestProduct.status || '').toLowerCase() !== 'active') {
    const products = buildCommerceCatalogPage(await listProductsByClinicId(conversation.clinicId));
    return {
      replyText: products.items.length
        ? `Ese producto ya no está disponible en este momento 🤔\n\nSi querés, te muestro otras opciones del catálogo:\n\n${buildCommerceCatalogReply(products)}`
        : 'Ese producto ya no está disponible en este momento y no veo otras opciones activas para mostrarte ahora.',
      newState: products.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: products.items.length ? products.items : null,
        commerceCatalogOffset: products.offset,
        commerceCatalogNextOffset: products.nextOffset,
        commerceCatalogTotal: products.total
      })
    };
  }

  if (Number(latestProduct.stock || 0) < quantity) {
    logInfo('commerce_order_create_failed_stock', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      requestedQuantity: quantity,
      availableStock: Number(latestProduct.stock || 0)
    });
    const stockFailurePatch = onStockFailureContextPatch
      ? {
        ...onStockFailureContextPatch,
        commerceSelectedProduct: onStockFailureContextPatch.commerceSelectedProduct
          ? {
            ...onStockFailureContextPatch.commerceSelectedProduct,
            name: latestProduct.name,
            price: Number(latestProduct.price || 0),
            currency: String(latestProduct.currency || onStockFailureContextPatch.commerceSelectedProduct.currency || 'ARS').toUpperCase(),
            stock: Number(latestProduct.stock || 0),
            sku: latestProduct.sku || null
          }
          : onStockFailureContextPatch.commerceSelectedProduct
      }
      : null;
    return {
      replyText: 'No me alcanza el stock de ese producto en este momento 🤔 Si querés, probá con otra cantidad o te muestro otras opciones.',
      newState: onStockFailureState,
      contextPatch: stockFailurePatch || {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceSelectedProduct: null
      }
    };
  }

  const existingItem = cartItems.find((item) => String(item.productId || '') === String(latestProduct.id));
  const effectiveQuantity = isPlanProduct(latestProduct) ? 1 : quantity;
  const requestedCartQuantity = Number(existingItem && existingItem.quantity ? existingItem.quantity : 0) + effectiveQuantity;
  if (Number(latestProduct.stock || 0) < requestedCartQuantity) {
    logInfo('commerce_order_create_failed_stock', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      requestedQuantity: requestedCartQuantity,
      availableStock: Number(latestProduct.stock || 0)
    });
    const stockFailurePatch = onStockFailureContextPatch
      ? {
        ...onStockFailureContextPatch,
        commerceSelectedProduct: onStockFailureContextPatch.commerceSelectedProduct
          ? {
            ...onStockFailureContextPatch.commerceSelectedProduct,
            name: latestProduct.name,
            price: Number(latestProduct.price || 0),
            currency: String(latestProduct.currency || onStockFailureContextPatch.commerceSelectedProduct.currency || 'ARS').toUpperCase(),
            stock: Number(latestProduct.stock || 0),
            sku: latestProduct.sku || null
          }
          : onStockFailureContextPatch.commerceSelectedProduct
      }
      : null;
    return {
      replyText: 'No me alcanza el stock de ese producto en este momento 🤔 Si querés, probá con otra cantidad o te muestro otras opciones.',
      newState: onStockFailureState,
      contextPatch: stockFailurePatch || {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceSelectedProduct: null
      }
    };
  }

  const baseItem = {
    productId: latestProduct.id,
    name: latestProduct.name,
    price: Number(latestProduct.price || 0),
    currency: String(latestProduct.currency || 'ARS').toUpperCase(),
    sku: latestProduct.sku || null
  };
  const updatedCartItems = isPlanProduct(latestProduct)
    ? [
        {
          ...baseItem,
          quantity: 1
        }
      ]
    : mergeCommerceCartItem(
        cartItems,
        baseItem,
        effectiveQuantity
      );

  logInfo('commerce_cart_item_added', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      addedQuantity: effectiveQuantity,
      cartQuantity: requestedCartQuantity
    });

  return {
    replyText: isPlanProduct(latestProduct) ? buildPlanSelectionReply(latestProduct) : buildCommerceCartReply(updatedCartItems),
    outboundMedia: [buildCatalogProductImageMessage(latestProduct)].filter(Boolean),
    newState: 'WAITING_PRODUCT_SELECTION',
    contextPatch: buildCommerceResetPatch({
      commerceCatalog: catalogFromContext.length
        ? catalogFromContext
        : buildCommerceCatalogPage(await listProductsByClinicId(conversation.clinicId)).items,
      commerceCartItems: updatedCartItems,
      commerceLastAddedItem: {
        productId: String(latestProduct.id || '').trim() || null,
        quantity: effectiveQuantity
      },
      commercialShortMemory: buildCommercialShortMemoryPatch({
        topic: isPlanProduct(latestProduct) ? 'plans' : 'catalog',
        categoryId: latestProduct.categoryId || null,
        lastSuggestedProductId: latestProduct.id || latestProduct.productId,
        recommendationType: normalizeProductRecommendationType(
          latestProduct,
          buildCommerceEligibleProducts(await listProductsByClinicId(conversation.clinicId))
            .filter((product) => {
              if (!latestProduct.categoryId) return true;
              return String(product && product.categoryId ? product.categoryId : '').trim() === String(latestProduct.categoryId).trim();
            })
            .sort((left, right) => Number(left.price || 0) - Number(right.price || 0))
        )
      }).commercialShortMemory
    })
  };
}

async function resolveCommerceMultiCartAddition({
  conversation,
  catalogFromContext,
  cartItems,
  selections
}) {
  const safeCatalog = Array.isArray(catalogFromContext) ? catalogFromContext : [];
  const safeSelections = Array.isArray(selections) ? selections : [];
  let updatedCartItems = Array.isArray(cartItems) ? cartItems : [];
  const addedItems = [];
  const ignoredSelections = [];

  for (const selection of safeSelections) {
    const selectedProduct = safeCatalog[selection - 1] || null;
    if (!selectedProduct || !selectedProduct.productId) {
      ignoredSelections.push(selection);
      continue;
    }

    const latestProduct = await findProductById(selectedProduct.productId, conversation.clinicId);
    if (!latestProduct || String(latestProduct.status || '').toLowerCase() !== 'active') {
      ignoredSelections.push(selection);
      continue;
    }

    const existingItem = updatedCartItems.find((item) => String(item.productId || '') === String(latestProduct.id));
    const requestedCartQuantity = Number(existingItem && existingItem.quantity ? existingItem.quantity : 0) + 1;
    if (Number(latestProduct.stock || 0) < requestedCartQuantity) {
      ignoredSelections.push(selection);
      continue;
    }

    updatedCartItems = mergeCommerceCartItem(
      updatedCartItems,
      {
        productId: latestProduct.id,
        name: latestProduct.name,
        price: Number(latestProduct.price || 0),
        currency: String(latestProduct.currency || 'ARS').toUpperCase()
      },
      1
    );

    addedItems.push({
      selection,
      name: latestProduct.name
    });

    logInfo('commerce_cart_item_added', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      addedQuantity: 1,
      cartQuantity: requestedCartQuantity,
      source: 'multi_selection'
    });
  }

  if (!addedItems.length) {
    return {
      replyText: safeCatalog.length
          ? 'No pude agregar esos productos así como me los mandaste 🤔 Elegí números válidos de la lista o escribí "ayuda" y te guío.'
          : 'Ahora mismo no veo productos disponibles para mostrarte. Si querés, probá con "productos" de nuevo en un rato.',
      newState: safeCatalog.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: safeCatalog.length ? safeCatalog : null,
        commerceCartItems: updatedCartItems.length ? updatedCartItems : null
      })
    };
  }

  const lines = [
    'Agregue estos productos:',
    ...addedItems.map((item, index) => `${index + 1}. ${item.name}`)
  ];

  if (ignoredSelections.length) {
    lines.push('', `Ignore estos numeros porque no estaban disponibles o no eran validos: ${ignoredSelections.join(', ')}`);
  }

  lines.push(
    '',
    'Podes:',
    '- elegir otro producto',
    '- escribir "confirmar"',
    '- escribir "deshacer"',
    ...(safeCatalog.length && safeCatalog.some((item) => item && item.categoryId) ? ['- escribir "0" para volver a categorias'] : [])
  );

  return {
    replyText: lines.join('\n'),
    newState: 'WAITING_PRODUCT_SELECTION',
    contextPatch: buildCommerceResetPatch({
      commerceCatalog: safeCatalog.length
        ? safeCatalog
        : buildCommerceCatalogPage(await listProductsByClinicId(conversation.clinicId)).items,
      commerceCartItems: updatedCartItems,
      commerceLastAddedItem: {
        productId: null,
        quantity: addedItems.length
      }
    })
  };
}

async function resolveCommerceCancellation({ conversation, inboundText, currentState, safeContext }) {
  if (!isCommerceCancelIntent(inboundText)) {
    return null;
  }

  logInfo('commerce_flow_cancelled_by_user', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    inboundText: normalizeCommandText(inboundText)
  });
  logInfo('commerce_trace', {
    sourcePath: 'worker.commerce',
    flow: 'cart_cancel',
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    currentState
  });

  const cartItems = normalizeCommerceCartItems(safeContext);
  const hasActiveFlow = currentState === 'WAITING_PRODUCT_SELECTION' ||
    currentState === 'WAITING_QUANTITY' ||
    cartItems.length > 0 ||
    Boolean(safeContext && safeContext.commerceSelectedProduct);
  const lastOrderId = String(safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : '').trim();
  if (!lastOrderId || hasActiveFlow) {
    return {
      replyText: "Listo, cancelé este pedido en curso. Si querés, puedo mostrarte el catálogo otra vez o ayudarte a elegir algo distinto.",
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCartItems: null,
        commerceLastOrderId: null,
        commerceLastOrderAt: null
      })
    };
  }

  logInfo('commerce_order_cancel_attempt', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    orderId: lastOrderId
  });

  const cancelResult = await patchOrderStatusForClinic(conversation.clinicId, lastOrderId, {
    orderStatus: 'cancelled'
  });

  if (!cancelResult.ok) {
    if (cancelResult.reason === 'order_not_found') {
      return {
        replyText: "No encontré ese pedido para cancelarlo 🤔 Si querés, te muestro el catálogo otra vez o revisamos otra opción.",
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: null,
          commerceLastOrderAt: null
        })
      };
    }

    return {
      replyText: 'No pude cancelar tu pedido en este momento. Si querés, intentá de nuevo en unos minutos y lo revisamos.',
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceLastOrderId: lastOrderId,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
      })
    };
  }

  logInfo('commerce_order_cancel_success', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    orderId: lastOrderId,
    finalStatus: cancelResult.order && cancelResult.order.orderStatus ? cancelResult.order.orderStatus : null
  });

  return {
    replyText: "Listo, cancelé tu pedido y liberé el stock reservado. Si querés, te muestro el catálogo otra vez o buscamos otra opción.",
    newState: 'IDLE',
    contextPatch: buildCommerceResetPatch({
      commerceCartItems: null,
      commerceLastOrderId: null,
      commerceLastOrderAt: null
    })
  };
}

async function resolveCommerceDecision({ conversation, clinic, contact, inboundText, inboundMessage = null }) {
  const currentState = String(conversation.state || '').toUpperCase();
  const safeContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const catalogFromContext = Array.isArray(safeContext.commerceCatalog) ? safeContext.commerceCatalog : [];
  const categoriesFromContext = Array.isArray(safeContext.commerceCategories) ? safeContext.commerceCategories : [];
  const categorySelectionActive = safeContext.commerceCategorySelection === true;
  const activeCategoryId = String(safeContext.commerceActiveCategoryId || '').trim() || null;
  const activeCategoryName = String(safeContext.commerceActiveCategoryName || '').trim() || null;
  const catalogNextOffset = Number.isFinite(Number(safeContext.commerceCatalogNextOffset)) ? Number(safeContext.commerceCatalogNextOffset) : null;
  const catalogTotal = Number.isFinite(Number(safeContext.commerceCatalogTotal)) ? Number(safeContext.commerceCatalogTotal) : 0;
  const cartItems = normalizeCommerceCartItems(safeContext);
  const lastAddedItem = safeContext.commerceLastAddedItem && typeof safeContext.commerceLastAddedItem === 'object'
    ? {
      productId: String(safeContext.commerceLastAddedItem.productId || '').trim() || null,
      quantity: Number.parseInt(String(safeContext.commerceLastAddedItem.quantity || 0), 10)
    }
    : null;
  const traceCommerceFlow = (flow, extra = {}) => {
    logInfo('commerce_trace', {
      sourcePath: 'worker.commerce',
      flow,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      currentState,
      ...extra
    });
  };
  let cachedClinicProducts = null;
  const loadClinicProducts = async () => {
    if (!cachedClinicProducts) {
      cachedClinicProducts = await listProductsByClinicId(conversation.clinicId);
    }
    return cachedClinicProducts;
  };
  const buildPlanSalesDecision = async (replyText, suggestedProduct = null) => {
    const products = await loadClinicProducts();
    const page = buildCommerceCatalogPage(products);
    const orderedPlans = getOrderedPlanProducts(buildCommerceEligibleProducts(products));

    return {
      replyText,
      outboundMedia: [buildCatalogProductImageMessage(suggestedProduct)].filter(Boolean),
      newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: page.items,
        commerceCatalogOffset: page.offset,
        commerceCatalogNextOffset: page.nextOffset,
        commerceCatalogTotal: page.total,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceLastAddedItem: lastAddedItem,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
        commerceSuggestedProductId: suggestedProduct && (suggestedProduct.id || suggestedProduct.productId)
          ? String(suggestedProduct.id || suggestedProduct.productId)
          : null,
        commerceSuggestedProductName: suggestedProduct && suggestedProduct.name ? String(suggestedProduct.name) : null,
        commercialPlanContext: suggestedProduct
          ? buildCommercialPlanContextPatch({
            topic: 'plan_discussion',
            lastDiscussedPlanId: suggestedProduct.id || suggestedProduct.productId,
            recommendationType: normalizeProductRecommendationType(suggestedProduct, orderedPlans)
          }).commercialPlanContext
          : safeContext.commercialPlanContext || null,
        commercialShortMemory: suggestedProduct
          ? buildCommercialShortMemoryPatch({
            topic: 'plans',
            lastSuggestedProductId: suggestedProduct.id || suggestedProduct.productId,
            recommendationType: normalizeProductRecommendationType(suggestedProduct, orderedPlans)
          }).commercialShortMemory
          : safeContext.commercialShortMemory || null
      })
    };
  };
  const buildCatalogEntryDecision = async () => {
    const products = await loadClinicProducts();
    if (isPlanCatalog(buildCommerceEligibleProducts(products))) {
      const page = buildCommerceCatalogPage(products);
      traceCommerceFlow('catalog_plans', {
        shownCount: page.items.length,
        total: page.total,
        hasMore: page.hasMore
      });
      return {
        replyText: buildCommerceCatalogReply(page),
        newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: page.items,
          commerceCatalogOffset: page.offset,
          commerceCatalogNextOffset: page.nextOffset,
          commerceCatalogTotal: page.total,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
        })
      };
    }

    const categories = buildCommerceCategories(products);
    if (categories.length > 0) {
      traceCommerceFlow('catalog_by_category', {
        categoryCount: categories.length,
        productCount: buildCommerceEligibleProducts(products).length
      });
      return {
        replyText: buildCommerceCategoriesReply(categories),
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCategories: categories,
          commerceCategorySelection: true,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
        })
      };
    }

    const page = buildCommerceCatalogPage(products);
    traceCommerceFlow('catalog_general', {
      shownCount: page.items.length,
      total: page.total,
      hasMore: page.hasMore
    });
    return {
      replyText: buildCommerceCatalogReply(page),
      newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: page.items,
        commerceCatalogOffset: page.offset,
        commerceCatalogNextOffset: page.nextOffset,
        commerceCatalogTotal: page.total,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceLastAddedItem: lastAddedItem,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
      })
    };
  };
  const buildPaymentPlanSelectionDecision = async ({ source = 'whatsapp_payment' } = {}) => {
    const plans = getOrderedPlanProducts(buildCommerceEligibleProducts(await loadClinicProducts()));
    await recordTransferPaymentIntent({
      conversation,
      contact,
      selectedPlan: null,
      source,
      status: 'awaiting_plan_selection'
    });

    return {
      replyText: buildPaymentPlanCatalogReply(plans),
      newState: 'PAYMENT_TRANSFER',
      newStage: 'payment_plan_selection',
      contextPatch: {
        activeBotDomain: 'commerce',
        transferPayment: {
          orderId: null,
          status: 'awaiting_plan_selection',
          paymentMethod: 'bank_transfer',
          source,
          requestedAt: new Date().toISOString()
        },
        commerceCatalog: plans.map((plan, index) => ({
          ...plan,
          productId: plan.id || plan.productId,
          index: index + 1
        })),
        commerceCartItems: null,
        commerceSelectedProduct: null
      }
    };
  };
  const buildPaymentInstructionsDecision = async ({ selectedPlan, source = 'whatsapp_payment' } = {}) => {
    const normalizedPlan = normalizePaymentPlan(selectedPlan);
    const hasTransferData = hasConfiguredTransferData(transferConfig);
    await recordTransferPaymentIntent({
      conversation,
      contact,
      selectedPlan: normalizedPlan,
      source,
      status: hasTransferData ? 'payment_requested' : 'missing_transfer_config'
    });

    return {
      replyText: buildTransferInstructionsWithPlanReply(transferConfig, normalizedPlan),
      outboundMedia: [buildCatalogProductImageMessage(selectedPlan)].filter(Boolean),
      newState: hasTransferData ? 'PAYMENT_TRANSFER' : 'IDLE',
      newStage: hasTransferData ? 'payment_requested' : 'handoff',
      contextPatch: {
        activeBotDomain: 'commerce',
        commerceCartItems: normalizedPlan ? [{ ...normalizedPlan, quantity: 1 }] : null,
        transferPayment: {
          orderId: null,
          status: hasTransferData ? 'payment_requested' : 'missing_transfer_config',
          paymentMethod: 'bank_transfer',
          source,
          selectedPlan: normalizedPlan,
          destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
          requestedAt: new Date().toISOString()
        }
      }
    };
  };

  const buildDemoEntryDecision = () => ({
    replyText: buildDemoExperienceReply(1),
    newState: 'DEMO',
    newStage: getDemoStageKey(1),
    contextPatch: buildCommerceResetPatch({
      commerceCartItems: null,
      commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
      commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
      commerceActivationOfferState: 'demo',
      commerceActivationChoice: '2',
      commerceDemoStep: 1,
      demoEntrySource: 'public_demo_whatsapp'
    })
  });

  const cancelDecision = await resolveCommerceCancellation({
    conversation,
    inboundText,
    currentState,
    safeContext
  });
  if (cancelDecision) {
    return cancelDecision;
  }

  if (
    isPublicDemoExperienceIntent(inboundText) &&
    currentState !== 'PAYMENT_TRANSFER'
  ) {
    return buildDemoEntryDecision();
  }

  const activeRuntimeConfig = getActiveGeneratedBotConfig(clinic);
  const runtimeEditIntent = parseActiveBotRuntimeEditIntent(inboundText);
  if (activeRuntimeConfig && runtimeEditIntent && ['READY', 'NEW', 'IDLE'].includes(currentState)) {
    const updatedRuntimeConfig = buildEditedActiveBotConfig(activeRuntimeConfig, getOnboardingData(safeContext), runtimeEditIntent);
    if (updatedRuntimeConfig) {
      await updateClinicBotRuntimeConfigById(conversation.clinicId, updatedRuntimeConfig);
      return {
        replyText: buildActiveBotEditReply(updatedRuntimeConfig, runtimeEditIntent),
        newState: 'READY',
        newStage: 'offering',
        contextPatch: {
          activeBotDomain: 'commerce',
          botRuntimeConfig: updatedRuntimeConfig
        }
      };
    }
  }

  const transferConfig = getClinicTransferConfig(clinic);
  const transferIntent = parseTransferPaymentIntent(inboundText);
  const nextStepIntent = detectCommercialNextStepIntent(inboundText);
  const transferContext = safeContext.transferPayment && typeof safeContext.transferPayment === 'object'
    ? safeContext.transferPayment
    : null;
  const transferOrderId = String(
    (transferContext && transferContext.orderId) ||
    (safeContext && safeContext.commerceLastOrderId) ||
    ''
  ).trim() || null;
  const transferFlowActive = currentState === 'PAYMENT_TRANSFER' || Boolean(transferContext);
  const transferStatus = String(transferContext && transferContext.status ? transferContext.status : '').trim().toLowerCase();
  const canReportTransferPayment =
    transferFlowActive &&
    transferStatus !== 'awaiting_plan_selection' &&
    transferStatus !== 'payment_reported' &&
    transferStatus !== 'payment_pending_validation';
  const ensureOrderPendingForTransfer = async () => {
    if (!transferOrderId) return null;
    const patchPayload = {
      paymentStatus: 'pending'
    };

    if (transferConfig && transferConfig.destinationId) {
      patchPayload.paymentDestinationId = transferConfig.destinationId;
    }

    const patchResult = await patchOrderStatusForClinic(conversation.clinicId, transferOrderId, patchPayload);
    return patchResult && patchResult.ok ? patchResult.order : null;
  };

  if (nextStepIntent && currentState !== 'PAYMENT_TRANSFER') {
    const plans = getOrderedPlanProducts(buildCommerceEligibleProducts(await loadClinicProducts()));
    const contextualPlan =
      resolveExistingPaymentPlan(safeContext, plans) ||
      parsePaymentPlanSelection(inboundText, plans) ||
      findPlanByCommercialPlanContext(plans, safeContext, inboundText) ||
      resolveRecentCommercialPlan(
        plans,
        getActiveCommercialSalesContext(safeContext),
        getActiveCommercialPlanContext(safeContext),
        getActiveCommercialShortMemory(safeContext)
      ) ||
      findPlanByBusinessRecommendationContext(plans, getActiveBusinessRecommendationContext(safeContext));

    if (contextualPlan) {
      return buildPaymentInstructionsDecision({
        selectedPlan: contextualPlan,
        source: 'whatsapp_payment'
      });
    }

    if (plans.length) {
      return buildPaymentPlanSelectionDecision({
        source: 'whatsapp_payment'
      });
    }
  }

  if (transferContext && transferContext.status === 'awaiting_plan_selection') {
    const plans = getOrderedPlanProducts(buildCommerceEligibleProducts(await loadClinicProducts()));
    const selectedPlan = parsePaymentPlanSelection(inboundText, plans);
    if (!selectedPlan) {
      return {
        replyText: buildPaymentPlanCatalogReply(plans),
        newState: 'PAYMENT_TRANSFER',
        newStage: 'payment_plan_selection',
        contextPatch: {
          transferPayment: transferContext,
          commerceCatalog: plans.map((plan, index) => ({
            ...plan,
            productId: plan.id || plan.productId,
            index: index + 1
          }))
        }
      };
    }

    return buildPaymentInstructionsDecision({
      selectedPlan,
      source: transferContext.source || 'whatsapp_payment'
    });
  }

  if ((isInboundPaymentProofMessage(inboundMessage) && canReportTransferPayment) || (transferIntent === 'proof_notice' && canReportTransferPayment)) {
    const order = await ensureOrderPendingForTransfer();
    const proofMetadata = extractPaymentProofMetadata(inboundMessage);
    const reported = await recordTransferPaymentReported({
      conversation,
      contact,
      transferContext,
      selectedPlan: transferContext && transferContext.selectedPlan ? transferContext.selectedPlan : null,
      proofMetadata,
      source: transferContext && transferContext.source ? transferContext.source : 'whatsapp_payment',
      clinic
    });
    return {
      replyText: buildTransferPendingValidationReply(),
      newState: 'PAYMENT_TRANSFER',
      newStage: 'payment_pending_validation',
      contextPatch: {
        commerceLastOrderId: transferOrderId,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
        transferPayment: {
          orderId: transferOrderId,
          status: 'payment_reported',
          paymentMethod: 'bank_transfer',
          source: transferContext && transferContext.source ? transferContext.source : 'whatsapp_payment',
          selectedPlan: reported.selectedPlan,
          destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
          requestedAt: transferContext && transferContext.requestedAt ? transferContext.requestedAt : new Date().toISOString(),
          reportedAt: reported.reportedAt,
          awaitingHumanValidation: true,
          proofSubmittedAt: reported.reportedAt,
          proofMessageId: inboundMessage && inboundMessage.id ? inboundMessage.id : null,
          proofMetadata,
          orderPaymentStatus: order && order.paymentStatus ? order.paymentStatus : 'pending',
          agendaFollowUp: reported.agendaFollowUp
        }
      }
    };
  }

  if (transferIntent === 'request' || transferIntent === 'proof_notice') {
    if (transferIntent === 'proof_notice') {
      const isAlreadyPendingValidation =
        transferContext &&
        (
          transferContext.status === 'payment_pending_validation' ||
          transferContext.status === 'payment_reported'
        );

      if (isAlreadyPendingValidation) {
        return {
          replyText: buildTransferPendingStatusReply(),
          newState: 'PAYMENT_TRANSFER',
          newStage: 'payment_pending_validation',
          contextPatch: {
            activeBotDomain: 'commerce',
            transferPayment: transferContext
          }
        };
      }

      return {
        replyText: buildTransferProofRequestReply(),
        newState: 'PAYMENT_TRANSFER',
        newStage: 'payment_requested',
        contextPatch: {
          activeBotDomain: 'commerce',
          commerceLastOrderId: transferOrderId,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
          transferPayment: {
            orderId: transferOrderId,
            status: transferContext && transferContext.status ? transferContext.status : 'payment_requested',
            paymentMethod: 'bank_transfer',
            source: transferContext && transferContext.source ? transferContext.source : 'whatsapp_payment',
            selectedPlan: transferContext && transferContext.selectedPlan ? transferContext.selectedPlan : null,
            destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
            requestedAt: transferContext && transferContext.requestedAt ? transferContext.requestedAt : new Date().toISOString()
          }
        }
      };
    }

    if (!transferOrderId) {
      const plans = getOrderedPlanProducts(buildCommerceEligibleProducts(await loadClinicProducts()));
      const selectedPlan =
        resolveExistingPaymentPlan(safeContext, plans) ||
        parsePaymentPlanSelection(inboundText, plans);

      if (selectedPlan) {
        return buildPaymentInstructionsDecision({
          selectedPlan,
          source: 'whatsapp_payment'
        });
      }

      if (isTransferInstructionsRequestIntent(inboundText)) {
        return buildPaymentInstructionsDecision({
          selectedPlan: null,
          source: 'whatsapp_payment'
        });
      }

      return buildPaymentPlanSelectionDecision({
        source: 'whatsapp_payment'
      });
    }

    if (!hasConfiguredTransferData(transferConfig)) {
      return {
        replyText: buildTransferMissingConfigReply(),
        newState: 'PAYMENT_TRANSFER',
        newStage: 'payment_requested',
        contextPatch: {
          commerceLastOrderId: transferOrderId,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
          transferPayment: {
            orderId: transferOrderId,
            status: 'payment_requested',
            paymentMethod: 'bank_transfer',
            destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
            requestedAt: new Date().toISOString()
          }
        }
      };
    }

    const order = await ensureOrderPendingForTransfer();
    if (transferIntent === 'proof_notice') {
      return {
        replyText: buildTransferProofRequestReply(),
        newState: 'PAYMENT_TRANSFER',
        newStage: 'payment_requested',
        contextPatch: {
          commerceLastOrderId: transferOrderId,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
          transferPayment: {
            orderId: transferOrderId,
            status: 'payment_requested',
            paymentMethod: 'bank_transfer',
            destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
            requestedAt: transferContext && transferContext.requestedAt ? transferContext.requestedAt : new Date().toISOString(),
            orderPaymentStatus: order && order.paymentStatus ? order.paymentStatus : 'pending'
          }
        }
      };
    }

    return {
      replyText: buildTransferInstructionsReply(transferConfig),
      newState: 'PAYMENT_TRANSFER',
      newStage: 'payment_requested',
      contextPatch: {
        commerceLastOrderId: transferOrderId,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
        transferPayment: {
          orderId: transferOrderId,
          status: 'payment_requested',
          paymentMethod: 'bank_transfer',
          destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
          requestedAt: new Date().toISOString(),
          orderPaymentStatus: order && order.paymentStatus ? order.paymentStatus : 'pending'
        }
      }
    };
  }

  if (currentState === 'PAYMENT_TRANSFER') {
    if (transferContext && (transferContext.status === 'payment_pending_validation' || transferContext.status === 'payment_reported')) {
      return {
        replyText: buildTransferPendingStatusReply(),
        newState: 'PAYMENT_TRANSFER',
        newStage: 'payment_pending_validation',
        contextPatch: {
          transferPayment: transferContext
        }
      };
    }

    return {
      replyText: buildTransferHelpReply(transferConfig),
      newState: 'PAYMENT_TRANSFER',
      newStage: 'payment_requested',
      contextPatch: {
        transferPayment: transferContext || {
          orderId: transferOrderId,
          status: 'payment_requested',
          paymentMethod: 'bank_transfer',
          destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
          requestedAt: new Date().toISOString()
        }
      }
    };
  }

  if (currentState === 'POST_CONFIRMATION') {
    const activationOption = parsePostConfirmationOption(inboundText);
    if (activationOption) {
      if (activationOption === '1') {
        return {
          replyText: buildOnboardingReply(1),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(1),
          contextPatch: buildCommerceResetPatch({
            commerceCartItems: null,
            commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
            commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
            commerceActivationOfferState: 'onboarding',
            commerceActivationChoice: activationOption,
            onboarding: {
              businessType: null,
              mainOffer: null,
              goal: null,
              channel: null
            }
          })
        };
      }

      if (activationOption === '2') {
        return {
          replyText: buildDemoExperienceReply(1),
          newState: 'DEMO',
          newStage: getDemoStageKey(1),
          contextPatch: buildCommerceResetPatch({
            commerceCartItems: null,
            commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
            commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
            commerceActivationOfferState: 'demo',
            commerceActivationChoice: activationOption,
            commerceDemoStep: 1
          })
        };
      }

      return {
        replyText: buildPostConfirmationOptionReply(activationOption),
        newState: 'IDLE',
        newStage: activationOption === '3' ? 'handoff' : 'activation_followup',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'completed',
          commerceActivationChoice: activationOption
        })
      };
    }

    if (isCommerceEntryIntent(inboundText)) {
      return buildCatalogEntryDecision();
    }

    return {
      replyText: buildPostConfirmationFallbackReply(),
      newState: 'POST_CONFIRMATION',
      newStage: 'activation_offer',
      contextPatch: buildCommerceResetPatch({
        commerceCartItems: null,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
        commerceActivationOfferState: 'pending',
        commerceActivationChoice: null
      })
    };
  }

  if (currentState === 'ONBOARDING') {
    const onboarding = getOnboardingData(safeContext);
    const currentStage = String(conversation.stage || '').trim().toLowerCase();
    const onboardingStep = currentStage === 'onboarding_step_2'
      ? 2
      : currentStage === 'onboarding_step_3'
        ? 3
        : currentStage === 'onboarding_step_4'
          ? 4
          : currentStage === 'onboarding_complete'
            ? 5
            : 1;

    if (onboardingStep === 1) {
      const answer = String(inboundText || '').trim();
      if (!answer) {
        return {
          replyText: buildOnboardingReply(1),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(1),
          contextPatch: {
            onboarding
          }
        };
      }

      return {
        replyText: buildOnboardingReply(2),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(2),
        contextPatch: {
          onboarding: {
            ...onboarding,
            businessType: answer
          },
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding',
          commerceActivationChoice: '1'
        }
      };
    }

    if (onboardingStep === 2) {
      const answer = String(inboundText || '').trim();
      if (!answer) {
        return {
          replyText: buildOnboardingReply(2),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(2),
          contextPatch: {
            onboarding
          }
        };
      }

      return {
        replyText: buildOnboardingReply(3),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(3),
        contextPatch: {
          onboarding: {
            ...onboarding,
            mainOffer: answer
          },
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding',
          commerceActivationChoice: '1'
        }
      };
    }

    if (onboardingStep === 3) {
      const answer = String(inboundText || '').trim();
      if (!answer) {
        return {
          replyText: buildOnboardingReply(3),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(3),
          contextPatch: {
            onboarding
          }
        };
      }

      return {
        replyText: buildOnboardingReply(4),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(4),
        contextPatch: {
          onboarding: {
            ...onboarding,
            goal: answer
          },
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding',
          commerceActivationChoice: '1'
        }
      };
    }

    if (onboardingStep === 4) {
      const answer = String(inboundText || '').trim();
      const nextOnboarding = {
        ...onboarding,
        channel: normalizeOnboardingChannel(answer) || answer
      };
      if (!answer) {
        return {
          replyText: buildOnboardingReply(4),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(4),
          contextPatch: {
            onboarding
          }
        };
      }

      return {
        replyText: isDemoCommercialOnboardingContext(safeContext)
          ? buildDemoCommercialCloseReply()
          : buildOnboardingReply(5),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(5),
        contextPatch: {
          onboarding: nextOnboarding,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding_completed',
          commerceActivationChoice: '1'
        }
      };
    }

    if (onboardingStep === 5) {
      const completeOption = parseOnboardingCompleteOption(inboundText);
      const editIntent = parseGeneratedBotEditIntent(inboundText);
      const existingPreview = safeContext.generatedBotPreview && typeof safeContext.generatedBotPreview === 'object'
        ? safeContext.generatedBotPreview
        : null;
      const demoCommercialContext = isDemoCommercialOnboardingContext(safeContext);

      if (isPublicDemoExperienceIntent(inboundText)) {
        return buildDemoEntryDecision();
      }

      if (demoCommercialContext) {
        const closeOption = parseDemoCommercialCloseOption(inboundText);
        if (closeOption === 'advisor') {
          const summary = await recordDemoCommercialLead({
            conversation,
            contact,
            onboarding,
            action: 'advisor',
            clinic
          });
          return {
            replyText: buildDemoAdvisorReply(summary),
            newState: 'IDLE',
            newStage: 'handoff',
            contextPatch: {
              demoCommercialOutcome: 'advisor_requested',
              demoLeadSummary: summary,
              commerceActivationOfferState: 'commercial_handoff',
              commerceActivationChoice: 'advisor'
            }
          };
        }

        if (closeOption === 'payment') {
          const summary = await recordDemoCommercialLead({
            conversation,
            contact,
            onboarding,
            action: 'payment'
          });
          const paymentDecision = await buildPaymentPlanSelectionDecision({ source: 'demo_whatsapp' });
          paymentDecision.contextPatch = mergeContextPatches(paymentDecision.contextPatch, {
            demoCommercialOutcome: 'payment_plan_selection',
            demoLeadSummary: summary,
            commerceActivationOfferState: 'payment_plan_selection',
            commerceActivationChoice: 'payment'
          });
          return paymentDecision;
        }

        return {
          replyText: buildDemoCommercialCloseReply(),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding
          }
        };
      }

      if (existingPreview && editIntent) {
        const preview = buildEditedBotPreview(existingPreview, onboarding, editIntent);
        const persistedRuntimeConfig = activeRuntimeConfig
          ? buildEditedActiveBotConfig(activeRuntimeConfig, onboarding, editIntent)
          : null;
        if (persistedRuntimeConfig) {
          await updateClinicBotRuntimeConfigById(conversation.clinicId, persistedRuntimeConfig);
        }
        return {
          replyText: persistedRuntimeConfig
            ? `${preview.text}\n\n---\n\nYa guardé este cambio en tu bot activo.`
            : preview.text,
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            generatedBotPreview: {
              type: preview.type,
              summary: preview.summary,
              generatedAt: preview.generatedAt,
              lastEditMode: preview.lastEditMode,
              previewText: preview.text
            },
            botRuntimeConfig: persistedRuntimeConfig || null,
            commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
            commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
            commerceActivationOfferState: 'onboarding_completed',
            commerceActivationChoice: '1'
          }
        };
      }

      if (completeOption === '1') {
        const preview = buildInitialBotFlowFromOnboarding(onboarding);
        return {
          replyText: preview.text,
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            generatedBotPreview: {
              type: preview.type,
              summary: preview.summary,
              generatedAt: preview.generatedAt,
              lastEditMode: preview.lastEditMode,
              previewText: preview.text
            },
            commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
            commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
            commerceActivationOfferState: 'onboarding_completed',
            commerceActivationChoice: '1'
          }
        };
      }

      if (existingPreview && isGeneratedBotActivationIntent(inboundText)) {
        const runtimeConfig = buildExecutableBotConfigFromPreview(onboarding, existingPreview);
        await updateClinicBotRuntimeConfigById(conversation.clinicId, runtimeConfig);
        return {
          replyText: [
            'Perfecto 🙌',
            '',
            'Ya dejé esta versión como base de tu bot.',
            '',
            'A partir de ahora, podemos seguir ajustándolo o usarlo como punto de partida para tu configuración real.'
          ].join('\n'),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            botRuntimeConfig: runtimeConfig,
            generatedBotPreview: {
              ...existingPreview
            }
          }
        };
      }

      if (completeOption === '2') {
        return {
          replyText: 'Perfecto. El siguiente paso es cargar tus productos o servicios para que el bot pueda recomendarlos mejor. Cuando quieras, seguimos por ahí.',
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding
          }
        };
      }

      if (isOnboardingProductsIntent(inboundText)) {
        return {
          replyText: 'Perfecto. El siguiente paso es cargar tus productos o servicios para que el bot pueda recomendarlos mejor. Cuando quieras, seguimos por ahi.',
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            generatedBotPreview: existingPreview
          }
        };
      }

      if (completeOption === '3') {
        return {
          replyText: 'Perfecto. El siguiente paso es conectar tu WhatsApp para que este flujo pueda empezar a atender conversaciones reales.',
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding
          }
        };
      }

      if (isOnboardingNextStepIntent(inboundText)) {
        return {
          replyText: buildOnboardingReply(5),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            generatedBotPreview: existingPreview
          }
        };
      }

      if (completeOption === 'adapt') {
        if (existingPreview) {
          const preview = buildEditedBotPreview(existingPreview, onboarding, 'business');
          return {
            replyText: preview.text,
            newState: 'ONBOARDING',
            newStage: getOnboardingStageKey(5),
            contextPatch: {
              onboarding,
              generatedBotPreview: {
                type: preview.type,
                summary: preview.summary,
                generatedAt: preview.generatedAt,
                lastEditMode: preview.lastEditMode,
                previewText: preview.text
              }
            }
          };
        }

        return {
          replyText: 'Perfecto. Primero te genero el bot base y después lo adaptamos más a tu negocio.',
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding
          }
        };
      }

      if (existingPreview) {
        return {
          replyText: buildGeneratedBotPreviewHelpReply(),
          newState: 'ONBOARDING',
          newStage: getOnboardingStageKey(5),
          contextPatch: {
            onboarding,
            generatedBotPreview: existingPreview
          }
        };
      }
    }

    return {
      replyText: isDemoCommercialOnboardingContext(safeContext)
        ? buildDemoCommercialCloseReply()
        : buildOnboardingReply(5),
      newState: 'ONBOARDING',
      newStage: getOnboardingStageKey(5),
      contextPatch: {
        onboarding,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
        commerceActivationOfferState: 'onboarding_completed',
        commerceActivationChoice: '1'
      }
    };
  }

  if (currentState === 'DEMO') {
    const demoStep = Number.isInteger(Number(safeContext.commerceDemoStep))
      ? Number(safeContext.commerceDemoStep)
      : 1;

    if (demoStep >= 5) {
      const closeOption = parseDemoCommercialCloseOption(inboundText);
      if (closeOption === 'advisor') {
        const summary = await recordDemoCommercialLead({
          conversation,
          contact,
          onboarding: getOnboardingData(safeContext),
          action: 'advisor',
          clinic
        });
        return {
          replyText: buildDemoAdvisorReply(summary),
          newState: 'IDLE',
          newStage: 'handoff',
          contextPatch: buildCommerceResetPatch({
            demoEntrySource: 'public_demo_whatsapp',
            demoCommercialOutcome: 'advisor_requested',
            demoLeadSummary: summary,
            commerceActivationOfferState: 'commercial_handoff',
            commerceActivationChoice: 'advisor'
          })
        };
      }

      if (closeOption === 'payment') {
        const summary = await recordDemoCommercialLead({
          conversation,
          contact,
          onboarding: getOnboardingData(safeContext),
          action: 'payment'
        });
        const paymentDecision = await buildPaymentPlanSelectionDecision({ source: 'demo_whatsapp' });
        paymentDecision.contextPatch = mergeContextPatches(paymentDecision.contextPatch, {
          demoEntrySource: 'public_demo_whatsapp',
          demoCommercialOutcome: 'payment_plan_selection',
          demoLeadSummary: summary,
          commerceActivationOfferState: 'payment_plan_selection',
          commerceActivationChoice: 'payment'
        });
        return paymentDecision;
      }
    }

    if (isDemoHumanIntent(inboundText)) {
      return null;
    }

    if (isDemoActivateIntent(inboundText) && demoStep < 5) {
      return {
        replyText: buildOnboardingReply(1),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(1),
        contextPatch: buildCommerceResetPatch({
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding',
          commerceActivationChoice: '1',
          demoEntrySource: 'public_demo_whatsapp',
          onboarding: {
            businessType: null,
            mainOffer: null,
            goal: null,
            channel: null
          }
        })
      };
    }

    if (isDemoBackIntent(inboundText)) {
      return {
        replyText: buildPostConfirmationFallbackReply(),
        newState: 'POST_CONFIRMATION',
        newStage: 'activation_offer',
        contextPatch: buildCommerceResetPatch({
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'pending',
          commerceActivationChoice: null
        })
      };
    }

    if (isRelistPlansCommand(inboundText) || isCommerceEntryIntent(inboundText)) {
      const catalogDecision = await buildCatalogEntryDecision();
      return {
        ...catalogDecision,
        newStage: 'offering'
      };
    }

    if (demoStep >= 5) {
      return {
        replyText: buildDemoExperienceReply(5),
        newState: 'DEMO',
        newStage: getDemoStageKey(5),
        contextPatch: buildCommerceResetPatch({
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'demo',
          commerceActivationChoice: '2',
          commerceDemoStep: 5
        })
      };
    }

    if (isDemoAdvanceIntent(inboundText)) {
      const nextDemoStep = Math.min(demoStep + 1, 5);
      return {
        replyText: buildDemoExperienceReply(nextDemoStep),
        newState: 'DEMO',
        newStage: getDemoStageKey(nextDemoStep),
        contextPatch: buildCommerceResetPatch({
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'demo',
          commerceActivationChoice: '2',
          commerceDemoStep: nextDemoStep
        })
      };
    }

    return {
      replyText: buildDemoExperienceReply(demoStep),
      newState: 'DEMO',
      newStage: getDemoStageKey(demoStep),
      contextPatch: buildCommerceResetPatch({
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
        commerceActivationOfferState: 'demo',
        commerceActivationChoice: '2',
        commerceDemoStep: demoStep
      })
    };
  }

  if (
    isCommerceHelpIntent(inboundText) &&
    (
      currentState === 'WAITING_PRODUCT_SELECTION' ||
      currentState === 'WAITING_QUANTITY' ||
      categoriesFromContext.length > 0 ||
      catalogFromContext.length > 0 ||
      cartItems.length > 0 ||
      Boolean(safeContext && safeContext.commerceLastOrderId)
    )
  ) {
    return {
      replyText: buildCommerceHelpReply({ currentState, cartItems }),
      newState: currentState === 'WAITING_QUANTITY'
        ? 'WAITING_QUANTITY'
        : (catalogFromContext.length || categoriesFromContext.length || cartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE'),
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
        commerceCategorySelection: categorySelectionActive,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceSelectedProduct: currentState === 'WAITING_QUANTITY' ? safeContext.commerceSelectedProduct || null : null,
        commerceLastAddedItem: lastAddedItem,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
      }
    };
  }

  if (isCommerceViewCartIntent(inboundText)) {
    return {
      replyText: buildCommerceCartSummaryReply(cartItems),
      newState: catalogFromContext.length || categoriesFromContext.length || cartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
        commerceCategorySelection: categorySelectionActive,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: lastAddedItem
      }
    };
  }

  if (isCommerceClearCartIntent(inboundText)) {
    return {
      replyText: cartItems.length ? buildCommerceCartClearedReply() : buildCommerceAlreadyEmptyCartReply(),
      newState: catalogFromContext.length || categoriesFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
        commerceCategorySelection: categorySelectionActive,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal,
        commerceCartItems: null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  const removeCartItemIndex = parseCommerceRemoveCartItemIntent(inboundText);
  if (removeCartItemIndex) {
    if (!cartItems.length) {
      return {
        replyText: buildCommerceEmptyCartReply(),
        newState: catalogFromContext.length || categoriesFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
          commerceCategorySelection: categorySelectionActive,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal,
          commerceCartItems: null,
          commerceSelectedProduct: null,
          commerceLastAddedItem: null
        }
      };
    }

    if (removeCartItemIndex > cartItems.length) {
      return {
        replyText: `No encontré ese ítem en tu carrito 🤔 Te muestro cómo quedó hasta ahora:\n\n${buildCommerceCartSummaryReply(cartItems)}`,
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
          commerceCategorySelection: categorySelectionActive,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal,
          commerceCartItems: cartItems,
          commerceSelectedProduct: null,
          commerceLastAddedItem: lastAddedItem
        }
      };
    }

    const removedItem = cartItems[removeCartItemIndex - 1] || null;
    const updatedCartItems = removeCommerceCartItemByIndex(cartItems, removeCartItemIndex);

    logInfo('commerce_cart_item_removed_by_index', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      removedIndex: removeCartItemIndex,
      productId: removedItem && removedItem.productId ? removedItem.productId : null,
      cartItemCount: updatedCartItems.length
    });

    return {
      replyText: buildCommerceRemovedCartItemReply(updatedCartItems, removedItem),
      newState: catalogFromContext.length || categoriesFromContext.length || updatedCartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
        commerceCategorySelection: categorySelectionActive,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal,
        commerceCartItems: updatedCartItems.length ? updatedCartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  if (isCommerceUndoIntent(inboundText)) {
    if (!cartItems.length || !lastAddedItem || !lastAddedItem.productId || !Number.isInteger(lastAddedItem.quantity) || lastAddedItem.quantity <= 0) {
      return {
        replyText: 'Todavía no sumaste productos al carrito. Si querés, escribí "productos" y te muestro el catálogo.',
        newState: catalogFromContext.length || categoriesFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
          commerceCategorySelection: categorySelectionActive,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal,
          commerceCartItems: cartItems,
          commerceSelectedProduct: null,
          commerceLastAddedItem: null
        }
      };
    }

    const updatedCartItems = removeLastAddedCommerceCartItem(cartItems, lastAddedItem);
    logInfo('commerce_cart_item_removed', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: lastAddedItem.productId,
      removedQuantity: lastAddedItem.quantity,
      cartItemCount: updatedCartItems.length
    });
    traceCommerceFlow('cart_undo', {
      productId: lastAddedItem.productId,
      removedQuantity: lastAddedItem.quantity,
      cartItemCount: updatedCartItems.length
    });

    return {
      replyText: buildCommerceUndoReply(updatedCartItems),
      newState: 'WAITING_PRODUCT_SELECTION',
      contextPatch: {
        commerceCatalog: catalogFromContext.length
          ? catalogFromContext
          : buildCommerceCatalogPage(await loadClinicProducts()).items,
        commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
        commerceCategorySelection: categorySelectionActive,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal,
        commerceCartItems: updatedCartItems.length ? updatedCartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  if (isCommerceConfirmIntent(inboundText)) {
    const lastOrderId = String(safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : '').trim();
    const lastOrderAt = safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null;
    let confirmCartItems = cartItems;
    if (!confirmCartItems.length) {
      const suggestedProductId = String(safeContext && safeContext.commerceSuggestedProductId ? safeContext.commerceSuggestedProductId : '').trim();
      if (suggestedProductId) {
        const suggestedProduct = await findProductById(suggestedProductId, conversation.clinicId);
        if (suggestedProduct && String(suggestedProduct.status || '').toLowerCase() === 'active' && isPlanProduct(suggestedProduct)) {
          confirmCartItems = [
            {
              productId: suggestedProduct.id,
              name: suggestedProduct.name,
              price: Number(suggestedProduct.price || 0),
              currency: String(suggestedProduct.currency || 'ARS').toUpperCase(),
              quantity: 1,
              sku: suggestedProduct.sku || null
            }
          ];
        }
      }
    }

    if (!confirmCartItems.length && lastOrderId && isRecentCommerceOrder(lastOrderAt)) {
      return {
        replyText: buildCommerceAlreadyConfirmedReply(lastOrderId),
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: lastOrderId,
          commerceLastOrderAt: lastOrderAt
        })
      };
    }

    if (!confirmCartItems.length) {
      return {
        replyText: 'Tu carrito está vacío por ahora. Si querés, escribí "productos" y te muestro el catálogo para seguir.',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null
        })
      };
    }

    logInfo('commerce_order_create_attempt', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      contactId: contact.id || null,
      itemCount: confirmCartItems.length,
      cartItems: confirmCartItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    });

    const orderPayload = {
      source: 'bot',
      contactId: contact.id || null,
      conversationId: conversation.id,
      customerName: contact.name || `Cliente ${String(contact.waId || contact.phone || '').slice(-4) || 'WhatsApp'}`,
      customerPhone: contact.phone || contact.waId || null,
      notes: 'Pedido creado desde WhatsApp commerce',
      items: confirmCartItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    };

    const orderResult = await createOrderForClinic(conversation.clinicId, {
      ...orderPayload
    });

    if (!orderResult.ok) {
      logError('commerce_order_create_failed', {
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        contactId: contact.id || null,
        source: orderPayload.source,
        itemCount: confirmCartItems.length,
        items: orderPayload.items,
        reason: orderResult.reason || null,
        details: orderResult.details || null
      });
      if (
        orderResult.reason === 'order_item_insufficient_stock' ||
        orderResult.reason === 'order_item_product_not_found' ||
        orderResult.reason === 'order_item_product_inactive'
      ) {
        const products = buildCommerceCatalogPage(await loadClinicProducts());
        logInfo('commerce_order_create_failed_stock', {
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          itemCount: confirmCartItems.length,
          reason: orderResult.reason,
          details: orderResult.details || null
        });
        return {
          replyText:
            'No pude confirmar tu pedido porque uno o más productos ya no tienen stock suficiente.\n\nSi querés, escribí "productos" y te muestro el catálogo actualizado.',
          newState: 'WAITING_PRODUCT_SELECTION',
          contextPatch: buildCommerceResetPatch({
            commerceCatalog: products.items,
            commerceCatalogOffset: products.offset,
            commerceCatalogNextOffset: products.nextOffset,
            commerceCatalogTotal: products.total,
            commerceCartItems: confirmCartItems
          })
        };
      }

      return {
        replyText: 'No pude registrar tu pedido en este momento. Si querés, probá de nuevo en unos minutos y seguimos desde acá.',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: confirmCartItems
        })
      };
    }

    const order = orderResult.order;
    logInfo('commerce_order_create_success', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      orderId: order.id || null,
      itemCount: confirmCartItems.length,
      total: Number(order.total || 0),
      currency: order.currency || (confirmCartItems[0] && confirmCartItems[0].currency) || 'ARS'
    });
    traceCommerceFlow('cart_confirm', {
      orderId: order.id || null,
      itemCount: confirmCartItems.length,
      total: Number(order.total || 0)
    });

    return {
      replyText: buildCommerceOrderConfirmation(order, confirmCartItems),
      newState: 'POST_CONFIRMATION',
      newStage: 'activation_offer',
      contextPatch: buildCommerceResetPatch({
        commerceCartItems: null,
        commerceLastOrderId: order.id || null,
        commerceLastOrderAt: new Date().toISOString(),
        commerceActivationOfferState: 'pending',
        commerceActivationChoice: null
      })
    };
  }

  if (isCommerceEntryIntent(inboundText)) {
    return buildCatalogEntryDecision();
  }

  if (
    isRelistPlansCommand(inboundText) &&
    (
      currentState === 'WAITING_PRODUCT_SELECTION' ||
      currentState === 'WAITING_QUANTITY' ||
      catalogFromContext.length > 0 ||
      cartItems.length > 0
    )
  ) {
    return buildCatalogEntryDecision();
  }

  if (currentState === 'WAITING_PRODUCT_SELECTION' && !categorySelectionActive) {
    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalogPage(await loadClinicProducts(), { categoryId: activeCategoryId }).items;
    const multiSelection = isPlanCatalog(products) ? [] : parseCommerceMultiSelection(inboundText, products.length);
    if (multiSelection.length > 1) {
      return resolveCommerceMultiCartAddition({
        conversation,
        catalogFromContext: products,
        cartItems,
        selections: multiSelection
      });
    }
  }

  const clinicProducts = await loadClinicProducts();
  const availablePlanProducts = getOrderedPlanProducts(buildCommerceEligibleProducts(clinicProducts));
  const planSalesActive = isPlanCatalog(availablePlanProducts);

  if (isCatalogItemDetailIntent(inboundText)) {
    const eligibleProducts = buildCommerceEligibleProducts(clinicProducts);
    const matchedItem = findReferencedPlan(eligibleProducts, inboundText) || findProductByName(eligibleProducts, inboundText);

    if (matchedItem) {
      const page = buildCommerceCatalogPage(clinicProducts);
      const preferredComparedItemId = safeContext &&
        safeContext.commercialPlanContext &&
        typeof safeContext.commercialPlanContext === 'object' &&
        safeContext.commercialPlanContext.lastComparedPlanId
        ? safeContext.commercialPlanContext.lastComparedPlanId
        : null;
      const comparedItem = chooseLogicalComparisonItem(eligibleProducts, matchedItem, preferredComparedItemId);

      return {
        replyText: buildCatalogItemDetailReply(matchedItem, comparedItem),
        outboundMedia: [buildCatalogProductImageMessage(matchedItem)].filter(Boolean),
        sendTextWithMedia: false,
        newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: page.items,
          commerceCatalogOffset: page.offset,
          commerceCatalogNextOffset: page.nextOffset,
          commerceCatalogTotal: page.total,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceSuggestedProductId: matchedItem && (matchedItem.id || matchedItem.productId)
            ? String(matchedItem.id || matchedItem.productId)
            : null,
          commerceSuggestedProductName: matchedItem && matchedItem.name ? String(matchedItem.name) : null,
          ...buildCatalogItemDetailContextPatch(matchedItem, comparedItem, eligibleProducts)
        })
      };
    }
  }

  const shortMemoryDecision = await buildCommercialShortMemoryReply({
    clinic,
    conversation,
    inboundText
  });
  if (shortMemoryDecision) {
    return shortMemoryDecision;
  }

  if (planSalesActive) {
    const directlyReferencedPlan = findReferencedPlan(availablePlanProducts, inboundText);
    const contextualPlan = isContextualPlanReferenceIntent(inboundText)
      ? findPlanByContext(availablePlanProducts, safeContext)
      : null;
    const referencedPlan = directlyReferencedPlan || contextualPlan;
    const needHint = resolvePlanNeedHint(inboundText);

    if (isPlanComparisonIntent(inboundText)) {
      const suggestedPlan = findPlanByNeedHint(availablePlanProducts, 'growth');
      return buildPlanSalesDecision(buildPlanComparisonReply(availablePlanProducts), suggestedPlan);
    }

    if (referencedPlan && (directlyReferencedPlan || contextualPlan || isPlanDirectDetailIntent(inboundText) || isPlanPricingIntent(inboundText))) {
      return buildPlanSalesDecision(
        buildPlanDetailReply(referencedPlan, {
          includePrice: true,
          includeFeatures: true
        }),
        referencedPlan
      );
    }

    if (needHint) {
      const suggestedPlan = findPlanByNeedHint(availablePlanProducts, needHint);
      if (suggestedPlan) {
        return buildPlanSalesDecision(buildPlanRecommendationReply(suggestedPlan, null, availablePlanProducts), suggestedPlan);
      }
    }

    if (isPlanRecommendationIntent(inboundText)) {
      const suggestedPlan = referencedPlan || findPlanByNeedHint(availablePlanProducts, 'growth');
      if (suggestedPlan) {
        return buildPlanSalesDecision(buildPlanRecommendationReply(suggestedPlan, null, availablePlanProducts), suggestedPlan);
      }
    }

    if (isPlanPricingIntent(inboundText)) {
      return buildPlanSalesDecision(buildPlanComparisonReply(availablePlanProducts));
    }
  }

  const naturalOrder = parseCommerceNaturalOrder(inboundText);
  if (naturalOrder) {
    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalogPage(await loadClinicProducts(), { categoryId: activeCategoryId }).items;
    const matchedProduct = findProductByName(products, naturalOrder.productName);
    if (!matchedProduct) {
      return {
        replyText: "No encontré ese producto exacto 🤔 Si querés, te muestro el catálogo o te ayudo a buscar algo parecido.",
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products.length ? products : null,
          commerceCategories: categoriesFromContext.length ? categoriesFromContext : null,
          commerceCategorySelection: categorySelectionActive,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal,
          commerceCartItems: cartItems,
          commerceLastAddedItem: lastAddedItem
        })
      };
    }

    return resolveCommerceCartAddition({
      conversation,
      catalogFromContext: products,
      cartItems,
      quantity: naturalOrder.quantity,
      productId: matchedProduct.productId || matchedProduct.id
    });
  }

  if (currentState === 'WAITING_PRODUCT_SELECTION') {
    if (categorySelectionActive) {
      const categories = categoriesFromContext.length ? categoriesFromContext : buildCommerceCategories(await loadClinicProducts());
      const selectedCategory = parseCommerceCategorySelection(inboundText, categories);
      if (!selectedCategory) {
        return {
          replyText: categories.length
            ? 'Creo que no entendí esa categoría 😅 Podés escribirme el número o el nombre de la categoría que querés ver.'
            : 'Ahora mismo no veo categorías disponibles para mostrarte. Si querés, probá con "productos" de nuevo.',
          newState: categories.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
          contextPatch: buildCommerceResetPatch({
            commerceCategories: categories.length ? categories : null,
            commerceCategorySelection: categories.length > 0,
            commerceCartItems: cartItems.length ? cartItems : null,
            commerceLastAddedItem: lastAddedItem
          })
        };
      }

      const page = buildCommerceCatalogPage(await loadClinicProducts(), { categoryId: selectedCategory.categoryId });
      traceCommerceFlow('catalog_by_category', {
        categoryId: selectedCategory.categoryId,
        categoryName: selectedCategory.name,
        shownCount: page.items.length,
        total: page.total,
        hasMore: page.hasMore
      });
      return {
        replyText: buildCommerceCatalogReply(page),
        newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: page.items,
          commerceCatalogOffset: page.offset,
          commerceCatalogNextOffset: page.nextOffset,
          commerceCatalogTotal: page.total,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceActiveCategoryId: selectedCategory.categoryId,
          commerceActiveCategoryName: selectedCategory.name
        })
      };
    }

    if (activeCategoryId && isCommerceBackToCategoriesIntent(inboundText)) {
      const categories = categoriesFromContext.length ? categoriesFromContext : buildCommerceCategories(await loadClinicProducts());
      if (!categories.length) {
        return buildCatalogEntryDecision();
      }

      traceCommerceFlow('catalog_categories', {
        categoryCount: categories.length,
        fromCategoryId: activeCategoryId,
        fromCategoryName: activeCategoryName
      });
      return {
        replyText: buildCommerceCategoriesReply(categories),
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCategories: categories,
          commerceCategorySelection: true,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
        })
      };
    }

    if (isCommerceMoreIntent(inboundText)) {
      if (!catalogNextOffset || catalogNextOffset >= catalogTotal) {
        return {
          replyText: 'Ya te mostré todo lo disponible por ahora 👌\n\nSi querés, escribí "productos" para volver al catálogo completo o elegí uno por número.',
          newState: 'WAITING_PRODUCT_SELECTION',
          contextPatch: {
            commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
            commerceCartItems: cartItems.length ? cartItems : null,
            commerceLastAddedItem: lastAddedItem,
            commerceActiveCategoryId: activeCategoryId,
            commerceActiveCategoryName: activeCategoryName,
            commerceCatalogNextOffset: catalogNextOffset,
            commerceCatalogTotal: catalogTotal
          }
        };
      }

      const page = buildCommerceCatalogPage(await loadClinicProducts(), {
        offset: catalogNextOffset,
        categoryId: activeCategoryId
      });
      traceCommerceFlow('more_products', {
        categoryId: activeCategoryId,
        categoryName: activeCategoryName,
        offset: catalogNextOffset,
        shownCount: page.items.length,
        total: page.total,
        hasMore: page.hasMore
      });
      return {
        replyText: buildCommerceCatalogReply(page),
        newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: page.items,
          commerceCatalogOffset: page.offset,
          commerceCatalogNextOffset: page.nextOffset,
          commerceCatalogTotal: page.total,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName
        })
      };
    }

    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalogPage(await loadClinicProducts(), { categoryId: activeCategoryId }).items;
    const selection = parseCommerceSelection(inboundText, products.length);
    if (!selection) {
      return {
        replyText: products.length
          ? 'Creo que no entendí cuál producto querés 😅 Podés elegir un número de la lista o escribir "ayuda" y te guío.'
          : 'Ahora mismo no veo productos disponibles para mostrarte. Si querés, escribí "productos" e intentamos de nuevo.',
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products.length ? products : null,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal
        })
      };
    }

    const selectedProduct = products[selection - 1] || null;
    if (!selectedProduct) {
      return {
        replyText: 'Creo que no entendí cuál producto querés 😅 Podés elegir un número de la lista o escribir "ayuda" y te guío.',
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal
        })
      };
    }

    if (isPlanProduct(selectedProduct)) {
      return resolveCommerceCartAddition({
        conversation,
        catalogFromContext: products,
        cartItems,
        quantity: 1,
        productId: selectedProduct.productId || selectedProduct.id
      });
    }

    return {
      replyText: `Elegiste: ${selectedProduct.name}\n\n¿Cuántas unidades querés?`,
      outboundMedia: [buildCatalogProductImageMessage(selectedProduct)].filter(Boolean),
      newState: 'WAITING_QUANTITY',
      contextPatch: {
        commerceCatalog: products,
        commerceCartItems: cartItems,
        commerceSelectedProduct: selectedProduct,
        commerceLastAddedItem: lastAddedItem,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal
      }
    };
  }

  if (currentState === 'WAITING_QUANTITY') {
    const selectedProduct = safeContext.commerceSelectedProduct || null;
    if (activeCategoryId && isCommerceBackToCategoriesIntent(inboundText)) {
      const categories = categoriesFromContext.length ? categoriesFromContext : buildCommerceCategories(await loadClinicProducts());
      if (!categories.length) {
        return buildCatalogEntryDecision();
      }

      traceCommerceFlow('catalog_categories', {
        categoryCount: categories.length,
        fromCategoryId: activeCategoryId,
        fromCategoryName: activeCategoryName,
        previousState: currentState
      });
      return {
        replyText: buildCommerceCategoriesReply(categories),
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCategories: categories,
          commerceCategorySelection: true,
          commerceCartItems: cartItems.length ? cartItems : null,
          commerceLastAddedItem: lastAddedItem,
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
        })
      };
    }

    if (!selectedProduct || !selectedProduct.productId) {
      const page = buildCommerceCatalogPage(await loadClinicProducts(), { categoryId: activeCategoryId });
      return {
        replyText: buildCommerceCatalogReply(page),
        newState: page.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: page.items,
          commerceCatalogOffset: page.offset,
          commerceCatalogNextOffset: page.nextOffset,
          commerceCatalogTotal: page.total,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName
        })
      };
    }

    const quantity = parseCommerceQuantity(inboundText);
    if (!quantity) {
      return {
        replyText: 'Creo que no entendí la cantidad 😅 Decime cuántas unidades querés y seguimos.',
        newState: 'WAITING_QUANTITY',
        contextPatch: {
          commerceCatalog: catalogFromContext,
          commerceCartItems: cartItems,
          commerceSelectedProduct: selectedProduct,
          commerceLastAddedItem: lastAddedItem,
          commerceActiveCategoryId: activeCategoryId,
          commerceActiveCategoryName: activeCategoryName,
          commerceCatalogNextOffset: catalogNextOffset,
          commerceCatalogTotal: catalogTotal
        }
      };
    }

    return resolveCommerceCartAddition({
      conversation,
      catalogFromContext,
      cartItems,
      quantity,
      productId: selectedProduct.productId,
      onStockFailureState: 'WAITING_QUANTITY',
      onStockFailureContextPatch: {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceLastAddedItem: lastAddedItem,
        commerceSelectedProduct: selectedProduct,
        commerceActiveCategoryId: activeCategoryId,
        commerceActiveCategoryName: activeCategoryName,
        commerceCatalogNextOffset: catalogNextOffset,
        commerceCatalogTotal: catalogTotal
      }
    });
  }

  return null;
}

function formatMoney(value, currency = 'ARS') {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: String(currency || 'ARS').toUpperCase(),
    maximumFractionDigits: 0
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function extractSelection(rawText) {
  const text = normalizeText(rawText);
  const match = text.match(/^([1-5])$/);
  if (!match) return null;
  return Number(match[1]);
}

function parseTimeWindowInput(rawText) {
  const text = normalizeCommandText(rawText);
  if (/(manana|temprano)/.test(text)) return 'morning';
  if (/\btarde\b/.test(text)) return 'afternoon';
  if (/\bnoche\b/.test(text)) return 'evening';
  return null;
}

function isAffirmativeSimple(rawText) {
  const text = normalizeCommandText(rawText);
  return ['si', 's', 'confirmo', 'ok', 'dale'].includes(text);
}

function isGlobalMenuCommand(rawText) {
  const text = normalizeCommandText(rawText);
  return ['cancelar', 'salir', 'menu', 'volver', 'atras'].includes(text);
}

function isSuggestionExpired(createdAtIso, ttlMinutes = 30) {
  const raw = String(createdAtIso || '').trim();
  if (!raw) return true;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return true;
  return Date.now() - dt.getTime() > ttlMinutes * 60 * 1000;
}

function formatDateIsoShort(dateISO) {
  const match = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateISO || '');
  return `${match[3]}/${match[2]}`;
}

function resolveBotTimezone(timezone) {
  return timezone && DateTime.now().setZone(String(timezone)).isValid ? String(timezone) : 'America/Argentina/Buenos_Aires';
}

function formatAppointmentDateForHuman(value, timezone) {
  const safeTimezone = resolveBotTimezone(timezone);
  if (!value) return '';

  let local = null;
  const safeValue = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(safeValue)) {
    local = DateTime.fromISO(safeValue, { zone: safeTimezone });
  } else {
    local = DateTime.fromISO(safeValue, { zone: 'utc' }).setZone(safeTimezone);
  }

  return local.isValid ? local.setLocale('es').toFormat('cccc dd/LL') : safeValue;
}

function formatAppointmentTimeForHuman(utcIso, timezone) {
  const safeTimezone = resolveBotTimezone(timezone);
  const local = DateTime.fromISO(String(utcIso), { zone: 'utc' }).setZone(safeTimezone);
  return local.isValid ? local.setLocale('es').toFormat('HH:mm') : String(utcIso || '');
}

function formatSlotForHuman(utcIso, timezone) {
  const safeTimezone = resolveBotTimezone(timezone);
  const local = DateTime.fromISO(String(utcIso), { zone: 'utc' }).setZone(safeTimezone);
  return local.isValid ? local.setLocale('es').toFormat('cccc dd/LL') + ' a las ' + local.setLocale('es').toFormat('HH:mm') : String(utcIso || '');
}

function buildAppointmentReminderText({ startAt, timezone, nowUtc = DateTime.utc() }) {
  const safeTimezone = resolveBotTimezone(timezone);
  const local = DateTime.fromISO(String(startAt || ''), { zone: 'utc' }).setZone(safeTimezone);
  if (!local.isValid) {
    return 'Te recordamos tu turno. Si necesitás reprogramarlo, escribinos por acá.';
  }

  const nowLocal = nowUtc.setZone(safeTimezone);
  const dayLabel = local.hasSame(nowLocal, 'day') ? 'de hoy' : `del ${local.setLocale('es').toFormat('cccc dd/LL')}`;
  return `Te recordamos tu turno ${dayLabel} a las ${local.setLocale('es').toFormat('HH:mm')}. Si necesitás reprogramarlo, escribinos por acá.`;
}

function formatAppointmentOptionLabel(slot, timezone, referenceDateISO = null) {
  if (!slot) return '';
  if (slot.startAt) {
    const slotDate = DateTime.fromISO(String(slot.startAt), { zone: 'utc' }).setZone(resolveBotTimezone(timezone)).toISODate();
    if (referenceDateISO && slotDate === referenceDateISO) {
      return formatAppointmentTimeForHuman(slot.startAt, timezone);
    }
    return formatSlotForHuman(slot.startAt, timezone);
  }
  const fallback = String((slot.displayText || slot.label || '')).trim();
  return fallback;
}

function buildSuggestionReply({ dateISO, timeWindow, suggestions, timezone }) {
  const windowLabel = timeWindow === 'morning' ? 'a la mañana' : timeWindow === 'afternoon' ? 'a la tarde' : timeWindow === 'evening' ? 'a la noche' : null;
  const dateLabel = dateISO ? formatAppointmentDateForHuman(dateISO, timezone) : 'ese día';
  const intro = windowLabel
    ? `Tengo estos horarios disponibles para ${dateLabel} ${windowLabel}:`
    : `Tengo estos horarios disponibles para ${dateLabel}:`;
  const lines = [
    intro,
    ...suggestions.map((slot, idx) => `${idx + 1}) ${formatAppointmentOptionLabel(slot, timezone, dateISO || null)}`),
    'Elegí una opción respondiendo con 1, 2 o 3.'
  ];
  return lines.join('\n');
}

function isReplaySafeConfirmation(context, startAt) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const status = String(safeContext.appointmentStatus || '').toLowerCase();
  const lastStartAt = String(safeContext.appointmentLastConfirmedStartAt || '').trim();
  const targetStartAt = String(startAt || '').trim();
  return status === 'confirmed' && !!lastStartAt && !!targetStartAt && lastStartAt === targetStartAt;
}

function buildConfirmedContextPatch(startAt) {
  return {
    activeBotDomain: null,
    appointmentStatus: 'confirmed',
    appointmentConfirmedAt: new Date().toISOString(),
    appointmentLastConfirmedStartAt: startAt || null,
    appointmentFlowPhase: null,
    appointmentSelectedSlot: null,
    appointmentBookingName: null,
    appointmentBookingNote: null,
    appointmentSuggestions: null,
    appointmentSuggestionsForDate: null,
    appointmentSuggestionsTimeWindow: null,
    appointmentSuggestionsCreatedAt: null
  };
}

function buildEmptyAppointmentSuggestionPatch() {
  return {
    activeBotDomain: null,
    appointmentFlowPhase: null,
    appointmentSelectedSlot: null,
    appointmentBookingName: null,
    appointmentBookingNote: null,
    appointmentSuggestions: null,
    appointmentSuggestionsForDate: null,
    appointmentSuggestionsTimeWindow: null,
    appointmentSuggestionsCreatedAt: null
  };
}

function buildAppointmentSuggestionContextPatch({ appointmentCandidate, suggestions, dateISO, timeWindow }) {
  const basePatch = {
    activeBotDomain: 'agenda',
    appointmentFlowPhase: 'waiting_slot_selection',
    appointmentSelectedSlot: null,
    appointmentBookingName: null,
    appointmentBookingNote: null,
    appointmentSuggestions: suggestions,
    appointmentSuggestionsForDate: dateISO || null,
    appointmentSuggestionsTimeWindow: timeWindow || null,
    appointmentSuggestionsCreatedAt: new Date().toISOString()
  };

  if (appointmentCandidate !== undefined) {
    basePatch.appointmentCandidate = appointmentCandidate;
  }

  return basePatch;
}

function buildAppointmentSelectedSlotPatch({ suggestion, bookingName = null, bookingNote = null, phase = 'waiting_contact_note' }) {
  return {
    activeBotDomain: 'agenda',
    appointmentFlowPhase: phase,
    appointmentSelectedSlot: suggestion
      ? {
          source: suggestion.source || 'agenda',
          startAt: suggestion.startAt || null,
          endAt: suggestion.endAt || null,
          dateISO: suggestion.dateISO || null,
          displayText: suggestion.displayText || suggestion.label || null
        }
      : null,
    appointmentBookingName: bookingName || null,
    appointmentBookingNote: bookingNote || null
  };
}

function hasUsableContactName(contact, safeContext) {
  const candidates = [
    safeContext && safeContext.appointmentBookingName,
    safeContext && safeContext.name,
    contact && contact.name
  ];
  return candidates.some((value) => String(value || '').trim().length >= 2);
}

function normalizeOptionalAppointmentNote(rawText) {
  const safeText = String(rawText || '').trim();
  const normalized = normalizeCommandText(safeText);
  if (!safeText) return null;
  if (['no', 'nop', 'ninguno', 'ninguna', 'sin motivo', 'sin nota', 'omitir'].includes(normalized)) {
    return null;
  }
  return safeText;
}

function buildAppointmentReservationDescription({ contact, bookingName, bookingNote, suggestion }) {
  const lines = [];
  const safeName = String(bookingName || (contact && contact.name) || '').trim();
  const safePhone = String((contact && (contact.phone || contact.waId)) || '').trim();
  const safeNote = String(bookingNote || '').trim();
  const safeSlot = suggestion && suggestion.startAt
    ? formatSlotForHuman(suggestion.startAt, 'America/Argentina/Buenos_Aires')
    : String((suggestion && (suggestion.displayText || suggestion.label)) || '').trim();

  if (safeName) lines.push(`Nombre: ${safeName}`);
  if (safePhone) lines.push(`Telefono: ${safePhone}`);
  if (safeNote) lines.push(`Motivo: ${safeNote}`);
  if (safeSlot) lines.push(`Horario: ${safeSlot}`);
  lines.push('Origen: WhatsApp');

  return lines.join('\n');
}

function buildAppointmentFinalConfirmation({ timezone, suggestion, bookingName, bookingNote }) {
  const startAt = suggestion && suggestion.startAt ? suggestion.startAt : null;
  const safeName = String(bookingName || '').trim();
  const safeNote = String(bookingNote || '').trim();
  const formattedTime = startAt ? formatSlotForHuman(startAt, timezone) : String((suggestion && suggestion.displayText) || '').trim();
  const lines = [`Listo, tu turno quedó reservado para ${formattedTime}.`];

  if (safeName) {
    lines.push(`Nombre: ${safeName}.`);
  }
  if (safeNote) {
    lines.push(`Motivo: ${safeNote}.`);
  }

  return lines.join('\n');
}

function buildAutomationDisabledReply(key) {
  if (key === 'agenda_booking') {
    return 'Puedo tomar tu pedido de turno, pero la reserva automatica no esta habilitada en este momento. Si queres, te ayudamos por este mismo canal.';
  }

  return 'Esa automatizacion no esta habilitada para esta cuenta en este momento.';
}

function logAutomationRuntimeBlocked({ tenantId = null, clinicId = null, key, action, reason = 'automation_disabled', extra = null }) {
  logInfo('automation_runtime_blocked', {
    tenantId: tenantId || null,
    clinicId: clinicId || null,
    key: String(key || '').trim() || null,
    action: String(action || '').trim() || null,
    reason,
    ...(extra || {})
  });
}

function isCancellation(rawText) {
  const text = normalizeText(rawText);
  return /(cancelar|cancelo|cancelaci[oó]n|anular turno)/i.test(text);
}

function detectTurnManagementIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    /(^|\s)(reprogramar|cambiar turno|otro horario|no puedo|mover turno)(\s|$)/i.test(text)
  ) {
    return 'reschedule';
  }

  if (
    /(^|\s)(cancelar|anular|darlo de baja)(\s|$)/i.test(text)
  ) {
    return 'cancel';
  }

  return null;
}

async function suggestAppointmentOptions({ clinic, timing, count = 3 }) {
  if (!clinic || !timing) {
    return { source: 'none', timing: timing || {}, suggestions: [] };
  }

  const tryAgenda =
    timing.startAt || (timing.dateISO && timing.timeWindow)
      ? await suggestClinicAgendaSlots(
          {
            clinicId: clinic.id,
            startAt: timing.startAt || null,
            dateISO: timing.dateISO || null,
            timeWindow: timing.timeWindow || null,
            count,
            stepMinutes: 30,
            durationMinutes: 30,
            maxLookaheadDays: 7
          },
          { clinic }
        )
      : null;

  if (tryAgenda && tryAgenda.ok && tryAgenda.strategy === 'agenda') {
    return {
      source: 'agenda',
      timing: {
        ...timing,
        dateISO: timing.dateISO || (tryAgenda.suggestions[0] && tryAgenda.suggestions[0].dateISO) || null
      },
      suggestions: tryAgenda.suggestions
    };
  }

  if (tryAgenda && !tryAgenda.ok) {
    logWarn('agenda_bot_suggestions_failed', {
      clinicId: clinic.id,
      reason: tryAgenda.reason,
      detail: tryAgenda.detail || null,
      dateISO: timing.dateISO || null,
      startAt: timing.startAt || null,
      timeWindow: timing.timeWindow || null
    });
  }

  return {
    source: 'agenda',
    timing: {
      ...timing,
      dateISO: timing.dateISO || (tryAgenda && tryAgenda.suggestions[0] && tryAgenda.suggestions[0].dateISO) || null
    },
    suggestions: []
  };
}

function buildAppointmentFlowResetPatch(extraPatch = null) {
  return mergeContextPatches(
    {
      activeBotDomain: null,
      appointmentCandidate: null,
      appointmentFlowPhase: null,
      appointmentSelectedSlot: null,
      appointmentBookingName: null,
      appointmentBookingNote: null,
      appointmentSuggestions: null,
      appointmentSuggestionsForDate: null,
      appointmentSuggestionsTimeWindow: null,
      appointmentSuggestionsCreatedAt: null
    },
    extraPatch || null
  );
}

function resolveActiveAgendaGuardDecision({ currentState, safeContext, inboundText }) {
  const appointmentFlowPhase = String(safeContext && safeContext.appointmentFlowPhase ? safeContext.appointmentFlowPhase : '').trim().toLowerCase();
  const hasActiveAppointmentFlow =
    BOT_ROUTER_APPOINTMENT_STATES.has(currentState) ||
    Boolean(appointmentFlowPhase) ||
    Boolean(safeContext && safeContext.appointmentSelectedSlot) ||
    Boolean(safeContext && safeContext.appointmentCandidate) ||
    (Array.isArray(safeContext && safeContext.appointmentSuggestions) && safeContext.appointmentSuggestions.length > 0);

  if (!hasActiveAppointmentFlow) return null;

  const normalizedInboundText = normalizeCommandText(inboundText);
  if (isGreeting(inboundText)) {
    return {
      replyText: 'Gracias por escribirnos. Puedo ayudarte con turnos, urgencias o consultas de precios. Contame que necesitás.',
      newState: 'READY',
      contextPatch: buildAppointmentFlowResetPatch()
    };
  }

  if (normalizedInboundText === 'cancelar' && currentState !== 'READY') {
    return {
      replyText: 'Listo, cancelé este flujo de turno. Si querés sacar otro, decime qué día te gustaría reservar.',
      newState: 'READY',
      contextPatch: buildAppointmentFlowResetPatch()
    };
  }

  return null;
}

async function resolveAgendaTimingDecision({ inboundText, clinic, conversation, contact, channel, safeContext }) {
  const parsed = parseAppointmentText(inboundText);
  if (!parsed.ok) {
    return null;
  }

  const appointmentCandidate = {
    rawText: String(inboundText || '').trim(),
    displayText: parsed.displayText || inboundText,
    parsed: parsed.parsed,
    createdAt: new Date().toISOString()
  };
  const timing = conversationRepo.resolveCandidateTiming(appointmentCandidate);
  const timezone = clinic.timezone || 'America/Argentina/Buenos_Aires';

  if (timing.startAt) {
    const requestedStart = DateTime.fromISO(String(timing.startAt), { zone: 'utc' });
    if (!requestedStart.isValid || requestedStart <= DateTime.utc()) {
      return {
        replyText: 'Ese horario ya paso. Decime un dia y horario futuro para reservar.',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: mergeContextPatches(buildAppointmentFlowResetPatch(), {
          activeBotDomain: 'agenda',
          appointmentCandidate
        })
      };
    }

    if (isReplaySafeConfirmation(safeContext, timing.startAt)) {
      return {
        replyText: `Listo. Tu turno ya estaba confirmado para ${formatSlotForHuman(timing.startAt, timezone)}.`,
        newState: 'READY',
        contextPatch: buildConfirmedContextPatch(timing.startAt)
      };
    }

    const created = await createBotReservationFromSuggestion({
      clinic,
      conversation,
      contact,
      channel,
      safeContext,
      suggestion: {
        source: 'agenda',
        startAt: timing.startAt,
        endAt: timing.endAt || null,
        dateISO: timing.dateISO || null,
        displayText: timing.requestedText || formatSlotForHuman(timing.startAt, timezone)
      }
    });

    if (created.ok) {
      const confirmedStartAt = created.startAt || timing.startAt;
      return {
        replyText: `Listo. Tu turno quedo confirmado para ${formatSlotForHuman(confirmedStartAt, timezone)}.`,
        newState: 'READY',
        contextPatch: buildConfirmedContextPatch(confirmedStartAt)
      };
    }

    const alternativeResult = await suggestAppointmentOptions({
      clinic,
      timing,
      count: 3
    });
    const alternatives = alternativeResult.suggestions;
    return {
      replyText: alternatives.length
        ? `No pude reservar ese horario.\n${buildSuggestionReply({
            dateISO: alternativeResult.timing.dateISO || timing.dateISO || null,
            timeWindow: alternativeResult.timing.timeWindow || timing.timeWindow || 'afternoon',
            suggestions: alternatives,
            timezone
          })}`
        : 'No pude reservar ese horario. Decime otro dia y horario para intentar de nuevo.',
      newState: alternatives.length ? 'SELECT_APPOINTMENT_SLOT' : 'ASKED_APPOINTMENT_DATETIME',
      contextPatch: alternatives.length
        ? buildAppointmentSuggestionContextPatch({
            appointmentCandidate,
            suggestions: alternatives,
            dateISO: alternativeResult.timing.dateISO || timing.dateISO || null,
            timeWindow: alternativeResult.timing.timeWindow || timing.timeWindow || null
          })
        : mergeContextPatches(buildAppointmentFlowResetPatch(), {
            activeBotDomain: 'agenda',
            appointmentCandidate
          })
    };
  }

  if (!parsed.hasTime && !parsed.hasTimeWindow) {
    return {
      replyText: 'Perfecto. ¿Te va mejor a la mañana, tarde o noche?',
      newState: 'ASKED_APPOINTMENT_TIMEWINDOW',
      contextPatch: mergeContextPatches(buildAppointmentFlowResetPatch(), {
        activeBotDomain: 'agenda',
        appointmentCandidate
      })
    };
  }

  if (parsed.hasTimeWindow && !parsed.hasTime) {
    const suggestionResult = await suggestAppointmentOptions({
      clinic,
      timing,
      count: 3
    });

    if (suggestionResult.suggestions.length > 0) {
      return {
        replyText: buildSuggestionReply({
          dateISO: suggestionResult.timing.dateISO || timing.dateISO,
          timeWindow: suggestionResult.timing.timeWindow || timing.timeWindow,
          suggestions: suggestionResult.suggestions,
          timezone: clinic.timezone || 'America/Argentina/Buenos_Aires'
        }),
        newState: 'SELECT_APPOINTMENT_SLOT',
        contextPatch: buildAppointmentSuggestionContextPatch({
          appointmentCandidate,
          suggestions: suggestionResult.suggestions,
          dateISO: suggestionResult.timing.dateISO || timing.dateISO,
          timeWindow: suggestionResult.timing.timeWindow || timing.timeWindow
        })
      };
    }

    return {
      replyText: 'No encontré horarios para ese momento. Decime otro día o una franja distinta y te propongo opciones.',
      newState: 'ASKED_APPOINTMENT_DATETIME',
      contextPatch: buildAppointmentFlowResetPatch()
    };
  }

  return {
    replyText: 'Decime dia y horario para reservar. Por ejemplo: martes 15:30.',
    newState: 'ASKED_APPOINTMENT_DATETIME',
    contextPatch: mergeContextPatches(buildAppointmentFlowResetPatch(), {
      activeBotDomain: 'agenda',
      appointmentCandidate
    })
  };
}

async function createBotReservationFromSuggestion({ clinic, conversation, contact, channel, safeContext, suggestion }) {
  if (!suggestion || !suggestion.startAt) {
    return { ok: false, source: 'none', reason: 'missing_startAt' };
  }

  const legacyAvailable = await conversationRepo.isSlotAvailable({
    clinicId: clinic.id,
    startAt: suggestion.startAt
  });
  if (!legacyAvailable) {
    return { ok: false, source: 'agenda', reason: 'agenda_time_conflict' };
  }

  const bookingName = String(
    (safeContext && (safeContext.appointmentBookingName || safeContext.name)) ||
      contact.name ||
      ''
  ).trim() || null;
  const bookingNote = String((safeContext && safeContext.appointmentBookingNote) || '').trim() || null;
  const agendaResult = await createClinicAgendaBotReservation(
    {
      clinicId: clinic.id,
      contactId: contact.id,
      conversationId: conversation.id || null,
      patientName: bookingName,
      title: bookingName ? `Turno - ${bookingName}` : 'Turno reservado',
      description: buildAppointmentReservationDescription({
        contact,
        bookingName,
        bookingNote,
        suggestion
      }),
      requestedText: suggestion.displayText || null,
      startAt: suggestion.startAt,
      endAt: suggestion.endAt || null,
      status: 'confirmed',
      origin: 'whatsapp_bot'
    },
    { clinic }
  );

  if (agendaResult.ok) {
    logInfo('agenda_bot_reservation_created', {
      clinicId: clinic.id,
      conversationId: conversation.id || null,
      contactId: contact.id || null,
      startAt: agendaResult.reservation.startAt || null,
      itemId: agendaResult.reservation.id || null,
      suggestionSource: suggestion.source || null
    });
    return {
      ok: true,
      source: 'agenda',
      reservation: agendaResult.reservation,
      startAt: agendaResult.reservation.startAt
    };
  }

  logWarn('agenda_bot_reservation_rejected', {
    clinicId: clinic.id,
    conversationId: conversation.id || null,
    contactId: contact.id || null,
    reason: agendaResult.reason,
    startAt: suggestion.startAt,
    endAt: suggestion.endAt || null
  });
  return {
    ok: false,
    source: 'agenda',
    reason: agendaResult.reason,
    detail: agendaResult.detail || null
  };
}

function normalizeChannelSendContext(channel, meta = {}) {
  const safeChannel = channel && typeof channel === 'object' ? channel : null;
  const accessToken = safeChannel && safeChannel.accessToken ? String(safeChannel.accessToken).trim() : '';
  const phoneNumberId = safeChannel && safeChannel.phoneNumberId ? String(safeChannel.phoneNumberId).trim() : '';
  const provider = safeChannel && safeChannel.provider ? String(safeChannel.provider).trim().toLowerCase() : '';
  const status = safeChannel && safeChannel.status ? String(safeChannel.status).trim().toLowerCase() : '';

  if (!safeChannel || !String(safeChannel.id || '').trim()) {
    const error = new Error('Missing WhatsApp channel for tenant-scoped send');
    error.code = 'CHANNEL_NOT_FOUND';
    error.meta = meta;
    throw error;
  }

  if (!accessToken) {
    const error = new Error('Missing WhatsApp channel access token');
    error.code = 'CHANNEL_ACCESS_TOKEN_MISSING';
    error.channelId = safeChannel.id;
    error.clinicId = safeChannel.clinicId || null;
    error.meta = meta;
    throw error;
  }

  if (!phoneNumberId) {
    const error = new Error('Missing WhatsApp channel phone number id');
    error.code = 'CHANNEL_PHONE_NUMBER_ID_MISSING';
    error.channelId = safeChannel.id;
    error.clinicId = safeChannel.clinicId || null;
    error.meta = meta;
    throw error;
  }

  if (provider && provider !== 'whatsapp_cloud') {
    const error = new Error('Invalid channel provider for WhatsApp send');
    error.code = 'CHANNEL_PROVIDER_INVALID';
    error.channelId = safeChannel.id;
    error.clinicId = safeChannel.clinicId || null;
    error.meta = meta;
    throw error;
  }

  if (status && status !== 'active') {
    const error = new Error('Inactive WhatsApp channel cannot be used for send');
    error.code = 'CHANNEL_INACTIVE';
    error.channelId = safeChannel.id;
    error.clinicId = safeChannel.clinicId || null;
    error.meta = meta;
    throw error;
  }

  return {
    channelId: safeChannel.id,
    clinicId: safeChannel.clinicId || null,
    accessToken,
    phoneNumberId,
    provider: safeChannel.provider || null,
    status: safeChannel.status || null,
    wabaId: safeChannel.wabaId || null
  };
}

async function sendAndPersistReply({
  clinicId,
  channel,
  conversationId,
  contact,
  text,
  requestId,
  correlationMessageId,
  outboundMedia = null,
  automation = null
}) {
  const channelCredentials = normalizeChannelSendContext(channel, {
    conversationId: conversationId || null,
    requestId
  });
  const safeAutomation = automation && typeof automation === 'object' ? automation : null;
  const automationPayload = safeAutomation
    ? {
        inboundMessageId: safeAutomation.inboundMessageId || null,
        inboundWaMessageId: safeAutomation.inboundWaMessageId || null,
        source: safeAutomation.source || null,
        jobId: safeAutomation.jobId || null
      }
    : null;
  const safeOutboundMedia = Array.isArray(outboundMedia)
    ? outboundMedia.filter((item) => item && item.type === 'image' && item.image && item.image.link)
    : [];
  const sendSequence = [];
  logInfo('worker_whatsapp_send_attempt', {
    requestId,
    clinicId,
    channelId: channelCredentials.channelId,
    conversationId: conversationId || null,
    jobId: null,
    phoneNumberId: channelCredentials.phoneNumberId,
    hasAccessToken: true,
    hasOutboundMedia: safeOutboundMedia.length > 0
  });
  let primarySendResult = null;
  let firstMediaSendResult = null;
  if (!safeOutboundMedia.length) {
    sendSequence.push({
      order: sendSequence.length + 1,
      payloadType: 'text',
      textPreview: String(text || '').slice(0, 160)
    });
    logInfo('conversation_reply_send_step', {
      requestId,
      conversationId: conversationId || null,
      order: sendSequence.length,
      payloadType: 'text',
      hasMedia: false,
      textPreview: String(text || '').slice(0, 160)
    });
    primarySendResult = await sendChannelScopedMessage(
      { to: contact.waId, text },
      {
        requestId,
        credentials: {
          channelId: channelCredentials.channelId,
          accessToken: channelCredentials.accessToken,
          phoneNumberId: channelCredentials.phoneNumberId,
          clinicId: channelCredentials.clinicId,
          provider: channelCredentials.provider,
          status: channelCredentials.status,
          wabaId: channelCredentials.wabaId
        }
      }
    );

    await conversationRepo.insertOutboundMessage({
      conversationId,
      waMessageId: primarySendResult && primarySendResult.messageId ? primarySendResult.messageId : null,
      from: channelCredentials.phoneNumberId,
      to: contact.waId || null,
      type: 'text',
      text,
      raw: {
        ...(primarySendResult && primarySendResult.raw ? primarySendResult.raw : {}),
        ...(automationPayload ? { automation: automationPayload } : {})
      }
    });
  }

  for (let index = 0; index < safeOutboundMedia.length; index += 1) {
    const mediaMessage = safeOutboundMedia[index];
    const caption = String(mediaMessage.image.caption || '').trim() || (index === 0 ? String(text || '').trim() : '');
    sendSequence.push({
      order: sendSequence.length + 1,
      payloadType: 'image',
      hasCaption: Boolean(caption),
      captionPreview: caption.slice(0, 160),
      productId: mediaMessage.productId || null
    });
    logInfo('conversation_reply_send_step', {
      requestId,
      conversationId: conversationId || null,
      order: sendSequence.length,
      payloadType: 'image',
      hasCaption: Boolean(caption),
      captionPreview: caption.slice(0, 160),
      productId: mediaMessage.productId || null
    });
    const mediaSendResult = await sendChannelScopedMessage(
      {
        to: contact.waId,
        image: {
          link: String(mediaMessage.image.link || '').trim(),
          caption
        }
      },
      {
        requestId,
        credentials: {
          channelId: channelCredentials.channelId,
          accessToken: channelCredentials.accessToken,
          phoneNumberId: channelCredentials.phoneNumberId,
          clinicId: channelCredentials.clinicId,
          provider: channelCredentials.provider,
          status: channelCredentials.status,
          wabaId: channelCredentials.wabaId
        }
      }
    );
    if (!firstMediaSendResult) {
      firstMediaSendResult = mediaSendResult;
    }

    await conversationRepo.insertOutboundMessage({
      conversationId,
      waMessageId: mediaSendResult && mediaSendResult.messageId ? mediaSendResult.messageId : null,
      from: channelCredentials.phoneNumberId,
      to: contact.waId || null,
      type: 'image',
      text: caption || null,
      raw: {
        ...(mediaSendResult && mediaSendResult.raw ? mediaSendResult.raw : {}),
        ...(automationPayload ? { automation: automationPayload } : {}),
        message: {
          image: {
            link: String(mediaMessage.image.link || '').trim(),
            caption
          }
        }
      }
    });
  }

  logInfo('worker_outbound_sent', {
    requestId,
    clinicId,
    channelId: channel.id,
    conversationId,
    contactId: contact.id,
    messageId: correlationMessageId || null,
    outboundMessageId: (
      (primarySendResult && primarySendResult.messageId) ||
      (firstMediaSendResult && firstMediaSendResult.messageId) ||
      null
    ),
    sendCount: sendSequence.length,
    sendOrder: sendSequence
  });

  return primarySendResult || firstMediaSendResult || null;
}

async function sendAgendaReminderMessage({ clinicId, channel, conversationId, contact, text, requestId, agendaItemId }) {
  const channelCredentials = normalizeChannelSendContext(channel, {
    conversationId: conversationId || null,
    requestId,
    agendaItemId
  });
  const targetWaId = normalizeWhatsAppTo(contact.waId || contact.whatsappPhone || contact.phone || '');
  if (!targetWaId) {
    const error = new Error('Missing WhatsApp destination for reminder');
    error.code = 'REMINDER_CONTACT_WA_MISSING';
    throw error;
  }

  const sendResult = await sendChannelScopedMessage(
    { to: targetWaId, text },
    {
      requestId,
      credentials: {
        channelId: channelCredentials.channelId,
        accessToken: channelCredentials.accessToken,
        phoneNumberId: channelCredentials.phoneNumberId,
        clinicId: channelCredentials.clinicId,
        provider: channelCredentials.provider,
        status: channelCredentials.status,
        wabaId: channelCredentials.wabaId
      }
    }
  );

  await conversationRepo.insertOutboundMessage({
    conversationId: conversationId || null,
    waMessageId: sendResult.messageId,
    from: channelCredentials.phoneNumberId,
    to: targetWaId,
    type: 'text',
    text,
    raw: sendResult.raw || {}
  });

  return { sendResult, targetWaId };
}

async function processDueAppointmentReminders() {
  const nowMs = Date.now();
  if (lastReminderSweepAt && nowMs - lastReminderSweepAt < APPOINTMENT_REMINDER_SWEEP_MS) {
    return { throttled: true, candidates: 0, sent: 0, skipped: 0, duplicatesBlocked: 0 };
  }
  lastReminderSweepAt = nowMs;

  const nowUtc = DateTime.utc();
  const candidates = await listDueAgendaReminderCandidates({
    fromStartAt: nowUtc.toISO(),
    toStartAt: nowUtc.plus({ minutes: APPOINTMENT_REMINDER_LEAD_MINUTES }).toISO(),
    limit: 25
  });
  const staleBefore = nowUtc.minus({ minutes: APPOINTMENT_REMINDER_CLAIM_TTL_MINUTES }).toISO();
  const stats = { candidates: candidates.length, sent: 0, skipped: 0, duplicatesBlocked: 0 };

  for (const item of candidates) {
    const claimed = await claimAgendaItemReminder(item.clinicId, item.id, staleBefore);
    if (!claimed) {
      stats.duplicatesBlocked += 1;
      continue;
    }

    try {
      const reminderAutomation = await getAutomationEnablementState({
        clinicId: claimed.clinicId,
        key: 'appointment_reminders',
        capabilitiesHint: ['agenda', 'whatsapp', 'contacts']
      });
      if (!reminderAutomation.enabled) {
        await releaseAgendaItemReminderClaim(claimed.clinicId, claimed.id, 'automation_disabled');
        logAutomationRuntimeBlocked({
          tenantId: reminderAutomation.tenantId || null,
          clinicId: claimed.clinicId,
          key: 'appointment_reminders',
          action: 'send_appointment_reminder',
          reason: reminderAutomation.reason,
          extra: {
            agendaItemId: claimed.id,
            conversationId: claimed.conversationId || null,
            contactId: claimed.contactId || null
          }
        });
        stats.skipped += 1;
        continue;
      }

      const clinic = await getClinic(claimed.clinicId);
      const contact = claimed.contactId ? await findContactByIdAndClinicId(claimed.contactId, claimed.clinicId) : null;
      const channel = await findPreferredWhatsAppChannelByClinicId(claimed.clinicId);

      if (!contact) {
        await releaseAgendaItemReminderClaim(claimed.clinicId, claimed.id, 'contact_not_found');
        logInfo('appointment_reminder_skipped', { agendaItemId: claimed.id, clinicId: claimed.clinicId, reason: 'contact_not_found' });
        stats.skipped += 1;
        continue;
      }

      if (!normalizeWhatsAppTo(contact.waId || contact.whatsappPhone || contact.phone || '')) {
        await releaseAgendaItemReminderClaim(claimed.clinicId, claimed.id, 'contact_wa_missing');
        logInfo('appointment_reminder_skipped', { agendaItemId: claimed.id, clinicId: claimed.clinicId, contactId: contact.id, reason: 'contact_wa_missing' });
        stats.skipped += 1;
        continue;
      }

      if (!channel) {
        await releaseAgendaItemReminderClaim(claimed.clinicId, claimed.id, 'channel_not_found');
        logInfo('appointment_reminder_skipped', { agendaItemId: claimed.id, clinicId: claimed.clinicId, contactId: contact.id, reason: 'channel_not_found' });
        stats.skipped += 1;
        continue;
      }

      const text = buildAppointmentReminderText({
        startAt: claimed.startAt,
        timezone: (clinic && clinic.timezone) || 'America/Argentina/Buenos_Aires',
        nowUtc
      });

      const { sendResult, targetWaId } = await sendAgendaReminderMessage({
        clinicId: claimed.clinicId,
        channel,
        conversationId: claimed.conversationId || null,
        contact,
        text,
        requestId: `reminder:${claimed.id}`,
        agendaItemId: claimed.id
      });

      await markAgendaItemReminderSent(claimed.clinicId, claimed.id, nowUtc.toISO());
      if (claimed.conversationId) {
        await addEvent({
          clinicId: claimed.clinicId,
          conversationId: claimed.conversationId,
          type: 'APPOINTMENT_REMINDER_SENT',
          data: {
            agendaItemId: claimed.id,
            startAt: claimed.startAt,
            contactId: claimed.contactId || null,
            channelId: channel.id || null,
            providerMessageId: sendResult.messageId || null
          }
        });
      }

      logInfo('appointment_reminder_sent', {
        agendaItemId: claimed.id,
        clinicId: claimed.clinicId,
        conversationId: claimed.conversationId || null,
        contactId: claimed.contactId || null,
        channelId: channel.id || null,
        to: targetWaId,
        startAt: claimed.startAt
      });
      stats.sent += 1;
    } catch (error) {
      await releaseAgendaItemReminderClaim(claimed.clinicId, claimed.id, error.message || 'send_failed');
      logWarn('appointment_reminder_failed', {
        agendaItemId: claimed.id,
        clinicId: claimed.clinicId,
        conversationId: claimed.conversationId || null,
        contactId: claimed.contactId || null,
        error: error.message
      });
      stats.skipped += 1;
    }
  }

  return stats;
}

async function openHandoffFlow({
  clinicId,
  conversationId,
  contact,
  lead,
  reason,
  clinicSettings,
  channel,
  requestId,
  messageId,
  customMessage = null,
  automation = null
}) {
  await withTransaction(async (client) => {
    const handoff = await openHandoff(
      {
        clinicId,
        conversationId,
        contactId: contact.id,
        leadId: lead ? lead.id : null,
        reason
      },
      client
    );

    await updateConversationStatus(conversationId, 'needs_human', client);
    await updateConversationStage(conversationId, 'handoff', client);

    if (lead) {
      await updateLeadStatus(lead.id, 'handoff', `handoff:${reason}`, client);
    }

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'HANDOFF_OPENED',
        data: {
          handoffId: handoff.id,
          reason
        }
      },
      client
    );

    const defaultAssignee = await getDefaultAssignee(clinicId, client);
    if (defaultAssignee) {
      await assignHandoff(handoff.id, defaultAssignee.id, client);
      if (lead) {
        await assignLead(lead.id, defaultAssignee.id, client);
      }
      await addEvent(
        {
          clinicId,
          conversationId,
          type: 'HANDOFF_ASSIGNED',
          data: {
            handoffId: handoff.id,
            staffUserId: defaultAssignee.id,
            staffName: defaultAssignee.name
          }
        },
        client
      );

      logInfo('handoff_assigned_default_staff', {
        requestId,
        clinicId,
        conversationId,
        contactId: contact.id,
        staffUserId: defaultAssignee.id,
        staffName: defaultAssignee.name
      });
    }
  });

  const handoffMessage =
    String(customMessage || '').trim() ||
    (clinicSettings && clinicSettings.handoffMessage) ||
    'Te derivamos con un humano. En breve te contactamos.';

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: handoffMessage,
    automation,
    requestId,
    correlationMessageId: messageId
  });
}

async function tryAppointmentSelection({
  clinicId,
  conversationId,
  contact,
  lead,
  rawText,
  channel,
  clinic,
  timezone,
  requestId,
  messageId,
  automation = null
}) {
  const selection = extractSelection(rawText);
  if (!selection) {
    return false;
  }

  const offeredEvent = await findLatestEventByType(clinicId, conversationId, 'SLOT_OFFERED', 20);
  if (!offeredEvent || !offeredEvent.data || !Array.isArray(offeredEvent.data.options)) {
    return false;
  }

  const chosen = offeredEvent.data.options.find((item) => Number(item.index) === selection);
  if (!chosen || (!chosen.slotId && !chosen.startAt)) {
    return false;
  }

  if (chosen.source === 'agenda' && chosen.startAt) {
    const booked = await createBotReservationFromSuggestion({
      clinic,
      conversation: {
        id: conversationId,
        channelId: channel.id,
        clinicId
      },
      contact,
      channel,
      safeContext: { name: contact.name || null },
      suggestion: chosen
    });

    if (!booked.ok) {
      const alternatives = await suggestAppointmentOptions({
        clinic,
        timing: {
          startAt: chosen.startAt,
          dateISO: chosen.dateISO || null,
          timeWindow: null
        },
        count: 5
      });

      const reply = alternatives.suggestions.length
        ? [
            'Ese horario ya no está disponible. Te propongo estas opciones:',
            ...alternatives.suggestions.slice(0, 5).map((item, index) => `${index + 1}) ${item.displayText}`),
            'Elegí una opción respondiendo con 1, 2, 3, 4 o 5.'
          ].join('\n')
        : 'Ese horario ya no está disponible. Decime otro día u horario y te propongo nuevas opciones.';

      if (alternatives.suggestions.length) {
        await addEvent({
          clinicId,
          conversationId,
          type: 'SLOT_OFFERED',
          data: {
            source: alternatives.source,
            options: alternatives.suggestions.slice(0, 5).map((item, index) => ({
              index: index + 1,
              source: item.source || alternatives.source,
              startAt: item.startAt,
              endAt: item.endAt || null,
              dateISO: item.dateISO || null,
              label: item.displayText,
              displayText: item.displayText
            }))
          }
        });
      }

      await sendAndPersistReply({
        clinicId,
        channel,
        conversationId,
        contact,
        text: reply,
        automation,
        requestId,
        correlationMessageId: messageId
      });
      return true;
    }

    const humanTime = formatSlotForHuman(booked.startAt, timezone);
    const confirmation = `Perfecto, reservo ${humanTime}. Si querés, decime el motivo o una nota para agregar al turno. Si no, respondé "sin motivo".`;

    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId,
      contact,
      text: confirmation,
      automation,
      requestId,
      correlationMessageId: messageId
    });

    return true;
  }

  const booked = await withTransaction(async (client) => {
    const held = await holdSlot(clinicId, chosen.slotId, conversationId, HOLD_MINUTES, client);
    if (!held) {
      return null;
    }

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'SLOT_HELD',
        data: {
          slotId: held.id,
          startsAt: held.startsAt,
          heldUntil: held.heldUntil
        }
      },
      client
    );

    const bookedResult = await bookHeldSlot(clinicId, held.id, lead.id, conversationId, contact.id, client);
    if (!bookedResult) {
      return null;
    }

    await updateLeadStatus(lead.id, 'confirmed', null, client);
    await updateConversationStage(conversationId, 'confirmed', client);
    await updateConversationStatus(conversationId, 'open', client);

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'APPOINTMENT_BOOKED',
        data: {
          appointmentId: bookedResult.appointment.id,
          slotId: bookedResult.slot.id,
          startsAt: bookedResult.slot.startsAt,
          leadId: lead.id
        }
      },
      client
    );

    return bookedResult;
  });

  if (!booked) {
    const reply = 'Ese horario ya no está disponible. Te muestro nuevas opciones en segundos.';
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId,
      contact,
      text: reply,
      automation,
      requestId,
      correlationMessageId: messageId
    });
    return true;
  }

  const humanTime = formatSlotForHuman(booked.slot.startsAt, timezone);
  const confirmation = `Perfecto, reservo ${humanTime}. Si querés, decime el motivo o una nota para agregar al turno. Si no, respondé "sin motivo".`;

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: confirmation,
    automation,
    requestId,
    correlationMessageId: messageId
  });

  return true;
}

async function processAppointmentIntent({
  clinicId,
  conversationId,
  contact,
  lead,
  channel,
  clinic,
  requestId,
  messageId,
  automation = null
}) {
  const rules = await getOrCreateCalendarRules(clinicId);
  const nowUtc = DateTime.utc();
  const fromUtc = nowUtc.plus({ minutes: Number(rules.leadTimeMinutes || 60) });
  const timezone = rules.timezone || clinic.timezone || 'America/Argentina/Buenos_Aires';
  const agendaSuggestions = await suggestClinicAgendaSlots(
    {
      clinicId,
      startAt: fromUtc.toISO(),
      count: 5,
      stepMinutes: 30,
      durationMinutes: 30,
      maxLookaheadDays: DAYS_AHEAD
    },
    { clinic }
  );

  let options = [];
  const agendaConfigured = agendaSuggestions.ok && agendaSuggestions.strategy === 'agenda';
  if (agendaConfigured) {
    options = agendaSuggestions.suggestions.slice(0, 5).map((slot, idx) => ({
      index: idx + 1,
      source: 'agenda',
      startAt: slot.startAt,
      endAt: slot.endAt || null,
      dateISO: slot.dateISO || null,
      label: slot.displayText,
      displayText: slot.displayText
    }));
  }

  if (!options.length) {
    await openHandoffFlow({
      clinicId,
      conversationId,
      contact,
      lead,
      reason: 'manual',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId,
      automation
    });
    return;
  }

  const intro =
    (clinic.settings && clinic.settings.appointmentIntroMessage) ||
    'Tengo estos horarios disponibles:';

  const lines = [intro, ...options.map((opt) => `${opt.index}) ${opt.label}`), 'Elegí una opción respondiendo con 1, 2, 3, 4 o 5.'];
  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: lines.join('\n'),
    automation,
    requestId,
    correlationMessageId: messageId
  });

  await addEvent({
    clinicId,
    conversationId,
    type: 'SLOT_OFFERED',
    data: {
      source: options[0] && options[0].source ? options[0].source : 'agenda',
      options
    }
  });

  await updateLeadStatus(lead.id, 'offering', null);
  await updateConversationStage(conversationId, 'offering');
  await conversationRepo.updateConversationState({
    conversationId,
    state: 'SELECT_APPOINTMENT_SLOT',
    contextPatch: buildAppointmentSuggestionContextPatch({
      suggestions: options.map((option) => ({
        source: option.source || 'agenda',
        slotId: option.slotId || null,
        startAt: option.startAt || option.startsAt || null,
        endAt: option.endAt || null,
        dateISO: option.dateISO || null,
        displayText: option.displayText || option.label || null,
        label: option.label || option.displayText || null
      })),
      dateISO: options[0] && options[0].dateISO ? options[0].dateISO : null,
      timeWindow: null
    })
  });
}

async function processInboundJob(job) {
  const payload = job.payload || {};
  const requestId = `worker:${job.id}`;
  const clinicId = job.clinicId;
  const channelId = job.channelId;
  const messageId = payload.messageId || null;

  const channel = await findChannelById(channelId);
  if (!channel) {
    throw new Error('Channel not found for job');
  }

  const conversation = await findConversationById(payload.conversationId);
  if (!conversation || conversation.clinicId !== clinicId) {
    throw new Error('Conversation not found for job');
  }

  const contact = await findContactByIdAndClinicId(conversation.contactId || payload.contactId, clinicId);
  if (!contact) {
    throw new Error('Contact not found for job');
  }

  const clinic = await getClinic(clinicId);
  if (!clinic) {
    throw new Error('Clinic not found for job');
  }

  const dbMessageId = payload.dbMessageId || null;
  const inboundMessage = dbMessageId ? await getMessageById(dbMessageId) : null;
  const inboundText = inboundMessage && inboundMessage.body ? inboundMessage.body : '';
  const inboundAutomationMeta = inboundMessage
    ? {
      inboundMessageId: inboundMessage.id,
      inboundWaMessageId: messageId || null,
      jobId: job.id
    }
    : null;

  const meta = {
    requestId,
    clinicId,
    channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    messageId
  };

  if (contact.optedOut) {
    const leadOpt = await upsertLeadForConversation({
      clinicId,
      channelId,
      conversationId: conversation.id,
      contactId: contact.id,
      primaryIntent: null
    });
    await updateLeadStatus(leadOpt.id, 'lost', 'contact_opted_out');
    await addEvent({
      clinicId,
      conversationId: conversation.id,
      type: 'CONTACT_OPTED_OUT',
      data: { contactId: contact.id }
    });

    logInfo('worker_job_skipped_opted_out', meta);
    return;
  }

  const intent = detectIntent(inboundText);
  const commercialIntent = detectCommercialIntent(inboundText);
  const lead = await upsertLeadForConversation({
    clinicId,
    channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    primaryIntent: intent === 'unknown' ? null : intent
  });

  await addEvent({
    clinicId,
    conversationId: conversation.id,
    type: 'LEAD_CREATED',
    data: { leadId: lead.id, intent }
  });

  const openHandoff = await getOpenHandoff(clinicId, conversation.id);
  if (openHandoff) {
    logInfo('worker_bot_paused_handoff_open', {
      ...meta,
      handoffId: openHandoff.id
    });
    return;
  }

  if (isCancellation(inboundText)) {
    const booked = await findBookedAppointmentByConversation(clinicId, conversation.id);
    const agendaBooked = !booked ? await findLatestActiveAgendaAppointmentByConversation(clinicId, conversation.id) : null;
    if (booked) {
      await cancelAppointment(clinicId, booked.id, 'cancelled_by_patient');
      await updateLeadStatus(lead.id, 'qualifying', 'appointment_cancelled');
      await addEvent({
        clinicId,
        conversationId: conversation.id,
        type: 'APPOINTMENT_CANCELLED',
        data: { appointmentId: booked.id, slotId: booked.slotId }
      });

      await sendAndPersistReply({
        clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: 'Tu turno fue cancelado. Si queres, te puedo ofrecer nuevas opciones.',
        automation: inboundAutomationMeta
          ? { ...inboundAutomationMeta, source: 'appointment_cancellation' }
          : null,
        requestId,
        correlationMessageId: messageId
      });
      return;
    }
    if (agendaBooked) {
      await updateAgendaItemById(clinicId, agendaBooked.id, {
        status: 'cancelled',
        resultNote: 'Cancelado por paciente desde WhatsApp'
      });
      await updateLeadStatus(lead.id, 'qualifying', 'appointment_cancelled');
      await addEvent({
        clinicId,
        conversationId: conversation.id,
        type: 'APPOINTMENT_CANCELLED',
        data: { agendaItemId: agendaBooked.id, startAt: agendaBooked.startAt }
      });

      await sendAndPersistReply({
        clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: 'Tu turno fue cancelado. Si querés, te puedo ofrecer nuevas opciones.',
        automation: inboundAutomationMeta
          ? { ...inboundAutomationMeta, source: 'appointment_cancellation' }
          : null,
        requestId,
        correlationMessageId: messageId
      });
      return;
    }
  }

  const handledSelection = await tryAppointmentSelection({
    clinicId,
    conversationId: conversation.id,
    contact,
    lead,
    rawText: inboundText,
    channel,
    clinic,
    timezone: clinic.timezone || 'America/Argentina/Buenos_Aires',
    requestId,
    messageId,
    automation: inboundAutomationMeta
      ? { ...inboundAutomationMeta, source: 'appointment_selection' }
      : null
  });
  if (handledSelection) {
    return;
  }

  if (intent === 'urgent' || intent === 'human') {
    await openHandoffFlow({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      reason: intent === 'urgent' ? 'urgent' : 'manual',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: intent === 'urgent' ? 'urgent_handoff' : 'manual_handoff' }
        : null
    });
    return;
  }

  if (intent === 'appointment') {
    await updateLeadStatus(lead.id, 'qualifying', null);
    await processAppointmentIntent({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      channel,
      clinic,
      requestId,
      messageId,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: 'appointment_intent' }
        : null
    });
    return;
  }

  if (intent === 'pricing') {
    await updateLeadStatus(lead.id, 'offering', null);
    await updateConversationStage(conversation.id, 'offering');
    const pricingMessage =
      (clinic.settings && clinic.settings.pricingMessage) ||
      'Te compartimos informacion de tratamientos y valores en una llamada breve. Si queres, te ofrezco turnos disponibles ahora mismo.';

    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId: conversation.id,
      contact,
      text: pricingMessage,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: 'pricing_reply' }
        : null,
      requestId,
      correlationMessageId: messageId
    });
    return;
  }

  const safeCommercialReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation,
    inboundText
  });
  const shortMemoryReply = safeCommercialReply
    ? null
    : await buildCommercialShortMemoryReply({
      clinic,
      conversation,
      inboundText
    });
  if (shortMemoryReply) {
    await updateLeadStatus(lead.id, 'qualifying', 'commercial_short_memory');
    if (shortMemoryReply.contextPatch || shortMemoryReply.newState) {
      await conversationRepo.updateConversationState({
        conversationId: conversation.id,
        state: shortMemoryReply.newState || conversation.state || 'READY',
        contextPatch: shortMemoryReply.contextPatch || null
      });
    }
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId: conversation.id,
      contact,
      text: shortMemoryReply.replyText,
      outboundMedia: shortMemoryReply.outboundMedia || null,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: 'commercial_short_memory' }
        : null,
      requestId,
      correlationMessageId: messageId
    });
    return;
  }
  if (safeCommercialReply) {
    if (safeCommercialReply.triggerHandoff === true || commercialIntent.type === 'human_handoff') {
      await openHandoffFlow({
        clinicId,
        conversationId: conversation.id,
        contact,
        lead,
        reason: 'manual',
        clinicSettings: clinic.settings,
        channel,
        requestId,
        messageId,
        customMessage: safeCommercialReply.replyText,
        automation: inboundAutomationMeta
          ? { ...inboundAutomationMeta, source: 'safe_commercial_handoff' }
          : null
      });
      return;
    }

    await updateLeadStatus(lead.id, 'qualifying', `semantic:${safeCommercialReply.type}`);
    if (safeCommercialReply.contextPatch) {
      await conversationRepo.updateConversationState({
        conversationId: conversation.id,
        state: conversation.state || 'READY',
        contextPatch: safeCommercialReply.contextPatch
      });
    }
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId: conversation.id,
      contact,
      text: safeCommercialReply.replyText,
      outboundMedia: safeCommercialReply.outboundMedia || null,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: 'safe_commercial_reply' }
        : null,
      requestId,
      correlationMessageId: messageId
    });
    return;
  }

  if (
    intent === 'unknown' &&
    commercialIntent.type === 'unknown' &&
    !isGreetingIntent(inboundText)
  ) {
    const intelligentFallback = buildIntelligentFallbackReply(conversation.context, inboundText);
    await updateLeadStatus(lead.id, 'qualifying', 'unknown_intent');
    await updateConversationStage(conversation.id, 'qualifying');
    await conversationRepo.updateConversationState({
      conversationId: conversation.id,
      state: conversation.state || 'READY',
      contextPatch: intelligentFallback.contextPatch
    });
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId: conversation.id,
      contact,
      text: intelligentFallback.replyText,
      automation: inboundAutomationMeta
        ? { ...inboundAutomationMeta, source: 'intelligent_fallback' }
        : null,
      requestId,
      correlationMessageId: messageId
    });
    return;
  }

  await addEvent({
    clinicId,
    conversationId: conversation.id,
    type: 'UNKNOWN_INTENT',
    data: { messageId, body: inboundText }
  });
  const unknownCount = await countRecentEventsByType(clinicId, conversation.id, 'UNKNOWN_INTENT', 120);

  if (unknownCount >= 2) {
    await openHandoffFlow({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      reason: 'unknown_intent',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId
    });
    return;
  }

  await updateLeadStatus(lead.id, 'qualifying', 'unknown_intent');
  await updateConversationStage(conversation.id, 'qualifying');
  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId: conversation.id,
    contact,
    text: 'Gracias por escribirnos. Puedo ayudarte con turnos, urgencias o consultas de precios. Contame que necesitas.',
    automation: inboundAutomationMeta
      ? { ...inboundAutomationMeta, source: 'unknown_fallback' }
      : null,
    requestId,
    correlationMessageId: messageId
  });
}

async function processConversationReplyJob(job) {
  const payload = parseJobPayload(job.payload);
  const requestId = `worker:${job.id}`;
  const conversationId = String(payload.conversationId || '').trim();
  const inboundMessageId = String(payload.inboundMessageId || '').trim();
  const channelId = String(payload.channelId || job.channelId || '').trim();
  const contactId = String(payload.contactId || '').trim();
  const waMessageId = String(payload.waMessageId || '').trim() || null;

  if (!conversationId || !inboundMessageId || !channelId || !contactId) {
    throw new Error('Invalid conversation_reply payload: missing conversationId/inboundMessageId/channelId/contactId');
  }

  const conversation = await conversationRepo.getConversationById(conversationId);
  if (!conversation) {
    throw new Error('Conversation not found in automation runtime');
  }

  const [inboundMessage, channel, contact] = await Promise.all([
    conversationRepo.getMessageById(inboundMessageId),
    findChannelById(channelId),
    findContactByIdAndClinicId(contactId, conversation.clinicId)
  ]);
  if (!inboundMessage) {
    throw new Error('Inbound message not found for conversation_reply job');
  }
  if (!channel) {
    throw new Error('Channel not found for conversation_reply job');
  }
  if (!contact) {
    throw new Error('Contact not found for conversation_reply job');
  }
  const clinic = await getClinic(conversation.clinicId);
  if (!clinic) {
    throw new Error('Clinic not found for conversation_reply job');
  }

  const inboundText = String(inboundMessage.text || '').trim();
  const currentState = String(conversation.state || '').toUpperCase();
  const safeContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const normalizedInboundText = normalizeCommandText(inboundText);
  const intent = detectIntent(inboundText);
  const commercialIntent = detectCommercialIntent(inboundText);
  const transferPaymentIntent = parseTransferPaymentIntent(inboundText);
  const managementIntent = detectTurnManagementIntent(inboundText);
  const inboundLooksLikeCommerce = isCommerceEntryIntent(inboundText);
  const inboundLooksLikeCommerceCancel = isCommerceCancelIntent(inboundText);
  const commerceContextActive = hasCommerceContext(safeContext);
  const activeBotDomain = String(safeContext && safeContext.activeBotDomain ? safeContext.activeBotDomain : '').trim().toLowerCase();
  const appointmentFlowPhase = String(safeContext && safeContext.appointmentFlowPhase ? safeContext.appointmentFlowPhase : '').trim().toLowerCase();
  const isInAgendaFlow = activeBotDomain === 'agenda' && !!appointmentFlowPhase;
  const qaAgendaBypassActive = shouldBypassCommerceForQa({
    contact,
    channel,
    contactId,
    channelId,
    inboundText
  });
  const replyAutomationMeta = {
    inboundMessageId,
    inboundWaMessageId: waMessageId,
    jobId: job.id
  };
  const hasNewerInbound = await conversationRepo.hasNewerInboundMessage(conversation.id, inboundMessage.id);
  const recentMessages = await conversationRepo.listConversationMessagesByClinicId(conversation.id, conversation.clinicId, 5);

  logInfo('automation_runtime_start', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    messageCount: Array.isArray(recentMessages) ? recentMessages.length : 0
  });
  logInfo('conversation_reply_job_trace', {
    stage: 'job_loaded',
    requestId,
    jobId: job.id,
    inboundMessageId,
    waMessageId,
    attempts: Number(job.attempts || 0),
    currentState,
    inboundText: normalizedInboundText,
    pendingOfferedActionAtLoad: summarizePendingOfferedActionForLog(safeContext.pendingOfferedAction)
  });

  if (isInAgendaFlow) {
    logInfo('agenda_flow_priority_guard_active', {
      requestId,
      jobId: job.id,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      currentState,
      inboundText: normalizedInboundText,
      activeBotDomain,
      appointmentFlowPhase
    });
  }

  if (hasNewerInbound) {
    logInfo('conversation_reply_skipped_stale_inbound', {
      requestId,
      jobId: job.id,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      inboundMessageId: inboundMessage.id,
      waMessageId
    });
    return;
  }

  const existingAutomationOutbound = await conversationRepo.findAutomationOutboundByInboundMessageId(
    conversation.id,
    inboundMessage.id
  );
  if (existingAutomationOutbound) {
    logInfo('conversation_reply_skipped_duplicate_inbound', {
      requestId,
      jobId: job.id,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      inboundMessageId: inboundMessage.id,
      outboundMessageId: existingAutomationOutbound.id,
      waMessageId
    });
    return;
  }

  if (qaAgendaBypassActive) {
    logInfo('qa_agenda_bypass_activated', {
      marker: 'AGENDA_BYPASS_V2',
      requestId,
      jobId: job.id,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      contactId: contact.id || null,
      channelId: channel.id || null,
      waId: contact.waId || null,
      currentState,
      inboundText: normalizedInboundText,
      bypass: {
        intent,
        reason: 'keyword_match',
        contactScoped: QA_AGENDA_BYPASS_CONTACT_IDS.has(String(contact.id || '').trim()),
        waScoped: QA_AGENDA_BYPASS_CONTACT_WA_IDS.has(normalizeDigitsOnly(contact.waId || contact.phone || '')),
        channelScoped: QA_AGENDA_BYPASS_CHANNEL_IDS.has(String(channel.id || '').trim())
      }
    });

    const qaLead = await upsertLeadForConversation({
      clinicId: conversation.clinicId,
      channelId,
      conversationId: conversation.id,
      contactId: contact.id,
      primaryIntent: 'appointment'
    });

    await processAppointmentIntent({
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      contact,
      lead: qaLead,
      channel,
      clinic,
      requestId,
      messageId: waMessageId || inboundMessage.id
    });
    return;
  }

  const botRoute = resolveBotDomainRoute({
    clinic,
    currentState,
    safeContext,
    inboundText,
    intent,
    commercialIntentType: commercialIntent.type,
    transferPaymentIntent,
    managementIntent,
    inboundLooksLikeCommerce,
    inboundLooksLikeCommerceCancel
  });

  const chosenBotPath =
    qaAgendaBypassActive
      ? 'agenda'
      : botRoute.domain === 'agenda'
        ? 'agenda'
        : botRoute.domain === 'demo'
          ? 'demo'
        : botRoute.domain === 'commerce'
          ? 'commerce'
          : 'fallback';

  console.log('BOT_ROUTER_DECISION', {
    botMode: botRoute.botMode,
    botFlowLock: botRoute.botFlowLock || 'automatic',
    botDomainOverride: botRoute.overrideDomain || 'automatic',
    inboundText: normalizedInboundText,
    chosenPath: chosenBotPath
  });

  console.log('BOT_OVERRIDE_RUNTIME_CHECK', {
    conversationId: conversation.id,
    botFlowLock: botRoute.botFlowLock || 'automatic',
    botDomainOverride: botRoute.overrideDomain || 'automatic',
    botMode: botRoute.botMode,
    currentState,
    inboundText: normalizedInboundText,
    chosenPath: chosenBotPath
  });

  logInfo('bot_domain_route_resolved', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    currentState,
    inboundText: normalizedInboundText,
    botMode: botRoute.botMode,
    domain: botRoute.domain,
    reason: botRoute.reason,
    botFlowLock: botRoute.botFlowLock,
    activeDomain: botRoute.activeDomain,
    overrideDomain: botRoute.overrideDomain,
    agendaIntent: botRoute.agendaIntent,
    explicitCommerceIntent: botRoute.explicitCommerceIntent,
    commerceContextActive
  });

  const shouldPrioritizeAgendaFlow =
    isInAgendaFlow &&
    (
      currentState === 'SELECT_APPOINTMENT_SLOT' ||
      currentState === 'ASKED_APPOINTMENT_NAME' ||
      currentState === 'ASKED_APPOINTMENT_NOTE'
    );

  const shouldRouteDirectToAgenda =
    botRoute.domain === 'agenda' &&
    (
      botRoute.overrideDomain === 'agenda' ||
      botRoute.botMode === 'agenda' ||
      botRoute.agendaIntent
    ) &&
    !BOT_ROUTER_APPOINTMENT_STATES.has(currentState);
  const shouldShortCircuitToDemoSourceOfTruth =
    botRoute.domain === 'demo' &&
    !shouldPrioritizeAgendaFlow &&
    currentState !== 'PAYMENT_TRANSFER' &&
    !transferPaymentIntent;

  if (
    shouldRouteDirectToAgenda
  ) {
    const routedLead = await upsertLeadForConversation({
      clinicId: conversation.clinicId,
      channelId,
      conversationId: conversation.id,
      contactId: contact.id,
      primaryIntent: botRoute.agendaIntent || botRoute.botMode === 'agenda' ? 'appointment' : (intent === 'unknown' ? null : intent)
    });

    await conversationRepo.updateConversationState({
      conversationId: conversation.id,
      state: conversation.state || null,
      contextPatch: { activeBotDomain: 'agenda' }
    });
    await updateLeadStatus(routedLead.id, 'qualifying', null);

    logInfo('bot_domain_agenda_routed', {
      requestId,
      jobId: job.id,
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      botMode: botRoute.botMode,
      reason: botRoute.reason,
      chosenPath: 'agenda'
    });

    const timingDecision = await resolveAgendaTimingDecision({
      inboundText,
      clinic,
      conversation,
      contact,
      channel,
      safeContext: {
        ...safeContext,
        activeBotDomain: 'agenda'
      }
    });

    if (timingDecision) {
      await conversationRepo.updateConversationState({
        conversationId: conversation.id,
        state: timingDecision.newState || conversation.state || 'READY',
        contextPatch: mergeContextPatches(timingDecision.contextPatch || null, { activeBotDomain: 'agenda' })
      });

      await sendAndPersistReply({
        clinicId: conversation.clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: timingDecision.replyText,
        automation: {
          ...replyAutomationMeta,
          source: 'agenda_timing_decision'
        },
        requestId,
        correlationMessageId: waMessageId || inboundMessage.id
      });
      return;
    }

    await processAppointmentIntent({
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      contact,
      lead: routedLead,
      channel,
      clinic,
      requestId,
      messageId: waMessageId || inboundMessage.id,
      automation: {
        ...replyAutomationMeta,
        source: 'appointment_intent'
      }
    });
    return;
  }

  if (!shouldPrioritizeAgendaFlow && !shouldShortCircuitToDemoSourceOfTruth) {
    const safeCommercialReply = await buildSafeCommercialIntentReply({
      clinic,
      conversation,
      inboundText
    });

    if (safeCommercialReply) {
      const routedLead = await upsertLeadForConversation({
        clinicId: conversation.clinicId,
        channelId,
        conversationId: conversation.id,
        contactId: contact.id,
        primaryIntent: commercialIntent.type === 'human_handoff'
          ? 'human'
          : intent === 'unknown'
            ? null
            : intent
      });

      if (safeCommercialReply.triggerHandoff === true || commercialIntent.type === 'human_handoff') {
        await openHandoffFlow({
          clinicId: conversation.clinicId,
          conversationId: conversation.id,
          contact,
          lead: routedLead,
          reason: 'manual',
          clinicSettings: clinic.settings,
        channel,
        requestId,
        messageId: waMessageId || inboundMessage.id,
        customMessage: safeCommercialReply.replyText,
        automation: {
          ...replyAutomationMeta,
          source: 'safe_commercial_handoff'
        }
      });
        return;
      }

      await updateLeadStatus(routedLead.id, 'qualifying', `semantic:${safeCommercialReply.type}`);
      if (safeCommercialReply.contextPatch) {
        await conversationRepo.updateConversationState({
          conversationId: conversation.id,
          state: conversation.state || 'READY',
          contextPatch: safeCommercialReply.contextPatch
        });
      }
      logInfo('conversation_reply_job_trace', {
        stage: 'safe_commercial_reply_selected',
        requestId,
        jobId: job.id,
        inboundMessageId: inboundMessage.id,
        source: 'safe_commercial_reply',
        replyType: safeCommercialReply.type || null,
        pendingOfferedActionBefore: summarizePendingOfferedActionForLog(safeContext.pendingOfferedAction),
        pendingOfferedActionAfter: summarizePendingOfferedActionForLog(safeCommercialReply.contextPatch && safeCommercialReply.contextPatch.pendingOfferedAction),
        ...summarizeVisibleReplyForLog(safeCommercialReply)
      });
      await sendAndPersistReply({
        clinicId: conversation.clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: safeCommercialReply.replyText,
        outboundMedia: safeCommercialReply.outboundMedia || null,
        automation: {
          ...replyAutomationMeta,
          source: 'safe_commercial_reply'
        },
        requestId,
        correlationMessageId: waMessageId || inboundMessage.id
      });
      return;
    }
  }

  if (
    !shouldPrioritizeAgendaFlow &&
    !shouldShortCircuitToDemoSourceOfTruth &&
    !inboundLooksLikeCommerceCancel
  ) {
    const aiAssistInvocation = shouldInvokeAiAssist({
      botRoute,
      intent,
      commercialIntent,
      transferPaymentIntent,
      inboundText,
      safeContext
    });
    if (aiAssistInvocation.ok) {
      if (aiAssistInvocation.reason === 'commercial_weak_signal') {
        logInfo('ai_assist_weak_signal_detected', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          signal: aiAssistInvocation.signal || null
        });
      }
      const aiAssistResult = await classifyCommerceAiAssist({
        clinicId: conversation.clinicId,
        conversationId: conversation.id,
        message: inboundText,
        context: safeContext,
        recentMessages: Array.isArray(recentMessages)
          ? recentMessages.map((item) => item && (item.text || item.body || item.message || '')).filter(Boolean)
          : [],
        reason: aiAssistInvocation.reason
      });

      if (aiAssistResult.ok && canUseSafeLowConfidenceAiAssistDecision(aiAssistResult.decision)) {
        const aiAssistReply = await resolveAiAssistDecision({
          clinic,
          conversation,
          inboundText,
          aiDecision: aiAssistResult.decision,
          safeContext
        });

        if (aiAssistReply) {
          await conversationRepo.updateConversationState({
            conversationId: conversation.id,
            state: conversation.state || 'READY',
            contextPatch: aiAssistReply.contextPatch || null
          });

          await sendAndPersistReply({
            clinicId: conversation.clinicId,
            channel,
            conversationId: conversation.id,
            contact,
            text: aiAssistReply.replyText,
            outboundMedia: aiAssistReply.outboundMedia || null,
            automation: {
              ...replyAutomationMeta,
              source: 'ai_assist'
            },
            requestId,
            correlationMessageId: waMessageId || inboundMessage.id
          });
          return;
        }
      } else {
        if (shouldUseWeakSignalCommercialFallback(aiAssistInvocation, aiAssistResult)) {
          const weakSignalFallback = buildWeakSignalCommercialFallback({
            inboundText,
            safeContext,
            signal: aiAssistInvocation.signal || null
          });

          if (weakSignalFallback) {
            logInfo('ai_assist_weak_signal_fallback_used', {
              requestId,
              jobId: job.id,
              conversationId: conversation.id,
              clinicId: conversation.clinicId,
              signal: aiAssistInvocation.signal || null,
              aiReason: aiAssistResult.reason || null
            });
            await conversationRepo.updateConversationState({
              conversationId: conversation.id,
              state: conversation.state || 'READY',
              contextPatch: weakSignalFallback.contextPatch || null
            });

            await sendAndPersistReply({
              clinicId: conversation.clinicId,
              channel,
              conversationId: conversation.id,
              contact,
              text: weakSignalFallback.replyText,
              outboundMedia: weakSignalFallback.outboundMedia || null,
              automation: {
                ...replyAutomationMeta,
                source: 'ai_assist_weak_signal_fallback'
              },
              requestId,
              correlationMessageId: waMessageId || inboundMessage.id
            });
            return;
          }
        }
        logInfo('ai_assist_skipped_or_low_confidence', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          ok: aiAssistResult.ok === true,
          reason: aiAssistResult.reason || null,
          confidence: aiAssistResult.decision ? aiAssistResult.decision.confidence : null
        });
      }
    }

    if (
      intent === 'unknown' &&
      commercialIntent.type === 'unknown' &&
      !inboundLooksLikeCommerce &&
      !transferPaymentIntent &&
      !isGreetingIntent(inboundText)
    ) {
      const intelligentFallback = buildIntelligentFallbackReply(safeContext, inboundText);
      await conversationRepo.updateConversationState({
        conversationId: conversation.id,
        state: conversation.state || 'READY',
        contextPatch: intelligentFallback.contextPatch
      });

      await sendAndPersistReply({
        clinicId: conversation.clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: intelligentFallback.replyText,
        automation: {
          ...replyAutomationMeta,
          source: 'intelligent_fallback'
        },
        requestId,
        correlationMessageId: waMessageId || inboundMessage.id
      });
      return;
    }
  }

  const workerOwnsCommerceFlow =
    !qaAgendaBypassActive &&
    !shouldPrioritizeAgendaFlow &&
    (botRoute.domain === 'commerce' || botRoute.domain === 'demo');
  const automationRuntime = qaAgendaBypassActive
    ? {
      replyText: null,
      contextPatch: null,
      matched: [],
      source: 'qa.agenda_bypass'
    }
    : shouldPrioritizeAgendaFlow
    ? {
      replyText: null,
      contextPatch: null,
      matched: [],
      source: 'agenda.flow_priority'
    }
    : workerOwnsCommerceFlow
    ? {
      replyText: null,
      contextPatch: null,
      matched: [],
      source: 'worker.commerce'
    }
    : await resolveAutomationReplyForInbound({
      clinic,
      conversation,
      inboundText,
      recentMessages
    });
  const shouldBypassAutomationForRuntimeEdit = Boolean(
    getActiveGeneratedBotConfig(clinic) &&
    parseActiveBotRuntimeEditIntent(inboundText)
  );
  if (shouldBypassAutomationForRuntimeEdit) {
    automationRuntime.replyText = null;
    automationRuntime.contextPatch = null;
  }
  let automationContextPatch = automationRuntime.contextPatch || null;

  logInfo('incoming_whatsapp_message_received', {
    requestId,
    jobId: job.id,
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    inboundText: normalizedInboundText,
    inboundMessageId
  });

  if (workerOwnsCommerceFlow) {
    logInfo(botRoute.domain === 'demo' ? 'automation_runtime_skipped_for_demo_source_of_truth' : 'automation_runtime_skipped_for_commerce_source_of_truth', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      inboundText: normalizedInboundText,
      sourcePath: botRoute.domain === 'demo' ? 'worker.demo' : 'worker.commerce'
    });
  }

  if (automationRuntime.matched.length) {
    logInfo('automation_match_found', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      automationIds: automationRuntime.matched.map((automation) => automation.id),
      triggerTypes: automationRuntime.matched.map((automation) => automation.trigger?.type || null)
    });
  }

  if (shouldBypassAutomationForRuntimeEdit) {
    logInfo('automation_runtime_bypassed_for_active_bot_edit', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      inboundText: normalizedInboundText
    });
  }

  const buildSuggestionsFromContext = async (count = 3) => {
    const timing = conversationRepo.resolveCandidateTiming(safeContext.appointmentCandidate || null);
    const suggestionResult = await suggestAppointmentOptions({
      clinic,
      timing,
      count
    });
    return { suggestions: suggestionResult.suggestions, timing: suggestionResult.timing, source: suggestionResult.source };
  };

  let decision = null;
  let decisionSource = null;

  const activeAgendaGuardDecision = resolveActiveAgendaGuardDecision({
    currentState,
    safeContext,
    inboundText
  });
  if (!decision && activeAgendaGuardDecision) {
    decision = activeAgendaGuardDecision;
    decisionSource = normalizeCommandText(inboundText) === 'cancelar' ? 'agenda_flow_cancel' : 'agenda_flow_greeting_reset';
  }

  if (!decision) {
    const loyaltyFollowUpDecision = await resolveLoyaltyFollowUpDecision({
      clinic,
      conversation,
      contact,
      inboundText,
      safeContext
    });
    if (loyaltyFollowUpDecision) {
      decision = loyaltyFollowUpDecision;
      decisionSource = 'loyalty_follow_up';
    }
  }

  if (!decision) {
    const loyaltyDecision = await resolveLoyaltyDecision({
      clinic,
      conversation,
      contact,
      inboundText
    });
    if (loyaltyDecision) {
      decision = loyaltyDecision;
      decisionSource = 'loyalty';
    }
  }

  if (!decision && automationRuntime.replyText) {
    decision = {
      replyText: automationRuntime.replyText,
      outboundMedia: Array.isArray(automationRuntime.outboundMedia) ? automationRuntime.outboundMedia : null,
      newState: conversation.state || 'READY',
      contextPatch: automationContextPatch
    };
    decisionSource = 'automation';
  }
  if (!decision && !qaAgendaBypassActive && !shouldPrioritizeAgendaFlow && botRoute.allowCommerce && botRoute.domain !== 'demo') {
    const configuredBotDecision = resolveConfiguredSalesBotReply({
      clinic,
      inboundText,
      currentState,
      safeContext
    });
    if (configuredBotDecision) {
      decision = configuredBotDecision;
      decisionSource = 'configured_bot';
    }
  }
  if (!decision && !qaAgendaBypassActive && !shouldPrioritizeAgendaFlow) {
    if (botRoute.allowCommerce) {
      console.log('COMMERCE_PREEMPT_CHECK', {
        conversationId: conversation.id,
        botFlowLock: botRoute.botFlowLock || 'automatic',
        botDomainOverride: botRoute.overrideDomain || 'automatic',
        botMode: botRoute.botMode,
        currentState,
        inboundText: normalizedInboundText
      });
      decision = await resolveCommerceDecision({
        conversation,
        clinic,
        contact,
        inboundText,
        inboundMessage
      });
      if (decision) {
        decisionSource = botRoute.domain === 'demo' ? 'demo' : 'commerce';
        logInfo(botRoute.domain === 'demo' ? 'demo_flow_entered' : 'commerce_flow_entered', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          currentState,
          nextState: decision.newState || null,
          inboundText: normalizedInboundText
        });
      } else {
        logInfo('commerce_flow_skipped', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          currentState,
          inboundText: normalizedInboundText,
          reason: inboundLooksLikeCommerce ? 'resolve_commerce_returned_null' : 'not_a_commerce_command'
        });
      }
    } else {
      logInfo('commerce_flow_blocked_by_bot_mode', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        currentState,
        inboundText: normalizedInboundText,
        botMode: botRoute.botMode,
        domain: botRoute.domain,
        reason: botRoute.reason
      });
    }
  }

  if (
    !decision &&
    managementIntent &&
    (currentState === 'READY' || currentState === 'SELECT_APPOINTMENT_SLOT' || currentState === 'CONFIRM_APPOINTMENT')
  ) {
    const latestAppointment = await conversationRepo.findLatestConfirmedAppointment({
      clinicId: conversation.clinicId,
      waId: contact.waId || null,
      conversationId: conversation.id
    });
    const latestAgendaAppointment = !latestAppointment
      ? await findLatestActiveAgendaAppointmentByConversation(conversation.clinicId, conversation.id)
      : null;

    if (!latestAppointment && !latestAgendaAppointment) {
      decision = {
        replyText: 'No encuentro un turno confirmado. Decime qué día y horario te gustaría reservar.',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: buildEmptyAppointmentSuggestionPatch()
      };
    } else if (
      String(safeContext.appointmentStatus || '').toLowerCase() === 'cancelled' &&
      String(safeContext.appointmentLastCancelledStartAt || '') === String(latestAppointment.startAt || '')
    ) {
      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancelé tu turno. Si querés sacar otro, decime qué día y horario te gustaría reservar.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      } else {
        decision = {
          replyText: "Dale. ¿Para qué día y horario querés reprogramar? Por ejemplo: 'lunes 15:30' o 'martes a la tarde'.",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            appointmentCandidate: null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      }
    } else if (latestAppointment) {
      const cancelled = await conversationRepo.cancelAppointmentById({
        appointmentId: latestAppointment.id
      });
      const cancelledStartAt = (cancelled && cancelled.startAt) || latestAppointment.startAt || null;

      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancelé tu turno. Si querés sacar otro, decime qué día y horario te gustaría reservar.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      } else {
        decision = {
          replyText: "Dale. ¿Para qué día y horario querés reprogramar? Por ejemplo: 'lunes 15:30' o 'martes a la tarde'.",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            appointmentCandidate: null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      }
    } else {
      const cancelledAgenda = await updateAgendaItemById(conversation.clinicId, latestAgendaAppointment.id, {
        status: 'cancelled',
        resultNote: 'Cancelado por paciente desde WhatsApp'
      });
      const cancelledStartAt = (cancelledAgenda && cancelledAgenda.startAt) || latestAgendaAppointment.startAt || null;

      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancelé tu turno. Si querés sacar otro, decime qué día y horario te gustaría reservar.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      } else {
        decision = {
          replyText: "Dale. ¿Para qué día y horario querés reprogramar? Por ejemplo: 'lunes 15:30' o 'martes a la tarde'.",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            appointmentCandidate: null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      }
    }

    if (decision) {
      decisionSource = 'legacy_appointment_management';
      logInfo('legacy_clinic_flow_matched', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        currentState,
        reason: 'appointment_management',
        nextState: decision.newState || null
      });
    }
  }

  if (!decision && currentState === 'ASKED_APPOINTMENT_TIMEWINDOW') {
    const selectedWindow = parseTimeWindowInput(inboundText);
    if (selectedWindow) {
      const candidate = safeContext.appointmentCandidate || {};
      const parsed = candidate.parsed && typeof candidate.parsed === 'object' ? candidate.parsed : {};
      const patchedCandidate = {
        ...candidate,
        parsed: {
          ...parsed,
          timeWindow: selectedWindow
        }
      };
      const timing = conversationRepo.resolveCandidateTiming(patchedCandidate);
      if (timing.dateISO) {
        const suggestionResult = await suggestAppointmentOptions({
          clinic,
          timing: {
            ...timing,
            timeWindow: selectedWindow
          },
          count: 3
        });
        if (suggestionResult.suggestions.length > 0) {
          decision = {
            replyText: buildSuggestionReply({
              dateISO: suggestionResult.timing.dateISO || timing.dateISO,
              timeWindow: selectedWindow,
              suggestions: suggestionResult.suggestions
            }),
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: buildAppointmentSuggestionContextPatch({
              appointmentCandidate: patchedCandidate,
              suggestions: suggestionResult.suggestions,
              dateISO: suggestionResult.timing.dateISO || timing.dateISO,
              timeWindow: selectedWindow
            })
          };
        }
      }
    }
  }

  if (!decision && currentState === 'ASKED_APPOINTMENT_DATETIME') {
    decision = await resolveAgendaTimingDecision({
      inboundText,
      clinic,
      conversation,
      contact,
      channel,
      safeContext
    });
    if (decision) {
      decisionSource = 'agenda_datetime_worker';
    }
  }

  if (!decision && currentState === 'SELECT_APPOINTMENT_SLOT') {
    if (isGlobalMenuCommand(inboundText)) {
      decision = {
        replyText: 'Listo, cancelé este flujo de turno. Si querés sacar otro, decime qué día te gustaría reservar.',
        newState: 'READY',
        contextPatch: buildAppointmentFlowResetPatch()
      };
    } else {
      const selection = extractSelection(inboundText);
      const suggestions = Array.isArray(safeContext.appointmentSuggestions) ? safeContext.appointmentSuggestions : [];
      const expired = isSuggestionExpired(safeContext.appointmentSuggestionsCreatedAt, 30);
      const maxSelection = Math.max(1, Math.min(5, suggestions.length || 3));

      if (!selection || selection < 1 || selection > maxSelection) {
        decision = {
          replyText: `Respondé con una opción válida del 1 al ${maxSelection} para elegir un horario.`,
          newState: 'SELECT_APPOINTMENT_SLOT',
          contextPatch: null
        };
      } else if (!suggestions.length || expired) {
        const regen = await buildSuggestionsFromContext(3);
        if (!regen.suggestions.length) {
          decision = {
            replyText: 'No pude encontrar horarios en este momento. Decime día y hora nuevamente, por ejemplo: lunes 10:30.',
            newState: 'ASKED_APPOINTMENT_DATETIME',
            contextPatch: buildEmptyAppointmentSuggestionPatch()
          };
        } else {
          decision = {
            replyText: buildSuggestionReply({
              dateISO: regen.timing.dateISO,
              timeWindow: regen.timing.timeWindow || safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
              suggestions: regen.suggestions,
              timezone: clinic.timezone || 'America/Argentina/Buenos_Aires'
            }),
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: buildAppointmentSuggestionContextPatch({
              suggestions: regen.suggestions,
              dateISO: regen.timing.dateISO || null,
              timeWindow: regen.timing.timeWindow || null
            })
          };
        }
      } else {
        const chosen = suggestions[selection - 1] || null;
        if (!chosen || !chosen.startAt) {
          decision = {
            replyText: 'Esa opción no es válida. Elegí 1, 2 o 3.',
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: null
          };
        } else if (isReplaySafeConfirmation(safeContext, chosen.startAt)) {
          decision = {
            replyText: `Listo, tu turno ya estaba reservado para ${formatSlotForHuman(chosen.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}.`,
            newState: 'READY',
            contextPatch: buildConfirmedContextPatch(chosen.startAt)
          };
        } else {
          const bookingName = String(
            (safeContext && (safeContext.appointmentBookingName || safeContext.name)) ||
              contact.name ||
              ''
          ).trim();
          const selectedHumanTime = formatSlotForHuman(chosen.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires');

          if (!bookingName) {
            decision = {
              replyText: `Perfecto, reservo ${selectedHumanTime}. Antes de confirmarlo, decime tu nombre.`,
              newState: 'ASKED_APPOINTMENT_NAME',
              contextPatch: buildAppointmentSelectedSlotPatch({
                suggestion: chosen,
                phase: 'waiting_contact_name'
              })
            };
          } else {
            decision = {
              replyText: `Perfecto, reservo ${selectedHumanTime}. Si querés, decime el motivo o una nota para agregar al turno. Si no, respondé "sin motivo".`,
              newState: 'ASKED_APPOINTMENT_NOTE',
              contextPatch: buildAppointmentSelectedSlotPatch({
                suggestion: chosen,
                bookingName,
                phase: 'waiting_contact_note'
              })
            };
          }
        }
      }
    }
  }

  if (!decision && currentState === 'ASKED_APPOINTMENT_NAME') {
    const providedName = String(inboundText || '').trim();
    if (providedName.length < 2) {
      decision = {
        replyText: 'Necesito tu nombre para confirmar el turno. Respondé con tu nombre y apellido.',
        newState: 'ASKED_APPOINTMENT_NAME',
        contextPatch: null
      };
    } else {
      await updateContact(contact.id, clinic.id, {
        name: providedName,
        email: contact.email || null,
        phone: contact.phone || null,
        whatsappPhone: contact.whatsappPhone || null,
        taxId: contact.taxId || null,
        taxCondition: contact.taxCondition || null,
        companyName: contact.companyName || null,
        notes: contact.notes || null
      });
      decision = {
        replyText: 'Perfecto. Si querés, decime el motivo o una nota para agregar al turno. Si no, respondé "sin motivo".',
        newState: 'ASKED_APPOINTMENT_NOTE',
        contextPatch: buildAppointmentSelectedSlotPatch({
          suggestion: safeContext.appointmentSelectedSlot || null,
          bookingName: providedName,
          bookingNote: null,
          phase: 'waiting_contact_note'
        })
      };
    }
  }

  if (!decision && currentState === 'ASKED_APPOINTMENT_NOTE') {
    const selectedSlot = safeContext && safeContext.appointmentSelectedSlot ? safeContext.appointmentSelectedSlot : null;
    const bookingName = String(
      (safeContext && (safeContext.appointmentBookingName || safeContext.name)) ||
        contact.name ||
        ''
    ).trim();

    if (!selectedSlot || !selectedSlot.startAt) {
      decision = {
        replyText: 'Perdí el horario elegido. Decime día y hora nuevamente y te propongo opciones.',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: buildEmptyAppointmentSuggestionPatch()
      };
    } else {
      const bookingNote = normalizeOptionalAppointmentNote(inboundText);
      const created = await createBotReservationFromSuggestion({
        clinic,
        conversation,
        contact,
        channel,
        safeContext: {
          ...safeContext,
          appointmentBookingName: bookingName || null,
          appointmentBookingNote: bookingNote || null,
          name: bookingName || contact.name || null
        },
        suggestion: selectedSlot
      });

      if (created.ok) {
        decision = {
          replyText: buildAppointmentFinalConfirmation({
            timezone: clinic.timezone || 'America/Argentina/Buenos_Aires',
            suggestion: selectedSlot,
            bookingName,
            bookingNote
          }),
          newState: 'READY',
          contextPatch: mergeContextPatches(
            buildConfirmedContextPatch(selectedSlot.startAt),
            {
              appointmentBookingName: bookingName || null,
              appointmentBookingNote: bookingNote || null
            }
          )
        };
      } else if (created.reason === 'automation_disabled') {
        decision = {
          replyText: buildAutomationDisabledReply('agenda_booking'),
          newState: 'READY',
          contextPatch: buildAppointmentFlowResetPatch()
        };
      } else {
        const alternativeResult = await suggestAppointmentOptions({
          clinic,
          timing: {
            startAt: selectedSlot.startAt,
            dateISO: safeContext.appointmentSuggestionsForDate || selectedSlot.dateISO || null,
            timeWindow: safeContext.appointmentSuggestionsTimeWindow || null
          },
          count: 3
        });
        const alternatives = alternativeResult.suggestions;
        decision = {
          replyText: alternatives.length
            ? `Ese horario se ocupo recien.\n${buildSuggestionReply({
                dateISO:
                  alternativeResult.timing.dateISO ||
                  safeContext.appointmentSuggestionsForDate ||
                  selectedSlot.dateISO ||
                  null,
                timeWindow:
                  alternativeResult.timing.timeWindow ||
                  safeContext.appointmentSuggestionsTimeWindow ||
                  'afternoon',
                suggestions: alternatives,
                timezone: clinic.timezone || 'America/Argentina/Buenos_Aires'
              })}`
            : 'Ese horario se ocupó recién. Decime día y hora nuevamente, por ejemplo: lunes 10:30.',
          newState: alternatives.length ? 'SELECT_APPOINTMENT_SLOT' : 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: alternatives.length
            ? mergeContextPatches(
                buildAppointmentSuggestionContextPatch({
                  suggestions: alternatives,
                  dateISO:
                    alternativeResult.timing.dateISO ||
                    safeContext.appointmentSuggestionsForDate ||
                    selectedSlot.dateISO ||
                    null,
                  timeWindow:
                    alternativeResult.timing.timeWindow ||
                    safeContext.appointmentSuggestionsTimeWindow ||
                    null
                }),
                {
                  appointmentBookingName: bookingName || null,
                  appointmentBookingNote: bookingNote || null
                }
              )
            : buildEmptyAppointmentSuggestionPatch()
        };
      }
    }
  }

  if (!decision && currentState === 'CONFIRM_APPOINTMENT' && isAffirmativeSimple(inboundText)) {
    const timing = conversationRepo.resolveCandidateTiming(safeContext.appointmentCandidate || null);
    if (timing.startAt) {
      if (isReplaySafeConfirmation(safeContext, timing.startAt)) {
        decision = {
          replyText: `Listo, tu turno ya estaba reservado para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}.`,
          newState: 'READY',
          contextPatch: buildConfirmedContextPatch(timing.startAt)
        };
      }
    }

    if (!decision && timing.startAt) {
      const created = await createBotReservationFromSuggestion({
        clinic,
        conversation,
        contact,
        channel,
        safeContext,
        suggestion: {
          source: 'agenda',
          startAt: timing.startAt,
          endAt: timing.endAt || null,
          dateISO: timing.dateISO || null,
          displayText: timing.requestedText || formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')
        }
      });

      if (created.ok) {
        decision = {
          replyText: `Listo, tu turno quedó reservado para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}.`,
          newState: 'READY',
          contextPatch: buildConfirmedContextPatch(timing.startAt)
        };
      } else if (created.reason === 'automation_disabled') {
        decision = {
          replyText: buildAutomationDisabledReply('agenda_booking'),
          newState: 'READY',
          contextPatch: buildAppointmentFlowResetPatch()
        };
      }

      if (!decision) {
        const alternativeResult = await suggestAppointmentOptions({
          clinic,
          timing,
          count: 3
        });
        const alternatives = alternativeResult.suggestions;
        if (alternatives.length) {
          decision = {
            replyText: `Ese horario se ocupo recien.\n${buildSuggestionReply({
              dateISO:
                alternativeResult.timing.dateISO ||
                timing.dateISO ||
                safeContext.appointmentSuggestionsForDate ||
                null,
              timeWindow:
                alternativeResult.timing.timeWindow ||
                timing.timeWindow ||
                safeContext.appointmentSuggestionsTimeWindow ||
                'afternoon',
              suggestions: alternatives,
              timezone: clinic.timezone || 'America/Argentina/Buenos_Aires'
            })}`,
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: buildAppointmentSuggestionContextPatch({
              suggestions: alternatives,
              dateISO:
                alternativeResult.timing.dateISO ||
                timing.dateISO ||
                null,
              timeWindow:
                alternativeResult.timing.timeWindow ||
                timing.timeWindow ||
                null
            })
          };
        }
      }
    } else if (timing.timeWindow && timing.dateISO) {
      const suggestionResult = await suggestAppointmentOptions({
        clinic,
        timing,
        count: 3
      });
      if (suggestionResult.suggestions.length) {
        decision = {
          replyText: buildSuggestionReply({
            dateISO: suggestionResult.timing.dateISO || timing.dateISO,
            timeWindow: suggestionResult.timing.timeWindow || timing.timeWindow,
            suggestions: suggestionResult.suggestions,
            timezone: clinic.timezone || 'America/Argentina/Buenos_Aires'
          }),
          newState: 'SELECT_APPOINTMENT_SLOT',
          contextPatch: buildAppointmentSuggestionContextPatch({
            suggestions: suggestionResult.suggestions,
            dateISO: suggestionResult.timing.dateISO || timing.dateISO,
            timeWindow: suggestionResult.timing.timeWindow || timing.timeWindow
          })
        };
      }
    }
  }

  if (!decision && !qaAgendaBypassActive && !shouldPrioritizeAgendaFlow && botRoute.allowCommerce) {
    if (inboundLooksLikeCommerceCancel || inboundLooksLikeCommerce || commerceContextActive) {
      logInfo('legacy_menu_blocked_for_commerce', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        currentState,
        inboundText: normalizedInboundText,
        reason: inboundLooksLikeCommerceCancel
          ? 'commerce_cancel_intent'
          : inboundLooksLikeCommerce
            ? 'commerce_entry_intent'
            : 'commerce_context_active'
      });

      if (inboundLooksLikeCommerceCancel) {
        decision = {
          replyText: "Listo, cancelé este pedido en curso. Si querés, puedo mostrarte el catálogo otra vez o ayudarte a elegir algo distinto.",
          newState: 'IDLE',
          contextPatch: buildCommerceResetPatch()
        };
        decisionSource = 'commerce_cancel_block';
        logInfo('commerce_flow_cancelled_response_returned', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          currentState,
          inboundText: normalizedInboundText
        });
      } else {
        const products = buildCommerceCatalogPage(await listProductsByClinicId(conversation.clinicId));
        decision = {
          replyText: buildCommerceCatalogReply(products),
          newState: products.items.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
          contextPatch: buildCommerceResetPatch({
            commerceCatalog: products.items,
            commerceCatalogOffset: products.offset,
            commerceCatalogNextOffset: products.nextOffset,
            commerceCatalogTotal: products.total
          })
        };
        decisionSource = 'commerce_legacy_block';
      }
    }
  }

  const activeBotDomainPatch = buildActiveBotDomainPatch({
    decisionSource,
    botRoute,
    currentState,
    nextState: decision && decision.newState ? decision.newState : null,
    safeContext
  });

  if (decision && automationContextPatch) {
    decision.contextPatch = mergeContextPatches(decision.contextPatch || null, automationContextPatch);
  }
  if (decision && activeBotDomainPatch) {
    decision.contextPatch = mergeContextPatches(decision.contextPatch || null, activeBotDomainPatch);
  }

  if (!decision) {
    logInfo('legacy_clinic_flow_matched', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      reason: 'conversation_engine_fallback'
    });
    decision = decideReply({
      state: conversation.state,
      context: safeContext,
      inboundText
    });
    decisionSource = 'legacy_conversation_engine';
  }

  if (
    decision &&
    typeof decision.replyText === 'string' &&
    /1\)\s*Sacar turno[\s\S]*2\)\s*Precios[\s\S]*3\)\s*Direccion/i.test(decision.replyText)
  ) {
    logInfo('legacy_menu_generated', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      source: decisionSource || 'unknown',
      inboundText: normalizedInboundText
    });
  }

  const deterministicReplyText = String(decision && decision.replyText ? decision.replyText : '').trim();

  logInfo('reply_job_response_selected', {
    requestId,
    jobId: job.id,
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    nextState: decision && decision.newState ? decision.newState : null,
    source: decisionSource || 'unknown',
    inboundText: normalizedInboundText
  });

  let replyText = deterministicReplyText;
  let aiUsed = false;
  let aiFallbackUsed = false;
  let aiModel = null;
  let aiUsage = null;
  let aiAttempted = false;
  let aiSkipReason = null;
  const outboundMedia = Array.isArray(decision && decision.outboundMedia)
    ? decision.outboundMedia.filter((item) => item && item.type === 'image' && item.image && item.image.link)
    : [];
  const shouldSendTextWithMedia = outboundMedia.length === 0 || decision.sendTextWithMedia !== false;
  logInfo('conversation_reply_job_trace', {
    stage: 'decision_selected',
    requestId,
    jobId: job.id,
    inboundMessageId: inboundMessage.id,
    source: decisionSource || 'unknown',
    replyType: decision && decision.type ? decision.type : null,
    pendingOfferedActionBefore: summarizePendingOfferedActionForLog(safeContext.pendingOfferedAction),
    pendingOfferedActionAfter: summarizePendingOfferedActionForLog(decision && decision.contextPatch && decision.contextPatch.pendingOfferedAction),
    ...summarizeVisibleReplyForLog({
      replyText: deterministicReplyText,
      outboundMedia,
      sendTextWithMedia: decision && decision.sendTextWithMedia
    })
  });

  const aiEnabled = env.aiEnabled === true;
  const hasAiKey = !!String(env.openaiApiKey || '').trim();
  const aiEligibility = evaluateAiEligibility({
    jobType: job.type,
    state: conversation.state
  });
  const aiScope = isAiAllowedForScope({
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: conversation.channelId || channelId || null
  });

  if (!shouldSendTextWithMedia) {
    aiSkipReason = 'media_caption_only';
  } else if (decisionSource === 'automation') {
    aiSkipReason = 'automation_matched';
  } else if (aiEnabled && hasAiKey && aiEligibility.allowed && aiScope.ok) {
    const budget = reserveAiBudget(conversation.id);
    if (!budget.allowed) {
      aiSkipReason = budget.reason || 'rate_limited';
      if (aiSkipReason === 'rate_limited') {
        logWarn('ai_rate_limited', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          usedCount: budget.usedCount,
          max: AI_MAX_CALLS_PER_WINDOW,
          windowMs: AI_WINDOW_MS
        });
      }
    }
  } else if (!aiEligibility.allowed) {
    aiSkipReason = aiEligibility.reason;
  } else if (!aiScope.ok) {
    aiSkipReason = aiScope.reason;
  }

  if (decisionSource !== 'automation' && aiEnabled && hasAiKey && aiEligibility.allowed && aiScope.ok && !aiSkipReason) {
    aiAttempted = true;
    logInfo('ai_request_start', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      model: env.openaiModel
    });

    try {
      const historyMessages = await conversationRepo.getLastMessagesForAi(conversation.id, 10);
      const aiContext = buildAiMessages({
        conversation,
        historyMessages,
        inboundText
      });
      const aiResult = await generateReply({
        systemPrompt: aiContext.systemPrompt,
        messages: aiContext.messages,
        model: env.openaiModel,
        timeoutMs: env.openaiTimeoutMs
      });

      replyText = String(aiResult.replyText || '').trim() || deterministicReplyText;
      aiUsed = !!String(aiResult.replyText || '').trim();
      aiModel = aiResult.model || env.openaiModel;
      aiUsage = sanitizeAiUsage(aiResult.usage || null);

      logInfo('ai_request_success', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        model: aiModel,
        used: aiUsed
      });
    } catch (error) {
      aiFallbackUsed = true;
      replyText = deterministicReplyText;
      logWarn('ai_request_error', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        error: error.message
      });
      logWarn('ai_fallback_used', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id
      });
    }
  } else if (aiEnabled && hasAiKey && aiSkipReason) {
    logInfo('ai_skipped', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId || job.clinicId || null,
      channelId: conversation.channelId || channelId || null,
      state: conversation.state || null,
      reason: aiSkipReason
    });
  }

  if (!replyText) {
    throw new Error('Conversation engine returned empty replyText');
  }

  await conversationRepo.updateConversationState({
    conversationId: conversation.id,
    state: decision.newState || conversation.state || 'READY',
    contextPatch: decision.contextPatch || null
  });

  if (decision.newStage) {
    await updateConversationStage(conversation.id, decision.newStage);
  }

  const replyChannelCredentials = normalizeChannelSendContext(channel, {
    jobId: job.id,
    clinicId: conversation.clinicId || job.clinicId || null,
    conversationId: conversation.id
  });
  logInfo('worker_whatsapp_send_attempt', {
    requestId,
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: replyChannelCredentials.channelId,
    conversationId: conversation.id,
    jobId: job.id,
    phoneNumberId: replyChannelCredentials.phoneNumberId,
    hasAccessToken: true
  });

  let firstMediaSendResult = null;
  for (const mediaMessage of outboundMedia) {
    try {
      const mediaSendResult = await sendChannelScopedMessage(
        {
          to: contact.waId,
          image: {
            link: String(mediaMessage.image.link || '').trim(),
            caption: String(mediaMessage.image.caption || '').trim()
          }
        },
        {
          requestId,
          credentials: {
            ...replyChannelCredentials
          }
        }
      );
      if (!firstMediaSendResult) {
        firstMediaSendResult = mediaSendResult;
      }

      const mediaOutboundWrite = await conversationRepo.insertOutboundMessage({
        conversationId: conversation.id,
        waMessageId: mediaSendResult && mediaSendResult.messageId ? mediaSendResult.messageId : null,
        from: replyChannelCredentials.phoneNumberId,
        to: contact.waId || null,
        type: 'image',
        text: mediaMessage.image.caption || null,
        raw: {
          ...(mediaSendResult && mediaSendResult.raw ? mediaSendResult.raw : {}),
          message: {
            image: {
              link: String(mediaMessage.image.link || '').trim(),
              caption: String(mediaMessage.image.caption || '').trim() || null
            }
          },
          automation: {
            inboundMessageId: inboundMessage.id,
            inboundWaMessageId: waMessageId,
            source: decisionSource || null,
            jobId: job.id,
            productId: mediaMessage.productId || null
          }
        }
      });

      if (mediaOutboundWrite && mediaOutboundWrite.inserted === false) {
        logWarn('outbound_duplicate_waMessageId_skipped', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          waMessageId: mediaSendResult && mediaSendResult.messageId ? mediaSendResult.messageId : null
        });
      }
    } catch (error) {
      logWarn('worker_whatsapp_media_send_failed', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId || job.clinicId || null,
        channelId: replyChannelCredentials.channelId,
        productId: mediaMessage.productId || null,
        error: error.message,
        graphStatus: error.graphStatus || null,
        graphErrorCode: error.graphErrorCode || null,
        graphErrorSubcode: error.graphErrorSubcode || null
      });
    }
  }

  let sendResult = null;
  if (shouldSendTextWithMedia) {
    sendResult = await sendChannelScopedMessage(
      { to: contact.waId, text: replyText },
      {
        requestId,
        credentials: {
          ...replyChannelCredentials
        }
      }
    );

    const outboundWrite = await conversationRepo.insertOutboundMessage({
      conversationId: conversation.id,
      waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
      from: replyChannelCredentials.phoneNumberId,
      to: contact.waId || null,
      type: 'text',
      text: replyText,
      raw: {
        ...(sendResult && sendResult.raw ? sendResult.raw : {}),
        automation: {
          inboundMessageId: inboundMessage.id,
          inboundWaMessageId: waMessageId,
          source: decisionSource || null,
          jobId: job.id
        },
        ai: {
          enabled: aiEnabled && hasAiKey,
          attempted: aiAttempted,
          used: aiUsed,
          model: aiModel,
          usage: aiUsage,
          fallbackUsed: aiFallbackUsed,
          skipReason: aiSkipReason
        }
      }
    });

    if (outboundWrite && outboundWrite.inserted === false) {
      logWarn('outbound_duplicate_waMessageId_skipped', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
      });
    }
  }
  const effectiveSendResult = sendResult || firstMediaSendResult || null;

  logInfo('conversation_reply_processed', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: conversation.channelId || channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    waMessageId,
    graphStatus: effectiveSendResult && effectiveSendResult.status ? effectiveSendResult.status : null,
    outboundMessageId: effectiveSendResult && effectiveSendResult.messageId ? effectiveSendResult.messageId : null
  });
}

async function processJob(job) {
  processingCount += 1;
  try {
    if (job.type === 'conversation_reply') {
      await processConversationReplyJob(job);
      await markJobDone(job.id);
      return;
    }

    if (job.type === 'PROCESS_INBOUND_MESSAGE') {
      await processInboundJob(job);
      await markJobDone(job.id);
      return;
    }

    if (job.type === 'whatsapp_send' || job.type === 'whatsapp_template_send') {
      const requestId = `worker:${job.id}`;
      const payload = parseJobPayload(job.payload);
      const payloadType = String(payload.type || '').trim().toLowerCase();
      const isTemplateJob = job.type === 'whatsapp_template_send' || payloadType === 'template';
      const payloadChannelId = String(payload.channelId || job.channelId || '').trim();
      const originalToRaw = String(payload.to || '');
      const originalTo = normalizeDigitsOnly(originalToRaw);
      const to = normalizeWhatsAppTo(originalTo);
      const toLast4 = to ? to.slice(-4) : null;
      const toLen = to ? to.length : 0;
      const originalLast4 = originalTo ? originalTo.slice(-4) : null;
      const originalLen = originalTo ? originalTo.length : 0;
      const text = String(payload.text || 'ClinicAI test message').trim() || 'ClinicAI test message';

      payload.to = to;

      // Extra visibility: identify common AR mobile prefix 549 in raw input (without logging full number)
      const rawDigits = normalizeDigitsOnly(originalToRaw);
      logInfo('worker_to_input_detected', {
        requestId,
        jobId: job.id,
        rawHas549Prefix: rawDigits.startsWith('549'),
        rawLen: rawDigits.length,
        rawLast4: rawDigits ? rawDigits.slice(-4) : null
      });

      logInfo('worker_to_normalized', {
        requestId,
        jobId: job.id,
        originalLast4,
        normalizedLast4: toLast4,
        originalLen,
        normalizedLen: toLen
      });

      logInfo('worker_whatsapp_send_start', {
        requestId,
        jobId: job.id,
        sendType: isTemplateJob ? 'template' : 'text',
        clinicId: job.clinicId || null,
        channelId: payloadChannelId || null,
        phoneNumberId: null,
        toLast4,
        toLen
      });

      if (!payloadChannelId) {
        throw new Error('Missing channelId for tenant-scoped WhatsApp job');
      }

      if (!/^\d{8,15}$/.test(to)) {
        throw new Error('Invalid "to" for whatsapp_send job. Expected 8..15 digits');
      }

      const channel = await findChannelById(payloadChannelId);
      const channelCredentials = normalizeChannelSendContext(channel, {
        jobId: job.id,
        clinicId: job.clinicId || null,
        conversationId: String(payload.conversationId || '').trim() || null
      });

      logInfo('worker_whatsapp_send_attempt', {
        requestId,
        clinicId: job.clinicId || channelCredentials.clinicId,
        channelId: channelCredentials.channelId,
        conversationId: String(payload.conversationId || '').trim() || null,
        jobId: job.id,
        phoneNumberId: channelCredentials.phoneNumberId,
        hasAccessToken: true
      });

      // Ultra-defensive: ensure final `to` is normalized right before sending
      const finalTo = normalizeWhatsAppTo(normalizeDigitsOnly(to));

      const credentials = {
        channelId: channelCredentials.channelId,
        accessToken: channelCredentials.accessToken,
        phoneNumberId: channelCredentials.phoneNumberId,
        clinicId: channelCredentials.clinicId,
        provider: channelCredentials.provider,
        status: channelCredentials.status,
        wabaId: channelCredentials.wabaId
      };
      let sendResult = null;

      if (isTemplateJob) {
        const templateName = String(payload.templateName || (payload.template && payload.template.name) || '').trim();
        const languageCode = String(
          payload.languageCode || (payload.template && payload.template.languageCode) || 'es'
        ).trim() || 'es';
        const components = Array.isArray(payload.components)
          ? payload.components
          : (payload.template && Array.isArray(payload.template.components) ? payload.template.components : []);

        if (!templateName) {
          throw new Error('templateName is required for template send jobs');
        }

        sendResult = await sendChannelScopedMessage(
          {
            to: finalTo,
            templateName,
            languageCode,
            components
          },
          {
            requestId,
            credentials
          }
        );
      } else {
        sendResult = await sendChannelScopedMessage(
          { to: finalTo, text },
          {
            requestId,
            credentials
          }
        );
      }

      const payloadConversationId = String(payload.conversationId || '').trim();
      if (payloadConversationId) {
        const outboundWrite = await conversationRepo.insertOutboundMessage({
          conversationId: payloadConversationId,
          waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
          from: channelCredentials.phoneNumberId,
          to: finalTo,
          type: isTemplateJob ? 'template' : 'text',
          text: isTemplateJob ? null : text,
          raw: sendResult && sendResult.raw ? sendResult.raw : {}
        });

        if (outboundWrite && outboundWrite.inserted === false) {
          logWarn('outbound_duplicate_waMessageId_skipped', {
            requestId,
            jobId: job.id,
            conversationId: payloadConversationId,
            waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
          });
        }
      }

      logInfo('worker_whatsapp_send_ok', {
        requestId,
        jobId: job.id,
        sendType: isTemplateJob ? 'template' : 'text',
        clinicId: job.clinicId || channelCredentials.clinicId,
        channelId: channelCredentials.channelId,
        phoneNumberId: channelCredentials.phoneNumberId,
        toLast4,
        toLen,
        outboundMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
      });

      await markJobDone(job.id);
      return;
    }

    await markJobDone(job.id);
    logWarn('worker_unknown_job_type_marked_done', {
      requestId: `worker:${job.id}`,
      jobId: job.id,
      type: job.type
    });
  } catch (error) {
    const result = await requeueOrFailJob(job, error);
    logWarn('worker_job_failed', {
      requestId: `worker:${job.id}`,
      jobId: job.id,
      attemptsAtFailure: Number(job.attempts || 0),
      clinicId: job.clinicId,
      channelId: job.channelId,
      type: job.type,
      statusAfterFailure: result.status,
      nextRunAt: result.nextRunAt || null,
      graphErrorCode:
        error && error.graphErrorCode !== undefined && error.graphErrorCode !== null
          ? Number(error.graphErrorCode)
          : null,
      error: error.message,
      reason:
        error && error.code
          ? error.code
          : (error && error.graphErrorCode !== undefined && error.graphErrorCode !== null ? 'GRAPH_SEND_FAILED' : null),
      missingChannelAccessToken: error && error.code === 'CHANNEL_ACCESS_TOKEN_MISSING',
      missingChannelPhoneNumberId: error && error.code === 'CHANNEL_PHONE_NUMBER_ID_MISSING'
    });
  } finally {
    processingCount -= 1;
  }
}

async function pollOnce() {
  if (polling || stopped) {
    return;
  }

  polling = true;
  try {
    logInfo('worker_poll_tick', {
      workerId: WORKER_ID,
      now: new Date().toISOString()
    });

    const reminderStats = await processDueAppointmentReminders();
    if (reminderStats.candidates || reminderStats.sent || reminderStats.skipped || reminderStats.duplicatesBlocked) {
      logInfo('appointment_reminder_sweep_result', {
        workerId: WORKER_ID,
        ...reminderStats
      });
    }

    await releaseExpiredHolds();
    await maybeRunArchivedContactCleanup({ workerId: WORKER_ID });
    const jobs = await claimJobs({ workerId: WORKER_ID, limit: BATCH_SIZE });

    logInfo('worker_poll_result', {
      workerId: WORKER_ID,
      found: jobs.length,
      ids: jobs.map((j) => j.id),
      types: jobs.map((j) => j.type),
      statuses: jobs.map((j) => j.status),
      nextRunAt: jobs.map((j) => j.nextRunAt || j.runAt || null)
    });

    for (const job of jobs) {
      if (stopped) {
        break;
      }

      logInfo('worker_job_picked', {
        workerId: WORKER_ID,
        jobId: job.id,
        type: job.type,
        status: job.status
      });

      await processJob(job);
    }
  } catch (error) {
    logWarn('worker_poll_failed', {
      workerId: WORKER_ID,
      error: error.message
    });
  } finally {
    polling = false;
  }
}

function scheduleNextPoll() {
  if (stopped) {
    return;
  }

  timer = setTimeout(async () => {
    await pollOnce();
    scheduleNextPoll();
  }, POLL_MS);
}

function waitForDrain(timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startedAt;
      if ((!polling && processingCount === 0) || elapsed >= timeoutMs) {
        return resolve();
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function shutdown(signal) {
  if (stopped) {
    return;
  }

  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  logInfo('worker_shutdown_requested', {
    workerId: WORKER_ID,
    signal,
    polling,
    processingCount
  });

  await waitForDrain();

  logInfo('worker_stopped', {
    workerId: WORKER_ID,
    signal
  });

  process.exit(0);
}

function startWorker() {
  if (started) {
    logWarn('worker_start_skipped_already_running', {
      workerId: WORKER_ID
    });
    return;
  }

  started = true;
  const dbInfo = sanitizeDatabaseUrl(env.databaseUrl || '');
  logInfo('worker_env_loaded', {
    dbSource: 'DATABASE_URL',
    hasDatabaseUrl: !!env.databaseUrl,
    dbHostname: dbInfo ? String(dbInfo.hostPort || '').split(':')[0] || null : null,
    dbDatabase: dbInfo ? dbInfo.dbname : null,
    hasToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null
  });
  logInfo('worker_started', {
    workerId: WORKER_ID,
    pollMs: POLL_MS,
    batchSize: BATCH_SIZE,
    daysAhead: DAYS_AHEAD,
    holdMinutes: HOLD_MINUTES
  });
  logInfo('WORKER_IDENTITY', {
    marker: 'AGENDA_BYPASS_V2',
    workerId: WORKER_ID,
    pid: process.pid,
    timestamp: new Date().toISOString()
  });

  pollOnce()
    .catch((error) => {
      logWarn('worker_first_poll_failed', { workerId: WORKER_ID, error: error.message });
    })
    .finally(() => {
      scheduleNextPoll();
    });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logWarn('worker_shutdown_failed', { workerId: WORKER_ID, signal: 'SIGINT', error: error.message });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logWarn('worker_shutdown_failed', { workerId: WORKER_ID, signal: 'SIGTERM', error: error.message });
      process.exit(1);
    });
  });
}

if (require.main === module) {
  startWorker();
}

module.exports = {
  startWorker,
  __private__: {
    hasAgendaContext,
    hasDemoContext,
    isPublicDemoExperienceIntent,
    resolveBotDomainRoute,
    buildActiveBotDomainPatch,
    buildDemoExperienceReply,
    buildDemoCommercialCloseReply,
    parseDemoCommercialCloseOption,
    buildDemoLeadSummary,
    buildDemoPaymentReply,
    resolveCommerceDecision,
    detectIntent,
    isAffirmativeIntent,
    isNegativeIntent,
    isClarificationIntent,
    isGreetingIntent,
    isThanksIntent,
    isCommerceEntryIntent,
    isCommercialOfferIntent,
    isPlanRecommendationIntent,
    isPlanPricingIntent,
    isPlanWorthItIntent,
    isCurrentMessageAskingForPlanRecommendation,
    isCommercialSoftFollowUpIntent,
    isLoyaltyIntent,
    detectCommercialIntent,
    detectCommercialPlanObjection,
    detectCommercialIndecisionIntent,
    detectCommercialNextStepIntent,
    detectBusinessRecommendationContext,
    parseTransferPaymentIntent,
    buildCommercialPlanObjectionReply,
    buildSafeCommercialIntentReply,
    buildCommercialShortMemoryReply,
    getActiveCommercialShortMemory,
    getActiveCommercialDiscoveryPending,
    getActiveBusinessRecommendationContext,
    getActiveCommercialPlanContext,
    getPendingPlanComparisonAction,
    resolveCommercialShortMemoryFollowUpType,
    parseCommercialTeamSizeAnswer,
    parseCommercialWhatsAppAccountTypeAnswer,
    parseCommercialOfferTypeAnswer,
    resolveCommercialDiscoveryPendingReply,
    buildIntelligentFallbackReply,
    buildCommercialGreetingReply,
    buildCommercialIndecisionReply,
    hasWeakCommercialSignal,
    detectWeakCommercialSignal,
    normalizeAiAssistBusinessType,
    normalizeAiAssistTeamSizeSignal,
    normalizeAiAssistPainPoints,
    buildAiAssistSalesContext,
    canUseSafeLowConfidenceAiAssistDecision,
    shouldInvokeAiAssist,
    shouldUseWeakSignalCommercialFallback,
    buildWeakSignalCommercialFallback,
    resolveAiAssistDecision,
    buildLoyaltyWhatsAppReply,
    buildLoyaltyContextPatch,
    getPendingLoyaltyOfferedAction,
    resolveLoyaltyDecision,
    isLoyaltyFollowUpIntent,
    isPendingOfferedActionIntent,
    buildLoyaltyProgramExplanationReply,
    buildLoyaltyRecommendedRewardReply,
    resolveLoyaltyFollowUpDecision,
    resolveActiveAgendaGuardDecision,
    resolveAgendaTimingDecision,
    createBotReservationFromSuggestion,
    buildAppointmentFlowResetPatch,
    buildConfirmedContextPatch,
    formatSlotForHuman,
    processDueAppointmentReminders,
    buildAutomationDisabledReply
  }
};


