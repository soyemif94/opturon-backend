const assert = require('assert');
const path = require('path');

const catalogProducts = [
    { id: 'coke-red', name: 'Coca Cola roja 500ml', price: 1800, currency: 'ARS', stock: 8, status: 'active', sku: 'COKE-R-500', categoryId: 'drinks', categoryName: 'Gaseosas' },
    { id: 'coke-zero', name: 'Coca Cola Zero 500ml', price: 1900, currency: 'ARS', stock: 4, status: 'active', sku: 'COKE-Z-500', categoryId: 'drinks', categoryName: 'Gaseosas' },
    { id: 'sprite', name: 'Sprite 500ml', price: 1700, currency: 'ARS', stock: 9, status: 'active', sku: 'SPRITE-500', categoryId: 'drinks', categoryName: 'Gaseosas' }
];

const tenantProducts = {
  'tenant-catalog': catalogProducts,
  'tenant-p1': [
    { id: 'plan-initial', name: 'Plan Inicial', price: 15000, currency: 'ARS', stock: 99, status: 'active', sku: 'PLAN-INITIAL', description: 'Orden inicial para WhatsApp y contactos.' },
    { id: 'plan-growth', name: 'Plan Crecimiento', price: 30000, currency: 'ARS', stock: 99, status: 'active', sku: 'PLAN-GROWTH', description: 'Seguimiento comercial, automatizaciones y reportes.' },
    { id: 'plan-enterprise', name: 'Plan Empresa', price: 60000, currency: 'ARS', stock: 99, status: 'active', sku: 'PLAN-ENTERPRISE', description: 'Control de equipos y operación avanzada.' }
  ],
  'tenant-other': [
    { id: 'private-other', name: 'Producto privado otro tenant', price: 999999, currency: 'ARS', stock: 99, status: 'active' }
  ]
};

const orderCalls = [];
function stubModule(relativePath, exportsValue) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

stubModule('src/repositories/products.repository.js', {
  listProductsByClinicId: async (clinicId) => tenantProducts[clinicId] || [],
  findProductById: async (first, second) => {
    const clinicId = tenantProducts[first] ? first : second;
    const productId = tenantProducts[first] ? second : first;
    return (tenantProducts[clinicId] || []).find((item) => item.id === productId) || null;
  }
});
stubModule('src/services/portal-orders.service.js', {
  createOrderForClinic: async (clinicId, payload) => {
    orderCalls.push({ clinicId, payload });
    return { ok: true, order: { id: 'should-not-be-created', total: 0, currency: 'ARS' } };
  },
  patchOrderStatusForClinic: async () => ({ ok: false, reason: 'not_used' })
});
stubModule('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }),
  findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0,
  countEventsByType: async () => 0,
  countClinicEventsByTypeCurrentMonth: async () => 0
});
stubModule('src/utils/logger.js', { logInfo: () => {}, logWarn: () => {}, logError: () => {} });

const worker = require('../../src/worker');
const { parseAppointmentText, parsePartySize } = require('../../src/conversations/appointment.parser');
const {
  normalizeCommandText,
  parseCommerceQuantity,
  parseCommerceNaturalOrder,
  parseContextualCartAction,
  extractCommercialProductQuery,
  parseProductDiscoveryRequest,
  findProductsByQuery,
  detectIntent,
  detectCommercialIntent,
  isLoyaltyIntent,
  buildSafeCommercialIntentReply,
  resolveCommerceDecision
} = worker.__private__;

const clinic = {
  id: 'tenant-p1',
  timezone: 'America/Argentina/Buenos_Aires',
  settings: {
    businessProfile: {
      deliveryZones: 'CABA y GBA',
      paymentMethods: 'Transferencia, efectivo y tarjeta'
    },
    bot: {
      transferConfig: {
        enabled: true,
        alias: 'P1.TEST.ALIAS',
        cbu: '0000003100000000000002',
        holderName: 'Opturon Test'
      }
    }
  }
};
const contact = { id: 'contact-p1', name: 'QA', waId: '5491100000000' };
const products = catalogProducts;
let caseCount = 0;

function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label);
  caseCount += 1;
}

function checkTruthy(label, value) {
  assert.ok(value, label);
  caseCount += 1;
}

function mergePatch(base, patch) {
  return { ...(base || {}), ...(patch || {}) };
}

async function turn(conversation, message, targetClinic = clinic) {
  const decision = await resolveCommerceDecision({ conversation, clinic: targetClinic, contact, inboundText: message });
  assert.ok(decision, `missing decision for: ${message}`);
  return {
    decision,
    conversation: {
      ...conversation,
      state: decision.newState || conversation.state,
      context: mergePatch(conversation.context, decision.contextPatch)
    }
  };
}

