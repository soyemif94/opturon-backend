const { sanitizeCapabilityDecision } = require('./capability-resolver.service');

const SUMMARY_VERSION = 1;
const TRUSTED_FACT_SOURCES = new Set(['EXPLICIT', 'STRUCTURED', 'PERSISTED_VERIFIED']);
const EXPLICIT_FACT_SOURCES = new Set(['EXPLICIT', 'STRUCTURED']);
const RELEVANT_FACT_FIELDS = Object.freeze([
  'businessType',
  'inquiryTypes',
  'objective',
  'problem',
  'ecommercePlatform',
  'physicalStoreSystem',
  'stockSourceOfTruth',
  'stockUpdateMode',
  'sharedSkuCatalog'
]);
const QUESTION_LABELS = Object.freeze({
  commerce_platform: '¿Que plataforma usas para la tienda online?',
  physical_store_system: '¿Que sistema usas en el local fisico?',
  stock_source_of_truth: '¿Que sistema tomas como referencia principal del stock?',
  stock_update_method: '¿Actualizas manualmente el stock en ambos sistemas cuando hay una venta?',
  shared_sku_catalog: '¿Ambos sistemas usan los mismos codigos o SKU para cada producto?'
});

function normalizeString(value, maxLength = 1000) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function parseObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeFact(value) {
  const fact = parseObject(value);
  const normalizedValue = normalizeString(fact.value, 500);
  const source = normalizeString(fact.source, 80);
  if (!normalizedValue || !source || !TRUSTED_FACT_SOURCES.has(source)) return null;
  return { value: normalizedValue, source };
}

function getGroundedFacts(salesContext) {
  return parseObject(parseObject(salesContext).groundedFacts);
}

function collectRelevantFacts(salesContext) {
  const groundedFacts = getGroundedFacts(salesContext);
  return RELEVANT_FACT_FIELDS.reduce((acc, field) => {
    const fact = normalizeFact(groundedFacts[field]);
    if (fact) acc.push({ field, ...fact });
    return acc;
  }, []);
}

function normalizeSystems(values) {
  const uniqueValues = Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeString(value, 300))
      .filter(Boolean)
  ));
  const genericSystems = new Set(['tienda online', 'ecommerce', 'e-commerce']);
  const hasSpecificSystem = uniqueValues.some((value) => !genericSystems.has(value.toLowerCase()));
  return hasSpecificSystem
    ? uniqueValues.filter((value) => !genericSystems.has(value.toLowerCase()))
    : uniqueValues;
}

function collectSystems(salesContext) {
  const groundedFacts = getGroundedFacts(salesContext);
  const systems = Array.isArray(groundedFacts.systems) ? groundedFacts.systems : [];
  const directSystems = [groundedFacts.ecommercePlatform, groundedFacts.physicalStoreSystem];
  const values = [...systems, ...directSystems]
    .map(normalizeFact)
    .filter(Boolean)
    .map((fact) => fact.value);
  return normalizeSystems(values);
}

function factValue(relevantFacts, field) {
  const fact = (Array.isArray(relevantFacts) ? relevantFacts : []).find((item) => item.field === field);
  return fact ? fact.value : null;
}

function mergeFacts(existingFacts, nextFacts) {
  const byField = new Map();
  for (const fact of [...(Array.isArray(existingFacts) ? existingFacts : []), ...(Array.isArray(nextFacts) ? nextFacts : [])]) {
    const field = normalizeString(fact && fact.field, 80);
    const value = normalizeString(fact && fact.value, 500);
    const source = normalizeString(fact && fact.source, 80);
    if (!field || !value || !source || !TRUSTED_FACT_SOURCES.has(source)) continue;
    byField.set(field, { field, value, source });
  }
  return [...byField.values()];
}

function buildContactSummary(contact, existingContact = null) {
  const safeContact = parseObject(contact);
  const existing = parseObject(existingContact);
  return {
    id: normalizeString(safeContact.id, 120) || normalizeString(existing.id, 120),
    name:
      normalizeString(safeContact.name, 200) ||
      normalizeString(existing.name, 200) ||
      null
  };
}

