const env = require('../config/env');
const {
  addEvent,
  countEventsByType,
  countClinicEventsByTypeCurrentMonth
} = require('../repositories/conversation-events.repository');
const { logInfo, logWarn } = require('../utils/logger');

const AI_ASSIST_EVENT_TYPE = 'AI_ASSIST_INVOKED';
const AI_ASSIST_FAILURE_EVENT_TYPE = 'AI_ASSIST_FAILED';
const OPENAI_API_BASE = 'https://api.openai.com/v1';
let aiAssistRuntimeConfigLogged = false;

const SUPPORTED_DOMAINS = new Set(['commerce', 'unknown']);
const SUPPORTED_INTENTS = new Set([
  'unknown',
  'plan_recommendation',
  'plan_comparison',
  'objection',
  'business_fit',
  'implementation_question',
  'general_commerce_question',
  'channel_compatibility',
  'whatsapp_number_portability',
  'seller_replacement',
  'industry_fit',
  'feature_fit',
  'catalog_import_fit'
]);
const SUPPORTED_ROUTING_DECISIONS = new Set([
  'fallback_current',
  'use_existing_commerce_reply',
  'handoff_soft',
  'ask_clarifying_question'
]);
const SUPPORTED_REPLY_INTENTS = new Set([
  'unknown',
  'recommend_plan_starter',
  'recommend_plan_growth',
  'recommend_plan_enterprise',
  'recommend_plan_by_business_context',
  'compare_plans',
  'explain_business_fit',
  'handle_objection_price',
  'handle_objection_starting',
  'handle_objection_excel',
  'handle_objection_whatsapp_manual',
  'handle_objection_crm_existing',
  'handle_objection_later',
  'handle_objection_consulting',
  'general_commerce_followup',
  'implementation_followup',
  'channel_compatibility',
  'whatsapp_number_portability',
  'seller_replacement',
  'industry_fit',
  'feature_fit',
  'catalog_import_fit'
]);

