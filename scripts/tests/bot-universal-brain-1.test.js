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
  buildSafeCommercialIntentReply,
  resolveCommerceDecision
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

  assert.strictEqual(detectCommercialPlanObjection('es caro'), 'price');
  assert.strictEqual(detectCommercialPlanObjection('algo mas barato'), 'price');

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
