const assert = require('assert');
const path = require('path');

function product(id, name, {
  stock = 0,
  categoryId = null,
  categoryName = null,
  brand = null,
  family = null,
  price = 100
} = {}) {
  return {
    id,
    name,
    stock,
    categoryId,
    categoryName,
    brand,
    family,
    price,
    currency: 'ARS',
    status: 'active',
    sku: id.toUpperCase()
  };
}

const largeCatalog = Array.from({ length: 505 }, (_, index) => product(
  `large-${index + 1}`,
  index === 0
    ? '9 DE ORO BIZCOCHO'
    : index === 1
      ? '9 DE ORO AGRIDULCE'
      : index === 2
        ? '9 DE ORO COOKIES'
        : index === 3
          ? 'ALIKAL X SOBRE'
          : index === 4
            ? 'ASPIRINETA X14'
            : index === 5
              ? 'LA YAPA X UNIDAD'
              : index === 6
                ? 'BELDENT X UNIDAD'
                : `PRODUCTO CATALOGO ${String(index + 1).padStart(3, '0')}`,
  {
    stock: index === 1 ? 12 : index === 2 ? 0 : index > 2 ? 4 : 0,
    price: index === 5 ? 430 : 1000 + index
  }
));

const numberingCatalog = Array.from({ length: 105 }, (_, index) => product(
  `number-${index + 1}`,
  `ARTICULO NUMERADO ${index + 1}`,
  { stock: index % 2, price: 200 + index }
));

const longNameCatalog = Array.from({ length: 120 }, (_, index) => product(
  `long-${index + 1}`,
  `PRODUCTO CON NOMBRE EXTENSO ${String(index + 1).padStart(3, '0')} ${'DESCRIPCION COMERCIAL '.repeat(7).trim()}`,
  { stock: 1, price: 500 + index }
));

