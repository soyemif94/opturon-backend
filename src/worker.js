require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { DateTime } = require('luxon');
const env = require('./config/env');
const { withTransaction } = require('./db/client');
const { logInfo, logWarn, logError } = require('./utils/logger');
const { findChannelById } = require('./repositories/tenant.repository');
const { updateClinicBotRuntimeConfigById } = require('./repositories/tenant.repository');
const { findContactById, findContactByIdAndClinicId, updateContact } = require('./repositories/contact.repository');
const {
  findConversationById,
  markLastOutbound,
  updateConversationStatus,
  updateConversationStage
} = require('./repositories/conversation.repository');
const { insertOutboundMessage, getMessageById } = require('./repositories/message.repository');
const { sendChannelScopedMessage } = require('./whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('./whatsapp/normalize-phone');
const conversationRepo = require('./conversations/conversation.repo');
const { decideReply } = require('./conversations/conversation.engine');
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
  ensureSlotsForDateRange,
  listAvailableSlots,
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
const {
  suggestClinicAgendaSlots,
  createClinicAgendaBotReservation
} = require('./services/portal-agenda.service');

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
const aiBudget = new Map();

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
  return String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?]+$/g, '')
    .trim();
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
  const text = normalizeText(rawText);

  const appointmentWords = /(turno|cita|agenda|sacar turno|reservar|agendar)/i;
  const urgentWords = /(dolor|urgencia|sangrado|inflamado|se me sali[oó]|me duele mucho)/i;
  const pricingWords = /(precio|cuanto|cu[aá]nto|valor|costo)/i;
  const humanWords = /(humano|recepcion|persona|llamar|asesor)/i;

  if (urgentWords.test(text)) return 'urgent';
  if (humanWords.test(text)) return 'human';
  if (appointmentWords.test(text)) return 'appointment';
  if (pricingWords.test(text)) return 'pricing';
  return 'unknown';
}

function isGreeting(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return ['hola', 'buenas', 'buen dia', 'buen día', 'hello', 'holi'].includes(text);
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
    if (safe === 'sales' || safe === 'agenda' || safe === 'hybrid') {
      return safe;
    }
  }

  return 'sales';
}

function hasAgendaContext(safeContext) {
  const context = safeContext && typeof safeContext === 'object' ? safeContext : {};
  return Boolean(
    context.appointmentCandidate ||
      context.appointmentStatus ||
      context.appointmentLastCancelledStartAt ||
      context.appointmentSuggestionsForDate ||
      (Array.isArray(context.appointmentSuggestions) && context.appointmentSuggestions.length > 0)
  );
}

function isExplicitCommerceTrigger(rawText) {
  const text = normalizeCommandText(rawText);
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
    triggers.some((trigger) => text.includes(normalizeCommandText(trigger))) ||
    isPlanComparisonIntent(text) ||
    isPlanRecommendationIntent(text) ||
    isPlanPricingIntent(text)
  );
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
  const explicitDomain = String(safeContext && safeContext.activeBotDomain ? safeContext.activeBotDomain : '').trim().toLowerCase();
  if (BOT_ROUTER_APPOINTMENT_STATES.has(currentState) || hasAgendaContext(safeContext)) {
    return 'agenda';
  }
  if (BOT_ROUTER_COMMERCE_STATES.has(currentState) || hasCommerceContext(safeContext)) {
    return 'commerce';
  }
  if (explicitDomain === 'agenda' || explicitDomain === 'commerce') {
    return explicitDomain;
  }
  return null;
}

function resolveBotDomainRoute({
  clinic,
  currentState,
  safeContext,
  inboundText,
  intent,
  managementIntent,
  inboundLooksLikeCommerce,
  inboundLooksLikeCommerceCancel
}) {
  const botMode = resolveClinicBotMode(clinic);
  const configuredBotActive = Boolean(getActiveGeneratedBotConfig(clinic));
  const botFlowLock = normalizeConversationBotFlowLock(safeContext);
  const overrideDomain = normalizeConversationBotDomainOverride(safeContext);
  const activeDomain = resolveConversationDomain({ currentState, safeContext });
  const agendaIntent = looksLikeAgendaIntent({ inboundText, intent, managementIntent });
  const runtimeConfiguredCommerceIntent =
    configuredBotActive &&
    (
      isGreeting(inboundText) ||
      isConfiguredBotOfferIntent(inboundText) ||
      isConfiguredBotRecommendationIntent(inboundText) ||
      Boolean(parseActiveBotRuntimeEditIntent(inboundText)) ||
      Boolean(parseTransferPaymentIntent(inboundText))
    );
  const explicitCommerceIntent =
    inboundLooksLikeCommerce ||
    inboundLooksLikeCommerceCancel ||
    intent === 'pricing' ||
    isExplicitCommerceTrigger(inboundText) ||
    runtimeConfiguredCommerceIntent;

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
  if (!text) return false;
  return (
    text === 'hola' ||
    text === 'buenas' ||
    text === 'buen dia' ||
    text === 'buenas tardes' ||
    text === 'buenas noches' ||
    text === 'quiero hacer un pedido' ||
    text === 'quiero comprar' ||
    text === 'productos' ||
    text === 'catalogo' ||
    text === 'comprar' ||
    text === 'pedido' ||
    text === 'pedidos'
  );
}

