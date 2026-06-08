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
    status: 'active',
    sku: 'PLAN-STARTER',
    description: 'Ideal para arrancar\nBase ordenada\nBot inicial'
  },
  {
    id: 'plan-growth',
    productId: 'plan-growth',
    name: 'Plan Crecimiento',
    price: 30000,
    currency: 'ARS',
    stock: 8,
    status: 'active',
    sku: 'PLAN-GROWTH',
    description: 'Seguimiento comercial real\nMas control\nMas contexto'
  },
  {
    id: 'plan-enterprise',
    productId: 'plan-enterprise',
    name: 'Plan Empresa',
    price: 50000,
    currency: 'ARS',
    stock: 3,
    status: 'active',
    sku: 'PLAN-ENTERPRISE',
    description: 'Operacion avanzada\nSoporte prioritario\nMas personalizacion'
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

const worker = require('../../src/worker.js');
const {
  isGreetingIntent,
  isCommercialSoftFollowUpIntent,
  detectCommercialIntent,
  detectBusinessRecommendationContext,
  detectCommercialNextStepIntent,
  detectCommercialPlanObjection,
  parseTransferPaymentIntent,
  isLoyaltyIntent,
  detectIntent,
  parseCommercialTeamSizeAnswer,
  parseCommercialWhatsAppAccountTypeAnswer,
  parseCommercialOfferTypeAnswer,
  parseCommercialWhatsappVolumeAnswer,
  buildSafeCommercialIntentReply,
  resolveCommerceDecision,
  getActiveCommercialDiscoveryPending,
  buildCommercialOrientationReply,
  deriveBusinessRecommendationContextFromSalesContext,
  hasEnoughCommercialSignalsForSoftRecommendation,
  isPlanPriceComparisonIntent
} = worker.__private__;

const clinic = {
  id: 'clinic-1',
  settings: {
    businessProfile: {
      address: 'Av. Siempre Viva 123, CABA',
      openingHours: 'Lunes a viernes de 9 a 18 hs',
      deliveryZones: 'Enviamos a CABA y GBA',
      paymentMethods: 'Transferencia, efectivo y tarjeta'
    },
    bot: {
      transferConfig: {
        enabled: true,
        alias: 'OPTURON.PAGOS',
        cbu: '0000003100000000000001',
        holderName: 'Opturon SAS'
      }
    }
  }
};

const conversation = {
  id: 'conv-1',
  clinicId: 'clinic-1',
  state: 'READY',
  context: {
    activeBotDomain: 'commerce',
    commercialPlanContext: {
      activeAt: new Date().toISOString(),
      topic: 'plan_recommendation',
      lastDiscussedPlanId: 'plan-growth',
      lastComparedPlanId: 'plan-enterprise',
      recommendationType: 'growth'
    },
    commercialShortMemory: {
      activeAt: new Date().toISOString(),
      topic: 'plans',
      lastSuggestedProductId: 'plan-growth',
      recommendationType: 'growth'
    }
  }
};

function applyContextPatch(baseContext, patch) {
  return {
    ...(baseContext && typeof baseContext === 'object' ? baseContext : {}),
    ...(patch && typeof patch === 'object' ? patch : {})
  };
}

const contact = {
  id: 'contact-1',
  name: 'Emi',
  phone: '5491111111111',
  waId: '5491111111111'
};

async function run() {
  assert.strictEqual(isGreetingIntent('hola'), true);
  assert.strictEqual(isGreetingIntent('buenass'), true);
  assert.strictEqual(isGreetingIntent('como andas'), true);

  assert.strictEqual(isCommercialSoftFollowUpIntent('dale'), true);
  assert.strictEqual(isCommercialSoftFollowUpIntent('ok'), true);
  assert.strictEqual(isCommercialSoftFollowUpIntent('contame'), true);

  assert.strictEqual(detectCommercialIntent('que planes tienen').type, 'products');
  assert.strictEqual(detectBusinessRecommendationContext('tengo un local de ropa').recommendationLevel, 'growth');
  assert.strictEqual(detectCommercialIntent('que me recomendas').type, 'recommendation');
  assert.strictEqual(detectCommercialNextStepIntent('me interesa'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('como hago para contratar'), 'advance');

  const productsReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: { ...conversation, context: {} },
    inboundText: 'que planes tienen'
  });
  assert.strictEqual(productsReply.type, 'products');
  assert.match(productsReply.replyText, /Plan Crecimiento/i);

  const hoursReply = await buildSafeCommercialIntentReply({ clinic, conversation, inboundText: 'horarios' });
  assert.match(hoursReply.replyText, /Lunes a viernes/i);

  const deliveryReply = await buildSafeCommercialIntentReply({ clinic, conversation, inboundText: 'hacen envios' });
  assert.match(deliveryReply.replyText, /CABA y GBA/i);

  const locationReply = await buildSafeCommercialIntentReply({ clinic, conversation, inboundText: 'donde estan' });
  assert.match(locationReply.replyText, /Siempre Viva 123/i);

  const paymentReply = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'formas de pago'
  });
  assert.match(paymentReply.replyText, /Alias: OPTURON\.PAGOS/i);

  const stockReply = await buildSafeCommercialIntentReply({ clinic, conversation, inboundText: 'hay stock del plan crecimiento' });
  assert.match(stockReply.replyText, /stock disponible/i);

  const nextStepDecision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'me interesa'
  });
  assert.strictEqual(nextStepDecision.newState, 'PAYMENT_TRANSFER');
  assert.strictEqual(nextStepDecision.contextPatch.transferPayment.selectedPlan.name, 'Plan Crecimiento');

  const hireDecision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'como hago para contratar'
  });
  assert.strictEqual(hireDecision.newState, 'PAYMENT_TRANSFER');
  assert.strictEqual(hireDecision.contextPatch.transferPayment.selectedPlan.name, 'Plan Crecimiento');

  assert.strictEqual(detectCommercialPlanObjection('es caro'), 'price_high');
  assert.strictEqual(detectCommercialPlanObjection('algo mas barato'), 'cheaper_option');

  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('mi esposa y yo'), { teamSizeValue: 2, teamSizeSignal: 'team' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('atiendo yo solo'), { teamSizeValue: 1, teamSizeSignal: 'solo' });
  assert.strictEqual(parseCommercialTeamSizeAnswer('Tengo una distribuidora'), null);
  assert.strictEqual(parseCommercialWhatsAppAccountTypeAnswer('Uso WhatsApp Business'), 'business');
  assert.strictEqual(parseCommercialOfferTypeAnswer('Productos'), 'products');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('30 por dia'), 'high');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('10 por dia'), 'low');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('Somos 3 vendedores y recibimos unas 80 consultas por dia'), 'high');
  assert.strictEqual(isPlanPriceComparisonIntent('Y cuanto mas caro es Empresa?'), true);

  const sellerDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          updatedAt: new Date().toISOString(),
          businessType: 'food_business'
        },
        commercialDiscoveryPending: {
          field: 'team_size',
          askedAt: new Date().toISOString(),
          sourceIntent: 'seller_replacement'
        }
      }
    },
    inboundText: 'Tengo 2 personas en atencion al publico'
  });
  assert.match(sellerDiscoveryReply.replyText, /relativamente chica/i);
  assert.match(sellerDiscoveryReply.replyText, /por d[ií]a/i);
  assert.strictEqual(sellerDiscoveryReply.contextPatch.commercialSalesContext.teamSizeSignal, 'team');
  assert.strictEqual(sellerDiscoveryReply.contextPatch.commercialSalesContext.teamSizeValue, 2);
  assert.strictEqual(getActiveCommercialDiscoveryPending(sellerDiscoveryReply.contextPatch).field, 'whatsapp_volume');

  const portabilityDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialDiscoveryPending: {
          field: 'whatsapp_account_type',
          askedAt: new Date().toISOString(),
          sourceIntent: 'whatsapp_number_portability'
        }
      }
    },
    inboundText: 'Uso WhatsApp Business'
  });
  assert.match(portabilityDiscoveryReply.replyText, /relativamente chica|en crecimiento|varias personas/i);
  assert.strictEqual(portabilityDiscoveryReply.contextPatch.commercialSalesContext.whatsappAccountTypeSignal, 'business');
  assert.strictEqual(portabilityDiscoveryReply.contextPatch.commercialSalesContext.channelMixSignal, 'whatsapp_only');
  assert.strictEqual(getActiveCommercialDiscoveryPending(portabilityDiscoveryReply.contextPatch).field, 'team_size');

  const offerTypeDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialDiscoveryPending: {
          field: 'offer_type',
          askedAt: new Date().toISOString(),
          sourceIntent: 'channel_compatibility'
        }
      }
    },
    inboundText: 'Productos'
  });
  assert.match(offerTypeDiscoveryReply.replyText, /relativamente chica|en crecimiento/i);
  assert.strictEqual(offerTypeDiscoveryReply.contextPatch.commercialSalesContext.offerTypeSignal, 'products');
  assert.strictEqual(getActiveCommercialDiscoveryPending(offerTypeDiscoveryReply.contextPatch).field, 'team_size');

  const mediumOrientationContext = {
    businessType: 'food_business',
    offerTypeSignal: 'products',
    teamSizeSignal: 'team',
    teamSizeValue: 2
  };
  const mediumOrientation = buildCommercialOrientationReply({
    salesContext: mediumOrientationContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(mediumOrientationContext),
    sourceIntent: 'seller_replacement'
  });
  assert.match(mediumOrientation.replyText, /relativamente chica/i);
  assert.strictEqual(mediumOrientation.pendingField, 'whatsapp_volume');

  const complexOrientationContext = {
    teamSizeSignal: 'team',
    teamSizeValue: 8
  };
  const complexOrientation = buildCommercialOrientationReply({
    salesContext: complexOrientationContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(complexOrientationContext),
    sourceIntent: 'seller_replacement'
  });
  assert.match(complexOrientation.replyText, /varias personas o m[aá]s de un frente/i);
  assert.strictEqual(complexOrientation.pendingField, 'channel_mix');

  const starterRecommendationContext = {
    businessType: 'food_business',
    offerTypeSignal: 'products',
    teamSizeSignal: 'team',
    teamSizeValue: 2,
    whatsappVolume: 'low'
  };
  const starterRecommendation = buildCommercialOrientationReply({
    salesContext: starterRecommendationContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(starterRecommendationContext),
    sourceIntent: 'seller_replacement'
  });
  assert.strictEqual(hasEnoughCommercialSignalsForSoftRecommendation(starterRecommendationContext), true);
  assert.match(starterRecommendation.replyText, /tipo Inicial/i);

  const growthRecommendationContext = {
    businessType: 'services',
    offerTypeSignal: 'services',
    teamSizeSignal: 'team',
    teamSizeValue: 3,
    whatsappVolume: 'high'
  };
  const growthRecommendation = buildCommercialOrientationReply({
    salesContext: growthRecommendationContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(growthRecommendationContext),
    sourceIntent: 'seller_replacement'
  });
  assert.match(growthRecommendation.replyText, /tipo Crecimiento/i);

  const enterpriseRecommendationContext = {
    businessType: 'distribution',
    offerTypeSignal: 'products',
    teamSizeSignal: 'team',
    teamSizeValue: 8,
    whatsappVolume: 'high',
    channelMixSignal: 'multi_channel'
  };
  const enterpriseRecommendation = buildCommercialOrientationReply({
    salesContext: enterpriseRecommendationContext,
    businessContext: deriveBusinessRecommendationContextFromSalesContext(enterpriseRecommendationContext),
    sourceIntent: 'seller_replacement'
  });
  assert.match(enterpriseRecommendation.replyText, /tipo Empresa/i);

  const discoveryAuditConversation = {
    ...conversation,
    context: {
      activeBotDomain: 'commerce'
    }
  };
  const discoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: discoveryAuditConversation,
    inboundText: 'Vendo por WhatsApp e Instagram, ¿me sirve su software?'
  });
  assert.doesNotMatch(discoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(discoveryReply.replyText, /WhatsApp/i);
  assert.match(discoveryReply.replyText, /Instagram/i);
  assert.match(discoveryReply.replyText, /productos o servicios/i);
  assert.strictEqual(discoveryReply.contextPatch.commercialSalesContext.channelMixSignal, 'multi_channel');
  assert.strictEqual(getActiveCommercialDiscoveryPending(discoveryReply.contextPatch).field, 'offer_type');

  const contextAfterDiscovery = applyContextPatch(discoveryAuditConversation.context, discoveryReply.contextPatch);
  const businessTypeReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterDiscovery
    },
    inboundText: 'Tengo una distribuidora'
  });
  assert.doesNotMatch(businessTypeReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.doesNotMatch(businessTypeReply.replyText, /est[eé]tica/i);
  assert.match(businessTypeReply.replyText, /distribuidora/i);
  assert.match(businessTypeReply.replyText, /cu[aá]ntas personas atienden/i);
  assert.strictEqual(businessTypeReply.contextPatch.commercialSalesContext.businessType, 'distribution');
  assert.strictEqual(getActiveCommercialDiscoveryPending(businessTypeReply.contextPatch).field, 'team_size');

  const contextAfterBusinessType = applyContextPatch(contextAfterDiscovery, businessTypeReply.contextPatch);
  const finalRecommendationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterBusinessType
    },
    inboundText: 'Somos 3 vendedores y recibimos unas 80 consultas por día'
  });
  assert.doesNotMatch(finalRecommendationReply.replyText, /est[eé]tica/i);
  assert.match(finalRecommendationReply.replyText, /tipo Empresa|Empresa/i);
  assert.match(finalRecommendationReply.replyText, /3 personas|3 vendedores|equipo atendiendo/i);
  assert.match(finalRecommendationReply.replyText, /bastante movimiento|seguimiento|control/i);
  assert.strictEqual(finalRecommendationReply.contextPatch.commercialSalesContext.businessType, 'distribution');
  assert.strictEqual(finalRecommendationReply.contextPatch.commercialSalesContext.teamSizeValue, 3);
  assert.strictEqual(finalRecommendationReply.contextPatch.commercialSalesContext.whatsappVolume, 'high');

  const contextAfterRecommendation = applyContextPatch(contextAfterBusinessType, finalRecommendationReply.contextPatch);
  const enterpriseDefenseReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'A ver contame por que Plan Empresa y no Plan Crecimiento'
  });
  assert.match(enterpriseDefenseReply.replyText, /Buena pregunta/i);
  assert.match(enterpriseDefenseReply.replyText, /Plan Crecimiento te puede servir/i);
  assert.match(enterpriseDefenseReply.replyText, /3 personas|mas de una persona|m[aá]s de una persona/i);
  assert.match(enterpriseDefenseReply.replyText, /bastante movimiento|seguimiento|control/i);
  assert.doesNotMatch(enterpriseDefenseReply.replyText, /^Por lo que me contas, yo miraria Plan Empresa/im);

  const cheaperDefenseReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Por que no el mas barato'
  });
  assert.match(cheaperDefenseReply.replyText, /Plan Inicial|mas chico|más chico/i);
  assert.match(cheaperDefenseReply.replyText, /justifica la diferencia|empieza a rendir mas|empieza a rendir más|seguimiento/i);

  const growthDefenseReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Me alcanza con Crecimiento'
  });
  assert.match(growthDefenseReply.replyText, /Plan Crecimiento te puede servir/i);
  assert.match(growthDefenseReply.replyText, /podria alcanzar|podría alcanzar/i);
  assert.match(growthDefenseReply.replyText, /Plan Empresa/i);

  const directComparisonReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Que diferencia hay entre Inicial y Crecimiento'
  });
  assert.match(directComparisonReply.replyText, /Buena pregunta/i);
  assert.match(directComparisonReply.replyText, /Plan Inicial/i);
  assert.match(directComparisonReply.replyText, /Plan Crecimiento/i);
  assert.doesNotMatch(directComparisonReply.replyText, /fallback|mezclo|mezcló/i);

  const priceComparisonReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Y cuanto mas caro es Empresa?'
  });
  assert.match(priceComparisonReply.replyText, /Plan Empresa hoy cuesta/i);
  assert.match(priceComparisonReply.replyText, /Plan Crecimiento/i);
  assert.match(priceComparisonReply.replyText, /La diferencia es de/i);
  assert.match(priceComparisonReply.replyText, /3 personas|bastante movimiento|control|seguimiento/i);
  assert.doesNotMatch(priceComparisonReply.replyText, /Plan Inicial —|Plan Crecimiento — .*Plan Empresa —/i);

  const worthPayingMoreReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Vale la pena pagar mas?'
  });
  assert.match(worthPayingMoreReply.replyText, /La diferencia es de|Lo importante no es solamente la diferencia de precio/i);
  assert.match(worthPayingMoreReply.replyText, /podr[ií]a seguir alcanzando|podr[ií]a alcanzar|se justifica/i);

  const economicDifferenceReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Que diferencia economica hay?'
  });
  assert.match(economicDifferenceReply.replyText, /La diferencia es de/i);
  assert.match(economicDifferenceReply.replyText, /seguimiento|control|coordin/i);

  const explicitCatalogReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: contextAfterRecommendation
    },
    inboundText: 'Que planes tienen?'
  });
  assert.match(explicitCatalogReply.replyText, /Plan Inicial/i);
  assert.match(explicitCatalogReply.replyText, /Plan Crecimiento/i);
  assert.match(explicitCatalogReply.replyText, /Plan Empresa/i);

  const contaminatedReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          updatedAt: new Date().toISOString(),
          businessType: 'beauty_business'
        }
      }
    },
    inboundText: 'Tengo una distribuidora'
  });
  assert.doesNotMatch(contaminatedReply.replyText, /est[eé]tica/i);
  assert.strictEqual(contaminatedReply.contextPatch.commercialSalesContext.businessType, 'distribution');

  const contaminatedDefenseReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          updatedAt: new Date().toISOString(),
          businessType: 'beauty_business',
          teamSizeSignal: 'team',
          teamSizeValue: 3,
          whatsappVolume: 'high',
          lastRecommendedPlan: 'plan-enterprise'
        },
        commercialPlanContext: {
          activeAt: new Date().toISOString(),
          topic: 'plan_recommendation',
          lastDiscussedPlanId: 'plan-enterprise',
          lastComparedPlanId: 'plan-growth',
          recommendationType: 'enterprise'
        },
        commercialShortMemory: {
          activeAt: new Date().toISOString(),
          topic: 'plans',
          lastSuggestedProductId: 'plan-enterprise',
          recommendationType: 'enterprise'
        }
      }
    },
    inboundText: 'Por que Empresa y no Crecimiento'
  });
  assert.doesNotMatch(contaminatedDefenseReply.replyText, /est[eÃ©]tica|uÃ±as|uñas/i);

  assert.strictEqual(detectIntent('quiero un turno'), 'appointment');
  assert.strictEqual(parseTransferPaymentIntent('como te transfiero'), 'request');
  assert.strictEqual(parseTransferPaymentIntent('te mando comprobante'), 'proof_notice');
  assert.strictEqual(isLoyaltyIntent('cuantos puntos tengo'), true);
  assert.strictEqual(detectCommercialIntent('quiero hablar con una persona').type, 'human_handoff');

  console.log('BOT.UNIVERSAL.BRAIN.1 validation passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