const productsByTenant = {
  'tenant-large': largeCatalog,
  'tenant-numbering': numberingCatalog,
  'tenant-long': longNameCatalog,
  'tenant-b': [product('tenant-b-1', 'PRODUCTO PRIVADO TENANT B', { stock: 3 })],
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
  createOrderForClinic: async () => { throw new Error('catalog UX regression must not write orders'); },
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
const { rankSimilarProducts } = require('../../src/utils/conversational-commerce');
const { ASSISTANT_MODES, sanitizeConversationContextForAssistantMode } = require('../../src/ai/assistant-mode');

const platformCopy = /Opturon|planes|CRM|automatizaciones|recomendarte algo segun tu negocio/i;
const keycapNumber = /[1-9]️⃣|🔟/u;

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
  const largeClinic = clinic('tenant-large');
  let largeConversation = conversation('large-conversation', largeClinic.id);

  const first = await tenantReply(largeClinic, largeConversation, 'Me pasás una lista de productos?');
  assert.ok(first);
  assert.strictEqual(first.contextPatch.commerceCatalog.length, 100);
  assert.strictEqual(first.contextPatch.commerceCatalog[0].index, 1);
  assert.strictEqual(first.contextPatch.commerceCatalog[99].index, 100);
  assert.strictEqual(first.contextPatch.commerceCatalogNextOffset, 100);
  assert.strictEqual(first.contextPatch.commerceCatalogLogicalPage, 1);
  assert.strictEqual(first.contextPatch.commerceCatalogPendingAction, 'CATALOG_BROWSE');
  assert.match(first.replyText, /^1\. 9 DE ORO BIZCOCHO$/m);
  assert.match(first.replyText, /^10\. PRODUCTO CATALOGO 010$/m);
  assert.match(first.replyText, /^11\. PRODUCTO CATALOGO 011$/m);
  assert.match(first.replyText, /^100\. PRODUCTO CATALOGO 100$/m);
  assert.doesNotMatch(first.replyText, keycapNumber);
  assert.doesNotMatch(first.replyText, /\$\s*[\d.]+/);
  assert.doesNotMatch(first.replyText, platformCopy);

  const pricedList = await tenantReply(
    largeClinic,
    conversation('priced-list-conversation', largeClinic.id),
    'Me pasás una lista de productos con precios?'
  );
  assert.strictEqual(pricedList.contextPatch.commerceCatalogIncludePrices, true);
  assert.match(pricedList.replyText, /^1\. 9 DE ORO BIZCOCHO — \$\s*[\d.]+$/m);
  assert.ok(worker.splitWhatsAppTextChunks(pricedList.replyText).every((chunk) => chunk.length <= 3500));

  largeConversation = applyDecision(largeConversation, first);
  const second = await tenantReply(largeClinic, largeConversation, 'ver más');
  assert.strictEqual(second.contextPatch.commerceCatalog[0].index, 101);
  assert.strictEqual(second.contextPatch.commerceCatalog[99].index, 200);
  assert.strictEqual(second.contextPatch.commerceCatalogLogicalPage, 2);
  assert.match(second.replyText, /^101\. PRODUCTO CATALOGO 101$/m);
  assert.doesNotMatch(second.replyText, /^11\./m);
  const pageTwoConversation = applyDecision(largeConversation, second);

  const third = await tenantReply(largeClinic, pageTwoConversation, 'siguiente');
  assert.strictEqual(third.contextPatch.commerceCatalog[0].index, 201);
  assert.strictEqual(third.contextPatch.commerceCatalog[99].index, 300);
  let paginationConversation = applyDecision(pageTwoConversation, third);
  const fourth = await tenantReply(largeClinic, paginationConversation, 'continuar');
  assert.strictEqual(fourth.contextPatch.commerceCatalog[0].index, 301);
  paginationConversation = applyDecision(paginationConversation, fourth);
  const fifth = await tenantReply(largeClinic, paginationConversation, 'más');
  assert.strictEqual(fifth.contextPatch.commerceCatalog[0].index, 401);
  assert.strictEqual(fifth.contextPatch.commerceCatalog[99].index, 500);
  paginationConversation = applyDecision(paginationConversation, fifth);
  const sixth = await tenantReply(largeClinic, paginationConversation, 'ver más');
  assert.strictEqual(sixth.contextPatch.commerceCatalog[0].index, 501);
  assert.strictEqual(sixth.contextPatch.commerceCatalog[4].index, 505);
  assert.strictEqual(sixth.contextPatch.commerceCatalogNextOffset, null);

  const outOfStock = await tenantReply(largeClinic, pageTwoConversation, '9 DE ORO BIZCOCHO');
  assert.match(outOfStock.replyText, /9 DE ORO BIZCOCHO/i);
  assert.match(outOfStock.replyText, /no tiene stock disponible/i);
  assert.match(outOfStock.replyText, /productos similares/i);
  assert.strictEqual(outOfStock.contextPatch.commerceCatalogPendingAction, 'SIMILAR_PRODUCTS');
  const outOfStockConversation = applyDecision(pageTwoConversation, outOfStock);

  const similar = await tenantReply(largeClinic, outOfStockConversation, 'ver más');
  assert.strictEqual(similar.type, 'tenant_catalog_similar_products');
  assert.match(similar.replyText, /9 DE ORO AGRIDULCE/i);
  assert.match(similar.replyText, /9 DE ORO COOKIES/i);
  assert.ok(similar.replyText.indexOf('9 DE ORO AGRIDULCE') < similar.replyText.indexOf('9 DE ORO COOKIES'));
  assert.doesNotMatch(similar.replyText, /ALIKAL|ASPIRINETA/i);
  assert.doesNotMatch(similar.replyText, /^201\./m);
  assert.doesNotMatch(similar.replyText, keycapNumber);
  assert.doesNotMatch(similar.replyText, platformCopy);
  const similarConversation = applyDecision(outOfStockConversation, similar);

  const resumed = await tenantReply(largeClinic, similarConversation, 'seguir catálogo');
  assert.strictEqual(resumed.type, 'tenant_catalog_resume');
  assert.strictEqual(resumed.contextPatch.commerceCatalog[0].index, 201);
  assert.match(resumed.replyText, /^201\. PRODUCTO CATALOGO 201$/m);
  assert.strictEqual(resumed.contextPatch.commerceCatalogPendingAction, 'CATALOG_BROWSE');

  const exact = await tenantReply(largeClinic, pageTwoConversation, '¿Cuánto sale LA YAPA X UNIDAD y tenés stock?');
  assert.match(exact.replyText, /LA YAPA X UNIDAD/i);
  assert.match(exact.replyText, /\$\s*430/i);
  assert.doesNotMatch(exact.replyText, /BELDENT/i);

  const numberingClinic = clinic('tenant-numbering');
  const numbering = await tenantReply(
    numberingClinic,
    conversation('numbering-conversation', numberingClinic.id),
    '¿Qué productos trabajan?'
  );
  assert.match(numbering.replyText, /^1\. ARTICULO NUMERADO 1$/m);
  assert.match(numbering.replyText, /^10\. ARTICULO NUMERADO 10$/m);
  assert.match(numbering.replyText, /^11\. ARTICULO NUMERADO 11$/m);
  assert.match(numbering.replyText, /^100\. ARTICULO NUMERADO 100$/m);
  assert.doesNotMatch(numbering.replyText, keycapNumber);

  const longClinic = clinic('tenant-long');
  const longReply = await tenantReply(
    longClinic,
    conversation('long-conversation', longClinic.id),
    'Me pasás una lista de productos?'
  );
  const chunks = worker.splitWhatsAppTextChunks(longReply.replyText);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.match(chunks.join('\n'), /PRODUCTO CON NOMBRE EXTENSO 100 DESCRIPCION COMERCIAL/);

  const brandFamilyCatalog = [
    product('selected', 'MODELO CENTRAL', { brand: 'Marca Alfa', family: 'Familia Uno', stock: 0 }),
    product('same-both', 'MODELO A', { brand: 'Marca Alfa', family: 'Familia Uno', stock: 1 }),
    product('same-family', 'MODELO B', { brand: 'Marca Beta', family: 'Familia Uno', stock: 1 }),
    product('same-brand', 'MODELO C', { brand: 'Marca Alfa', family: 'Familia Dos', stock: 1 }),
    product('unrelated', 'MODELO D', { brand: 'Marca Delta', family: 'Familia Tres', stock: 1 })
  ];
  const ranked = rankSimilarProducts(brandFamilyCatalog, brandFamilyCatalog[0]);
  assert.strictEqual(ranked[0].product.id, 'same-both');
  assert.ok(ranked.findIndex((entry) => entry.product.id === 'same-family') < ranked.findIndex((entry) => entry.product.id === 'same-brand'));
  assert.ok(!ranked.some((entry) => entry.product.id === 'unrelated'));

  const tenantB = clinic('tenant-b');
  const foreignConversation = conversation(
    'tenant-b-conversation',
    tenantB.id,
    similarConversation.state,
    similarConversation.context
  );
  const foreignReply = await tenantReply(tenantB, foreignConversation, 'ver más');
  assert.strictEqual(foreignReply, null);
  const tenantSafe = worker.buildIntelligentFallbackReply(foreignConversation.context, 'ver más', tenantB);
  assert.doesNotMatch(tenantSafe.replyText, /9 DE ORO|ALIKAL|ASPIRINETA/i);
  assert.doesNotMatch(tenantSafe.replyText, platformCopy);

  const noContextMore = await tenantReply(
    largeClinic,
    conversation('no-context-more', largeClinic.id),
    'ver más'
  );
  assert.strictEqual(noContextMore, null);
  const noContextFallback = worker.buildIntelligentFallbackReply({}, 'ver más', largeClinic);
  assert.match(noContextFallback.replyText, /producto|categoría|categoria/i);
  assert.doesNotMatch(noContextFallback.replyText, platformCopy);

  const opturonClinic = clinic('tenant-opturon', ASSISTANT_MODES.OPTURON_SALES);
  const opturonFallback = worker.buildIntelligentFallbackReply({}, 'ver más', opturonClinic);
  assert.match(opturonFallback.replyText, /planes|precios|pagos/i);

  console.log(JSON.stringify({
    numbering: 'PASS',
    logicalPageSize: 100,
    largeCatalogPagination: 'PASS',
    transportSafeCharBudget: 3500,
    transportChunking: 'PASS',
    outOfStockContext: 'PASS',
    similarProductRanking: 'PASS',
    stockPriority: 'PASS',
    catalogResume: 'PASS',
    exactProductMatch: 'PASS',
    multiTenantIsolation: 'PASS',
    opturonSalesRegression: 'PASS',
    writes: 0
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
