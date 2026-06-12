const assert = require('assert');
const path = require('path');
const { DateTime } = require('luxon');

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
const { findCommercialKnowledgeMatch } = require('../../src/ai/commercial-knowledge-base');
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
  isPlanPriceComparisonIntent,
  extractOpenBusinessTypeRaw,
  inferBusinessCategoryFromRawBusinessType,
  shouldInvokeAiAssist,
  shouldUseWeakSignalCommercialFallback,
  buildWeakSignalCommercialFallback,
  buildIntelligentFallbackReply,
  resolveAiAssistDecision,
  buildAiAssistSalesContext,
  getActiveCommercialShortMemory,
  resolveConfiguredOutOfHoursReply,
  parseOpeningHoursWindowForCurrentTime
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

const clinicWithBotConfig = {
  ...clinic,
  settings: {
    ...clinic.settings,
    bot: {
      ...clinic.settings.bot,
      config: {
        name: 'Alma',
        greetingMessage: 'Hola, soy Alma. Estoy para ayudarte con este WhatsApp.',
        tone: 'profesional',
        treatment: 'usted',
        outOfHoursMessage: 'Ahora estamos fuera de horario. Apenas retomemos seguimos por aca.',
        fallbackMessage: 'No llegue a entender bien su mensaje. Si quiere, cuenteme si busca ayuda con ventas, agenda o pagos.',
        handoffMessage: 'Le paso con una persona del equipo para continuar por ahi.'
      }
    }
  }
};

const clinicWithoutBotConfig = {
  ...clinic,
  settings: {
    ...clinic.settings,
    bot: {
      ...clinic.settings.bot
    }
  }
};