function normalizeString(value) {
  return String(value || '').trim();
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeIntentText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAiAssistEnabledForClinic(clinicId) {
  if (env.aiAssistEnabled !== true) {
    return { ok: false, reason: 'disabled_globally' };
  }

  const safeClinicId = normalizeString(clinicId);
  const enabledClinicIds = new Set((env.aiAssistEnabledClinicIds || []).map((item) => normalizeString(item)).filter(Boolean));
  const disabledClinicIds = new Set((env.aiAssistDisabledClinicIds || []).map((item) => normalizeString(item)).filter(Boolean));

  if (safeClinicId && disabledClinicIds.has(safeClinicId)) {
    return { ok: false, reason: 'clinic_disabled' };
  }

  if (enabledClinicIds.size > 0 && (!safeClinicId || !enabledClinicIds.has(safeClinicId))) {
    return { ok: false, reason: 'clinic_not_allowlisted' };
  }

  if (!normalizeString(env.aiAssistApiKey)) {
    return { ok: false, reason: 'missing_api_key' };
  }

  return { ok: true, reason: null };
}

function getAiAssistProvider() {
  const provider = normalizeString(env.aiAssistProvider).toLowerCase() || 'openai';
  return provider;
}

function getAiAssistRuntimeDiagnostics() {
  return {
    enabled: env.aiAssistEnabled === true,
    provider: getAiAssistProvider(),
    model: normalizeString(env.aiAssistModel) || 'gpt-4o-mini',
    maxMonthlyCalls: Math.max(1, Number(env.aiAssistMaxMonthlyCalls || 2000)),
    maxCallsPerConversation: Math.max(1, Number(env.aiAssistMaxCallsPerConversation || 3)),
    enabledClinicIds: Array.isArray(env.aiAssistEnabledClinicIds) ? env.aiAssistEnabledClinicIds.filter(Boolean) : [],
    enabledClinicIdsCount: Array.isArray(env.aiAssistEnabledClinicIds) ? env.aiAssistEnabledClinicIds.filter(Boolean).length : 0,
    disabledClinicIdsCount: Array.isArray(env.aiAssistDisabledClinicIds) ? env.aiAssistDisabledClinicIds.filter(Boolean).length : 0,
    keyPresent: Boolean(normalizeString(env.aiAssistApiKey))
  };
}

function logAiAssistRuntimeConfigOnce() {
  if (aiAssistRuntimeConfigLogged) return;
  aiAssistRuntimeConfigLogged = true;
  const diagnostics = getAiAssistRuntimeDiagnostics();
  logInfo('ai_assist_runtime_config', diagnostics);
}

function buildAiAssistSystemPrompt() {
  return [
    'Sos AI Assist de Opturon.',
    'No respondas al usuario final libremente.',
    'Tu tarea es clasificar intencion comercial, extraer entidades y recomendar una ruta segura.',
    'Devolve solo JSON valido, sin markdown.',
    'No inventes precios, stock, puntos, turnos, saldos, datos bancarios, disponibilidad ni promesas comerciales.',
    'Si el mensaje trata sobre pagos, comprobantes, agenda, turnos, catalogo operativo, pedidos, fidelizacion o handoff humano, devolve intent=unknown y routingDecision=fallback_current.',
    'Si no hay suficiente confianza, devolve confidence baja e intent=unknown.',
    'Dominio permitido principal: commerce.',
    'SuggestedReplyIntent debe ser uno de los permitidos por el integrador.',
    'Entities debe incluir solo inferencias razonables y conservadoras.',
    'Si preguntan compatibilidad con Instagram u otro canal, considera channel_compatibility.',
    'Si preguntan si pueden usar o conservar su numero actual de WhatsApp, considera whatsapp_number_portability.',
    'Si preguntan si reemplaza vendedores o equipo humano, considera seller_replacement.',
    'Si preguntan si sirve para un rubro o negocio especifico, considera industry_fit.',
    'Si preguntan por sucursales, canales, operacion o capacidad general del producto, considera feature_fit.',
    'Si preguntan por muchos productos, Excel, carga o importacion de catalogo, considera catalog_import_fit.',
    'Cuando una de esas clases aplique y haya suficiente señal, usa routingDecision=use_existing_commerce_reply.',
    'No mandes fallback_current si la consulta comercial es clara y coincide con una de esas clases.',
    'Si el usuario describe tipo de negocio + canales + equipo o tamaño de operacion y pregunta que ofrece Opturon, eso es commerce con business_fit o plan_recommendation, no seller_replacement.',
    'Si hay señales suficientes y claras, usa confidence >= 0.7.',
    'No clasifiques seller_replacement salvo que pregunten explicitamente si Opturon reemplaza vendedores, equipo humano o permite prescindir de personas.',
    'Si mencionan Instagram junto con WhatsApp, extrae channels=["whatsapp","instagram"] y considera business_fit o channel_compatibility.',
    'Si mencionan distribuidora, rotiseria, peluqueria, ropa o servicios, extrae businessType.',
    'Si dicen no tengo muchos vendedores o tengo poco equipo, eso describe teamSize small y no implica seller_replacement.',
    'Ejemplos: "vendo tambien por instagram, es compatible?" -> intent=channel_compatibility, suggestedReplyIntent=channel_compatibility.',
    'Ejemplos: "puedo usar mi numero actual de whatsapp?" -> intent=whatsapp_number_portability, suggestedReplyIntent=whatsapp_number_portability.',
    'Ejemplos: "esto reemplaza a mis vendedores?" -> intent=seller_replacement, suggestedReplyIntent=seller_replacement.',
    'Ejemplos: "sirve para una rotiseria?" o "sirve para una peluqueria?" -> intent=industry_fit, suggestedReplyIntent=industry_fit.',
    'Ejemplos: "puedo conectar dos sucursales?" -> intent=feature_fit, suggestedReplyIntent=feature_fit.',
    'Ejemplos: "tengo muchos productos, como los cargo?" -> intent=catalog_import_fit, suggestedReplyIntent=catalog_import_fit.',
    'Ejemplo de salida esperada para: "Hola Opturon, tengo una distribuidora y vendo por whatsapp e instagram pero no tengo muchos vendedores, que tenes para ofrecerme?" => {"domain":"commerce","intent":"business_fit","confidence":0.85,"entities":{"businessType":"distribution","teamSize":"small","channels":["whatsapp","instagram"]},"routingDecision":"use_existing_commerce_reply","suggestedReplyIntent":"feature_fit","reason":"El usuario describe su operación comercial y pregunta qué puede ofrecer Opturon."}',
    'Ejemplo de salida esperada para: "esto reemplaza a mis vendedores?" => {"domain":"commerce","intent":"seller_replacement","confidence":0.9,"entities":{},"routingDecision":"use_existing_commerce_reply","suggestedReplyIntent":"seller_replacement","reason":"El usuario pregunta explícitamente si Opturon reemplaza vendedores humanos."}',
    'Ejemplo de salida esperada para: "vendo también por instagram, su software es compatible?" => {"domain":"commerce","intent":"channel_compatibility","confidence":0.85,"entities":{"channels":["instagram"]},"routingDecision":"use_existing_commerce_reply","suggestedReplyIntent":"channel_compatibility","reason":"Pregunta si Opturon es compatible con el canal Instagram."}',
    'Ejemplo de salida esperada para: "puedo usar mi número actual de whatsapp?" => {"domain":"commerce","intent":"whatsapp_number_portability","confidence":0.9,"entities":{"channels":["whatsapp"]},"routingDecision":"use_existing_commerce_reply","suggestedReplyIntent":"whatsapp_number_portability","reason":"Pregunta si puede conservar su número actual de WhatsApp."}'
  ].join('\n');
}

function buildAiAssistUserPrompt(input) {
  const context = input && input.context && typeof input.context === 'object' ? input.context : {};
  const recentMessages = Array.isArray(input.recentMessages)
    ? input.recentMessages
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(-6)
    : [];

  return JSON.stringify({
    task: 'classify_commerce_intent_for_routing',
    allowedReplyIntents: Array.from(SUPPORTED_REPLY_INTENTS),
    message: String(input.message || '').trim(),
    recentMessages,
    context: {
      activeBotDomain: context.activeBotDomain || null,
      commercialBusinessContext: context.commercialBusinessContext || null,
      commercialSalesContext: context.commercialSalesContext || null,
      commercialPlanContext: context.commercialPlanContext || null,
      commercialShortMemory: context.commercialShortMemory || null
    }
  });
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: usage.prompt_tokens !== undefined && usage.prompt_tokens !== null ? Number(usage.prompt_tokens) : null,
    completionTokens: usage.completion_tokens !== undefined && usage.completion_tokens !== null ? Number(usage.completion_tokens) : null,
    totalTokens: usage.total_tokens !== undefined && usage.total_tokens !== null ? Number(usage.total_tokens) : null
  };
}

