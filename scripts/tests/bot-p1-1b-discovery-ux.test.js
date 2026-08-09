const assert = require('assert');
const path = require('path');

const samplePlans = [
  {
    id: 'plan-starter',
    productId: 'plan-starter',
    name: 'Plan Inicial',
    price: 15000,
    currency: 'ARS',
    stock: 10,
    status: 'active'
  },
  {
    id: 'plan-growth',
    productId: 'plan-growth',
    name: 'Plan Crecimiento',
    price: 30000,
    currency: 'ARS',
    stock: 8,
    status: 'active'
  }
];

function stubModule(relativePath, exportsValue) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
}

stubModule('src/repositories/products.repository.js', {
  listProductsByClinicId: async () => samplePlans,
  findProductById: async (clinicId, productId) => samplePlans.find((item) => item.id === productId) || null
});

stubModule('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }),
  findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0
});

const {
  buildSafeCommercialIntentReply,
  getActiveCommercialDiscoveryPending
} = require('../../src/worker').__private__;

const clinic = {
  id: 'clinic-1',
  settings: {
    businessProfile: {},
    bot: {}
  }
};

const portfolioInput = [
  'Hola Opturon. Vengo desde Portfolio y quiero probar como funciona el sistema.',
  'Rubro: Local de insumos para trabajos con resina',
  'Tipo de consultas que recibo: Compras de productos varios',
  'Objetivo principal: alinear stock tienda online y local fisico'
].join('\n');

function normalizeForAssertion(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function sendTurn(context, inboundText) {
  const reply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      id: 'conversation-1',
      clinicId: 'clinic-1',
      context
    },
    inboundText
  });
  return {
    reply,
    context: JSON.parse(JSON.stringify({
      ...(context || {}),
      ...((reply && reply.contextPatch) || {})
    }))
  };
}

function assertOneQuestion(replyText) {
  assert.strictEqual((String(replyText || '').match(/\?/g) || []).length, 1);
}

function assertCompressedIntermediateReply(replyText) {
  const text = normalizeForAssertion(replyText);
  assert.doesNotMatch(text, /perfecto/);
  assert.doesNotMatch(text, /local de insumos para trabajos con resina/);
  assert.doesNotMatch(text, /esto todavia no confirma una integracion/);
  assertOneQuestion(replyText);
}

async function startInventoryDiscovery() {
  return sendTurn({ activeBotDomain: 'commerce' }, portfolioInput);
}

