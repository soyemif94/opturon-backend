const assert = require('assert');
const path = require('path');

function product(id, name, { stock = 0, categoryId = null, categoryName = null, price = 100 } = {}) {
  return { id, name, stock, categoryId, categoryName, price, currency: 'ARS', status: 'active', sku: id.toUpperCase() };
}

const mixedCatalog = Array.from({ length: 40 }, (_, index) => product(
  `mixed-${index + 1}`,
  index === 0 ? 'LA YAPA X UNIDAD' : index === 1 ? 'BELDENT X UNIDAD' : `PRODUCTO MIXTO ${index + 1}`,
  {
    stock: index === 2 ? 5 : index === 3 ? null : 0,
    categoryId: index >= 32 ? 'cat-golosinas' : null,
    categoryName: index >= 32 ? 'Golosinas' : null,
    price: index === 0 ? 430 : 100 + index
  }
));

const categorizedCatalog = [
  ...Array.from({ length: 8 }, (_, index) => product(`cat-a-${index + 1}`, `BEBIDA ${index + 1}`, {
    stock: index === 0 ? 0 : 3,
    categoryId: 'cat-bebidas',
    categoryName: 'Bebidas',
    price: 500 + index
  })),
  ...Array.from({ length: 4 }, (_, index) => product(`cat-other-${index + 1}`, `VARIOS ${index + 1}`, { stock: 0 }))
];

const noCategoryCatalog = Array.from({ length: 100 }, (_, index) => product(
  `no-cat-${index + 1}`,
  `SIN CATEGORIA ${index + 1}`,
  { stock: index === 50 ? 2 : index === 51 ? null : 0, price: 700 + index }
));