const COMMERCE_PRODUCTS_PAGE_SIZE = 10;
const COMMERCE_MORE_KEYWORDS = new Set(['mas', 'más', 'ver mas', 'ver más', 'mostrar mas', 'mostrar más', 'siguiente']);
const COMMERCE_UNCATEGORIZED_CATEGORY_ID = '__uncategorized__';

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

function buildPlanSalesCta(text = 'Si querés, te recomiendo uno según lo que buscás o te muestro el que más te convenga.') {
  return text;
}

function isPlanComparisonIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;

  return [
    'cual me conviene',
    'cuál me conviene',
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
    text.includes('basico') ||
    text.includes('básico')
  ) {
    return 'starter';
  }

  if (
    text.includes('vender mas') ||
    text.includes('vender más') ||
    text.includes('automatizar mejor') ||
    text.includes('mas completo') ||
    text.includes('más completo') ||
    text.includes('quiero crecer')
  ) {
    return 'growth';
  }

  if (
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
    'cual recomendas',
    'cuál recomendás',
    'cual recomiendan',
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

function buildPlanComparisonReply(products) {
  const orderedPlans = getOrderedPlanProducts(products);
  if (!orderedPlans.length) {
    return 'Puedo ayudarte a comparar los planes de Opturon, pero ahora mismo no encuentro planes activos para mostrarte.';
  }

  return [
    'Te comparo los planes de Opturon 👇',
    '',
    ...orderedPlans.slice(0, 3).map((product) => {
      const { headline } = extractPlanDescription(product);
      return `• ${product.name} — ${formatMoney(product.price, product.currency)}: ${headline}`;
    }),
    '',
    'Si querés una recomendación rápida, Plan Crecimiento suele ser el más conveniente para negocios que quieren vender más por WhatsApp.',
    '',
    buildPlanSalesCta()
  ].join('\n');
}

function buildPlanRecommendationReply(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const { headline, featureLines } = extractPlanDescription(safeProduct);

  return [
    `Te recomiendo ${safeProduct.name || 'este plan'}.`,
    '',
    headline,
    '',
    ...(featureLines.length
      ? [
          'Incluye:',
          ...featureLines.map((line) => `- ${line}`),
          ''
        ]
      : []),
    buildPlanSalesCta('Si querés, te muestro ese plan o lo dejamos listo para avanzar.')
  ].join('\n');
}

function buildPlanDetailReply(product, { includePrice = true, includeFeatures = true } = {}) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const { headline, featureLines } = extractPlanDescription(safeProduct);

  return [
    `${safeProduct.name || 'Este plan'}${includePrice ? ` cuesta ${formatMoney(safeProduct.price, safeProduct.currency)}` : ''}.`,
    '',
    headline,
    '',
    ...(includeFeatures && featureLines.length
      ? [
          'Incluye:',
          ...featureLines.map((line) => `- ${line}`),
          ''
        ]
      : []),
    buildPlanSalesCta('Si querés, te muestro este plan o lo dejamos listo para avanzar.')
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
    ...products.map((product) => `${formatCommerceIndex(product.index)} ${product.name} — ${formatMoney(product.price, product.currency)}`),
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
    safeContext.commerceCategorySelection === true ||
    safeContext.commerceLastOrderId
  );
}

function buildCommerceResetPatch(extra = {}) {
  return {
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
  const safeProduct = product && typeof product === 'object' ? product : {};
  const rawDescription = String(safeProduct.description || '').trim();
  const descriptionLines = rawDescription
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = descriptionLines[0] || 'Es una gran opción para empezar a automatizar ventas con Opturon.';
  const featureLines = descriptionLines.slice(1, 4);

  return [
    `Elegiste el ${safeProduct.name || 'plan'}.`,
    '',
    headline,
    '',
    ...(featureLines.length
      ? [
          'Incluye:',
          ...featureLines.map((line) => `- ${line}`),
          ''
        ]
      : []),
    'Si querés avanzar, lo dejamos listo para activar ahora.',
    '',
    '¿Querés continuar con este plan? Escribí "confirmar" para seguir.'
  ].join('\n');
}

function buildCommerceUndoReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];

  if (!safeItems.length) {
    return [
      'Listo 👍',
      '',
      'Saque el ultimo producto agregado.',
      '',
      'Tu carrito quedo vacio.',
      'Escribi "productos" para ver el catalogo o mandame otro numero para seguir.'
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
  return 'Tu carrito está vacío por ahora. Escribí "productos" para ver el catálogo.';
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
    'Escribí "productos" para ver el catálogo y empezar de nuevo.'
  ].join('\n');
}