async function run() {
  const initial = await startInventoryDiscovery();
  assert.strictEqual(initial.context.commercialDiscoveryState.status, 'DISCOVERY_IN_PROGRESS');
  assert.strictEqual(initial.context.commercialDiscoveryState.currentEvidenceGap, 'commerce_platform');

  const platforms = await sendTurn(
    initial.context,
    'Empretienda online y Cianbox en el local'
  );
  const platformsText = normalizeForAssertion(platforms.reply.replyText);
  assertCompressedIntermediateReply(platforms.reply.replyText);
  assert.match(platformsText, /empretienda.*venta online.*cianbox.*local/);
  assert.strictEqual(getActiveCommercialDiscoveryPending(platforms.context).field, 'stock_source_of_truth');
  assert.strictEqual(platforms.context.commercialDiscoveryState.status, 'DISCOVERY_IN_PROGRESS');
  assert.strictEqual(platforms.context.commercialDiscoveryState.currentEvidenceGap, 'stock_source_of_truth');
  assert.strictEqual(platforms.context.commercialDiscoveryState.lastResolvedField, 'commerce_platform');

  const stockSource = await sendTurn(platforms.context, 'Cianbox');
  const stockSourceText = normalizeForAssertion(stockSource.reply.replyText);
  assertCompressedIntermediateReply(stockSource.reply.replyText);
  assert.match(stockSourceText, /cianbox.*referencia principal del stock/);
  assert.doesNotMatch(stockSourceText, /empretienda.*venta online/);
  assert.strictEqual(getActiveCommercialDiscoveryPending(stockSource.context).field, 'stock_update_method');

  const updateMode = await sendTurn(stockSource.context, 'Lo actualizo manualmente en los dos');
  const updateModeText = normalizeForAssertion(updateMode.reply.replyText);
  assertCompressedIntermediateReply(updateMode.reply.replyText);
  assert.match(updateModeText, /actualizas el stock manualmente/);
  assert.doesNotMatch(updateModeText, /cianbox.*referencia principal/);
  assert.strictEqual(getActiveCommercialDiscoveryPending(updateMode.context).field, 'shared_sku_catalog');

  const completed = await sendTurn(updateMode.context, 'si');
  const completedText = normalizeForAssertion(completed.reply.replyText);
  const completedFacts = completed.context.commercialSalesContext.groundedFacts;
  assert.strictEqual((completed.reply.replyText.match(/\?/g) || []).length, 0);
  assert.match(completedText, /ambos sistemas usan los mismos codigos o sku/);
  assert.match(completedText, /ya tengo claro como manejas hoy el stock/);
  assert.match(completedText, /prefiero no confirmarte una integracion sin esa revision/);
  assert.match(completedText, /asesor.*revise/);
  assert.doesNotMatch(completedText, /opturon (?:ya )?(?:integra|sincroniza)/);
  assert.strictEqual(getActiveCommercialDiscoveryPending(completed.context), null);
  assert.strictEqual(completed.context.commercialDiscoveryState.status, 'DISCOVERY_SUFFICIENT');
  assert.strictEqual(completed.context.commercialDiscoveryState.currentEvidenceGap, null);
  assert.strictEqual(completed.context.commercialDiscoveryState.lastResolvedField, 'shared_sku_catalog');
  assert.strictEqual(completed.context.commercialDiscoveryState.capabilityStatus, 'NEEDS_VERIFICATION');
  assert.strictEqual(completed.context.commercialDiscoveryState.nextAction, 'human_review');
  assert.strictEqual(completed.context.commercialDiscoveryState.handoffReason, 'capability_verification_required');
  assert.strictEqual(completed.reply.triggerHandoff, true);
  assert.strictEqual(completed.reply.handoffReason, 'capability_verification_required');
  assert.strictEqual(completed.context.commercialDiscoveryLastResolved.expectedField, 'shared_sku_catalog');
  assert.strictEqual(completedFacts.ecommercePlatform.value, 'empretienda');
  assert.strictEqual(completedFacts.physicalStoreSystem.value, 'cianbox');
  assert.strictEqual(completedFacts.stockSourceOfTruth.value, 'cianbox');
  assert.strictEqual(completedFacts.stockUpdateMode.value, 'manual');
  assert.strictEqual(completedFacts.sharedSkuCatalog.value, 'yes');

  const correctionInitial = await startInventoryDiscovery();
  const correctionPlatforms = await sendTurn(
    correctionInitial.context,
    'Empretienda online y Cianbox en el local'
  );
  const correction = await sendTurn(
    correctionPlatforms.context,
    'no, en realidad usamos Tienda Nube'
  );
  const correctionText = normalizeForAssertion(correction.reply.replyText);
  assertCompressedIntermediateReply(correction.reply.replyText);
  assert.match(correctionText, /corrijo la plataforma online.*tienda nube/);
  assert.doesNotMatch(correctionText, /empretienda/);
  assert.strictEqual(correction.context.commercialSalesContext.groundedFacts.ecommercePlatform.value, 'tienda nube');
  assert.strictEqual(correction.context.commercialSalesContext.groundedFacts.physicalStoreSystem.value, 'cianbox');
  assert.strictEqual(getActiveCommercialDiscoveryPending(correction.context).field, 'stock_source_of_truth');
  assert.notStrictEqual(correction.reply.triggerHandoff, true);

  const pricing = await sendTurn({ activeBotDomain: 'commerce' }, 'que planes tienen');
  assert.match(pricing.reply.replyText, /Plan Inicial|Plan Crecimiento/);
  assert.notStrictEqual(pricing.reply.triggerHandoff, true);
  assert.ok(!pricing.context.commercialDiscoveryState);

  console.log('bot-p1-1b-discovery-ux.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
