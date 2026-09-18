const assert = require('assert');
const path = require('path');

const productsByTenant = {
  'tenant-distributor': [
    { id: 'candy-1', name: 'Caramelos surtidos', categoryId: 'cat-candy', categoryName: 'Golosinas', price: 1500, currency: 'ARS', stock: 12, status: 'active', sku: 'CAR-1' },
    { id: 'candy-2', name: 'Alfajores caja x12', categoryId: 'cat-candy', categoryName: 'Golosinas', price: 6200, currency: 'ARS', stock: 4, status: 'active', sku: 'ALF-12' },
    { id: 'drink-1', name: 'Gaseosa cola 500ml', categoryId: 'cat-drinks', categoryName: 'Bebidas', price: 1800, currency: 'ARS', stock: 8, status: 'active', sku: 'COLA-500' }
  ],
  'tenant-clinic': [
    { id: 'service-1', name: 'Consulta general', categoryId: 'cat-services', categoryName: 'Consultas', price: 9000, currency: 'ARS', stock: 1, status: 'active', sku: 'CONSULTA' }
  ],
  'tenant-real-estate': [
    { id: 'listing-1', name: 'Departamento en alquiler Centro', categoryId: 'cat-rent', categoryName: 'Alquileres', price: 350000, currency: 'ARS', stock: 1, status: 'active', sku: 'ALQ-001' }
  ],
  'tenant-opturon-sales': [
    { id: 'plan-1', name: 'Plan Crecimiento', categoryId: 'cat-plans', categoryName: 'Planes', price: 68000, currency: 'ARS', stock: 10, status: 'active', sku: 'PLAN-GROWTH' }
  ]
};

function stub(relativePath, value) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: value };
}

stub('src/repositories/products.repository.js', {
  listProductsByClinicId: async (clinicId) => productsByTenant[clinicId] || [],
  findProductById: async (first, second) => {
    const clinicId = productsByTenant[first] ? first : second;
    const productId = productsByTenant[first] ? second : first;
    return (productsByTenant[clinicId] || []).find((product) => product.id === productId) || null;
  }
});
stub('src/services/portal-orders.service.js', {
  createOrderForClinic: async () => {
    throw new Error('identity routing regression must not write orders');
  },
  patchOrderStatusForClinic: async () => ({ ok: false, reason: 'not_used' })
});
stub('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }),
  findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0,
  countEventsByType: async () => 0,
  countClinicEventsByTypeCurrentMonth: async () => 0
});
stub('src/utils/logger.js', { logInfo: () => {}, logWarn: () => {}, logError: () => {} });

const { __private__: worker } = require('../../src/worker');
const aiAssist = require('../../src/services/ai-assist.service').__internal;
const {
  ASSISTANT_MODES,
  resolveAssistantModeFromSettings,
  buildAssistantModeCompatibilityPatch,
  sanitizeConversationContextForAssistantMode
} = require('../../src/ai/assistant-mode');

const exactKioskMessage = 'Hola, tengo un kiosco y quería saber qué productos manejan.';
const forbiddenPlatformSales = /CRM|cu[aá]ntas consultas(?: les entran)? por WhatsApp|cu[aá]ntas personas|vendedores responden|soluci[oó]n m[aá]s completa|caja y seguimiento/i;

function clinic(id, config, assistantMode = null) {
  return {
    id,
    timezone: 'America/Argentina/Buenos_Aires',
    settings: {
      bot: {
        ...(assistantMode ? { assistantMode } : {}),
        config
      }
    }
  };
}

function conversation(id, clinicId, context = {}) {
  return { id, clinicId, state: 'READY', context };
}

async function tenantReply(targetClinic, targetConversation, message) {
  const safeContext = sanitizeConversationContextForAssistantMode(
    ASSISTANT_MODES.TENANT_BUSINESS,
    targetConversation.context
  );
  return worker.buildSafeCommercialIntentReply({
    clinic: targetClinic,
    conversation: { ...targetConversation, context: safeContext },
    inboundText: message,
    assistantMode: ASSISTANT_MODES.TENANT_BUSINESS
  });
}

