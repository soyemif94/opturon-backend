const assert = require('assert');
const path = require('path');

function product(id, name, { stock = 5, categoryId = null, categoryName = null, price = 100 } = {}) {
  return { id, name, stock, categoryId, categoryName, price, currency: 'ARS', status: 'active', sku: id.toUpperCase() };
}

const tenantAProducts = [
  product('la-yapa', 'LA YAPA X UNIDAD', { stock: 0, categoryId: 'golosinas', categoryName: 'Golosinas', price: 430 }),
  product('nueve-oro', '9 DE ORO BIZCOCHO', { stock: 0, categoryId: 'galletitas', categoryName: 'Galletitas', price: 1510 }),
  product('nueve-oro-agridulce', '9 DE ORO AGRIDULCE', { stock: 8, categoryId: 'galletitas', categoryName: 'Galletitas', price: 1510 }),
  product('caramelos', 'CARAMELOS SURTIDOS', { stock: 12, categoryId: 'golosinas', categoryName: 'Golosinas', price: 900 }),
  ...Array.from({ length: 201 }, (_, index) => product(
    `tenant-a-${index + 5}`,
    `PRODUCTO TENANT A ${index + 5}`,
    { price: 1000 + index }
  ))
];
const tenantBProducts = [product('tenant-b-only', 'PRODUCTO EXCLUSIVO TENANT B', { stock: 3, price: 2200 })];
const productsByTenant = {
  'tenant-a': tenantAProducts,
  'tenant-b': tenantBProducts
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
    return (productsByTenant[clinicId] || []).find((item) => item.id === productId) || null;
  }
});
stub('src/services/portal-orders.service.js', {
  createOrderForClinic: async () => { throw new Error('explicit intent priority regression must not write orders'); },
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

const worker = require('../../src/worker').__private__;
const { ASSISTANT_MODES, sanitizeConversationContextForAssistantMode } = require('../../src/ai/assistant-mode');

const numericClarification = /No llegue a identificar que producto queres seleccionar/i;
const platformCopy = /Opturon|CRM|automatizaciones|planes y precios|recomendarte algo segun tu negocio/i;

function clinic(id, assistantMode = ASSISTANT_MODES.TENANT_BUSINESS) {
  return {
    id,
    settings: {
      bot: {
        assistantMode,
        config: {
          businessProfilePreset: 'wholesale_distributor',
          commercialObjective: 'order_generation',
          salesMode: 'proactive',
          businessInstructions: 'Usa solamente el catalogo real del tenant.'
        }
      }
    }
  };
}

function catalogItem(item, index) {
  return { ...item, productId: item.id, index };
}

function staleCatalogContext(clinicId, overrides = {}) {
  return {
    tenantMarker: `marker:${clinicId}`,
    crmState: { preserved: true },
    commerceCartItems: [{ productId: 'caramelos', name: 'CARAMELOS SURTIDOS', quantity: 2, price: 900, currency: 'ARS' }],
    commerceCatalogBrowseMode: 'tenant_catalog',
    commerceCatalogBrowseTenantId: clinicId,
    commerceCatalogIncludesUnavailable: true,
    commerceCatalog: tenantAProducts.slice(0, 100).map((item, index) => catalogItem(item, index + 1)),
    commerceCatalogOffset: 0,
    commerceCatalogNextOffset: 100,
    commerceCatalogTotal: tenantAProducts.length,
    commerceCatalogLogicalPage: 1,
    commerceCatalogPendingAction: 'CATALOG_BROWSE',
    commerceCatalogIncludePrices: false,
    ...overrides
  };
}

function conversation(id, clinicId, context = staleCatalogContext(clinicId)) {
  return { id, clinicId, state: 'WAITING_PRODUCT_SELECTION', context };
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

function applyDecision(targetConversation, decision) {
  return {
    ...targetConversation,
    state: decision.newState || targetConversation.state,
    context: { ...targetConversation.context, ...(decision.contextPatch || {}) }
  };
}

async function main() {
  const tenantA = clinic('tenant-a');
  const staleConversation = conversation('tenant-a-stale', tenantA.id);

  const catalogClassification = worker.classifyTenantExplicitNewIntent('Me podes pasar una lista de los productos que tienen?');
  assert.deepStrictEqual(catalogClassification, { type: 'products', confidence: 'strong', query: null });
  const restartedCatalog = await tenantReply(tenantA, staleConversation, 'Me podes pasar una lista de los productos que tienen?');
  assert.ok(restartedCatalog);
  assert.strictEqual(restartedCatalog.type, 'tenant_catalog_discovery');
  assert.doesNotMatch(restartedCatalog.replyText, numericClarification);
  assert.doesNotMatch(restartedCatalog.replyText, platformCopy);
  assert.match(restartedCatalog.replyText, /1\. LA YAPA X UNIDAD/);
  assert.strictEqual(restartedCatalog.contextPatch.commerceCatalog[0].index, 1);
  assert.strictEqual(restartedCatalog.contextPatch.commerceCatalogNextOffset, 100);
  assert.deepStrictEqual(staleConversation.context.crmState, { preserved: true });
  assert.deepStrictEqual(restartedCatalog.contextPatch.commerceCartItems, staleConversation.context.commerceCartItems);

  const exactSearch = await tenantReply(tenantA, staleConversation, 'Busco LA YAPA X UNIDAD');
  assert.strictEqual(exactSearch.type, 'tenant_catalog_direct_search');
  assert.match(exactSearch.replyText, /LA YAPA X UNIDAD/);
  assert.match(exactSearch.replyText, /\$\s*430/);
  assert.match(exactSearch.replyText, /no tiene stock disponible/i);
  assert.doesNotMatch(exactSearch.replyText, numericClarification);

  const categorySearch = await tenantReply(tenantA, staleConversation, '¿Qué golosinas tienen?');
  assert.ok(categorySearch);
  assert.strictEqual(categorySearch.type, 'tenant_catalog_search');
  assert.doesNotMatch(categorySearch.replyText, numericClarification);
  assert.doesNotMatch(categorySearch.replyText, /PRODUCTO EXCLUSIVO TENANT B/i);

  const filteredSearch = await tenantReply(tenantA, staleConversation, 'Quiero ver galletitas');
  assert.ok(filteredSearch);
  assert.strictEqual(filteredSearch.type, 'tenant_catalog_search');
  assert.match(filteredSearch.replyText, /9 DE ORO/i);
  assert.doesNotMatch(filteredSearch.replyText, numericClarification);

  const priceAndStock = await tenantReply(tenantA, staleConversation, '¿Cuánto sale 9 DE ORO BIZCOCHO y tenés stock?');
  assert.strictEqual(priceAndStock.type, 'price_and_stock');
  assert.match(priceAndStock.replyText, /9 DE ORO BIZCOCHO/);
  assert.match(priceAndStock.replyText, /\$\s*1\.510/);
  assert.match(priceAndStock.replyText, /no tiene stock disponible/i);
  assert.doesNotMatch(priceAndStock.replyText, numericClarification);

  const handoff = await tenantReply(tenantA, staleConversation, 'Quiero hablar con una persona');
  assert.strictEqual(handoff.type, 'human_handoff');
  assert.strictEqual(handoff.triggerHandoff, true);
  assert.strictEqual(handoff.contextPatch.commerceCatalogPendingAction, null);
  assert.strictEqual(handoff.contextPatch.commerceCatalogBrowseMode, null);

  const orderClassification = worker.classifyTenantExplicitNewIntent('Quiero hacer un pedido');
  assert.deepStrictEqual(orderClassification, { type: 'order', confidence: 'strong', query: null });
  const safeOrder = await tenantReply(tenantA, staleConversation, 'Quiero hacer un pedido');
  assert.strictEqual(safeOrder, null);
  const orderFlow = await worker.resolveCommerceDecision({
    clinic: tenantA,
    conversation: staleConversation,
    inboundText: 'Quiero hacer un pedido'
  });
  assert.ok(orderFlow);
  assert.doesNotMatch(orderFlow.replyText, numericClarification);
  assert.match(orderFlow.replyText, /categorias|productos/i);

  assert.strictEqual(worker.classifyTenantExplicitNewIntent('1'), null);
  const numericSelection = await tenantReply(tenantA, staleConversation, '1');
  assert.ok(numericSelection);
  assert.match(numericSelection.replyText, /LA YAPA X UNIDAD/);
  assert.doesNotMatch(numericSelection.replyText, numericClarification);

  assert.strictEqual(worker.classifyTenantExplicitNewIntent('ver más'), null);
  const catalogMore = await tenantReply(tenantA, staleConversation, 'ver más');
  assert.strictEqual(catalogMore.type, 'tenant_catalog_pagination');
  assert.strictEqual(catalogMore.contextPatch.commerceCatalog[0].index, 101);

  const outOfStockConversation = applyDecision(staleConversation, exactSearch);
  const similarMore = await tenantReply(tenantA, outOfStockConversation, 'ver más');
  assert.ok(similarMore);
  assert.match(similarMore.replyText, /similares|similar/i);
  assert.doesNotMatch(similarMore.replyText, /101\. PRODUCTO TENANT A 101/i);

  const resumedCatalog = await tenantReply(tenantA, outOfStockConversation, 'seguir catálogo');
  assert.strictEqual(resumedCatalog.type, 'tenant_catalog_resume');
  assert.strictEqual(resumedCatalog.contextPatch.commerceCatalog[0].index, 101);

  const tenantB = clinic('tenant-b');
  const crossTenantConversation = conversation('tenant-b-conversation', tenantB.id, staleConversation.context);
  const crossTenantNumeric = await tenantReply(tenantB, crossTenantConversation, '1');
  assert.strictEqual(crossTenantNumeric, null);
  const tenantBExplicit = await tenantReply(tenantB, crossTenantConversation, 'Me podes pasar una lista de los productos que tienen?');
  assert.match(tenantBExplicit.replyText, /PRODUCTO EXCLUSIVO TENANT B/);
  assert.doesNotMatch(tenantBExplicit.replyText, /LA YAPA|PRODUCTO TENANT A/i);

  const tenantFallback = worker.buildIntelligentFallbackReply(staleConversation.context, 'algo ambiguo', tenantA);
  assert.doesNotMatch(tenantFallback.replyText, platformCopy);
  const opturon = clinic('tenant-opturon', ASSISTANT_MODES.OPTURON_SALES);
  const opturonFallback = worker.buildIntelligentFallbackReply({}, 'algo ambiguo', opturon);
  assert.match(opturonFallback.replyText, /planes|precios|pagos/i);

  console.log(JSON.stringify({
    explicitIntentOverridesStaleState: 'PASS',
    staleNumericStateCatalogRequest: 'PASS',
    staleStateExactProductSearch: 'PASS',
    staleStateCategorySearch: 'PASS',
    staleStateOrderIntent: 'PASS',
    staleStateHumanHandoff: 'PASS',
    numericSelectionRegression: 'PASS',
    catalogSeeMoreRegression: 'PASS',
    similarSeeMoreRegression: 'PASS',
    catalogResumeRegression: 'PASS',
    multiTenantStateIsolation: 'PASS',
    opturonSalesRegression: 'PASS',
    writes: 0
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
