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
  },
  {
    id: 'plan-enterprise',
    productId: 'plan-enterprise',
    name: 'Plan Empresa',
    price: 50000,
    currency: 'ARS',
    stock: 3,
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
  buildCommercialOrientationReply,
  classifyCommercialOperationShape,
  chooseNextCommercialDiscoveryField,
  deriveBusinessRecommendationContextFromSalesContext,
  detectBusinessRecommendationContext,
  detectCommercialSalesContext,
  getActiveCommercialDiscoveryPending,
  mergeCommercialSalesContext
} = require('../../src/worker').__private__;

const clinic = {
  id: 'clinic-1',
  settings: {
    businessProfile: {},
    bot: {}
  }
};

function normalizeForAssertion(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildConversation(context = {}) {
  return {
    id: 'conversation-1',
    clinicId: 'clinic-1',
    context: {
      activeBotDomain: 'commerce',
      ...context
    }
  };
}

function applyContextPatch(context, patch) {
  return {
    ...(context || {}),
    ...(patch || {})
  };
}

async function run() {
  const inventoryPortfolioInput = [
    'Hola Opturon. Vengo desde Portfolio y quiero probar como funciona el sistema de Opturon en una conversacion real por WhatsApp.',
    'Rubro: Local de insumos para trabajos con resina',
    'Tipo de consultas que recibo: Compras de productos varios',
    'Objetivo principal: Ajustar y acoplar el stock de tienda online con el stock fisico del local'
  ].join('\n');
  const inventoryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation(),
    inboundText: inventoryPortfolioInput
  });
  const inventoryText = normalizeForAssertion(inventoryReply.replyText);
  const inventoryContext = inventoryReply.contextPatch.commercialSalesContext;

  assert.match(inventoryText, /stock de la tienda online/);
  assert.match(inventoryText, /local fisico/);
  assert.match(inventoryText, /plataforma o sistema/);
  assert.doesNotMatch(inventoryText, /operacion (?:relativamente )?chica|equipo chico/);
  assert.doesNotMatch(inventoryText, /el foco esta en organizar consultas/);
  assert.doesNotMatch(inventoryText, /ya (?:se )?integra|opturon sincroniza/);
  assert.strictEqual(classifyCommercialOperationShape(inventoryContext), 'unknown');
  assert.strictEqual(chooseNextCommercialDiscoveryField(inventoryContext, 'portfolio_discovery'), 'commerce_platform');
  assert.strictEqual(getActiveCommercialDiscoveryPending(inventoryReply.contextPatch).field, 'commerce_platform');
  assert.strictEqual(inventoryContext.groundedFacts.businessType.source, 'STRUCTURED');
  assert.strictEqual(inventoryContext.groundedFacts.inquiryTypes.source, 'STRUCTURED');
  assert.strictEqual(inventoryContext.groundedFacts.objective.source, 'STRUCTURED');
  assert.match(normalizeForAssertion(inventoryContext.groundedFacts.objective.value), /stock de tienda online/);
  assert.strictEqual(inventoryContext.signalProvenance.channelMixSignal, 'INFERRED_WEAK');
  assert.strictEqual(inventoryContext.painPointProvenance.sales_organization, 'INFERRED_WEAK');
  assert.strictEqual(inventoryContext.teamSizeSignal, null);
  assert.strictEqual(inventoryContext.teamSizeValue, null);
  assert.strictEqual(inventoryContext.estimatedDailyConversations, null);
  assert.strictEqual(inventoryContext.aiAssistConfidence, null);
  assert.strictEqual(deriveBusinessRecommendationContextFromSalesContext(inventoryContext), null);

  const inventoryContextAfterFirstReply = applyContextPatch(
    buildConversation().context,
    inventoryReply.contextPatch
  );
  const platformReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation(inventoryContextAfterFirstReply),
    inboundText: 'Tienda Nube'
  });
  const platformContext = platformReply.contextPatch.commercialSalesContext;
  assert.ok(platformContext.groundedFacts.systems.some((fact) => fact.value === 'tienda nube' && fact.source === 'EXPLICIT'));
  assert.strictEqual(platformContext.groundedFacts.ecommercePlatform.value, 'tienda nube');
  assert.strictEqual(platformContext.groundedFacts.ecommercePlatform.source, 'EXPLICIT');
  assert.strictEqual(getActiveCommercialDiscoveryPending(platformReply.contextPatch).field, 'physical_store_system');
  assert.doesNotMatch(normalizeForAssertion(platformReply.replyText), /ya (?:se )?integra|opturon sincroniza/);

  const contextAfterPlatform = applyContextPatch(inventoryContextAfterFirstReply, platformReply.contextPatch);
  const explicitTeamReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation(contextAfterPlatform),
    inboundText: 'Somos tres personas atendiendo.'
  });
  const explicitTeamContext = explicitTeamReply.contextPatch.commercialSalesContext;
  assert.strictEqual(explicitTeamContext.teamSizeValue, 3);
  assert.strictEqual(explicitTeamContext.signalProvenance.teamSizeSignal, 'EXPLICIT');
  assert.strictEqual(explicitTeamContext.signalProvenance.teamSizeValue, 'EXPLICIT');

  const productsOnlyContext = detectCommercialSalesContext('Vendo productos');
  const productsOnlyOrientation = buildCommercialOrientationReply({
    salesContext: productsOnlyContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(productsOnlyContext),
    sourceIntent: 'portfolio_discovery',
    allowSoftRecommendation: false
  });
  assert.strictEqual(classifyCommercialOperationShape(productsOnlyContext), 'unknown');
  assert.strictEqual(productsOnlyContext.handlesAppointments, null);
  assert.strictEqual(deriveBusinessRecommendationContextFromSalesContext(productsOnlyContext), null);
  assert.strictEqual(detectBusinessRecommendationContext('Tengo un local.'), null);
  assert.strictEqual(detectBusinessRecommendationContext('Quiero algo barato.').businessType, null);
  assert.strictEqual(detectBusinessRecommendationContext('Tengo una distribuidora mayorista.').teamSize, null);
  assert.doesNotMatch(normalizeForAssertion(productsOnlyOrientation.replyText), /operacion (?:relativamente )?chica|negocio chico/);

  const volumeOnlyContext = detectCommercialSalesContext('Recibo muchas consultas.');
  const volumeOnlyOrientation = buildCommercialOrientationReply({
    salesContext: volumeOnlyContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(volumeOnlyContext),
    sourceIntent: 'portfolio_discovery',
    allowSoftRecommendation: false
  });
  assert.strictEqual(classifyCommercialOperationShape(volumeOnlyContext), 'unknown');
  assert.strictEqual(volumeOnlyContext.teamSizeSignal, null);
  assert.match(normalizeForAssertion(volumeOnlyOrientation.replyText), /volumen alto/);
  assert.doesNotMatch(normalizeForAssertion(volumeOnlyOrientation.replyText), /equipo|personas atendiendo|operacion chica/);

  const legacyHeuristicOnlyContext = {
    channelMixSignal: 'multi_channel',
    painPoints: ['sales_organization']
  };
  const legacyHeuristicOrientation = buildCommercialOrientationReply({
    salesContext: legacyHeuristicOnlyContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(legacyHeuristicOnlyContext),
    sourceIntent: 'portfolio_discovery',
    allowSoftRecommendation: false
  });
  assert.strictEqual(deriveBusinessRecommendationContextFromSalesContext(legacyHeuristicOnlyContext), null);
  assert.doesNotMatch(normalizeForAssertion(legacyHeuristicOrientation.replyText), /whatsapp y tambien.*instagram|organizar consultas/);

  const explicitSmallContext = detectCommercialSalesContext('Somos un local chico y atendemos entre dos personas.');
  const explicitSmallOrientation = buildCommercialOrientationReply({
    salesContext: explicitSmallContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(explicitSmallContext),
    sourceIntent: 'portfolio_discovery',
    allowSoftRecommendation: false
  });
  assert.strictEqual(classifyCommercialOperationShape(explicitSmallContext), 'small');
  assert.strictEqual(explicitSmallContext.groundedFacts.operationSize.source, 'EXPLICIT');
  assert.strictEqual(explicitSmallContext.teamSizeValue, 2);
  assert.match(normalizeForAssertion(explicitSmallOrientation.replyText), /operacion chica/);

  const explicitTeamEvidence = {
    teamSizeSignal: 'team',
    teamSizeValue: 4,
    signalProvenance: {
      teamSizeSignal: 'EXPLICIT',
      teamSizeValue: 'EXPLICIT'
    }
  };
  const weakTeamInference = {
    teamSizeSignal: 'solo',
    teamSizeValue: 1,
    signalProvenance: {
      teamSizeSignal: 'INFERRED_WEAK',
      teamSizeValue: 'INFERRED_WEAK'
    }
  };
  const evidenceMerge = mergeCommercialSalesContext(explicitTeamEvidence, weakTeamInference);
  assert.strictEqual(evidenceMerge.teamSizeSignal, 'team');
  assert.strictEqual(evidenceMerge.teamSizeValue, 4);

  const correctedBusinessContext = mergeCommercialSalesContext(
    detectCommercialSalesContext('Tengo una distribuidora.'),
    detectCommercialSalesContext('En realidad no es distribuidora, es lubricentro.')
  );
  assert.strictEqual(correctedBusinessContext.businessType, null);
  assert.strictEqual(correctedBusinessContext.businessTypeRaw, 'lubricentro');
  assert.strictEqual(correctedBusinessContext.businessCategory, 'automotive');
  assert.strictEqual(correctedBusinessContext.groundedFacts.businessType.value, 'lubricentro');
  assert.strictEqual(correctedBusinessContext.groundedFacts.businessType.source, 'EXPLICIT');

  const priorSmallContext = {
    updatedAt: new Date().toISOString(),
    businessType: 'small_store',
    groundedFacts: {
      operationSize: { value: 'small', source: 'INFERRED_WEAK' },
      systems: []
    },
    painPoints: ['sales_organization'],
    painPointProvenance: {
      sales_organization: 'INFERRED_WEAK'
    }
  };
  const branchCorrectionReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation({
      commercialSalesContext: priorSmallContext,
      commercialBusinessContext: {
        activeAt: new Date().toISOString(),
        businessType: 'small_store',
        teamSize: 'small',
        recommendationLevel: 'starter'
      }
    }),
    inboundText: 'No, tenemos cuatro sucursales.'
  });
  const branchCorrectionContext = branchCorrectionReply.contextPatch.commercialSalesContext;
  assert.strictEqual(branchCorrectionContext.teamSizeSignal, 'multi_branch');
  assert.strictEqual(branchCorrectionContext.groundedFacts.branchCount.value, 4);
  assert.strictEqual(branchCorrectionContext.groundedFacts.branchCount.source, 'EXPLICIT');
  assert.ok(branchCorrectionContext.rejectedInferences.operationShapes.includes('small'));
  assert.strictEqual(classifyCommercialOperationShape(branchCorrectionContext), 'complex');
  assert.doesNotMatch(normalizeForAssertion(branchCorrectionReply.replyText), /operacion (?:relativamente )?chica|negocio chico/);

  const objectiveCorrectionReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation({
      commercialSalesContext: {
        updatedAt: new Date().toISOString(),
        businessType: 'retail_store',
        painPoints: ['sales_organization'],
        painPointProvenance: { sales_organization: 'INFERRED_WEAK' },
        groundedFacts: {
          objective: { value: 'organizar consultas', source: 'STRUCTURED' },
          systems: []
        }
      }
    }),
    inboundText: 'No quiero organizar consultas. El problema es el stock.'
  });
  const objectiveCorrectionContext = objectiveCorrectionReply.contextPatch.commercialSalesContext;
  assert.match(normalizeForAssertion(objectiveCorrectionContext.groundedFacts.objective.value), /stock/);
  assert.strictEqual(objectiveCorrectionContext.groundedFacts.objective.source, 'EXPLICIT');
  assert.ok(objectiveCorrectionContext.rejectedInferences.painPoints.includes('sales_organization'));
  assert.ok(!objectiveCorrectionContext.painPoints.includes('sales_organization'));
  assert.match(normalizeForAssertion(objectiveCorrectionReply.replyText), /stock/);
  assert.doesNotMatch(normalizeForAssertion(objectiveCorrectionReply.replyText), /tu objetivo principal es organizar consultas/);

  const integrationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation(),
    inboundText: 'Opturon se integra con Tienda Nube?'
  });
  const integrationText = normalizeForAssertion(integrationReply.replyText);
  assert.strictEqual(integrationReply.type, 'integration_compatibility');
  assert.match(integrationText, /no puedo confirmar/);
  assert.match(integrationText, /tienda nube/);
  assert.match(integrationText, /api|viabilidad/);
  assert.doesNotMatch(integrationText, /^si\b|ya (?:se )?integra|opturon sincroniza/);

  const emptyPortfolioReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: buildConversation(),
    inboundText: [
      'Hola Opturon. Vengo desde Portfolio y quiero probar como funciona el sistema.',
      'Rubro:',
      'Tipo de consultas que recibo:',
      'Objetivo principal:'
    ].join('\n')
  });
  assert.match(emptyPortfolioReply.replyText, /Rubro/i);
  assert.match(emptyPortfolioReply.replyText, /Tipo de consultas/i);
  assert.match(emptyPortfolioReply.replyText, /Objetivo principal/i);
  assert.doesNotMatch(emptyPortfolioReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);

  console.log('bot-p0-2-truth-context.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