function buildCommerceAlreadyEmptyCartReply() {
  return 'Tu carrito ya está vacío. Escribí "productos" para ver el catálogo.';
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
      'Te muestro cómo funciona Opturon en la práctica.',
      '',
      'Imaginá que un cliente te escribe por WhatsApp preguntando por tus productos 👇',
      '',
      'Cliente:',
      '"Hola, qué opciones tenés?"',
      '',
      'Escribí "seguir" y te muestro cómo respondería Opturon.'
    ].join('\n');
  }

  if (safeStep === 2) {
    return [
      'Bot:',
      '"Hola 👋 Te ayudo a elegir.',
      '',
      'Estos son algunos productos disponibles:',
      '1️⃣ Producto A',
      '2️⃣ Producto B',
      '3️⃣ Producto C"',
      '',
      'Escribí "seguir" y avanzamos.'
    ].join('\n');
  }

  if (safeStep === 3) {
    return [
      'Cliente:',
      '"Busco algo económico"',
      '',
      'Escribí "seguir" y te muestro cómo sigue la conversación.'
    ].join('\n');
  }

  if (safeStep === 4) {
    return [
      'Bot:',
      '"Si querés algo simple para empezar, te recomiendo Producto A.',
      '',
      'Es una buena opción para arrancar sin complicarte y ya te queda lista para avanzar hoy.',
      '',
      'Si querés, te lo dejo reservado ahora mismo."',
      '',
      'Escribí "seguir" para ver el cierre.'
    ].join('\n');
  }

  return [
    'Esto es lo que hace Opturon automáticamente por vos:',
    '- responde',
    '- recomienda',
    '- guía la conversación',
    '- ayuda a cerrar ventas',
    '',
    '¿Querés que lo activemos en tu negocio?',
    '',
    'Podés escribir:',
    '- "activar"',
    '- "volver"',
    '- "ver planes"'
  ].join('\n');
}

function isDemoAdvanceIntent(input) {
  const normalized = normalizeCommandText(input);
  if (!normalized) return false;

  return [
    'seguir',
    'ok',
    'dale',
    'continuar',
    'siguiente',
    'si',
    'bueno',
    'genial'
  ].includes(normalized) || normalized.length <= 20;
}

function isDemoActivateIntent(input) {
  const normalized = normalizeCommandText(input);
  return [
    'activar',
    'activar ahora',
    'quiero activar',
    'lo activamos',
    'avanzar',
    'seguir con la activacion'
  ].includes(normalized);
}

function isDemoBackIntent(input) {
  const normalized = normalizeCommandText(input);
  return normalized === 'volver' || normalized === 'volver atras';
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
  return 'Si querés, puedo adaptarlo a tu negocio, hacerlo más formal, más vendedor, más simple, cambiar la bienvenida o ajustar el mensaje final.';
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
  return config;
}

function getClinicTransferConfig(clinic) {
  const settings = parseClinicSettingsObject(clinic);
  const config = settings && settings.bot && settings.bot.transferConfig && typeof settings.bot.transferConfig === 'object'
    ? settings.bot.transferConfig
    : null;
  if (!config || config.enabled !== true) return null;
  return {
    ...config,
    alias: String(config.alias || '').trim(),
    cbu: String(config.cbu || '').trim(),
    titular: String(config.titular || config.holderName || '').trim(),
    bank: String(config.bank || config.bankName || '').trim(),
    instructions: String(config.instructions || '').trim(),
    holderName: String(config.holderName || config.titular || '').trim(),
    bankName: String(config.bankName || config.bank || '').trim()
  };
}

function hasConfiguredTransferData(transferConfig) {
  if (!transferConfig || typeof transferConfig !== 'object') return false;
  return Boolean(
    String(transferConfig.alias || '').trim() ||
    String(transferConfig.cbu || '').trim() ||
    String(transferConfig.titular || '').trim() ||
    String(transferConfig.bank || '').trim() ||
    String(transferConfig.holderName || '').trim() ||
    String(transferConfig.bankName || '').trim()
  );
}