function resolveChannelType(channel) {
  const type = normalizeString(channel && channel.type, 80);
  if (type) return type.toLowerCase();
  const provider = normalizeString(channel && channel.provider, 80);
  if (provider === 'instagram_graph') return 'instagram';
  if (provider === 'whatsapp_cloud') return 'whatsapp';
  return null;
}

function buildChannelSummary(channel, existingChannel = null, tenantId = null) {
  const inputChannel = parseObject(channel);
  const channelTenantId = normalizeString(inputChannel.clinicId || inputChannel.tenantId, 120);
  const safeTenantId = normalizeString(tenantId, 120);
  const safeChannel = channelTenantId && safeTenantId && channelTenantId !== safeTenantId
    ? {}
    : inputChannel;
  const existing = parseObject(existingChannel);
  const label =
    normalizeString(safeChannel.instagramUsername, 200) ||
    normalizeString(safeChannel.externalPageName, 200) ||
    normalizeString(safeChannel.verifiedName, 200) ||
    normalizeString(existing.label, 200) ||
    null;
  return {
    id: normalizeString(safeChannel.id, 120) || normalizeString(existing.id, 120),
    type: resolveChannelType(safeChannel) || normalizeString(existing.type, 80),
    provider: normalizeString(safeChannel.provider, 80) || normalizeString(existing.provider, 80),
    label
  };
}

function buildLatestRelevantExchange(question, answer, existingExchange = null) {
  const safeQuestion = parseObject(question);
  const existing = parseObject(existingExchange);
  const expectedField =
    normalizeString(safeQuestion.expectedField || safeQuestion.field, 100) ||
    normalizeString(existing.expectedField, 100);
  const normalizedAnswer = normalizeString(answer, 1000) || normalizeString(existing.answer, 1000);
  const questionText =
    normalizeString(safeQuestion.question, 1000) ||
    (expectedField ? QUESTION_LABELS[expectedField] || null : null) ||
    normalizeString(existing.question, 1000);
  if (!expectedField && !normalizedAnswer && !questionText) return null;
  return {
    questionId: normalizeString(safeQuestion.id, 200) || normalizeString(existing.questionId, 200),
    expectedField,
    question: questionText,
    answer: normalizedAnswer,
    answeredAt: normalizeString(safeQuestion.resolvedAt, 80) || normalizeString(existing.answeredAt, 80)
  };
}

function sanitizeHandoffSummary(value) {
  const summary = parseObject(value);
  const relevantFacts = mergeFacts([], summary.relevantFacts);
  const explicitFacts = relevantFacts.filter((fact) => EXPLICIT_FACT_SOURCES.has(fact.source));
  const systems = normalizeSystems(summary.systems);
  const capability = sanitizeCapabilityDecision(summary.capability);
  const latestRelevantExchange = buildLatestRelevantExchange(null, null, summary.latestRelevantExchange);

  return {
    version: SUMMARY_VERSION,
    tenantId: normalizeString(summary.tenantId, 120),
    conversationId: normalizeString(summary.conversationId, 120),
    contact: buildContactSummary(null, summary.contact),
    channel: buildChannelSummary(null, summary.channel),
    industry: normalizeString(summary.industry, 500),
    objective: normalizeString(summary.objective, 1000),
    problem: normalizeString(summary.problem, 1000),
    relevantFacts,
    explicitFacts,
    systems,
    collectedInformation: {
      ecommercePlatform: normalizeString(summary.collectedInformation && summary.collectedInformation.ecommercePlatform, 500),
      physicalStoreSystem: normalizeString(summary.collectedInformation && summary.collectedInformation.physicalStoreSystem, 500),
      stockSourceOfTruth: normalizeString(summary.collectedInformation && summary.collectedInformation.stockSourceOfTruth, 500),
      stockUpdateMode: normalizeString(summary.collectedInformation && summary.collectedInformation.stockUpdateMode, 500),
      sharedSkuCatalog: normalizeString(summary.collectedInformation && summary.collectedInformation.sharedSkuCatalog, 500)
    },
    capability,
    escalationReason: normalizeString(summary.escalationReason, 200),
    uncertaintyReason: normalizeString(summary.uncertaintyReason, 200),
    latestRelevantExchange,
    suggestedAction: normalizeString(summary.suggestedAction, 500),
    createdAt: normalizeString(summary.createdAt, 80),
    updatedAt: normalizeString(summary.updatedAt, 80)
  };
}