const productsByTenant = {
  'tenant-mixed': mixedCatalog,
  'tenant-categorized': categorizedCatalog,
  'tenant-no-category': noCategoryCatalog,
  'tenant-b': [product('tenant-b-1', 'PRODUCTO EXCLUSIVO B', { stock: 4, price: 900 })],
  'tenant-opturon': [product('plan-growth', 'Plan Crecimiento', {
    stock: 10,
    categoryId: 'plans',
    categoryName: 'Planes',
    price: 68000
  })]
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
  createOrderForClinic: async () => { throw new Error('catalog browse regression must not write orders'); },
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

const platformCopy = /Opturon|planes|CRM|automatizaciones|recomendarte algo segun tu negocio/i;

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

function conversation(id, clinicId, state = 'READY', context = {}) {
  return { id, clinicId, state, context };
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
  const mixedClinic = clinic('tenant-mixed');
  let mixedConversation = conversation('mixed-conversation', mixedClinic.id);

  const first = await tenantReply(
    mixedClinic,
    mixedConversation,
    'Me podes pasar una lista de los productos que tienen?'
  );
  assert.ok(first);
  assert.strictEqual(first.newState, 'WAITING_PRODUCT_SELECTION');
  assert.strictEqual(first.contextPatch.commerceCatalogBrowseMode, 'tenant_catalog');
  assert.strictEqual(first.contextPatch.commerceCatalogBrowseTenantId, mixedClinic.id);
  assert.match(first.replyText, /Trabajamos con 40 productos/i);
  assert.match(first.replyText, /LA YAPA X UNIDAD/i);
  assert.doesNotMatch(first.replyText, /1[^\n]*Otros/i);
  assert.doesNotMatch(first.replyText, platformCopy);

  mixedConversation = applyDecision(mixedConversation, first);
  const numeric = await tenantReply(mixedClinic, mixedConversation, '1');
  assert.ok(numeric);
  assert.match(numeric.replyText, /LA YAPA X UNIDAD/i);
  assert.match(numeric.replyText, /no tiene stock disponible/i);
  assert.match(numeric.replyText, /productos similares/i);
  assert.doesNotMatch(numeric.replyText, platformCopy);
  const unavailableConversation = applyDecision(mixedConversation, numeric);

  const directSearch = await tenantReply(mixedClinic, mixedConversation, 'LA YAPA');
  assert.match(directSearch.replyText, /LA YAPA X UNIDAD/i);
  assert.match(directSearch.replyText, /\$\s*430/i);
  assert.doesNotMatch(directSearch.replyText, /BELDENT/i);

  const explicitStock = await tenantReply(mixedClinic, mixedConversation, '¿Tenes stock de LA YAPA X UNIDAD?');
  assert.match(explicitStock.replyText, /LA YAPA X UNIDAD/i);
  assert.match(explicitStock.replyText, /no tiene stock disponible/i);

  const contextualAlternatives = await tenantReply(mixedClinic, unavailableConversation, 'ver mas');
  assert.ok(contextualAlternatives);
  assert.match(contextualAlternatives.replyText, /alternativa suficientemente parecida/i);
  assert.doesNotMatch(contextualAlternatives.replyText, /PRODUCTO MIXTO 11/i);
  assert.doesNotMatch(contextualAlternatives.replyText, platformCopy);

  const categoryClinic = clinic('tenant-categorized');
  let categoryConversation = conversation('category-conversation', categoryClinic.id);
  const categoryMenu = await tenantReply(categoryClinic, categoryConversation, '¿Que productos manejan?');
  assert.match(categoryMenu.replyText, /categorias de nuestro catalogo/i);
  assert.match(categoryMenu.replyText, /Bebidas/i);
  categoryConversation = applyDecision(categoryConversation, categoryMenu);
  const categorySelection = await tenantReply(categoryClinic, categoryConversation, '1');
  assert.match(categorySelection.replyText, /BEBIDA 1/i);
  assert.doesNotMatch(categorySelection.replyText, /VARIOS 1/i);
  assert.doesNotMatch(categorySelection.replyText, platformCopy);
  categoryConversation = applyDecision(categoryConversation, categorySelection);
  const stockedSelection = await tenantReply(categoryClinic, categoryConversation, '2');
  assert.match(stockedSelection.replyText, /Elegiste: BEBIDA 2/i);
  assert.strictEqual(stockedSelection.newState, 'WAITING_QUANTITY');
  categoryConversation = applyDecision(categoryConversation, stockedSelection);
  const quantityReply = await tenantReply(categoryClinic, categoryConversation, '2');
  assert.match(quantityReply.replyText, /Agregue|Agregué|BEBIDA 2/i);
  assert.doesNotMatch(quantityReply.replyText, platformCopy);

  const noCategoryClinic = clinic('tenant-no-category');
  const noCategoryReply = await tenantReply(
    noCategoryClinic,
    conversation('no-category-conversation', noCategoryClinic.id),
    '¿Que productos trabajan?'
  );
  assert.match(noCategoryReply.replyText, /Trabajamos con 100 productos/i);
  assert.match(noCategoryReply.replyText, /SIN CATEGORIA 1/i);
  assert.doesNotMatch(noCategoryReply.replyText, /1[^\n]*Otros/i);
  assert.strictEqual(noCategoryReply.contextPatch.commerceCatalog.length, 100);
  assert.strictEqual(noCategoryReply.contextPatch.commerceCatalogNextOffset, null);

  const tenantB = clinic('tenant-b');
  const foreignStateConversation = conversation(
    'tenant-b-conversation',
    tenantB.id,
    mixedConversation.state,
    mixedConversation.context
  );
  const foreignSelection = await tenantReply(tenantB, foreignStateConversation, '1');
  assert.strictEqual(foreignSelection, null);
  const tenantSafeFallback = worker.buildIntelligentFallbackReply(foreignStateConversation.context, '1', tenantB);
  assert.doesNotMatch(tenantSafeFallback.replyText, platformCopy);
  assert.doesNotMatch(tenantSafeFallback.replyText, /LA YAPA|PRODUCTO MIXTO/i);
  assert.match(tenantSafeFallback.replyText, /producto|categoria/i);

  const opturonClinic = clinic('tenant-opturon', ASSISTANT_MODES.OPTURON_SALES);
  const opturonFallback = worker.buildIntelligentFallbackReply({}, '1', opturonClinic);
  assert.match(opturonFallback.replyText, /planes|precios|pagos/i);

  console.log(JSON.stringify({
    exactMultiturnRegression: 'PASS',
    zeroStockCatalogMembership: 'PASS',
    noCategoryPagination: 'PASS',
    pagination: 'PASS',
    numericSelection: 'PASS',
    directProductSearch: 'PASS',
    tenantSafeFallback: 'PASS',
    multiTenantIsolation: 'PASS',
    opturonSalesRegression: 'PASS',
    writes: 0
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