function parseTransferPaymentIntent(input) {
  const text = normalizeCommandText(input);
  if (!text) return null;

  if (
    text.includes('ya pague') ||
    text.includes('ya pagué') ||
    text.includes('te mando el comprobante') ||
    text.includes('te envio el comprobante') ||
    text.includes('te envié el comprobante') ||
    text.includes('mando comprobante') ||
    text.includes('envio comprobante') ||
    text.includes('envié comprobante')
  ) {
    return 'proof_notice';
  }

  if (
    text.includes('quiero pagar') ||
    text.includes('te transfiero') ||
    text.includes('pasame alias') ||
    text.includes('pasame cbu') ||
    text.includes('como hago el pago') ||
    text.includes('cómo hago el pago') ||
    text.includes('pagar por transferencia') ||
    text.includes('transferencia')
  ) {
    return 'request';
  }

  return null;
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
  const lines = [
    'Perfecto.',
    '',
    'Podés pagar por transferencia con estos datos:'
  ];

  if (transferConfig.alias) lines.push(`- Alias: ${String(transferConfig.alias).trim()}`);
  if (transferConfig.cbu) lines.push(`- CBU: ${String(transferConfig.cbu).trim()}`);
  if (transferConfig.titular || transferConfig.holderName) lines.push(`- Titular: ${String(transferConfig.titular || transferConfig.holderName).trim()}`);
  if (transferConfig.bank || transferConfig.bankName) lines.push(`- Banco: ${String(transferConfig.bank || transferConfig.bankName).trim()}`);
  if (transferConfig.reference) lines.push(`- Referencia: ${String(transferConfig.reference).trim()}`);

  lines.push('');
  lines.push(
    String(transferConfig.instructions || '').trim() ||
    'Cuando hagas la transferencia, mandame el comprobante por acá y lo dejo registrado.'
  );

  return lines.join('\n');
}

function buildTransferMissingConfigReply() {
  return [
    'Todavía no tengo datos de transferencia configurados para pasarte por acá.',
    '',
    'Si querés, te puede ayudar alguien del equipo para terminar el cobro.'
  ].join('\n');
}

function buildTransferProofRequestReply() {
  return [
    'Perfecto.',
    '',
    'Mandame la foto o el archivo del comprobante y lo dejo registrado para validación.'
  ].join('\n');
}

function buildTransferPendingValidationReply() {
  return [
    'Recibí tu comprobante.',
    '',
    'Lo dejé registrado y quedó pendiente de validación.',
    'Te aviso por acá cuando esté validado.'
  ].join('\n');
}

