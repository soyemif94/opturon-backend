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

const SUPPORTED_DOMAINS = new Set(['commerce', 'unknown']);
const SUPPORTED_INTENTS = new Set([
  'unknown',
  'plan_recommendation',
  'plan_comparison',
  'objection',
  'business_fit',
  'implementation_question',
  'general_commerce_question'
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
  'implementation_followup'
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
    'Entities debe incluir solo inferencias razonables y conservadoras.'
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
  return {
    businessType: normalizeIntentText(safe.businessType) || null,
    teamSize: normalizeIntentText(safe.teamSize) || null,
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
    return { ok: false, reason: 'conversation_limit_reached', conversationCount, monthlyCount: null };
  }

  const monthlyCount = monthlySuccessCount + monthlyFailureCount;
  if (monthlyCount >= monthlyLimit) {
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
        confidence: providerResult.decision.confidence,
        routingDecision: providerResult.decision.routingDecision,
        suggestedReplyIntent: providerResult.decision.suggestedReplyIntent,
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
  __internal: {
    buildAiAssistSystemPrompt,
    buildAiAssistUserPrompt,
    normalizeAiAssistDecision,
    validateDecision,
    normalizeEntities,
    reserveAiAssistBudget,
    invokeProvider
  }
};