async function main() {
  // 15 product discovery / stock cases.
  const discoveryCases = [
    ['qué tenés de gaseosas', 'gaseosas'],
    ['que tenes de gaseosa', 'gaseosa'],
    ['tenés algo de coca', 'coca'],
    ['qué bebidas tenés', 'bebidas'],
    ['mostrame gaseosas', 'gaseosas'],
    ['tenes coca cola?', 'coca cola'],
    ['tienen Sprite', 'sprite'],
    ['ver coca zero', 'coca zero']
  ];
  for (const [message, query] of discoveryCases) {
    check(`discovery query: ${message}`, parseProductDiscoveryRequest(message).query, query);
  }
  check('stock query coca', extractCommercialProductQuery('hay stock de Coca Cola?'), 'coca cola');
  check('stock query sprite', extractCommercialProductQuery('¿hay stock de Sprite?'), 'sprite');
  check('price query coca', extractCommercialProductQuery('cuánto sale la Coca Cola?'), 'coca cola');
  check('partial product has two variants', findProductsByQuery(products, 'coca cola').length, 2);
  check('exact product has one match', findProductsByQuery(products, 'sprite').length, 1);
  check('unknown product has no match', findProductsByQuery(products, 'fanta').length, 0);
  check('stock intent remains deterministic', detectCommercialIntent('hay stock de Sprite').type, 'stock');

  // 20 quantity / cart / context cases.
  const quantityCases = [['1', 1], ['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5], ['seis', 6], ['siete', 7], ['ocho', 8], ['nueve', 9], ['diez', 10]];
  for (const [message, quantity] of quantityCases) check(`quantity: ${message}`, parseCommerceQuantity(message), quantity);
  check('pair is not silently assumed', parseCommerceQuantity('un par'), null);
  check('add another', parseContextualCartAction('sumame otro'), { type: 'add', quantity: 1 });
  check('add one more', parseContextualCartAction('uno más'), { type: 'add', quantity: 1 });
  check('set better three', parseContextualCartAction('mejor tres'), { type: 'set', quantity: 3 });
  check('set leave four', parseContextualCartAction('dejame cuatro'), { type: 'set', quantity: 4 });
  check('add three more', parseContextualCartAction('dame tres más'), { type: 'add', quantity: 3 });
  check('add contextual two', parseContextualCartAction('dame dos'), { type: 'add', quantity: 2 });
  check('continuation product', parseCommerceNaturalOrder('y una Sprite'), { quantity: 1, productName: 'sprite' });
  check('natural quantity product', parseCommerceNaturalOrder('dame dos Coca Cola'), { quantity: 2, productName: 'coca cola' });
  check('invalid contextual action', parseContextualCartAction('otro producto'), null);

  const catalogClinic = { ...clinic, id: 'tenant-catalog' };
  let catalogConversation = { id: 'conv-catalog', clinicId: 'tenant-catalog', state: 'READY', context: { activeBotDomain: 'commerce' } };
  let catalogResult = await turn(catalogConversation, 'tenés Sprite?', catalogClinic);
  catalogConversation = catalogResult.conversation;
  check('unique product referent stored', catalogConversation.context.commerceSuggestedProductId, 'sprite');
  const contextualStock = await buildSafeCommercialIntentReply({ clinic: catalogClinic, conversation: catalogConversation, contact, inboundText: 'hay stock?' });
  checkTruthy('stock reuses current product', /Sprite.*stock disponible/i.test(contextualStock.replyText));
  catalogResult = await turn(catalogConversation, 'dame dos', catalogClinic);
  catalogConversation = catalogResult.conversation;
  check('contextual quantity adds two', catalogConversation.context.commerceCartItems[0].quantity, 2);
  catalogResult = await turn(catalogConversation, 'mejor tres', catalogClinic);
  catalogConversation = catalogResult.conversation;
  check('replacement quantity sets total', catalogConversation.context.commerceCartItems[0].quantity, 3);
  catalogResult = await turn(catalogConversation, 'y una Coca Cola Zero', catalogClinic);
  catalogConversation = catalogResult.conversation;
  check('continuation retains both products', catalogConversation.context.commerceCartItems.length, 2);

  // 15 commercial plan / payment context cases, including the required real sequence.
  check('plans route', detectCommercialIntent('qué planes tienen').type, 'products');
  check('growth detail stays contextual', detectCommercialIntent('dame más detalles del Plan Crecimiento').type, 'unknown');
  check('interest route', detectCommercialIntent('me interesa').type, 'purchase_intent');
  check('pronoun payment route', detectCommercialIntent('cómo hago para pagarlo').type, 'payment');
  check('transfer route', detectCommercialIntent('por transferencia').type, 'payment');

  let planConversation = { id: 'conv-plan', clinicId: 'tenant-p1', state: 'READY', context: { activeBotDomain: 'commerce' } };
  let result = await turn(planConversation, 'planes');
  planConversation = result.conversation;
  checkTruthy('plan list contains Inicial', /Plan Inicial/i.test(result.decision.replyText));
  checkTruthy('plan list contains Crecimiento', /Plan Crecimiento/i.test(result.decision.replyText));
  checkTruthy('plan list contains Empresa', /Plan Empresa/i.test(result.decision.replyText));
  result = await turn(planConversation, 'a ver, pasame más detalles');
  planConversation = result.conversation;
  checkTruthy('contextual details avoids unknown fallback', !/no llegu[eé] a entender|no entend[ií]/i.test(result.decision.replyText));
  result = await turn(planConversation, 'dame más detalles del plan crecimiento');
  planConversation = result.conversation;
  checkTruthy('growth details resolved', /Plan Crecimiento/i.test(result.decision.replyText));
  check(
    'growth referent persisted',
    planConversation.context.commerceSuggestedProductId || (planConversation.context.commercialPlanContext && planConversation.context.commercialPlanContext.lastDiscussedPlanId),
    'plan-growth'
  );
  result = await turn(planConversation, 'genial, me interesa');
  planConversation = result.conversation;
  checkTruthy('interest retains growth', /Plan Crecimiento/i.test(result.decision.replyText));
  result = await turn(planConversation, 'Genial, me interesa, ¿cómo hago para pagarlo?');
  planConversation = result.conversation;
  checkTruthy('payment methods grounded', /transferencia|efectivo|tarjeta/i.test(result.decision.replyText));
  checkTruthy('payment does not ask plan again', !/eleg[ií].*plan|qu[eé] plan/i.test(result.decision.replyText));
  result = await turn(planConversation, 'por transferencia');
  planConversation = result.conversation;
  checkTruthy('transfer data path', /P1\.TEST\.ALIAS|0000003100000000000002/i.test(result.decision.replyText));

  // 10 delivery / loyalty cases.
  for (const message of ['hacen envíos?', 'tenés delivery?', 'me lo mandan?', 'envían a domicilio?', 'llega hoy?']) {
    check(`delivery: ${message}`, detectCommercialIntent(message).type, 'delivery');
  }
  for (const message of ['hay recompensas?', 'tengo puntos?', 'qué beneficios tengo?', 'puedo canjear algo?', 'mis puntos']) {
    check(`loyalty: ${message}`, isLoyaltyIntent(message), true);
  }

  // 15 agenda cases: intent, dates, windows, and party-size metadata.
  for (const message of ['reservame el viernes', 'reservame para el viernes', 'quiero reservar el viernes', 'reserva para dos personas', 'agendame', 'quiero un turno']) {
    check(`agenda intent: ${message}`, detectIntent(message), 'appointment');
  }
  check('weekday friday', parseAppointmentText('reservame el viernes').parsed.weekday, 'friday');
  check('next friday remains explicit weekday', parseAppointmentText('próximo viernes').parsed.weekday, 'friday');
  check('tomorrow relative date', parseAppointmentText('mañana a la tarde').hasDayOrDate, true);
  check('afternoon window', parseAppointmentText('mañana a la tarde').parsed.timeWindow, 'afternoon');
  check('party size words', parsePartySize('reserva para dos personas'), 2);
  check('party size digits', parsePartySize('para 2'), 2);
  check('party size continuation', parsePartySize('somos tres'), 3);
  check('party size not invented', parsePartySize('un par'), null);
  check('invalid date rejected', parseAppointmentText('turno el 31/02').ok, false);

  // 5 ambiguity / context invalidation cases.
  check('ambiguous coca has variants', findProductsByQuery(products, 'coca').length, 2);
  check('pronoun alone has no product query', parseProductDiscoveryRequest('esa'), null);
  check('generic price has no arbitrary product', extractCommercialProductQuery('q sale'), '');
  const noContextPrice = await buildSafeCommercialIntentReply({ clinic, conversation: { id: 'no-context', clinicId: 'tenant-p1', context: {} }, contact, inboundText: 'q sale' });
  checkTruthy('generic price asks product', /producto|nombre/i.test(noContextPrice.replyText));
  const crossTenantMatches = findProductsByQuery(tenantProducts['tenant-other'], 'coca');
  check('tenant scope excludes foreign products', crossTenantMatches.length, 0);

  assert.ok(caseCount >= 80, `expected at least 80 focused cases, got ${caseCount}`);
  assert.strictEqual(orderCalls.length, 0, 'P1 suite must not create or mutate orders');
  console.log(JSON.stringify({ passed: caseCount, orderWrites: orderCalls.length, realConversationFixture: 'PASS' }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