function buildTransferPendingStatusReply() {
  return [
    'Tu comprobante ya quedó registrado.',
    '',
    'Por ahora sigue pendiente de validación. Ni bien se revise, te avisamos por acá.'
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
      'Tu carrito quedó vacío.',
      'Escribí "productos" para ver el catálogo y empezar de nuevo.'
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
        ? `Ese producto ya no esta disponible.\n\n${buildCommerceCatalogReply(products)}`
        : 'Ese producto ya no esta disponible y no hay otros productos activos para pedir ahora mismo.',
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
      replyText: 'Lo siento, no tenemos suficiente stock de ese producto en este momento.',
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
      replyText: 'Lo siento, no tenemos suficiente stock de ese producto en este momento.',
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
    newState: 'WAITING_PRODUCT_SELECTION',
    contextPatch: buildCommerceResetPatch({
      commerceCatalog: catalogFromContext.length
        ? catalogFromContext
        : buildCommerceCatalogPage(await listProductsByClinicId(conversation.clinicId)).items,
      commerceCartItems: updatedCartItems,
      commerceLastAddedItem: {
        productId: String(latestProduct.id || '').trim() || null,
        quantity: effectiveQuantity
      }
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
        ? 'No pude agregar esos productos. Elegi numeros validos de la lista o escribi "ayuda" si queres ver las opciones.'
        : 'No hay productos disponibles ahora mismo. Escribi "productos" para intentar de nuevo.',
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
      replyText: "Entendido. Cancele este pedido en curso. Si queres, escribi 'productos' para ver el catalogo otra vez.",
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
        replyText: "No encontre ese pedido para cancelarlo. Si queres, escribi 'productos' para ver el catalogo otra vez.",
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: null,
          commerceLastOrderAt: null
        })
      };
    }

    return {
      replyText: 'No pude cancelar tu pedido en este momento. Intenta nuevamente en unos minutos.',
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
    replyText: "Entendido. Cancele tu pedido y devolvi el stock reservado. Si queres, escribi 'productos' para ver el catalogo otra vez.",
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

    return {
      replyText,
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
        commerceSuggestedProductName: suggestedProduct && suggestedProduct.name ? String(suggestedProduct.name) : null
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

  const cancelDecision = await resolveCommerceCancellation({
    conversation,
    inboundText,
    currentState,
    safeContext
  });
  if (cancelDecision) {
    return cancelDecision;
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
  const transferContext = safeContext.transferPayment && typeof safeContext.transferPayment === 'object'
    ? safeContext.transferPayment
    : null;
  const transferOrderId = String(
    (transferContext && transferContext.orderId) ||
    (safeContext && safeContext.commerceLastOrderId) ||
    ''
  ).trim() || null;
  const transferFlowActive = currentState === 'PAYMENT_TRANSFER' || Boolean(transferContext && transferContext.orderId);
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

  if (transferOrderId && isInboundPaymentProofMessage(inboundMessage) && transferFlowActive) {
    const order = await ensureOrderPendingForTransfer();
    const proofMetadata = extractPaymentProofMetadata(inboundMessage);
    return {
      replyText: buildTransferPendingValidationReply(),
      newState: 'PAYMENT_TRANSFER',
      newStage: 'payment_pending_validation',
      contextPatch: {
        commerceLastOrderId: transferOrderId,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : new Date().toISOString(),
        transferPayment: {
          orderId: transferOrderId,
          status: 'payment_pending_validation',
          paymentMethod: 'bank_transfer',
          destinationId: transferConfig && transferConfig.destinationId ? transferConfig.destinationId : null,
          requestedAt: transferContext && transferContext.requestedAt ? transferContext.requestedAt : new Date().toISOString(),
          proofSubmittedAt: new Date().toISOString(),
          proofMessageId: inboundMessage && inboundMessage.id ? inboundMessage.id : null,
          proofMetadata,
          orderPaymentStatus: order && order.paymentStatus ? order.paymentStatus : 'pending'
        }
      }
    };
  }

  if (transferIntent === 'request' || transferIntent === 'proof_notice') {
    if (!transferOrderId) {
      return {
        replyText: 'Primero dejemos tu plan o pedido confirmado, y ahí sí te paso cómo seguir con el pago.',
        newState: currentState || 'READY',
        contextPatch: null
      };
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
    if (transferContext && transferContext.status === 'payment_pending_validation') {
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
        replyText: buildOnboardingReply(5),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(5),
        contextPatch: {
          onboarding: {
            ...onboarding,
            channel: normalizeOnboardingChannel(answer) || answer
          },
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
      replyText: buildOnboardingReply(5),
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

    if (isDemoActivateIntent(inboundText)) {
      return {
        replyText: buildOnboardingReply(1),
        newState: 'ONBOARDING',
        newStage: getOnboardingStageKey(1),
        contextPatch: buildCommerceResetPatch({
          commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
          commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null,
          commerceActivationOfferState: 'onboarding',
          commerceActivationChoice: '1',
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
        replyText: `No encontré ese ítem en tu carrito. Te muestro cómo quedó:\n\n${buildCommerceCartSummaryReply(cartItems)}`,
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
        replyText: 'Todavia no hay productos en tu carrito. Escribi "productos" para ver el catalogo.',
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
        replyText: 'Tu carrito está vacío por ahora. Escribí "productos" para ver el catálogo.',
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
            'No pude confirmar tu pedido porque uno o mas productos ya no tienen stock suficiente.\n\nEscribi "productos" para ver el catalogo actualizado.',
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
        replyText: 'No pude registrar tu pedido en este momento. Intenta nuevamente en unos minutos.',
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

  if (planSalesActive) {
    const referencedPlan = findReferencedPlan(availablePlanProducts, inboundText);
    const needHint = resolvePlanNeedHint(inboundText);

    if (isPlanComparisonIntent(inboundText)) {
      const suggestedPlan = findPlanByNeedHint(availablePlanProducts, 'growth');
      return buildPlanSalesDecision(buildPlanComparisonReply(availablePlanProducts), suggestedPlan);
    }

    if (needHint) {
      const suggestedPlan = findPlanByNeedHint(availablePlanProducts, needHint);
      if (suggestedPlan) {
        return buildPlanSalesDecision(buildPlanRecommendationReply(suggestedPlan), suggestedPlan);
      }
    }

    if (isPlanRecommendationIntent(inboundText)) {
      const suggestedPlan = referencedPlan || findPlanByNeedHint(availablePlanProducts, 'growth');
      if (suggestedPlan) {
        return buildPlanSalesDecision(buildPlanRecommendationReply(suggestedPlan), suggestedPlan);
      }
    }

    if (isPlanPricingIntent(inboundText)) {
      if (referencedPlan) {
        return buildPlanSalesDecision(
          buildPlanDetailReply(referencedPlan, {
            includePrice: true,
            includeFeatures: true
          }),
          referencedPlan
        );
      }

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
        replyText: "No encontré ese producto.\nEscribí 'productos' para ver el catálogo.",
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
            ? 'No entendi esa categoria. Elegi un numero o el nombre de la categoria que queres ver.'
            : 'No hay categorias disponibles ahora mismo. Escribi "productos" para intentar de nuevo.',
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
          replyText: 'Ya te mostre todos los productos disponibles por ahora 👌\n\nEscribi "productos" para volver al catalogo completo o elegi uno por numero.',
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
          ? 'No entendí ese producto. Elegí un número de la lista o escribí "ayuda" si querés ver las opciones.'
          : 'No hay productos disponibles ahora mismo. Escribí "productos" para intentar de nuevo.',
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
        replyText: 'No entendí ese producto. Elegí un número de la lista o escribí "ayuda" si querés ver las opciones.',
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
        replyText: 'No entendí esa cantidad. Decime cuántas unidades querés.',
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

function buildSuggestionReply({ dateISO, timeWindow, suggestions }) {
  const windowLabel = timeWindow === 'morning' ? 'mañana' : timeWindow === 'afternoon' ? 'tarde' : 'noche';
  const dateLabel = formatDateIsoShort(dateISO);
  const lines = [
    `Tengo estos horarios disponibles para ${dateLabel} (${windowLabel}):`,
    ...suggestions.map((slot, idx) => `${idx + 1}) ${slot.displayText}`),
    'Responde con 1, 2 o 3.'
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
  const safeSlot = String((suggestion && (suggestion.displayText || suggestion.label)) || '').trim();

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
  const lines = [`Listo. Tu turno quedo confirmado para ${formattedTime}.`];

  if (safeName) {
    lines.push(`Nombre: ${safeName}.`);
  }
  if (safeNote) {
    lines.push(`Motivo: ${safeNote}.`);
  }

  return lines.join('\n');
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

function formatSlotForHuman(utcIso, timezone) {
  return DateTime.fromISO(String(utcIso), { zone: 'utc' }).setZone(timezone).toFormat('ccc dd/LL HH:mm');
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

  if (timing.startAt) {
    const suggestions = await conversationRepo.suggestNextAvailableSlots({
      clinicId: clinic.id,
      startAt: timing.startAt,
      count,
      stepMinutes: 30,
      maxLookaheadDays: 7
    });
    return { source: 'legacy', timing, suggestions };
  }

  if (timing.dateISO && timing.timeWindow) {
    const suggestions = await conversationRepo.suggestSlotsForTimeWindow({
      clinicId: clinic.id,
      dateISO: timing.dateISO,
      timeWindow: timing.timeWindow,
      count,
      stepMinutes: 30
    });
    return { source: 'legacy', timing, suggestions };
  }

  return { source: 'none', timing, suggestions: [] };
}

async function createBotReservationFromSuggestion({ clinic, conversation, contact, channel, safeContext, suggestion }) {
  if (!suggestion || !suggestion.startAt) {
    return { ok: false, source: 'none', reason: 'missing_startAt' };
  }

  if (suggestion.source === 'agenda') {
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
        status: 'pending'
      },
      { clinic }
    );

    if (agendaResult.ok) {
      logInfo('agenda_bot_reservation_created', {
        clinicId: clinic.id,
        conversationId: conversation.id || null,
        contactId: contact.id || null,
        startAt: agendaResult.reservation.startAt || null,
        itemId: agendaResult.reservation.id || null
      });
      return {
        ok: true,
        source: 'agenda',
        reservation: agendaResult.reservation,
        startAt: agendaResult.reservation.startAt
      };
    }

    if (agendaResult.reason !== 'agenda_bot_availability_not_configured') {
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
  }

  const available = await conversationRepo.isSlotAvailable({
    clinicId: clinic.id,
    startAt: suggestion.startAt
  });
  if (!available) {
    return { ok: false, source: 'legacy', reason: 'agenda_time_conflict' };
  }

  const created = await conversationRepo.createAppointmentFromSuggestion({
    clinicId: clinic.id,
    channelId: conversation.channelId || channel.id,
    conversationId: conversation.id,
    contactId: contact.id,
    waId: contact.waId || null,
    patientName: (safeContext && safeContext.name) || contact.name || null,
    startAt: suggestion.startAt,
    endAt: suggestion.endAt || null,
    requestedText: suggestion.displayText || null,
    source: 'bot'
  });

  if (created && created.created) {
    logInfo('legacy_bot_reservation_created', {
      clinicId: clinic.id,
      conversationId: conversation.id || null,
      contactId: contact.id || null,
      startAt: suggestion.startAt,
      appointmentId: created.row && created.row.id ? created.row.id : null
    });
    return {
      ok: true,
      source: 'legacy',
      reservation: created.row || null,
      startAt: suggestion.startAt
    };
  }

  logWarn('legacy_bot_reservation_rejected', {
    clinicId: clinic.id,
    conversationId: conversation.id || null,
    contactId: contact.id || null,
    reason: 'agenda_time_conflict',
    startAt: suggestion.startAt,
    endAt: suggestion.endAt || null
  });
  return { ok: false, source: 'legacy', reason: 'agenda_time_conflict' };
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

async function sendAndPersistReply({ clinicId, channel, conversationId, contact, text, requestId, correlationMessageId }) {
  const channelCredentials = normalizeChannelSendContext(channel, {
    conversationId: conversationId || null,
    requestId
  });
  logInfo('worker_whatsapp_send_attempt', {
    requestId,
    clinicId,
    channelId: channelCredentials.channelId,
    conversationId: conversationId || null,
    jobId: null,
    phoneNumberId: channelCredentials.phoneNumberId,
    hasAccessToken: true
  });
  const sendResult = await sendChannelScopedMessage(
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

  await insertOutboundMessage({
    clinicId,
    channelId: channel.id,
    conversationId,
    providerMessageId: sendResult.messageId,
    from: channelCredentials.phoneNumberId,
    to: contact.waId,
    type: 'text',
    body: text,
    raw: sendResult.raw || {}
  });

  await markLastOutbound(conversationId);

  logInfo('worker_outbound_sent', {
    requestId,
    clinicId,
    channelId: channel.id,
    conversationId,
    contactId: contact.id,
    messageId: correlationMessageId || null,
    outboundMessageId: sendResult.messageId || null
  });

  return sendResult;
}

async function openHandoffFlow({ clinicId, conversationId, contact, lead, reason, clinicSettings, channel, requestId, messageId }) {
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
    (clinicSettings && clinicSettings.handoffMessage) ||
    'Te derivamos con un humano. En breve te contactamos.';

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: handoffMessage,
    requestId,
    correlationMessageId: messageId
  });
}

async function tryAppointmentSelection({ clinicId, conversationId, contact, lead, rawText, channel, clinic, timezone, requestId, messageId }) {
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
            'Ese turno ya no esta disponible. Te propongo estas opciones:',
            ...alternatives.suggestions.slice(0, 5).map((item, index) => `${index + 1}) ${item.displayText}`),
            'Responde con 1, 2, 3, 4 o 5.'
          ].join('\n')
        : 'Ese turno ya no esta disponible. Decime otro dia u horario y te propongo nuevas opciones.';

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
        requestId,
        correlationMessageId: messageId
      });
      return true;
    }

    const humanTime = formatSlotForHuman(booked.startAt, timezone);
    const confirmation = `Listo, tu turno quedo confirmado para ${humanTime}. Queres agregar un motivo?`;

    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId,
      contact,
      text: confirmation,
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
    const reply = 'Ese turno ya no esta disponible. Te muestro nuevas opciones en segundos.';
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId,
      contact,
      text: reply,
      requestId,
      correlationMessageId: messageId
    });
    return true;
  }

  const humanTime = formatSlotForHuman(booked.slot.startsAt, timezone);
  const confirmation = `Listo, tu turno quedo confirmado para ${humanTime}. Queres agregar un motivo?`;

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: confirmation,
    requestId,
    correlationMessageId: messageId
  });

  return true;
}

async function processAppointmentIntent({ clinicId, conversationId, contact, lead, channel, clinic, requestId, messageId }) {
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

  if (!options.length && !agendaConfigured) {
    const toUtc = nowUtc.plus({ days: DAYS_AHEAD });
    await ensureSlotsForDateRange(clinicId, fromUtc.toISO(), toUtc.toISO());
    const slots = await listAvailableSlots(clinicId, fromUtc.toISO(), toUtc.toISO(), 5);
    options = slots.slice(0, 5).map((slot, idx) => ({
      index: idx + 1,
      source: 'legacy',
      slotId: slot.id,
      startAt: slot.startsAt,
      endAt: null,
      dateISO: DateTime.fromISO(String(slot.startsAt), { zone: 'utc' }).setZone(timezone).toISODate(),
      displayText: formatSlotForHuman(slot.startsAt, timezone),
      label: formatSlotForHuman(slot.startsAt, timezone)
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
      messageId
    });
    return;
  }

  const intro =
    (clinic.settings && clinic.settings.appointmentIntroMessage) ||
    'Tengo estos turnos disponibles:';

  const lines = [intro, ...options.map((opt) => `${opt.index}) ${opt.label}`), 'Responde con 1, 2, 3, 4 o 5.'];
  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: lines.join('\n'),
    requestId,
    correlationMessageId: messageId
  });

  await addEvent({
    clinicId,
    conversationId,
    type: 'SLOT_OFFERED',
    data: {
      source: options[0] && options[0].source ? options[0].source : 'legacy',
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
    messageId
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
      messageId
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
      messageId
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
  const hasNewerInbound = await conversationRepo.hasNewerInboundMessage(conversation.id, inboundMessage.id);
  const recentMessages = await conversationRepo.listConversationMessagesByClinicId(conversation.id, conversation.clinicId, 5);

  logInfo('automation_runtime_start', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId,
    conversationId: conversation.id,
    messageCount: Array.isArray(recentMessages) ? recentMessages.length : 0
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
    managementIntent,
    inboundLooksLikeCommerce,
    inboundLooksLikeCommerceCancel
  });

  const chosenBotPath =
    qaAgendaBypassActive
      ? 'agenda'
      : botRoute.domain === 'agenda'
        ? 'agenda'
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

    await processAppointmentIntent({
      clinicId: conversation.clinicId,
      conversationId: conversation.id,
      contact,
      lead: routedLead,
      channel,
      clinic,
      requestId,
      messageId: waMessageId || inboundMessage.id
    });
    return;
  }

  const workerOwnsCommerceFlow =
    !qaAgendaBypassActive &&
    !shouldPrioritizeAgendaFlow &&
    botRoute.domain === 'commerce';
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
    logInfo('automation_runtime_skipped_for_commerce_source_of_truth', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      inboundText: normalizedInboundText,
      sourcePath: 'worker.commerce'
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
  if (automationRuntime.replyText) {
    decision = {
      replyText: automationRuntime.replyText,
      newState: conversation.state || 'READY',
      contextPatch: automationContextPatch
    };
    decisionSource = 'automation';
  }
  if (!decision && !qaAgendaBypassActive && !shouldPrioritizeAgendaFlow && botRoute.allowCommerce) {
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
        decisionSource = 'commerce';
        logInfo('commerce_flow_entered', {
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

    if (!latestAppointment) {
      decision = {
        replyText: 'No encuentro un turno confirmado. Decime dia y horario para sacar uno.',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: buildEmptyAppointmentSuggestionPatch()
      };
    } else if (
      String(safeContext.appointmentStatus || '').toLowerCase() === 'cancelled' &&
      String(safeContext.appointmentLastCancelledStartAt || '') === String(latestAppointment.startAt || '')
    ) {
      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancele tu turno. Si queres sacar otro, decime dia y horario.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      } else {
        decision = {
          replyText: "Dale. Para que dia y horario queres reprogramar? (Ej: 'lunes 15:30' o 'martes a la tarde')",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            appointmentCandidate: null,
            ...buildEmptyAppointmentSuggestionPatch()
          }
        };
      }
    } else {
      const cancelled = await conversationRepo.cancelAppointmentById({
        appointmentId: latestAppointment.id
      });
      const cancelledStartAt = (cancelled && cancelled.startAt) || latestAppointment.startAt || null;

      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancele tu turno. Si queres sacar otro, decime dia y horario.",
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
          replyText: "Dale. Para que dia y horario queres reprogramar? (Ej: 'lunes 15:30' o 'martes a la tarde')",
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

  if (!decision && currentState === 'SELECT_APPOINTMENT_SLOT') {
    if (isGlobalMenuCommand(inboundText)) {
      decision = {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: buildEmptyAppointmentSuggestionPatch()
      };
    } else {
      const selection = extractSelection(inboundText);
      const suggestions = Array.isArray(safeContext.appointmentSuggestions) ? safeContext.appointmentSuggestions : [];
      const expired = isSuggestionExpired(safeContext.appointmentSuggestionsCreatedAt, 30);

      if (!selection || selection < 1 || selection > 3) {
        decision = {
          replyText: 'Responde con 1, 2 o 3 para elegir un horario.',
          newState: 'SELECT_APPOINTMENT_SLOT',
          contextPatch: null
        };
      } else if (!suggestions.length || expired) {
        const regen = await buildSuggestionsFromContext(3);
        if (!regen.suggestions.length) {
          decision = {
            replyText: 'No pude encontrar horarios en este momento. Decime dia y hora nuevamente (ej: lunes 10:30).',
            newState: 'ASKED_APPOINTMENT_DATETIME',
            contextPatch: buildEmptyAppointmentSuggestionPatch()
          };
        } else {
          decision = {
            replyText: buildSuggestionReply({
              dateISO: regen.timing.dateISO,
              timeWindow: regen.timing.timeWindow || safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
              suggestions: regen.suggestions
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
            replyText: 'Esa opcion no es valida. Elegi 1, 2 o 3.',
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: null
          };
        } else if (isReplaySafeConfirmation(safeContext, chosen.startAt)) {
          decision = {
            replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(chosen.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
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
              replyText: `Elegiste ${selectedHumanTime}. Antes de confirmarlo, decime tu nombre.`,
              newState: 'ASKED_APPOINTMENT_NAME',
              contextPatch: buildAppointmentSelectedSlotPatch({
                suggestion: chosen,
                phase: 'waiting_contact_name'
              })
            };
          } else {
            decision = {
              replyText: `Elegiste ${selectedHumanTime}. Si queres, decime un motivo o nota breve para el turno. Si no, responde "sin motivo".`,
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
        replyText: 'Necesito tu nombre para confirmar el turno. Responde con tu nombre y apellido.',
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
        replyText: 'Perfecto. Si queres, decime un motivo o nota breve para el turno. Si no, responde "sin motivo".',
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
        replyText: 'Perdi el horario elegido. Decime dia y hora nuevamente y te propongo opciones.',
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
                suggestions: alternatives
              })}`
            : 'Ese horario se ocupo recien. Decime dia y hora nuevamente (ej: lunes 10:30).',
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
          replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
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
          replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
          newState: 'READY',
          contextPatch: buildConfirmedContextPatch(timing.startAt)
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
              suggestions: alternatives
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
            suggestions: suggestionResult.suggestions
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
          replyText: "Entendido. Cancele este pedido en curso. Si queres, escribi 'productos' para ver el catalogo otra vez.",
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

  if (decisionSource === 'automation') {
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

  const sendResult = await sendChannelScopedMessage(
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

  logInfo('conversation_reply_processed', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: conversation.channelId || channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    waMessageId,
    graphStatus: sendResult && sendResult.status ? sendResult.status : null,
    outboundMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
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

    await releaseExpiredHolds();
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
  startWorker
};