function sanitizeModelRaw(raw) {
  return normalizeString(raw).slice(0, 1000) || null;
}

function sanitizeReason(reason) {
  return normalizeString(reason).slice(0, 280) || null;
}

function normalizeChannels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeIntentText(item)).filter(Boolean))].slice(0, 6);
}

function normalizeEntities(value) {
  const safe = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawTeamSize = normalizeIntentText(safe.teamSize);
  const normalizedTeamSize =
    rawTeamSize.includes('small') ||
    rawTeamSize.includes('pocos vendedores') ||
    rawTeamSize.includes('poco equipo') ||
    rawTeamSize.includes('equipo chico')
      ? 'small'
      : rawTeamSize || null;
  return {
    businessType: normalizeIntentText(safe.businessType) || null,
    teamSize: normalizedTeamSize,
    channels: normalizeChannels(safe.channels),
    currentTool: normalizeIntentText(safe.currentTool) || null,
    stage: normalizeIntentText(safe.stage) || null,
    painPoints: Array.isArray(safe.painPoints)
      ? [...new Set(safe.painPoints.map((item) => normalizeIntentText(item)).filter(Boolean))].slice(0, 6)
      : []
  };
}

function normalizeAiAssistDecision(parsed) {
  const safe = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const domain = normalizeIntentText(safe.domain) || 'unknown';
  const intent = normalizeIntentText(safe.intent) || 'unknown';
  const routingDecision = normalizeIntentText(safe.routingDecision) || 'fallback_current';
  const suggestedReplyIntent = normalizeIntentText(safe.suggestedReplyIntent) || 'unknown';
  const confidence = Number(safe.confidence);

  return {
    domain: SUPPORTED_DOMAINS.has(domain) ? domain : 'unknown',
    intent: SUPPORTED_INTENTS.has(intent) ? intent : 'unknown',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    entities: normalizeEntities(safe.entities),
    routingDecision: SUPPORTED_ROUTING_DECISIONS.has(routingDecision) ? routingDecision : 'fallback_current',
    suggestedReplyIntent: SUPPORTED_REPLY_INTENTS.has(suggestedReplyIntent) ? suggestedReplyIntent : 'unknown',
    reason: sanitizeReason(safe.reason)
  };
}