async function main() {
  const distributorConfig = {
    name: 'Mia',
    tone: 'amigable',
    treatment: 'vos',
    businessProfilePreset: 'wholesale_distributor',
    commercialObjective: 'order_generation',
    salesMode: 'proactive',
    businessInstructions: 'Ofrece solamente productos reales del catalogo.'
  };
  const distributor = clinic('tenant-distributor', distributorConfig);
  const clinicTenant = clinic('tenant-clinic', {
    businessProfilePreset: 'health_appointments',
    commercialObjective: 'appointments',
    salesMode: 'consultative',
    businessInstructions: 'Explica servicios reales y facilita agenda.'
  });
  const realEstate = clinic('tenant-real-estate', {
    businessProfilePreset: 'real_estate',
    commercialObjective: 'lead_capture',
    salesMode: 'consultative',
    businessInstructions: 'Usa solamente propiedades reales disponibles.'
  });

  assert.strictEqual(resolveAssistantModeFromSettings(distributor.settings), ASSISTANT_MODES.TENANT_BUSINESS);
  assert.strictEqual(
    resolveAssistantModeFromSettings({ bot: { assistantMode: 'opturon_sales' } }),
    ASSISTANT_MODES.OPTURON_SALES
  );

  const tenantPrompt = aiAssist.buildAiAssistSystemPrompt(distributorConfig, {
    assistantMode: ASSISTANT_MODES.TENANT_BUSINESS
  });
  const opturonPrompt = aiAssist.buildAiAssistSystemPrompt({}, {
    assistantMode: ASSISTANT_MODES.OPTURON_SALES
  });
  assert.match(tenantPrompt, /<TENANT_BUSINESS_IDENTITY>/);
  assert.match(tenantPrompt, /<TENANT_COMMERCIAL_PROFILE>/);
  assert.match(tenantPrompt, /No sos un vendedor de Opturon/i);
  assert.doesNotMatch(tenantPrompt, /Commercial Knowledge Base versionada/i);
  assert.doesNotMatch(tenantPrompt, /nextDiscoveryField debe sugerir/i);
  assert.match(opturonPrompt, /<OPTURON_SALES_IDENTITY>/);
  assert.match(opturonPrompt, /Commercial Knowledge Base versionada/i);
  assert.match(opturonPrompt, /nextDiscoveryField debe sugerir|cantidad de vendedores/i);

  const contaminatedContext = {
    activeBotDomain: 'commerce',
    commercialDiscoveryPending: { field: 'team_size', sourceIntent: 'industry_fit', status: 'pending' },
    commercialSalesContext: { businessTypeRaw: 'kiosco', teamSizeSignal: 'small' },
    commercialPlanContext: { topic: 'plan_recommendation', lastDiscussedPlanId: 'plan-growth' },
    commercialShortMemory: { topic: 'plans', lastSuggestedProductId: 'plan-growth' },
    commerceCartItems: [{ productId: 'candy-1', quantity: 1 }]
  };
  const compatibilityPatch = buildAssistantModeCompatibilityPatch(
    ASSISTANT_MODES.TENANT_BUSINESS,
    contaminatedContext
  );
  assert.strictEqual(compatibilityPatch.assistantMode, ASSISTANT_MODES.TENANT_BUSINESS);
  assert.strictEqual(compatibilityPatch.commercialDiscoveryPending, null);
  assert.strictEqual(compatibilityPatch.commercialSalesContext, null);
  assert.strictEqual(compatibilityPatch.commercialPlanContext, null);
  assert.strictEqual(compatibilityPatch.commercialShortMemory, null);
  const sanitized = sanitizeConversationContextForAssistantMode(
    ASSISTANT_MODES.TENANT_BUSINESS,
    contaminatedContext
  );
  assert.deepStrictEqual(sanitized.commerceCartItems, contaminatedContext.commerceCartItems);

  const exactReply = await tenantReply(
    distributor,
    conversation('conv-distributor', distributor.id, contaminatedContext),
    exactKioskMessage
  );
  assert.ok(exactReply, 'exact kiosk message must resolve in tenant mode');
  assert.doesNotMatch(exactReply.replyText, forbiddenPlatformSales);
  assert.match(exactReply.replyText, /pedido|categorias|Golosinas|Bebidas/i);
  assert.strictEqual(exactReply.newState, 'WAITING_PRODUCT_SELECTION');

  const candyReply = await tenantReply(
    distributor,
    conversation('conv-distributor-2', distributor.id),
    '¿Qué golosinas me podés ofrecer?'
  );
  assert.doesNotMatch(candyReply.replyText, forbiddenPlatformSales);
  assert.match(candyReply.replyText, /Caramelos surtidos|Alfajores caja x12/i);
  assert.doesNotMatch(candyReply.replyText, /Plan Crecimiento/i);

  const priceAndStockReply = await tenantReply(
    distributor,
    conversation('conv-distributor-price-stock', distributor.id),
    '¿Cuánto sale Caramelos surtidos y tenés stock?'
  );
  assert.match(priceAndStockReply.replyText, /Caramelos surtidos/i);
  assert.match(priceAndStockReply.replyText, /1[\.\s]?500/);
  assert.match(priceAndStockReply.replyText, /12\s+unidades|stock/i);
  assert.doesNotMatch(priceAndStockReply.replyText, forbiddenPlatformSales);
  assert.strictEqual(priceAndStockReply.contextPatch.activeBotDomain, 'commerce');

  const proactiveReply = await tenantReply(
    distributor,
    conversation('conv-distributor-3', distributor.id, {
      commerceCartItems: [{ productId: 'candy-1', name: 'Caramelos surtidos', price: 1500, currency: 'ARS', quantity: 1 }]
    }),
    'Estoy armando un pedido para el kiosco, ¿qué más me recomendás agregar?'
  );
  assert.match(proactiveReply.replyText, /podr[ií]as sumar|completar el pedido/i);
  assert.doesNotMatch(proactiveReply.replyText, /Caramelos surtidos/i);
  assert.doesNotMatch(proactiveReply.replyText, forbiddenPlatformSales);

  const clinicReply = await tenantReply(
    clinicTenant,
    conversation('conv-clinic', clinicTenant.id),
    '¿Qué servicios ofrecen?'
  );
  assert.match(clinicReply.replyText, /Consultas|Consulta general/i);
  assert.doesNotMatch(clinicReply.replyText, forbiddenPlatformSales);

  const propertyReply = await tenantReply(
    realEstate,
    conversation('conv-real-estate', realEstate.id),
    'Busco algo para alquilar.'
  );
  assert.match(propertyReply.replyText, /Departamento en alquiler Centro/i);
  assert.doesNotMatch(propertyReply.replyText, forbiddenPlatformSales);

  const blockedAiReply = await worker.resolveAiAssistDecision({
    clinic: distributor,
    conversation: conversation('conv-ai-tenant', distributor.id),
    inboundText: exactKioskMessage,
    safeContext: {},
    assistantMode: ASSISTANT_MODES.TENANT_BUSINESS,
    aiDecision: {
      domain: 'commerce',
      intent: 'industry_fit',
      confidence: 0.9,
      entities: { businessTypeRaw: 'kiosco', businessCategory: 'retail' },
      routingDecision: 'use_existing_commerce_reply',
      suggestedReplyIntent: 'industry_fit'
    }
  });
  assert.strictEqual(blockedAiReply, null);

  const opturonSales = clinic('tenant-opturon-sales', {}, ASSISTANT_MODES.OPTURON_SALES);
  const opturonReply = await worker.buildSafeCommercialIntentReply({
    clinic: opturonSales,
    conversation: conversation('conv-opturon-sales', opturonSales.id),
    inboundText: exactKioskMessage,
    assistantMode: ASSISTANT_MODES.OPTURON_SALES
  });
  assert.match(opturonReply.replyText, /cu[aá]ntas consultas les entran por WhatsApp/i);
  assert.match(opturonReply.replyText, /CRM, ventas, pedidos, caja y seguimiento/i);

  const greeting = worker.buildConfiguredCommercialGreetingCopy(distributorConfig);
  assert.match(greeting, /Mia/);
  assert.match(greeting, /distribuidora mayorista/i);
  assert.match(greeting, /generar pedidos/i);

  console.log(JSON.stringify({
    exactKioskRegression: 'PASS',
    tenants: 3,
    catalogGrounding: 'PASS',
    platformSalesRegression: 'PASS',
    staleStateCompatibility: 'PASS',
    writes: 0
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
