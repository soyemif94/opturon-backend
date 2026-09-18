const ASSISTANT_MODES = Object.freeze({
  TENANT_BUSINESS: 'tenant_business',
  OPTURON_SALES: 'opturon_sales'
});

const PLATFORM_DISCOVERY_FIELDS = new Set([
  'team_size',
  'channel_mix',
  'whatsapp_volume',
  'offer_type',
  'whatsapp_account_type'
]);

const PLATFORM_DISCOVERY_SOURCE_MARKERS = [
  'industry_fit',
  'business_fit',
  'feature_fit',
  'commercial_kb',
  'plan_recommendation',
  'portfolio_discovery'
];

function normalizeAssistantMode(value, fallback = ASSISTANT_MODES.TENANT_BUSINESS) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === ASSISTANT_MODES.OPTURON_SALES || normalized === 'opturon-sales') {
    return ASSISTANT_MODES.OPTURON_SALES;
  }
  if (normalized === ASSISTANT_MODES.TENANT_BUSINESS || normalized === 'tenant-business') {
    return ASSISTANT_MODES.TENANT_BUSINESS;
  }
  return fallback;
}

function resolveAssistantModeFromSettings(rawSettings) {
  const settings = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
    ? rawSettings
    : {};
  const candidates = [
    settings && settings.bot && settings.bot.assistantMode,
    settings && settings.ai && settings.ai.assistantMode,
    settings && settings.assistantMode
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAssistantMode(candidate, null);
    if (normalized) return normalized;
  }

  // Every ordinary tenant channel is customer-facing unless a platform sales
  // surface explicitly opts in above.
  return ASSISTANT_MODES.TENANT_BUSINESS;
}

function isPlatformDiscoveryPending(value) {
  const pending = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!pending) return false;
  const field = String(pending.field || pending.expectedField || '').trim().toLowerCase();
  const source = String(pending.sourceIntent || '').trim().toLowerCase();
  return (
    PLATFORM_DISCOVERY_FIELDS.has(field) ||
    PLATFORM_DISCOVERY_SOURCE_MARKERS.some((marker) => source.includes(marker))
  );
}

function isPlatformPlanContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!context) return false;
  const topic = String(context.topic || '').trim().toLowerCase();
  return topic.includes('plan') || Boolean(context.lastDiscussedPlanId || context.lastComparedPlanId);
}

function isPlatformShortMemory(value) {
  const memory = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!memory) return false;
  return String(memory.topic || '').trim().toLowerCase() === 'plans' || Boolean(
    memory.pendingCommercialExplanation || memory.pendingCommercialActivation || memory.activationSelectedPlanId
  );
}

function hasPlatformSalesContext(context) {
  const safe = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const sales = safe.commercialSalesContext && typeof safe.commercialSalesContext === 'object'
    ? safe.commercialSalesContext
    : null;
  return Boolean(
    isPlatformDiscoveryPending(safe.commercialDiscoveryPending) ||
    isPlatformPlanContext(safe.commercialPlanContext) ||
    isPlatformShortMemory(safe.commercialShortMemory) ||
    safe.commercialBusinessContext ||
    (sales && (
      sales.whatsappVolume ||
      sales.estimatedDailyConversations ||
      sales.peakDailyConversations ||
      sales.teamSizeSignal ||
      sales.teamSizeValue ||
      sales.channelMixSignal ||
      sales.whatsappAccountTypeSignal ||
      sales.offerTypeSignal ||
      sales.lastRecommendedPlan ||
      sales.lastRecommendationReason
    ))
  );
}

function buildAssistantModeCompatibilityPatch(assistantMode, rawContext) {
  const mode = normalizeAssistantMode(assistantMode);
  const context = rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext) ? rawContext : {};
  const patch = { assistantMode: mode };
  if (mode !== ASSISTANT_MODES.TENANT_BUSINESS || !hasPlatformSalesContext(context)) {
    return patch;
  }

  if (isPlatformDiscoveryPending(context.commercialDiscoveryPending)) patch.commercialDiscoveryPending = null;
  if (isPlatformPlanContext(context.commercialPlanContext)) patch.commercialPlanContext = null;
  if (isPlatformShortMemory(context.commercialShortMemory)) patch.commercialShortMemory = null;
  if (context.commercialBusinessContext) patch.commercialBusinessContext = null;
  if (context.commercialSalesContext) patch.commercialSalesContext = null;
  if (context.pendingOfferedAction && typeof context.pendingOfferedAction === 'object') {
    const pendingType = String(context.pendingOfferedAction.type || '').trim().toLowerCase();
    if (pendingType.includes('plan') || pendingType.includes('commercial')) patch.pendingOfferedAction = null;
  }
  return patch;
}

function sanitizeConversationContextForAssistantMode(assistantMode, rawContext) {
  const context = rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)
    ? rawContext
    : {};
  return {
    ...context,
    ...buildAssistantModeCompatibilityPatch(assistantMode, context)
  };
}

module.exports = {
  ASSISTANT_MODES,
  PLATFORM_DISCOVERY_FIELDS,
  normalizeAssistantMode,
  resolveAssistantModeFromSettings,
  isPlatformDiscoveryPending,
  hasPlatformSalesContext,
  buildAssistantModeCompatibilityPatch,
  sanitizeConversationContextForAssistantMode
};