const clinicWithOtherBotConfig = {
  ...clinic,
  id: 'clinic-2',
  settings: {
    ...clinic.settings,
    bot: {
      ...clinic.settings.bot,
      config: {
        name: 'Bruna',
        greetingMessage: 'Hola, soy Bruna.',
        tone: 'amigable',
        treatment: 'vos',
        outOfHoursMessage: '',
        fallbackMessage: '',
        handoffMessage: 'Te paso con otra persona.'
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
  assert.strictEqual(detectCommercialIntent('como contrato plan crecimiento').type, 'purchase_intent');
  assert.strictEqual(detectBusinessRecommendationContext('tengo un local de ropa').recommendationLevel, 'growth');
  assert.strictEqual(detectCommercialIntent('que me recomendas').type, 'recommendation');
  assert.strictEqual(detectCommercialNextStepIntent('me interesa'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('como hago para contratar'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('quiero ese plan'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('me interesa crecimiento'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('donde pago'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('pasame el link'), 'advance');
  assert.strictEqual(detectCommercialNextStepIntent('como funciona crecimiento'), null);
  assert.strictEqual(detectCommercialNextStepIntent('explicame crecimiento'), null);

  const productsReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: { ...conversation, context: {} },
    inboundText: 'que planes tienen'
  });
  assert.strictEqual(productsReply.type, 'products');
  assert.match(productsReply.replyText, /Plan Crecimiento/i);

  const pricesReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: { ...conversation, context: {} },
    inboundText: 'Cuanto cuesta?'
  });
  assert.strictEqual(pricesReply.type, 'prices');
  assert.match(pricesReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);

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
  assert.strictEqual(nextStepDecision.newStage, 'commercial_plan_activation');
  assert.match(nextStepDecision.replyText, /activarlo/i);

  const hireDecision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'como hago para contratar'
  });
  assert.strictEqual(hireDecision.newStage, 'commercial_plan_activation');
  assert.match(hireDecision.replyText, /activarlo/i);
  assert.doesNotMatch(hireDecision.replyText, /Plan ideal|Te puede servir|Diferencia con Empresa/i);

  const linkDecision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'pasame el link'
  });
  assert.strictEqual(linkDecision.newState, 'PAYMENT_TRANSFER');
  assert.strictEqual(linkDecision.contextPatch.transferPayment.selectedPlan.name, 'Plan Crecimiento');

  const whereToPayDecision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText: 'donde pago'
  });
  assert.strictEqual(whereToPayDecision.newState, 'PAYMENT_TRANSFER');
  assert.strictEqual(whereToPayDecision.contextPatch.transferPayment.selectedPlan.name, 'Plan Crecimiento');

  assert.strictEqual(detectCommercialPlanObjection('es caro'), 'price_high');
  assert.strictEqual(detectCommercialPlanObjection('algo mas barato'), 'cheaper_option');

  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('mi esposa y yo'), { teamSizeValue: 2, teamSizeSignal: 'team' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('atiendo yo solo'), { teamSizeValue: 1, teamSizeSignal: 'solo' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('100 mensajes por dia y tengo 3 vendedores'), { teamSizeValue: 3, teamSizeSignal: 'team' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('somos 2 vendedores'), { teamSizeValue: 2, teamSizeSignal: 'team' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('tenemos unas 30 consultas diarias y 1 persona atiende el whatsapp'), { teamSizeValue: 1, teamSizeSignal: 'solo' });
  assert.deepStrictEqual(parseCommercialTeamSizeAnswer('una secretaria agenda todo'), { teamSizeValue: 1, teamSizeSignal: 'solo' });
  assert.strictEqual(parseCommercialTeamSizeAnswer('Tengo una distribuidora'), null);
  assert.strictEqual(parseCommercialWhatsAppAccountTypeAnswer('Uso WhatsApp Business'), 'business');
  assert.strictEqual(parseCommercialOfferTypeAnswer('Productos'), 'products');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('30 por dia'), 'high');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('30/40 por dia y las atiende una sola persona'), 'high');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('10 por dia'), 'low');
  assert.strictEqual(parseCommercialWhatsappVolumeAnswer('Somos 3 vendedores y recibimos unas 80 consultas por dia'), 'high');
  assert.strictEqual(isPlanPriceComparisonIntent('Y cuanto mas caro es Empresa?'), true);
  assert.strictEqual(extractOpenBusinessTypeRaw('Tengo un lubricentro'), 'lubricentro');
  assert.strictEqual(extractOpenBusinessTypeRaw('Mi negocio es una distribuidora'), 'distribuidora');
  assert.strictEqual(extractOpenBusinessTypeRaw('Trabajo con productos para comercios'), 'productos para comercios');
  assert.strictEqual(extractOpenBusinessTypeRaw('Vendo heladeras mostrador, me sirve Opturon?'), 'heladeras mostrador');
  assert.strictEqual(extractOpenBusinessTypeRaw('En realidad no es una distribuidora, es un lubricentro'), 'lubricentro');
  assert.strictEqual(inferBusinessCategoryFromRawBusinessType('lubricentro'), 'automotive');
  assert.strictEqual(inferBusinessCategoryFromRawBusinessType('heladeras mostrador'), 'wholesale_distribution');
  assert.strictEqual(inferBusinessCategoryFromRawBusinessType('dentista'), 'healthcare');

  const openBusinessAiInvocation = shouldInvokeAiAssist({
    botRoute: null,
    intent: detectIntent('Tengo un lubricentro'),
    commercialIntent: detectCommercialIntent('Tengo un lubricentro'),
    transferPaymentIntent: parseTransferPaymentIntent('Tengo un lubricentro'),
    inboundText: 'Tengo un lubricentro',
    safeContext: {}
  });
  assert.strictEqual(openBusinessAiInvocation.ok, true);
  assert.strictEqual(openBusinessAiInvocation.reason, 'commercial_weak_signal');
  assert.strictEqual(openBusinessAiInvocation.signal, 'commercial_kb:business_fit_by_industry');

  const commerceContextIndustryAiInvocation = shouldInvokeAiAssist({
    botRoute: { domain: 'commerce' },
    intent: detectIntent('Tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi'),
    commercialIntent: detectCommercialIntent('Tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi'),
    transferPaymentIntent: parseTransferPaymentIntent('Tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi'),
    inboundText: 'Tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi',
    safeContext: { activeBotDomain: 'commerce' }
  });
  assert.strictEqual(commerceContextIndustryAiInvocation.ok, true);
  assert.strictEqual(commerceContextIndustryAiInvocation.reason, 'commercial_low_confidence_with_context');
  assert.strictEqual(shouldUseWeakSignalCommercialFallback(commerceContextIndustryAiInvocation, {
    ok: false,
    reason: 'ai_assist_provider_failed_500',
    failed: true
  }), true);

  const helloAiInvocation = shouldInvokeAiAssist({
    botRoute: null,
    intent: detectIntent('Hola'),
    commercialIntent: detectCommercialIntent('Hola'),
    transferPaymentIntent: parseTransferPaymentIntent('Hola'),
    inboundText: 'Hola',
    safeContext: {}
  });
  assert.strictEqual(helloAiInvocation.ok, false);
  assert.strictEqual(helloAiInvocation.reason, 'trivial_message');

  const helloCommercialReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Hola'
  });
  assert.match(helloCommercialReply.replyText, /Contame un poco de tu negocio/i);
  assert.doesNotMatch(helloCommercialReply.replyText, /planes|precios/i);

  const defaultGreetingReply = await buildSafeCommercialIntentReply({
    clinic: clinicWithoutBotConfig,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Hola'
  });
  assert.match(defaultGreetingReply.replyText, /Contame un poco de tu negocio/i);
  assert.doesNotMatch(defaultGreetingReply.replyText, /soy Alma/i);

  const customGreetingReply = await buildSafeCommercialIntentReply({
    clinic: clinicWithBotConfig,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Hola'
  });
  assert.strictEqual(customGreetingReply.type, 'greeting');
  assert.match(customGreetingReply.replyText, /soy Alma/i);

  const customFallbackReply = buildIntelligentFallbackReply({
    activeBotDomain: 'commerce'
  }, 'blabla sin sentido', clinicWithBotConfig);
  assert.match(customFallbackReply.replyText, /No llegue a entender bien su mensaje/i);

  const currentWindow = parseOpeningHoursWindowForCurrentTime(
    'Lunes a viernes de 9 a 18 hs',
    'America/Argentina/Buenos_Aires',
    DateTime.fromISO('2026-06-12T01:30:00Z')
  );
  assert.strictEqual(currentWindow.known, true);
  assert.strictEqual(currentWindow.isOpen, false);

  const outOfHoursReply = resolveConfiguredOutOfHoursReply({
    clinic: {
      ...clinicWithBotConfig,
      settings: {
        ...clinicWithBotConfig.settings,
        businessProfile: {
          ...clinicWithBotConfig.settings.businessProfile,
          openingHours: 'Lunes a viernes de 9 a 18 hs'
        }
      }
    },
    conversation: {
      ...conversation,
      context: {}
    },
    inboundText: 'Hola',
    nowUtc: DateTime.fromISO('2026-06-12T01:30:00Z')
  });
  assert.strictEqual(outOfHoursReply, 'Ahora estamos fuera de horario. Apenas retomemos seguimos por aca.');

  const customHumanReply = await buildSafeCommercialIntentReply({
    clinic: clinicWithBotConfig,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'quiero hablar con una persona'
  });
  assert.strictEqual(customHumanReply.type, 'human_handoff');
  assert.strictEqual(customHumanReply.replyText, 'Le paso con una persona del equipo para continuar por ahi.');

  const tenantIsolationGreetingReply = await buildSafeCommercialIntentReply({
    clinic: clinicWithOtherBotConfig,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Hola'
  });
  assert.match(tenantIsolationGreetingReply.replyText, /soy Bruna/i);
  assert.doesNotMatch(tenantIsolationGreetingReply.replyText, /soy Alma/i);

  const transferAiInvocation = shouldInvokeAiAssist({
    botRoute: null,
    intent: detectIntent('Como te transfiero'),
    commercialIntent: detectCommercialIntent('Como te transfiero'),
    transferPaymentIntent: parseTransferPaymentIntent('Como te transfiero'),
    inboundText: 'Como te transfiero',
    safeContext: {}
  });
  assert.strictEqual(transferAiInvocation.ok, false);
  assert.strictEqual(transferAiInvocation.reason, 'payment_transfer_flow');

  const catalogAiInvocation = shouldInvokeAiAssist({
    botRoute: null,
    intent: detectIntent('Que planes tienen'),
    commercialIntent: detectCommercialIntent('Que planes tienen'),
    transferPaymentIntent: parseTransferPaymentIntent('Que planes tienen'),
    inboundText: 'Que planes tienen',
    safeContext: {}
  });
  assert.strictEqual(catalogAiInvocation.ok, false);
  assert.match(catalogAiInvocation.reason, /strong_commercial_intent_/i);

  const lubricentroFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Tengo un lubricentro',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'open_business_phrase'
  });
  assert.match(lubricentroFallback.replyText, /lubricentro/i);
  assert.match(lubricentroFallback.replyText, /precios|disponibilidad|turnos/i);
  assert.match(lubricentroFallback.replyText, /centralizar las consultas|cat[aá]logo|registrar pedidos|seguimiento/i);
  assert.match(lubricentroFallback.replyText, /Recib[ií]s muchas consultas por WhatsApp|pedidos de forma manual/i);
  assert.strictEqual(lubricentroFallback.contextPatch.commercialSalesContext.businessTypeRaw, 'lubricentro');
  assert.strictEqual(lubricentroFallback.contextPatch.commercialSalesContext.businessCategory, 'automotive');
  assert.strictEqual(getActiveCommercialDiscoveryPending(lubricentroFallback.contextPatch).field, 'team_size');

  const realCaseFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'product_fit_phrase'
  });
  assert.match(realCaseFallback.replyText, /distribuidora de heladeras mostrador/i);
  assert.match(realCaseFallback.replyText, /WhatsApp/i);
  assert.match(realCaseFallback.replyText, /cat[aá]logo|productos/i);
  assert.match(realCaseFallback.replyText, /registrar pedidos/i);
  assert.doesNotMatch(realCaseFallback.replyText, /Se me mezcl/i);
  assert.strictEqual(realCaseFallback.contextPatch.commercialSalesContext.businessTypeRaw, 'distribuidora de heladeras mostrador');
  assert.strictEqual(realCaseFallback.contextPatch.commercialSalesContext.businessCategory, 'wholesale_distribution');

  const rotiseriaFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Tengo una rotiseria, sirve para mi negocio?',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'product_fit_phrase'
  });
  assert.match(rotiseriaFallback.replyText, /rotiseria/i);
  assert.match(rotiseriaFallback.replyText, /pedidos|consultas|seguimiento/i);
  assert.doesNotMatch(rotiseriaFallback.replyText, /Se me mezcl/i);

  const instagramFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Vendo por Instagram, me sirve?',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'selling_channel_phrase'
  });
  assert.match(instagramFallback.replyText, /Instagram/i);
  assert.doesNotMatch(instagramFallback.replyText, /Se me mezcl/i);

  const currentNumberFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Puedo usar mi numero actual de WhatsApp?',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'whatsapp_number_portability_phrase'
  });
  assert.match(currentNumberFallback.replyText, /n[uú]mero actual/i);
  assert.doesNotMatch(currentNumberFallback.replyText, /Se me mezcl/i);

  const sellerReplacementFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Esto reemplaza a mis vendedores?',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'seller_replacement_phrase'
  });
  assert.match(sellerReplacementFallback.replyText, /No, no busca reemplazar/i);
  assert.match(sellerReplacementFallback.replyText, /ordenar consultas|seguimiento/i);

  const dentistFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Soy dentista',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'open_business_phrase'
  });
  assert.match(dentistFallback.replyText, /consultorio/i);
  assert.match(dentistFallback.replyText, /turnos|seguimiento|WhatsApp/i);
  assert.doesNotMatch(dentistFallback.replyText, /fallback|mezclo|mezcló/i);
  assert.strictEqual(dentistFallback.contextPatch.commercialSalesContext.businessTypeRaw, 'dentista');
  assert.strictEqual(dentistFallback.contextPatch.commercialSalesContext.businessCategory, 'healthcare');
  assert.strictEqual(getActiveCommercialDiscoveryPending(dentistFallback.contextPatch).field, 'channel_mix');

  const massageFallback = buildWeakSignalCommercialFallback({
    inboundText: 'Tengo una casa de masajes',
    safeContext: {
      activeBotDomain: 'commerce'
    },
    signal: 'open_business_phrase'
  });
  assert.match(massageFallback.replyText, /casa de masajes/i);
  assert.match(massageFallback.replyText, /consultas|turnos|seguimiento/i);
  assert.doesNotMatch(massageFallback.replyText, /sensible|terapia sexual|adult/i);

  const correctedFallback = buildWeakSignalCommercialFallback({
    inboundText: 'En realidad no es una distribuidora, es un lubricentro',
    safeContext: {
      activeBotDomain: 'commerce',
      commercialSalesContext: {
        updatedAt: new Date().toISOString(),
        businessType: 'distribution',
        businessTypeRaw: 'distribuidora',
        businessCategory: 'wholesale_distribution'
      }
    },
    signal: 'open_business_phrase'
  });
  assert.strictEqual(correctedFallback.contextPatch.commercialSalesContext.businessTypeRaw, 'lubricentro');
  assert.strictEqual(correctedFallback.contextPatch.commercialSalesContext.businessCategory, 'automotive');
  assert.strictEqual(correctedFallback.contextPatch.commercialSalesContext.businessType, null);
  assert.doesNotMatch(correctedFallback.replyText, /distribuidora/i);

  const openIndustrySalesContext = buildAiAssistSalesContext({
    businessTypeRaw: 'lubricentro',
    businessCategory: 'automotive',
    likelyNeeds: ['precios', 'disponibilidad'],
    commercialFit: 'likely_fit',
    nextDiscoveryField: 'team_size',
    confidence: 0.88
  }, null);
  assert.strictEqual(openIndustrySalesContext.businessTypeRaw, 'lubricentro');
  assert.strictEqual(openIndustrySalesContext.businessCategory, 'automotive');
  assert.deepStrictEqual(openIndustrySalesContext.likelyNeeds, ['precios', 'disponibilidad']);
  assert.strictEqual(openIndustrySalesContext.commercialFit, 'likely_fit');
  assert.strictEqual(openIndustrySalesContext.nextDiscoveryField, 'team_size');
  assert.strictEqual(openIndustrySalesContext.aiAssistConfidence, 0.88);

  const aiIndustryReply = await resolveAiAssistDecision({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Tengo un lubricentro',
    aiDecision: {
      domain: 'commerce',
      intent: 'industry_fit',
      confidence: 0.91,
      entities: {
        businessTypeRaw: 'lubricentro',
        businessCategory: 'automotive',
        likelyNeeds: ['precios', 'disponibilidad', 'turnos'],
        commercialFit: 'likely_fit',
        nextDiscoveryField: 'team_size'
      },
      routingDecision: 'use_existing_commerce_reply',
      suggestedReplyIntent: 'industry_fit',
      reason: 'Rubro abierto interpretable'
    },
    safeContext: {
      activeBotDomain: 'commerce'
    }
  });
  assert.match(aiIndustryReply.replyText, /lubricentro/i);
  assert.strictEqual(aiIndustryReply.contextPatch.commercialSalesContext.businessTypeRaw, 'lubricentro');
  assert.strictEqual(aiIndustryReply.contextPatch.commercialSalesContext.businessCategory, 'automotive');
  assert.deepStrictEqual(aiIndustryReply.contextPatch.commercialSalesContext.likelyNeeds, ['precios', 'disponibilidad', 'turnos']);
  assert.strictEqual(aiIndustryReply.contextPatch.commercialSalesContext.commercialFit, 'likely_fit');
  assert.strictEqual(aiIndustryReply.contextPatch.commercialSalesContext.nextDiscoveryField, 'team_size');
  assert.strictEqual(aiIndustryReply.contextPatch.commercialSalesContext.aiAssistConfidence, 0.91);
  assert.strictEqual(getActiveCommercialDiscoveryPending(aiIndustryReply.contextPatch).field, 'team_size');

  const aiForcedIndustryDiscoveryReply = await resolveAiAssistDecision({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Hola Opturon, tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi?',
    aiDecision: {
      domain: 'commerce',
      intent: 'plan_recommendation',
      confidence: 0.86,
      entities: {
        businessType: 'distribution',
        businessTypeRaw: 'distribuidora de heladeras mostrador',
        businessCategory: 'wholesale_distribution'
      },
      routingDecision: 'use_existing_commerce_reply',
      suggestedReplyIntent: 'recommend_plan_by_business_context',
      reason: 'El usuario pregunta que servicio le sirve para su rubro'
    },
    safeContext: {
      activeBotDomain: 'commerce'
    }
  });
  assert.doesNotMatch(aiForcedIndustryDiscoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(aiForcedIndustryDiscoveryReply.replyText, /distribuidora de heladeras mostrador/i);
  assert.match(aiForcedIndustryDiscoveryReply.replyText, /3 preguntas r[aá]pidas/i);
  assert.strictEqual(getActiveCommercialDiscoveryPending(aiForcedIndustryDiscoveryReply.contextPatch).field, 'team_size');

  const aiForcedGrowthDiscoveryReply = await resolveAiAssistDecision({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Tengo una distribuidora, que plan me conviene?',
    aiDecision: {
      domain: 'commerce',
      intent: 'plan_recommendation',
      confidence: 0.88,
      entities: {
        businessType: 'distribution',
        businessTypeRaw: 'distribuidora',
        businessCategory: 'wholesale_distribution'
      },
      routingDecision: 'use_existing_commerce_reply',
      suggestedReplyIntent: 'recommend_plan_growth',
      reason: 'AI Assist intento recomendar growth solo por rubro'
    },
    safeContext: {
      activeBotDomain: 'commerce'
    }
  });
  assert.doesNotMatch(aiForcedGrowthDiscoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(aiForcedGrowthDiscoveryReply.replyText, /3 preguntas r[aá]pidas/i);

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

  const explanationDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          updatedAt: new Date().toISOString(),
          businessType: 'services'
        },
        commercialDiscoveryPending: {
          field: 'team_size',
          askedAt: new Date().toISOString(),
          sourceIntent: 'seller_replacement'
        }
      }
    },
    inboundText: '30/40 por dia, agenda una sola persona y tenemos todo en un excel y un calendario'
  });
  assert.match(explanationDiscoveryReply.replyText, /opci[oÃ³]n intermedia|Crecimiento/i);
  assert.match(explanationDiscoveryReply.replyText, /te explico r[aá]pido por qu[eé]/i);
  assert.strictEqual(explanationDiscoveryReply.contextPatch.commercialSalesContext.estimatedDailyConversations, 40);
  assert.strictEqual(explanationDiscoveryReply.contextPatch.commercialSalesContext.teamSizeValue, 1);
  assert.strictEqual(explanationDiscoveryReply.contextPatch.commercialSalesContext.handlesAppointments, true);
  assert.deepStrictEqual(explanationDiscoveryReply.contextPatch.commercialSalesContext.currentTools, ['excel', 'calendar']);
  assert.strictEqual(explanationDiscoveryReply.contextPatch.commercialShortMemory.pendingCommercialExplanation, true);

  const explanationContext = applyContextPatch(conversation.context, explanationDiscoveryReply.contextPatch);
  const explanationFollowUpReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: explanationContext
    },
    inboundText: 'Dale, explicame'
  });
  assert.match(explanationFollowUpReply.replyText, /Te lo pondr[ií]a por encima/i);
  assert.match(explanationFollowUpReply.replyText, /40 consultas por d[ií]a/i);
  assert.match(explanationFollowUpReply.replyText, /una sola persona/i);
  assert.match(explanationFollowUpReply.replyText, /Excel y calendario/i);
  assert.match(explanationFollowUpReply.replyText, /clientes, pedidos, agenda, pagos y seguimiento/i);
  assert.doesNotMatch(explanationFollowUpReply.replyText, /fallback|no te entend/i);
  assert.strictEqual(getActiveCommercialShortMemory(explanationFollowUpReply.contextPatch).pendingCommercialExplanation, false);

  const purchaseIntentReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: explanationContext
    },
    inboundText: 'Ok, como contrato plan crecimiento?'
  });
  assert.strictEqual(purchaseIntentReply.type, 'payment');
  assert.match(purchaseIntentReply.replyText, /activarlo|activacion|activación/i);
  assert.match(purchaseIntentReply.replyText, /contacte alguien del equipo|siguiente paso de activacion|datos para activarlo/i);
  assert.doesNotMatch(purchaseIntentReply.replyText, /Plan elegido:|que parte te gustaria ordenar|contame un poco de tu negocio|creo que el plan crecimiento puede irte muy bien|te cuento la diferencia con (el )?plan empresa|seguimiento comercial real|mas control|mas contexto/i);
  assert.ok(!purchaseIntentReply.outboundMedia || purchaseIntentReply.outboundMedia.length === 0);
  assert.strictEqual(getActiveCommercialShortMemory(purchaseIntentReply.contextPatch).lastReplyKey, 'commercial_plan_activation');
  assert.strictEqual(getActiveCommercialShortMemory(purchaseIntentReply.contextPatch).pendingCommercialActivation, true);

  const purchaseIntentDecision = await resolveCommerceDecision({
    conversation: {
      ...conversation,
      context: explanationContext
    },
    clinic,
    contact,
    inboundText: 'Ok, como contrato plan crecimiento?'
  });
  assert.strictEqual(purchaseIntentDecision.newStage, 'commercial_plan_activation');
  assert.match(purchaseIntentDecision.replyText, /activarlo|activacion|activación/i);
  assert.doesNotMatch(purchaseIntentDecision.replyText, /Plan elegido:|Te puede servir|Diferencia con Empresa|seguimiento comercial real|mas control|mas contexto/i);

  const activationContext = applyContextPatch(explanationContext, purchaseIntentReply.contextPatch);
  const activationContinuationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: activationContext
    },
    inboundText: 'Me compartis los datos para activarlo por aca?'
  });
  assert.strictEqual(activationContinuationReply.type, 'payment');
  assert.match(activationContinuationReply.replyText, /Alias: OPTURON\.PAGOS/i);
  assert.match(activationContinuationReply.replyText, /Plan Crecimiento/i);
  assert.doesNotMatch(activationContinuationReply.replyText, /Plan ideal para|Te puede servir|Diferencia con Empresa|seguimiento comercial real|mas control|mas contexto/i);
  assert.ok(!activationContinuationReply.outboundMedia || activationContinuationReply.outboundMedia.length === 0);
  assert.strictEqual(getActiveCommercialShortMemory(activationContinuationReply.contextPatch).pendingCommercialActivation, false);
  assert.strictEqual(getActiveCommercialShortMemory(activationContinuationReply.contextPatch).lastReplyKey, 'commercial_activation_continuation');

  const activationContinuationShortReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: activationContext
    },
    inboundText: 'compartime los datos'
  });
  assert.strictEqual(activationContinuationShortReply.type, 'payment');
  assert.match(activationContinuationShortReply.replyText, /Alias: OPTURON\.PAGOS/i);
  assert.doesNotMatch(activationContinuationShortReply.replyText, /Plan ideal para|Te puede servir|Diferencia con Empresa|compar/i);
  assert.strictEqual(getActiveCommercialShortMemory(activationContinuationShortReply.contextPatch).lastReplyKey, 'commercial_activation_continuation');

  const activationContinuationDecision = await resolveCommerceDecision({
    conversation: {
      ...conversation,
      context: activationContext
    },
    clinic,
    contact,
    inboundText: 'Me compartis los datos para activarlo por aca?'
  });
  assert.strictEqual(activationContinuationDecision.newState, 'PAYMENT_TRANSFER');
  assert.match(activationContinuationDecision.replyText, /Alias: OPTURON\.PAGOS/i);
  assert.doesNotMatch(activationContinuationDecision.replyText, /Plan ideal para|Te puede servir|Diferencia con Empresa/i);

  const activationHumanReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: activationContext
    },
    inboundText: 'Que me contacte alguien del equipo'
  });
  assert.strictEqual(activationHumanReply.type, 'human_handoff');
  assert.strictEqual(activationHumanReply.triggerHandoff, true);
  assert.match(activationHumanReply.replyText, /derivo con alguien del equipo/i);
  assert.strictEqual(getActiveCommercialShortMemory(activationHumanReply.contextPatch).pendingCommercialActivation, false);
  assert.strictEqual(getActiveCommercialShortMemory(activationHumanReply.contextPatch).lastReplyKey, 'commercial_activation_human_contact');

  for (const phrase of ['si contame', 'ok dale', 'por que?', 'como seria?']) {
    const variantReply = await buildSafeCommercialIntentReply({
      clinic,
      conversation: {
        ...conversation,
        context: explanationContext
      },
      inboundText: phrase
    });
    assert.match(variantReply.replyText, /Te lo pondr[ií]a por encima/i, phrase);
    assert.doesNotMatch(variantReply.replyText, /fallback|no te entend/i, phrase);
  }

  const noPendingExplanationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'dale'
  });
  if (noPendingExplanationReply) {
    assert.doesNotMatch(noPendingExplanationReply.replyText, /Te lo pondr[ií]a por encima/i);
  }

  const protectedCatalogReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: explanationContext
    },
    inboundText: 'que planes tienen'
  });
  assert.match(protectedCatalogReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.doesNotMatch(protectedCatalogReply.replyText, /Te lo pondr[ií]a por encima/i);

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

  const industryServiceDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: discoveryAuditConversation,
    inboundText: 'Hola Opturon, tengo una distribuidora de heladeras mostrador, que servicio me serviria a mi?'
  });
  assert.doesNotMatch(industryServiceDiscoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(industryServiceDiscoveryReply.replyText, /distribuidora de heladeras mostrador/i);
  assert.match(industryServiceDiscoveryReply.replyText, /3 preguntas r[aá]pidas/i);
  assert.match(industryServiceDiscoveryReply.replyText, /consultas.*WhatsApp/i);
  assert.match(industryServiceDiscoveryReply.replyText, /personas o vendedores/i);
  assert.match(industryServiceDiscoveryReply.replyText, /pedidos, clientes, pagos o comprobantes/i);
  assert.match(industryServiceDiscoveryReply.replyText, /CRM, ventas, pedidos, caja y seguimiento/i);
  assert.strictEqual(industryServiceDiscoveryReply.contextPatch.commercialSalesContext.businessTypeRaw, 'distribuidora de heladeras mostrador');
  assert.strictEqual(getActiveCommercialDiscoveryPending(industryServiceDiscoveryReply.contextPatch).field, 'team_size');

  const industryPlanDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: discoveryAuditConversation,
    inboundText: 'Tengo una distribuidora, que plan me conviene?'
  });
  assert.doesNotMatch(industryPlanDiscoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(industryPlanDiscoveryReply.replyText, /3 preguntas r[aá]pidas/i);

  const rotiseriaDiscoveryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: discoveryAuditConversation,
    inboundText: 'Tengo una rotiseria, sirve para mi negocio?'
  });
  assert.doesNotMatch(rotiseriaDiscoveryReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.match(rotiseriaDiscoveryReply.replyText, /rotiseria/i);
  assert.match(rotiseriaDiscoveryReply.replyText, /3 preguntas r[aá]pidas/i);

  const operationalRecommendationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: discoveryAuditConversation,
    inboundText: 'Tengo 200 consultas por dia y 5 vendedores, que plan me conviene?'
  });
  assert.match(operationalRecommendationReply.replyText, /Plan Inicial|Plan Crecimiento|Plan Empresa/i);
  assert.doesNotMatch(operationalRecommendationReply.replyText, /3 preguntas r[aá]pidas/i);

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

  const planDiscoveryStartReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'soy podologo de manana y masajista de tarde, me sirve su software?'
  });
  assert.match(planDiscoveryStartReply.replyText, /puede servirte|consultas|seguimiento/i);
  let planDiscoveryContext = applyContextPatch({ activeBotDomain: 'commerce' }, planDiscoveryStartReply.contextPatch);

  const planDiscoveryNeedReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: planDiscoveryContext
    },
    inboundText: 'Las consultas y el seguimiento'
  });
  assert.doesNotMatch(planDiscoveryNeedReply.replyText, /humano|fallback|no te entend/i);
  assert.match(planDiscoveryNeedReply.replyText, /consultas|seguimiento/i);
  planDiscoveryContext = applyContextPatch(planDiscoveryContext, planDiscoveryNeedReply.contextPatch);

  const planDiscoveryQuestionReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: planDiscoveryContext
    },
    inboundText: 'Perfecto, que plan me recomendarias?'
  });
  assert.match(planDiscoveryQuestionReply.replyText, /cuantas|consultas|personas|atienden/i);
  planDiscoveryContext = applyContextPatch(planDiscoveryContext, planDiscoveryQuestionReply.contextPatch);

  const planDiscoveryRecommendationReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: planDiscoveryContext
    },
    inboundText: '30/40 por día, agenda una sola persona y tenemos todo en un excel y una calendario'
  });
  assert.doesNotMatch(planDiscoveryRecommendationReply.replyText, /humano|fallback|no te entend/i);
  assert.match(planDiscoveryRecommendationReply.replyText, /Plan Crecimiento|intermedia|intermedio|Crecimiento/i);
  assert.match(planDiscoveryRecommendationReply.replyText, /una sola persona|1 persona|lo atiende una sola persona/i);
  assert.match(planDiscoveryRecommendationReply.replyText, /consultas|seguimiento|turnos|Excel|calendario/i);
  assert.strictEqual(planDiscoveryRecommendationReply.contextPatch.commercialSalesContext.teamSizeValue, 1);
  assert.strictEqual(planDiscoveryRecommendationReply.contextPatch.commercialSalesContext.whatsappVolume, 'high');
  assert.strictEqual(planDiscoveryRecommendationReply.contextPatch.commercialSalesContext.estimatedDailyConversations, 40);
  assert.strictEqual(planDiscoveryRecommendationReply.contextPatch.commercialSalesContext.handlesAppointments, true);
  assert.deepStrictEqual(planDiscoveryRecommendationReply.contextPatch.commercialSalesContext.currentTools, ['excel', 'calendar']);

  const commercialDiscoveryVariantInputs = [
    {
      text: '30 o 40 por dia, responde una sola secretaria y usamos excel y calendario',
      plan: /Plan Crecimiento|intermedia|intermedio|Crecimiento/i,
      teamSizeValue: 1,
      estimatedDailyConversations: 40
    },
    {
      text: 'unas 40 consultas, las agenda una persona y anotamos todo en planillas',
      plan: /Plan Crecimiento|intermedia|intermedio|Crecimiento/i,
      teamSizeValue: 1,
      estimatedDailyConversations: 40
    },
    {
      text: '100 mensajes por dia, 3 vendedores y usamos excel',
      plan: /tipo Empresa|Empresa|mas completa|m.s completa|avanzada/i,
      teamSizeValue: 3,
      estimatedDailyConversations: 100
    },
    {
      text: '10 consultas por dia, trabajo solo y anoto en calendario',
      plan: /Plan Inicial|tipo Inicial|algo simple/i,
      teamSizeValue: 1,
      estimatedDailyConversations: 10
    },
    {
      text: 'somos dos, 50 consultas por WhatsApp y llevamos clientes en Excel',
      plan: /Plan Crecimiento|intermedia|intermedio|Crecimiento/i,
      teamSizeValue: 2,
      estimatedDailyConversations: 50
    }
  ];

  for (const variant of commercialDiscoveryVariantInputs) {
    const variantContext = {
      activeBotDomain: 'commerce',
      commercialDiscoveryPending: {
        field: 'team_size',
        askedAt: new Date().toISOString(),
        sourceIntent: 'plan_recommendation',
        meta: null
      }
    };
    const variantReply = await buildSafeCommercialIntentReply({
      clinic,
      conversation: {
        ...conversation,
        context: variantContext
      },
      inboundText: variant.text
    });
    assert.doesNotMatch(variantReply.replyText, /te derivamos|humano|fallback|no te entend/i, variant.text);
    assert.match(variantReply.replyText, variant.plan, variant.text);
    assert.strictEqual(variantReply.contextPatch.commercialSalesContext.teamSizeValue, variant.teamSizeValue, variant.text);
    assert.strictEqual(variantReply.contextPatch.commercialSalesContext.estimatedDailyConversations, variant.estimatedDailyConversations, variant.text);
  }

  const starterPlanQuestionReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'que plan me conviene?'
  });
  const starterPlanContext = applyContextPatch({ activeBotDomain: 'commerce' }, starterPlanQuestionReply.contextPatch);
  const starterPlanReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: starterPlanContext
    },
    inboundText: '10 consultas por dia y trabajo solo'
  });
  assert.doesNotMatch(starterPlanReply.replyText, /humano|fallback|no te entend/i);
  assert.match(starterPlanReply.replyText, /Plan Inicial|tipo Inicial|algo simple/i);

  const enterprisePlanContext = applyContextPatch({ activeBotDomain: 'commerce' }, starterPlanQuestionReply.contextPatch);
  const enterprisePlanReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: enterprisePlanContext
    },
    inboundText: '100 mensajes por dia y tengo 3 vendedores'
  });
  assert.doesNotMatch(enterprisePlanReply.replyText, /humano|fallback|no te entend/i);
  assert.match(enterprisePlanReply.replyText, /tipo Empresa|Empresa|mas completa|m.s completa|avanzada/i);
  assert.strictEqual(enterprisePlanReply.contextPatch.commercialSalesContext.teamSizeValue, 3);
  assert.strictEqual(enterprisePlanReply.contextPatch.commercialSalesContext.estimatedDailyConversations, 100);

  const twoPeopleReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'somos dos personas respondiendo y recibimos 40 consultas'
  });
  assert.doesNotMatch(twoPeopleReply.replyText, /humano|fallback|no te entend/i);
  assert.match(twoPeopleReply.replyText, /Plan Crecimiento|intermedia|intermedio|Crecimiento/i);
  assert.strictEqual(twoPeopleReply.contextPatch.commercialSalesContext.teamSizeValue, 2);

  const accessoriesSoloReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          businessType: 'accessories_retail',
          offerTypeSignal: 'products'
        },
        commercialDiscoveryPending: {
          field: 'team_size',
          askedAt: new Date().toISOString(),
          sourceIntent: 'plan_recommendation',
          meta: null
        }
      }
    },
    inboundText: 'tenemos unas 30 consultas diarias, 1 persona atiende el whatsapp y registramos los pedidos en una planilla de excel'
  });
  assert.doesNotMatch(accessoriesSoloReply.replyText, /humano|fallback|no te entend/i);
  assert.match(accessoriesSoloReply.replyText, /Plan Crecimiento|intermedia|intermedio|Crecimiento/i);
  assert.match(accessoriesSoloReply.replyText, /30 consultas por d[ií]a|unas 30 consultas/i);
  assert.match(accessoriesSoloReply.replyText, /1 persona|una sola persona/i);
  assert.doesNotMatch(accessoriesSoloReply.replyText, /30 personas/i);
  assert.strictEqual(accessoriesSoloReply.contextPatch.commercialSalesContext.teamSizeValue, 1);
  assert.strictEqual(accessoriesSoloReply.contextPatch.commercialSalesContext.estimatedDailyConversations, 30);
  assert.deepStrictEqual(accessoriesSoloReply.contextPatch.commercialSalesContext.currentTools, ['excel', 'spreadsheet']);

  const secretaryReply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      ...conversation,
      context: {
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'una secretaria agenda todo y recibe muchas consultas'
  });
  assert.doesNotMatch(secretaryReply.replyText, /humano|fallback|no te entend/i);
  assert.match(secretaryReply.replyText, /agenda|consultas|seguimiento|Plan Crecimiento|Crecimiento/i);
  assert.strictEqual(secretaryReply.contextPatch.commercialSalesContext.teamSizeValue, 1);

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

  const commercialKbFixturePhrases = [
    ['vendo por instagram', 'instagram_sales'],
    ['puedo usar mi numero actual?', 'existing_whatsapp_number'],
    ['esto reemplaza a mis vendedores?', 'replaces_secretary_or_seller'],
    ['sirve para una rotiseria?', 'business_fit_by_industry'],
    ['soy podologa a la manana y masajista a la tarde', 'multi_service'],
    ['tengo dos emprendimientos', 'multi_business'],
    ['mi mujer atiende un consultorio y yo tengo una distribuidora', 'multi_business'],
    ['tengo una casa de repuestos', 'business_fit_by_industry'],
    ['tengo inmobiliaria', 'business_fit_by_industry'],
    ['trabajo con turnos', 'appointment_business'],
    ['vendo productos', 'product_catalog_business'],
    ['tengo delivery', 'delivery_or_distribution_business'],
    ['ya uso excel', 'excel_import'],
    ['tengo muchos mensajes y se me pierden', 'scaling_business_fit'],
    ['tengo varios vendedores', 'multi_user_sellers'],
    ['quiero que conteste cuando yo no estoy', 'business_fit_general'],
    ['quiero que derive a una persona', 'human_takeover'],
    ['me sirve si soy chico?', 'small_business_fit'],
    ['tengo pocos clientes todavia', 'small_business_fit'],
    ['tengo muchos clientes', 'scaling_business_fit'],
    ['tengo una estetica', 'business_fit_by_industry'],
    ['tengo lubricentro', 'business_fit_by_industry'],
    ['tengo tienda de ropa', 'business_fit_by_industry'],
    ['tengo distribuidora', 'delivery_or_distribution_business'],
    ['tengo local y vendo online', 'multi_business'],
    ['atiendo por whatsapp y por instagram', 'instagram_sales'],
    ['necesito agenda', 'appointment_business'],
    ['necesito pedidos', 'product_catalog_business'],
    ['necesito seguimiento', 'crm_and_follow_up'],
    ['el bot aprende solo?', 'limitations_or_edge_cases'],
    ['puedo pausar el bot?', 'human_takeover'],
    ['puedo hablar yo si quiero?', 'human_takeover'],
    ['que pasa si no entiende?', 'limitations_or_edge_cases'],
    ['que plan me conviene?', 'plan_recommendation'],
    ['como empiezo?', 'onboarding_how_to_start'],
    ['cuanto tarda en implementarse?', 'onboarding_how_to_start'],
    ['necesito cargar mis productos', 'excel_import'],
    ['puedo tener usuarios?', 'multi_user_sellers'],
    ['puedo ver metricas?', 'multi_user_sellers'],
    ['sirve para servicios y productos?', 'business_fit_by_industry']
  ];

  for (const [phrase, expectedCategory] of commercialKbFixturePhrases) {
    const match = findCommercialKnowledgeMatch(phrase);
    assert.ok(match, `Expected commercial KB match for "${phrase}"`);
    assert.strictEqual(match.category, expectedCategory, `Unexpected KB category for "${phrase}"`);

    const reply = await buildSafeCommercialIntentReply({
      clinic,
      conversation: {
        ...conversation,
        context: {
          activeBotDomain: 'commerce'
        }
      },
      inboundText: phrase
    });
    assert.ok(reply && reply.replyText, `Expected controlled reply for "${phrase}"`);
    assert.doesNotMatch(reply.replyText, /fallback|no te entend/i, `Unexpected fallback reply for "${phrase}"`);
  }

  const expectedControlledReplies = [
    ['soy podologa a la manana y masajista a la tarde', /m.s de una actividad/i],
    ['tengo una distribuidora y tambien vendo por instagram', /consultas que llegan desde Instagram/i],
    ['esto reemplaza a mis vendedores?', /no est. pensado para sacar vendedores/i],
    ['ya tengo mi numero de whatsapp, lo puedo usar?', /compatible con la conexi.n de WhatsApp Business\/API/i],
    ['ya uso excel', /no te lo vender.a como algo 100% autom.tico/i]
  ];

  for (const [phrase, expectedPattern] of expectedControlledReplies) {
    const reply = await buildSafeCommercialIntentReply({
      clinic,
      conversation: {
        ...conversation,
        context: {
          activeBotDomain: 'commerce'
        }
      },
      inboundText: phrase
    });
    assert.match(reply.replyText, expectedPattern, `Controlled reply mismatch for "${phrase}"`);
  }

  console.log('BOT.UNIVERSAL.BRAIN.1 validation passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