function validateDecision(decision) {
  return Boolean(
    decision &&
      typeof decision === 'object' &&
      decision.domain &&
      decision.intent &&
      decision.routingDecision &&
      decision.suggestedReplyIntent
  );
}

async function callOpenAiAssist(input) {
  const apiKey = normalizeString(env.aiAssistApiKey);
  const model = normalizeString(env.aiAssistModel) || 'gpt-4o-mini';
  const timeoutMs = Number(env.aiAssistTimeoutMs || 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    temperature: 0.1,
    max_tokens: 320,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildAiAssistSystemPrompt() },
      { role: 'user', content: buildAiAssistUserPrompt(input) }
    ]
  };

  try {
    const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    const json = safeJsonParse(raw);
    if (!response.ok) {
      const error = new Error(
        (json && json.error && json.error.message) || `ai_assist_provider_failed_${response.status}`
      );
      error.status = response.status;
      error.raw = sanitizeModelRaw(raw);
      throw error;
    }

    const content = normalizeString(
      json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content
    );
    const parsed = safeJsonParse(content);
    if (!parsed || typeof parsed !== 'object') {
      const error = new Error('ai_assist_invalid_json');
      error.raw = sanitizeModelRaw(content || raw);
      throw error;
    }

    return {
      model,
      usage: sanitizeUsage(json && json.usage),
      raw: sanitizeModelRaw(content || raw),
      decision: normalizeAiAssistDecision(parsed)
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`ai_assist_timeout_${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function invokeProvider(input, providerOverride = null) {
  const provider = providerOverride || getAiAssistProvider();
  if (provider === 'openai') {
    return callOpenAiAssist(input);
  }

  throw new Error(`ai_assist_provider_not_supported:${provider}`);
}

async function reserveAiAssistBudget({ clinicId, conversationId }) {
  logAiAssistRuntimeConfigOnce();
  const conversationLimit = Math.max(1, Number(env.aiAssistMaxCallsPerConversation || 3));
  const monthlyLimit = Math.max(1, Number(env.aiAssistMaxMonthlyCalls || 2000));
  const [conversationSuccessCount, conversationFailureCount, monthlySuccessCount, monthlyFailureCount] = await Promise.all([
    countEventsByType(clinicId, conversationId, AI_ASSIST_EVENT_TYPE),
    countEventsByType(clinicId, conversationId, AI_ASSIST_FAILURE_EVENT_TYPE),
    countClinicEventsByTypeCurrentMonth(clinicId, AI_ASSIST_EVENT_TYPE),
    countClinicEventsByTypeCurrentMonth(clinicId, AI_ASSIST_FAILURE_EVENT_TYPE)
  ]);
  const conversationCount = conversationSuccessCount + conversationFailureCount;
  if (conversationCount >= conversationLimit) {
    logWarn('ai_assist_budget_blocked', {
      clinicId,
      conversationId,
      conversationCount,
      conversationLimit,
      monthlyCount: null,
      monthlyLimit,
      reason: 'conversation_limit_reached'
    });
    return { ok: false, reason: 'conversation_limit_reached', conversationCount, monthlyCount: null };
  }

  const monthlyCount = monthlySuccessCount + monthlyFailureCount;
  if (monthlyCount >= monthlyLimit) {
    logWarn('ai_assist_budget_blocked', {
      clinicId,
      conversationId,
      conversationCount,
      conversationLimit,
      monthlyCount,
      monthlyLimit,
      reason: 'monthly_limit_reached'
    });
    return { ok: false, reason: 'monthly_limit_reached', conversationCount, monthlyCount };
  }

  return { ok: true, reason: null, conversationCount, monthlyCount };
}

async function classifyCommerceAiAssist(input, options = {}) {
  const clinicId = normalizeString(input && input.clinicId);
  const conversationId = normalizeString(input && input.conversationId);
  const enabled = isAiAssistEnabledForClinic(clinicId);
  if (!enabled.ok) {
    return { ok: false, reason: enabled.reason, skipped: true };
  }

  if (!clinicId || !conversationId) {
    return { ok: false, reason: 'missing_scope', skipped: true };
  }

  const budget = await reserveAiAssistBudget({ clinicId, conversationId });
  if (!budget.ok) {
    return { ok: false, reason: budget.reason, skipped: true };
  }

  const provider = options.providerOverride || getAiAssistProvider();
  const startedAt = Date.now();

  try {
    const providerResult = await invokeProvider(
      {
        message: input.message,
        context: input.context || {},
        recentMessages: input.recentMessages || []
      },
      provider
    );

    if (!validateDecision(providerResult.decision)) {
      throw new Error('ai_assist_invalid_decision');
    }

    await addEvent({
      clinicId,
      conversationId,
      type: AI_ASSIST_EVENT_TYPE,
      data: {
        provider,
        model: providerResult.model,
        reason: sanitizeReason(input.reason || 'commercial_low_confidence'),
        domain: providerResult.decision.domain,
        intent: providerResult.decision.intent,
        confidence: providerResult.decision.confidence,
        routingDecision: providerResult.decision.routingDecision,
        suggestedReplyIntent: providerResult.decision.suggestedReplyIntent,
        entities: providerResult.decision.entities,
        usage: providerResult.usage,
        estimatedCostUsd: null,
        latencyMs: Date.now() - startedAt
      }
    });

    logInfo('ai_assist_invoked', {
      clinicId,
      conversationId,
      provider,
      model: providerResult.model,
      confidence: providerResult.decision.confidence,
      routingDecision: providerResult.decision.routingDecision,
      suggestedReplyIntent: providerResult.decision.suggestedReplyIntent
    });

    return {
      ok: true,
      provider,
      model: providerResult.model,
      usage: providerResult.usage,
      raw: providerResult.raw,
      decision: providerResult.decision
    };
  } catch (error) {
    await addEvent({
      clinicId,
      conversationId,
      type: AI_ASSIST_FAILURE_EVENT_TYPE,
      data: {
        provider,
        reason: sanitizeReason(input.reason || 'commercial_low_confidence'),
        error: sanitizeReason(error.message),
        latencyMs: Date.now() - startedAt
      }
    });

    logWarn('ai_assist_failed', {
      clinicId,
      conversationId,
      provider,
      error: error.message
    });

    return { ok: false, reason: error.message, failed: true };
  }
}

module.exports = {
  AI_ASSIST_EVENT_TYPE,
  AI_ASSIST_FAILURE_EVENT_TYPE,
  classifyCommerceAiAssist,
  isAiAssistEnabledForClinic,
  getAiAssistRuntimeDiagnostics,
  __internal: {
    getAiAssistRuntimeDiagnostics,
    logAiAssistRuntimeConfigOnce,
    buildAiAssistSystemPrompt,
    buildAiAssistUserPrompt,
    normalizeAiAssistDecision,
    validateDecision,
    normalizeEntities,
    reserveAiAssistBudget,
    invokeProvider
  }
};
