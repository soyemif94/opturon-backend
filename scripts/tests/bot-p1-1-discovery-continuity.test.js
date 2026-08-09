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
  getActiveCommercialDiscoveryPending,
  mergeCommercialSalesContext,
  resolveCommerceDecision
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

function applyContextPatch(context, patch) {
  return {
    ...(context || {}),
    ...(patch || {})
  };
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
  const persistedContext = applyContextPatch(context, reply && reply.contextPatch);
  return {
    reply,
    context: JSON.parse(JSON.stringify(persistedContext))
  };
}

function getSalesFacts(context) {
  return context.commercialSalesContext.groundedFacts;
}

async function startInventoryDiscovery() {
  return sendTurn({ activeBotDomain: 'commerce' }, portfolioInput);
}

async function run() {
  const selectedPlan = await resolveCommerceDecision({
    conversation: {
      id: 'conversation-plan-selection',
      clinicId: 'clinic-1',
      state: 'PAYMENT_TRANSFER',
      context: {
        transferPayment: {
          status: 'awaiting_plan_selection',
          source: 'whatsapp_payment'
        }
      }
    },
    clinic,
    contact: { id: 'contact-1' },
    inboundText: '2'
  });
  assert.strictEqual(selectedPlan.contextPatch.transferPayment.selectedPlan.productId, 'plan-growth');
  assert.strictEqual(selectedPlan.contextPatch.transferPayment.selectedPlan.name, 'Plan Crecimiento');

  const correctedLegacySystems = mergeCommercialSalesContext(
    {
      groundedFacts: {
        systems: [{ value: 'empretienda', source: 'EXPLICIT' }]
      }
    },
    {
      groundedFacts: {
        ecommercePlatform: { value: 'tienda nube', source: 'EXPLICIT' },
        systems: [{ value: 'tienda nube', source: 'EXPLICIT' }]
      }
    }
  ).groundedFacts.systems.map((fact) => fact.value);
  assert.deepStrictEqual(correctedLegacySystems, ['tienda nube']);

  const initial = await startInventoryDiscovery();
  const initialPending = getActiveCommercialDiscoveryPending(initial.context);
  assert.ok(initialPending.id.startsWith('commercial_discovery:commerce_platform:'));
  assert.strictEqual(initialPending.field, 'commerce_platform');
  assert.strictEqual(initialPending.expectedField, 'commerce_platform');
  assert.strictEqual(initialPending.evidenceGap, 'commerce_platform');
  assert.strictEqual(initialPending.status, 'pending');
  assert.strictEqual(initialPending.provenance, 'BOT_ASKED');

  const singlePlatform = await sendTurn(initial.context, 'Empretienda');
  const singlePlatformFacts = getSalesFacts(singlePlatform.context);
  const singlePlatformPending = getActiveCommercialDiscoveryPending(singlePlatform.context);
  const singlePlatformText = normalizeForAssertion(singlePlatform.reply.replyText);
  assert.strictEqual(singlePlatformFacts.ecommercePlatform.value, 'empretienda');
  assert.strictEqual(singlePlatformFacts.ecommercePlatform.source, 'EXPLICIT');
  assert.strictEqual(singlePlatform.context.commercialDiscoveryLastResolved.expectedField, 'commerce_platform');
  assert.strictEqual(singlePlatform.context.commercialDiscoveryLastResolved.status, 'resolved');
  assert.strictEqual(singlePlatform.context.commercialDiscoveryLastResolved.provenance, 'EXPLICIT');
  assert.strictEqual(singlePlatformPending.field, 'physical_store_system');
  assert.doesNotMatch(singlePlatformText, /que plataforma.*tienda online|conocer la plataforma actual/);
  assert.doesNotMatch(singlePlatformText, /cuantas personas atienden/);

  const multiInitial = await startInventoryDiscovery();
  const multiPlatform = await sendTurn(
    multiInitial.context,
    'Empretienda para la venta online y Cianbox en la tienda fisica'
  );
  const multiFacts = getSalesFacts(multiPlatform.context);
  const multiPending = getActiveCommercialDiscoveryPending(multiPlatform.context);
  const multiText = normalizeForAssertion(multiPlatform.reply.replyText);
  assert.strictEqual(multiFacts.ecommercePlatform.value, 'empretienda');
  assert.strictEqual(multiFacts.ecommercePlatform.source, 'EXPLICIT');
  assert.strictEqual(multiFacts.physicalStoreSystem.value, 'cianbox');
  assert.strictEqual(multiFacts.physicalStoreSystem.source, 'EXPLICIT');
  assert.strictEqual(multiPending.field, 'stock_source_of_truth');
  assert.strictEqual(multiPending.meta.questionKind, 'entity_selection');
  assert.deepStrictEqual(multiPending.meta.options, ['empretienda', 'cianbox']);
  assert.strictEqual((multiPlatform.reply.replyText.match(/\?/g) || []).length, 1);
  assert.match(multiText, /empretienda o cianbox/);
  assert.doesNotMatch(multiText, /que plataforma.*tienda online|conocer la plataforma actual/);
  assert.doesNotMatch(multiText, /cuantas personas atienden/);
  assert.doesNotMatch(multiText, /ya se integra|opturon sincroniza|integracion activa confirmada/);

  const numberedSource = await sendTurn(multiPlatform.context, '2');
  assert.strictEqual(getSalesFacts(numberedSource.context).stockSourceOfTruth.value, 'cianbox');
  assert.strictEqual(getActiveCommercialDiscoveryPending(numberedSource.context).field, 'stock_update_method');

  const referentialSource = await sendTurn(multiPlatform.context, 'ese');
  assert.strictEqual(getSalesFacts(referentialSource.context).stockSourceOfTruth.value, 'cianbox');
  assert.strictEqual(getActiveCommercialDiscoveryPending(referentialSource.context).field, 'stock_update_method');

  const sourceOfTruth = await sendTurn(
    multiPlatform.context,
    'el stock principal lo manejo en Cianbox'
  );
  const sourceFacts = getSalesFacts(sourceOfTruth.context);
  const sourcePending = getActiveCommercialDiscoveryPending(sourceOfTruth.context);
  assert.strictEqual(sourceFacts.stockSourceOfTruth.value, 'cianbox');
  assert.strictEqual(sourceFacts.stockSourceOfTruth.source, 'EXPLICIT');
  assert.strictEqual(sourceFacts.ecommercePlatform.value, 'empretienda');
  assert.strictEqual(sourceFacts.physicalStoreSystem.value, 'cianbox');
  assert.match(normalizeForAssertion(sourceFacts.objective.value), /stock tienda online/);
  assert.strictEqual(sourcePending.field, 'stock_update_method');
  assert.strictEqual(sourceOfTruth.context.commercialDiscoveryLastResolved.expectedField, 'stock_source_of_truth');
  assert.doesNotMatch(normalizeForAssertion(sourceOfTruth.reply.replyText), /cuantas personas atienden/);

  const binaryAnswer = await sendTurn(sourceOfTruth.context, 'si');
  const binaryFacts = getSalesFacts(binaryAnswer.context);
  const binaryPending = getActiveCommercialDiscoveryPending(binaryAnswer.context);
  assert.strictEqual(binaryFacts.stockUpdateMode.value, 'manual');
  assert.strictEqual(binaryFacts.stockUpdateMode.source, 'EXPLICIT');
  assert.strictEqual(binaryAnswer.context.commercialDiscoveryLastResolved.expectedField, 'stock_update_method');
  assert.strictEqual(binaryPending.field, 'shared_sku_catalog');

  const colloquialBinaryAnswer = await sendTurn(sourceOfTruth.context, 'dale');
  assert.strictEqual(getSalesFacts(colloquialBinaryAnswer.context).stockUpdateMode.value, 'manual');
  assert.strictEqual(getActiveCommercialDiscoveryPending(colloquialBinaryAnswer.context).field, 'shared_sku_catalog');

  const skuAnswer = await sendTurn(binaryAnswer.context, 'si');
  const skuFacts = getSalesFacts(skuAnswer.context);
  assert.strictEqual(skuFacts.sharedSkuCatalog.value, 'yes');
  assert.strictEqual(skuFacts.sharedSkuCatalog.source, 'EXPLICIT');
  assert.strictEqual(getActiveCommercialDiscoveryPending(skuAnswer.context), null);
  assert.strictEqual(skuAnswer.context.commercialDiscoveryLastResolved.expectedField, 'shared_sku_catalog');
  assert.doesNotMatch(normalizeForAssertion(skuAnswer.reply.replyText), /cuantas personas atienden/);

  const shortAnswerInitial = await startInventoryDiscovery();
  const shortEcommerce = await sendTurn(shortAnswerInitial.context, 'Empretienda');
  const shortPhysical = await sendTurn(shortEcommerce.context, 'Cianbox');
  assert.strictEqual(getSalesFacts(shortPhysical.context).physicalStoreSystem.value, 'cianbox');
  assert.strictEqual(getActiveCommercialDiscoveryPending(shortPhysical.context).field, 'stock_source_of_truth');
  const bothSource = await sendTurn(shortPhysical.context, 'los dos');
  assert.strictEqual(getSalesFacts(bothSource.context).stockSourceOfTruth.value, 'both');
  const manualUpdate = await sendTurn(bothSource.context, 'manual');
  assert.strictEqual(getSalesFacts(manualUpdate.context).stockUpdateMode.value, 'manual');
  const negativeSku = await sendTurn(manualUpdate.context, 'no');
  assert.strictEqual(getSalesFacts(negativeSku.context).sharedSkuCatalog.value, 'no');
  assert.strictEqual(getActiveCommercialDiscoveryPending(negativeSku.context), null);

  const shortSourceInitial = await startInventoryDiscovery();
  const shortSourcePlatforms = await sendTurn(
    shortSourceInitial.context,
    'Empretienda online y Cianbox en el local'
  );
  const shortSource = await sendTurn(shortSourcePlatforms.context, 'desde Cianbox');
  assert.strictEqual(getSalesFacts(shortSource.context).stockSourceOfTruth.value, 'cianbox');

  const correction = await sendTurn(
    multiPlatform.context,
    'no, en realidad usamos Tienda Nube'
  );
  const correctionFacts = getSalesFacts(correction.context);
  const correctionSystems = correctionFacts.systems.map((fact) => fact.value);
  assert.strictEqual(correctionFacts.ecommercePlatform.value, 'tienda nube');
  assert.strictEqual(correctionFacts.ecommercePlatform.source, 'EXPLICIT');
  assert.strictEqual(correctionFacts.physicalStoreSystem.value, 'cianbox');
  assert.ok(!correctionSystems.includes('empretienda'));
  assert.ok(correctionSystems.includes('tienda nube'));
  assert.strictEqual(getActiveCommercialDiscoveryPending(correction.context).field, 'stock_source_of_truth');
  assert.doesNotMatch(normalizeForAssertion(correction.reply.replyText), /que plataforma.*tienda online|conocer la plataforma actual/);

  const noPending = await sendTurn({ activeBotDomain: 'commerce' }, 'si');
  assert.strictEqual(getActiveCommercialDiscoveryPending(noPending.context), null);
  assert.ok(!noPending.context.commercialSalesContext);

  console.log('bot-p1-1-discovery-continuity.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