function getOwnedHandoffSummary(value, {
  tenantId,
  conversationId,
  contactId = null,
  channelId = null
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = sanitizeHandoffSummary(value);
  const safeTenantId = normalizeString(tenantId, 120);
  const safeConversationId = normalizeString(conversationId, 120);
  const safeContactId = normalizeString(contactId, 120);
  const safeChannelId = normalizeString(channelId, 120);
  if (!safeTenantId || !safeConversationId) return null;
  if (summary.tenantId !== safeTenantId || summary.conversationId !== safeConversationId) return null;
  if (summary.contact.id && summary.contact.id !== safeContactId) return null;
  if (summary.channel.id && summary.channel.id !== safeChannelId) return null;
  return summary;
}

function buildHandoffSummary({
  existingSummary = null,
  tenantId,
  conversationId,
  contact = null,
  channel = null,
  salesContext = null,
  capabilityDecision = null,
  escalationReason = null,
  latestQuestion = null,
  latestAnswer = null,
  suggestedAction = 'verify_integration_feasibility_and_contact_customer',
  now = null
} = {}) {
  const safeTenantId = normalizeString(tenantId, 120);
  const safeConversationId = normalizeString(conversationId, 120);
  const existingCandidate = sanitizeHandoffSummary(existingSummary);
  const existingBelongsToContext = !(
    (safeTenantId && existingCandidate.tenantId && existingCandidate.tenantId !== safeTenantId) ||
    (safeConversationId && existingCandidate.conversationId && existingCandidate.conversationId !== safeConversationId)
  );
  const existing = existingBelongsToContext
    ? existingCandidate
    : sanitizeHandoffSummary(null);
  const nextFacts = collectRelevantFacts(salesContext);
  const relevantFacts = mergeFacts(existing.relevantFacts, nextFacts);
  const systems = normalizeSystems([
    ...existing.systems,
    ...collectSystems(salesContext)
  ]);
  const capability = capabilityDecision
    ? sanitizeCapabilityDecision(capabilityDecision)
    : existing.capability;
  const timestamp = normalizeString(now, 80) || new Date().toISOString();

  return sanitizeHandoffSummary({
    version: SUMMARY_VERSION,
    tenantId: safeTenantId || existing.tenantId,
    conversationId: safeConversationId || existing.conversationId,
    contact: buildContactSummary(contact, existing.contact),
    channel: buildChannelSummary(channel, existing.channel, safeTenantId || existing.tenantId),
    industry: factValue(relevantFacts, 'businessType') || existing.industry,
    objective: factValue(relevantFacts, 'objective') || existing.objective,
    problem: factValue(relevantFacts, 'problem') || existing.problem,
    relevantFacts,
    systems,
    collectedInformation: {
      ecommercePlatform: factValue(relevantFacts, 'ecommercePlatform') || existing.collectedInformation.ecommercePlatform,
      physicalStoreSystem: factValue(relevantFacts, 'physicalStoreSystem') || existing.collectedInformation.physicalStoreSystem,
      stockSourceOfTruth: factValue(relevantFacts, 'stockSourceOfTruth') || existing.collectedInformation.stockSourceOfTruth,
      stockUpdateMode: factValue(relevantFacts, 'stockUpdateMode') || existing.collectedInformation.stockUpdateMode,
      sharedSkuCatalog: factValue(relevantFacts, 'sharedSkuCatalog') || existing.collectedInformation.sharedSkuCatalog
    },
    capability,
    escalationReason: normalizeString(escalationReason, 200) || existing.escalationReason,
    uncertaintyReason: capability.reason || existing.uncertaintyReason,
    latestRelevantExchange: buildLatestRelevantExchange(
      latestQuestion,
      latestAnswer,
      existing.latestRelevantExchange
    ),
    suggestedAction: normalizeString(suggestedAction, 500) || existing.suggestedAction,
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp
  });
}

module.exports = {
  SUMMARY_VERSION,
  buildHandoffSummary,
  sanitizeHandoffSummary,
  getOwnedHandoffSummary
};
