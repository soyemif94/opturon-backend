const assert = require('assert');
const path = require('path');

const tenantProducts = {
  'tenant-a': [
    { id: 'coke-red', name: 'Coca Cola roja 500ml', price: 1800, currency: 'ARS', stock: 5, status: 'active', sku: 'COKE-R-500' },
    { id: 'coke-blue', name: 'Coca Cola azul 500ml', price: 1900, currency: 'ARS', stock: 2, status: 'active', sku: 'COKE-B-500' },
    { id: 'sprite', name: 'Sprite 500ml', price: 1700, currency: 'ARS', stock: 8, status: 'active', sku: 'SPRITE-500' },
    { id: 'water', name: 'Agua mineral', price: 900, currency: 'ARS', stock: 0, status: 'active', sku: 'WATER' },
    { id: 'mystery', name: 'Producto sin precio', price: null, currency: 'ARS', stock: 4, status: 'active', sku: 'NO-PRICE' },
    { id: 'plan-growth', name: 'Plan Crecimiento', price: 30000, currency: 'ARS', stock: 8, status: 'active', sku: 'PLAN-GROWTH', description: 'Seguimiento comercial' }
  ],
  'tenant-b': [
    { id: 'coke-b-only', name: 'Coca Cola roja 500ml', price: 9999, currency: 'ARS', stock: 99, status: 'active', sku: 'B-COKE' }
  ]
};

const orderCalls = [];

function stubModule(relativePath, exportsValue) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function productsForClinic(clinicId) {
  return tenantProducts[String(clinicId || '').trim()] || [];
}

stubModule('src/repositories/products.repository.js', {
  listProductsByClinicId: async (clinicId) => productsForClinic(clinicId),
  findProductById: async (first, second) => {
    const clinicId = tenantProducts[first] ? first : second;
    const productId = tenantProducts[first] ? second : first;
    return productsForClinic(clinicId).find((item) => item.id === productId) || null;
  }
});

stubModule('src/services/portal-orders.service.js', {
  createOrderForClinic: async (clinicId, payload) => {
    orderCalls.push({ type: 'create', clinicId, payload });
    if (payload.items.some((item) => item.productId === 'water')) {
      return { ok: false, reason: 'order_item_insufficient_stock' };
    }
    return {
      ok: true,
      order: { id: `order-${orderCalls.length}`, total: 3600, currency: 'ARS', orderStatus: 'pending' }
    };
  },
  patchOrderStatusForClinic: async (clinicId, orderId, patch) => {
    orderCalls.push({ type: 'patch', clinicId, orderId, patch });
    return { ok: true, order: { id: orderId, orderStatus: patch.orderStatus } };
  }
});

stubModule('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }),
  findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0,
  countEventsByType: async () => 0,
  countClinicEventsByTypeCurrentMonth: async () => 0
});

stubModule('src/utils/logger.js', {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {}
});

const worker = require('../../src/worker');
const { decideReply } = require('../../src/conversations/conversation.engine');
const {
  detectIntent,
  detectCommercialIntent,
  parseTransferPaymentIntent,
  isLoyaltyIntent,
  buildSafeCommercialIntentReply,
  resolveCommerceDecision,
  buildIntelligentFallbackReply,
  resolveBotReplyAuthority,
  BOT_REPLY_AUTHORITY_REASONS
} = worker.__private__;

const clinicA = {
  id: 'tenant-a',
  timezone: 'America/Argentina/Buenos_Aires',
  settings: {
    businessProfile: {
      address: 'Av. Audit 123, CABA',
      openingHours: 'Lunes a viernes de 9 a 18 hs',
      deliveryZones: 'CABA y GBA',
      paymentMethods: 'Transferencia, efectivo y tarjeta'
    },
    bot: {
      transferConfig: {
        enabled: true,
        alias: 'AUDIT.PAGOS',
        cbu: '0000003100000000000001',
        holderName: 'Comercio Auditado'
      }
    }
  }
};

const clinicNoData = { id: 'tenant-a', settings: { businessProfile: {}, bot: {} } };
const clinicB = {
  ...clinicA,
  id: 'tenant-b',
  settings: {
    ...clinicA.settings,
    bot: { transferConfig: { enabled: true, alias: 'TENANT.B', cbu: '9999999999999999999999' } }
  }
};
const contact = { id: 'contact-a', name: 'Ana', phone: '5491111111111', waId: '5491111111111' };

function conversation(overrides = {}) {
  return {
    id: 'conversation-a',
    clinicId: 'tenant-a',
    state: 'READY',
    status: 'open',
    context: { activeBotDomain: 'commerce' },
    ...overrides
  };
}

function mergePatch(base, patch) {
  return { ...(base || {}), ...(patch || {}) };
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const results = [];

function record(spec, observed, status, reason) {
  results.push({
    id: spec.id,
    category: spec.category,
    userMessage: spec.message,
    previousContext: spec.previousContext || null,
    expectedIntent: spec.expectedIntent,
    expectedAction: spec.expectedAction,
    expectedDataDependency: spec.dependency,
    forbiddenBehavior: spec.forbidden,
    observedResult: observed,
    status,
    severity: status === 'PASS' ? null : spec.severity,
    reason
  });
}

function routeObservation(message) {
  const transfer = parseTransferPaymentIntent(message);
  const commercial = detectCommercialIntent(message).type;
  const intent = detectIntent(message);
  return { intent, commercialIntent: commercial, transferIntent: transfer, loyalty: isLoyaltyIntent(message) };
}

async function runRoute(spec) {
  const observed = routeObservation(spec.message);
  const actual = spec.routeField === 'transferIntent'
    ? observed.transferIntent
    : spec.routeField === 'loyalty'
      ? observed.loyalty
      : spec.routeField === 'intent'
        ? observed.intent
        : observed.commercialIntent;
  const accepted = Array.isArray(spec.accept) ? spec.accept : [spec.accept];
  const pass = accepted.includes(actual);
  record(spec, observed, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'matched expected route' : `expected ${accepted.join('|')}, got ${String(actual)}`);
}

async function runReply(spec) {
  const targetClinic = spec.clinic || clinicA;
  const targetConversation = conversation(spec.conversation || {});
  const reply = await buildSafeCommercialIntentReply({
    clinic: targetClinic,
    conversation: targetConversation,
    contact,
    inboundText: spec.message
  });
  const text = normalize(reply && reply.replyText);
  const includesOk = (spec.includes || []).every((pattern) => pattern.test(text));
  const forbiddenOk = (spec.forbiddenPatterns || []).every((pattern) => !pattern.test(text));
  const actionOk = spec.expectHandoff === undefined || Boolean(reply && reply.triggerHandoff) === spec.expectHandoff;
  const pass = Boolean(reply && reply.replyText) && includesOk && forbiddenOk && actionOk;
  record(spec, { type: reply && reply.type, replyText: reply && reply.replyText, triggerHandoff: Boolean(reply && reply.triggerHandoff) }, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'controlled grounded reply' : 'reply contract mismatch');
}

async function runCommerce(spec) {
  const before = orderCalls.length;
  const conv = conversation(spec.conversation || {});
  const decision = await resolveCommerceDecision({
    conversation: conv,
    clinic: spec.clinic || clinicA,
    contact,
    inboundText: spec.message,
    inboundMessage: spec.inboundMessage || null
  });
  const text = normalize(decision && decision.replyText);
  const includesOk = (spec.includes || []).every((pattern) => pattern.test(text));
  const forbiddenOk = (spec.forbiddenPatterns || []).every((pattern) => !pattern.test(text));
  const expectedWriteCount = spec.expectedWrites === undefined ? null : spec.expectedWrites;
  const writeCount = orderCalls.length - before;
  const writeOk = expectedWriteCount === null || writeCount === expectedWriteCount;
  const pass = Boolean(decision) && includesOk && forbiddenOk && writeOk;
  record(spec, {
    newState: decision && decision.newState,
    newStage: decision && decision.newStage,
    replyText: decision && decision.replyText,
    contextPatch: decision && decision.contextPatch,
    transactionalCalls: orderCalls.slice(before)
  }, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'commerce contract matched' : 'commerce contract mismatch');
}

async function runEngine(spec) {
  const decision = decideReply({ state: spec.state || 'READY', context: spec.context || {}, inboundText: spec.message });
  const text = normalize(decision.replyText);
  const pass = (spec.includes || []).every((pattern) => pattern.test(text)) && (!spec.newState || decision.newState === spec.newState);
  record(spec, decision, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'state machine contract matched' : 'state machine contract mismatch');
}

async function runAuthority(spec) {
  const decision = resolveBotReplyAuthority(spec.input);
  const pass = decision.allowed === spec.allowed && decision.reason === spec.reason;
  record(spec, decision, pass ? 'PASS' : 'FAIL', pass ? 'authority guard matched' : 'authority guard mismatch');
}

async function runFallback(spec) {
  const decision = buildIntelligentFallbackReply(spec.context || {}, spec.message, spec.clinic || clinicA);
  const text = normalize(decision.replyText);
  const pass = (spec.includes || []).every((pattern) => pattern.test(text)) && (spec.forbiddenPatterns || []).every((pattern) => !pattern.test(text));
  record(spec, decision, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'safe fallback' : 'fallback contract mismatch');
}

async function runMultiturn(spec) {
  const before = orderCalls.length;
  let conv = conversation({ state: spec.initialState || 'READY', context: spec.initialContext || { activeBotDomain: 'commerce' } });
  const turns = [];
  for (const message of spec.turns) {
    const decision = await resolveCommerceDecision({ conversation: conv, clinic: clinicA, contact, inboundText: message });
    turns.push({ message, decision });
    if (!decision) break;
    conv = { ...conv, state: decision.newState || conv.state, context: mergePatch(conv.context, decision.contextPatch) };
  }
  const finalText = normalize(turns.at(-1) && turns.at(-1).decision && turns.at(-1).decision.replyText);
  const transactionalCalls = orderCalls.slice(before);
  const writesOk = spec.expectedWrites === undefined || transactionalCalls.length === spec.expectedWrites;
  const forbiddenOk = (spec.forbiddenPatterns || []).every((pattern) => !pattern.test(finalText));
  const pass = turns.length === spec.turns.length && turns.every((turn) => Boolean(turn.decision)) && (spec.includes || []).every((pattern) => pattern.test(finalText)) && forbiddenOk && writesOk;
  record(spec, { turns, finalState: conv.state, finalContext: conv.context, transactionalCalls }, pass ? 'PASS' : (spec.partialOnMismatch ? 'PARTIAL' : 'FAIL'), pass ? 'continuity contract matched' : 'continuity lost or final contract mismatch');
}

function base(category, id, message, expectedIntent, expectedAction, dependency, forbidden, severity = 'P1') {
  return { category, id: `${category}-${id}`, message, expectedIntent, expectedAction, dependency, forbidden, severity };
}

const scenarios = [];
function addRoute(category, entries, defaults = {}) {
  for (const entry of entries) {
    scenarios.push({ ...base(category, entry[0], entry[1], entry[2], entry[3], entry[4], entry[5], entry[8] || defaults.severity || 'P1'), evaluator: 'route', routeField: entry[6] || defaults.routeField || 'commercialIntent', accept: entry[7], partialOnMismatch: entry[9] === true });
  }
}

addRoute('A', [
  ['01', 'hola', 'greeting', 'greet', 'none', 'invent business facts', null, 'unknown'],
  ['02', 'buenass', 'greeting', 'greet', 'none', 'invent business facts', 'intent', 'unknown'],
  ['03', 'qué horarios tienen?', 'hours', 'read openingHours', 'tenant business profile', 'invent hours', null, 'hours'],
  ['04', 'dónde están?', 'location', 'read address', 'tenant business profile', 'invent address', null, 'location'],
  ['05', 'hacen delivery?', 'delivery', 'read deliveryZones', 'tenant business profile', 'invent coverage', null, 'delivery'],
  ['06', 'gracias', 'thanks', 'acknowledge', 'conversation context', 'restart transaction', 'intent', 'unknown'],
  ['07', 'q onda', 'greeting', 'greet', 'none', 'hallucinate', 'intent', 'unknown'],
  ['08', 'qué venden?', 'products', 'show catalog', 'tenant products', 'invent products', null, 'products'],
  ['09', 'hay promos?', 'promotions', 'read discounts', 'tenant products', 'invent discounts', null, 'promotions'],
  ['10', 'esto hace café?', 'unknown', 'safe fallback', 'none', 'claim unsupported feature', null, 'unknown']
]);

addRoute('B', [
  ['01', 'productos', 'products', 'catalog', 'tenant products', 'cross tenant products', null, 'products'],
  ['02', 'catálogo', 'products', 'catalog', 'tenant products', 'invent products', null, 'products'],
  ['03', 'qué tenés de gaseosas?', 'products', 'catalog/search', 'tenant products', 'invent category', null, 'products'],
  ['04', 'cuánto sale la Coca Cola?', 'prices', 'product lookup', 'tenant products', 'invent price', null, 'prices'],
  ['05', 'presio de la sprite', 'prices', 'product lookup', 'tenant products', 'invent price', null, 'prices'],
  ['06', 'quiero una coca roja', 'product selection', 'select product', 'tenant products', 'choose ambiguous variant', null, 'unknown', 'P1', true],
  ['07', 'quiero una coca azul', 'product selection', 'select product', 'tenant products', 'choose wrong variant', null, 'unknown', 'P1', true],
  ['08', 'tenés Coca Cola?', 'product search', 'disambiguate variants', 'tenant products', 'silently choose variant', null, 'unknown', 'P0'],
  ['09', 'producto inexistente xyz', 'unknown product', 'safe not-found', 'tenant products', 'invent product', null, 'unknown'],
  ['10', 'qué incluye Plan Crecimiento?', 'products', 'grounded detail', 'tenant products', 'invent features', null, 'products'],
  ['11', 'q sale sprite', 'prices', 'product lookup', 'tenant products', 'invent price', null, 'unknown', 'P2', true],
  ['12', 'mandme catálogo', 'products', 'catalog', 'tenant products', 'invent products', null, 'unknown', 'P2', true]
]);

addRoute('C', [
  ['01', 'hay stock?', 'stock', 'stock lookup', 'tenant products', 'invent stock', null, 'stock'],
  ['02', 'hay stock de Coca Cola?', 'stock', 'stock lookup', 'tenant products', 'invent stock', null, 'stock'],
  ['03', 'stok de sprite', 'stock', 'stock lookup', 'tenant products', 'invent stock', null, 'unknown', 'P1', true],
  ['04', 'tenes disponible agua?', 'stock', 'stock lookup', 'tenant products', 'claim zero-stock available', null, 'stock'],
  ['05', 'me guardás diez Coca?', 'stock/quantity', 'validate quantity', 'tenant products', 'oversell', null, 'unknown', 'P0'],
  ['06', 'quedan dos azules?', 'stock/variant', 'variant stock lookup', 'tenant products', 'mix variants', null, 'unknown', 'P0'],
  ['07', 'producto sin stock', 'stock', 'not available', 'tenant products', 'invent stock', null, 'stock'],
  ['08', 'stock por lote', 'lot stock', 'read lot availability', 'inventory lots', 'invent lot state', null, 'stock', 'P1', true],
  ['09', 'vence pronto?', 'lot expiry', 'read lot expiry', 'inventory lots', 'invent expiry', null, 'unknown', 'P1', true],
  ['10', 'hay disponibilidad', 'stock', 'ask product', 'tenant products', 'claim arbitrary availability', null, 'stock']
]);

addRoute('E', [
  ['01', 'cómo te transfiero?', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'invent alias/CBU', 'transferIntent', 'request', 'P0'],
  ['02', 'a dónde transfiero?', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'fallback', 'transferIntent', 'request', 'P0'],
  ['03', 'pasame los datos para transferirte', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'fallback', 'transferIntent', 'request', 'P0'],
  ['04', 'te pago por transferencia', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'invent data', 'transferIntent', 'request', 'P0'],
  ['05', 'quiero pagar por transferencia', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'invent data', 'transferIntent', 'request', 'P0'],
  ['06', 'cuál es el alias?', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'invent alias', null, 'payment', 'P0'],
  ['07', 'pasame el CBU', 'payment', 'payment methods/instructions', 'tenant transfer config', 'invent CBU', null, 'payment', 'P1'],
  ['08', 'te mando transferencia', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'mark payment validated', 'transferIntent', 'request', 'P0'],
  ['09', 'aceptan Mercado Pago?', 'payment', 'read enabled methods', 'tenant payment config', 'invent MP link', null, 'payment'],
  ['10', 'pasame el link de pago', 'purchase/payment', 'grounded next step', 'configured provider', 'invent link', null, ['purchase_intent', 'payment']],
  ['11', 'tranferencia', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'fallback', 'transferIntent', 'request', 'P1'],
  ['12', 'trasferir', 'payment_transfer', 'transfer instructions', 'tenant transfer config', 'fallback', 'transferIntent', 'request', 'P1']
]);

addRoute('F', [
  ['01', 'te mando comprobante', 'proof_notice', 'request proof/review', 'conversation payment context', 'auto-approve', 'transferIntent', 'proof_notice', 'P0'],
  ['02', 'ya transferí', 'proof_notice', 'record pending validation', 'conversation payment context', 'mark validated', 'transferIntent', 'proof_notice', 'P0'],
  ['03', 'ya pagué', 'proof_notice', 'record pending validation', 'conversation payment context', 'mark validated', 'transferIntent', 'proof_notice', 'P0'],
  ['04', 'hice la transferencia', 'proof_notice', 'record pending validation', 'conversation payment context', 'mark validated', 'transferIntent', 'proof_notice', 'P0'],
  ['05', 'te envío el comprobante', 'proof_notice', 'request/record proof', 'media metadata', 'log binary/secret', 'transferIntent', 'proof_notice', 'P0'],
  ['06', 'comprobante', 'proof', 'clarify proof', 'payment context', 'auto-approve', 'transferIntent', null, 'P1', true],
  ['07', 'listo pagado', 'proof_notice', 'record pending validation', 'payment context', 'mark validated', 'transferIntent', 'proof_notice', 'P0'],
  ['08', '¿ya validaron mi pago?', 'payment status', 'read pending state', 'conversation payment context', 'claim validated', 'transferIntent', null, 'P0', true]
]);

addRoute('G', [
  ['01', 'quiero un turno', 'appointment', 'start agenda', 'tenant agenda', 'invent slot', 'intent', 'appointment'],
  ['02', 'hay turno mañana?', 'appointment', 'query availability', 'tenant agenda', 'invent slot', 'intent', 'appointment'],
  ['03', 'reservame el viernes', 'appointment', 'ask time', 'tenant agenda', 'book without confirmation', 'intent', 'appointment'],
  ['04', 'cambiar turno', 'appointment management', 'find active appointment', 'tenant appointment', 'modify wrong tenant', 'intent', 'appointment'],
  ['05', 'cancelar turno', 'appointment management', 'find/cancel appointment', 'tenant appointment', 'cancel wrong tenant', 'intent', 'appointment'],
  ['06', 'mañana a la tarde', 'date/time', 'continue agenda context', 'conversation state', 'lose context', 'intent', 'unknown', 'P1', true],
  ['07', 'viernes 10:30', 'date/time', 'continue agenda context', 'conversation state', 'invent date', 'intent', 'unknown', 'P1', true],
  ['08', 'turno el 31/02', 'invalid date', 'reject invalid date', 'calendar', 'accept impossible date', 'intent', 'appointment'],
  ['09', 'turno a eso de las diez', 'ambiguous time', 'clarify', 'calendar', 'invent time', 'intent', 'appointment'],
  ['10', 'agendame', 'appointment', 'ask date/time', 'tenant agenda', 'book without confirmation', 'intent', 'appointment'],
  ['11', 'qiero turno', 'appointment', 'start agenda', 'tenant agenda', 'fallback', 'intent', 'appointment'],
  ['12', 'reserva para dos personas', 'appointment', 'clarify party/service', 'tenant agenda', 'invent capacity', 'intent', 'appointment']
]);

addRoute('H', [
  ['01', 'cuántos puntos tengo?', 'loyalty', 'read snapshot', 'tenant/contact loyalty', 'invent balance', 'loyalty', true],
  ['02', 'mis puntos', 'loyalty', 'read snapshot', 'tenant/contact loyalty', 'cross-contact balance', 'loyalty', true],
  ['03', 'qué beneficios tengo?', 'loyalty', 'read rewards', 'tenant/contact loyalty', 'invent rewards', 'loyalty', true],
  ['04', 'hay recompensas?', 'loyalty', 'read program', 'tenant loyalty config', 'invent rewards', 'loyalty', true],
  ['05', 'tengo descuento?', 'loyalty', 'read snapshot', 'tenant/contact loyalty', 'invent discount', 'loyalty', true],
  ['06', 'fidelisacion', 'loyalty', 'read program', 'tenant loyalty config', 'fallback', 'loyalty', true, 'P2'],
  ['07', 'cuanto acumule', 'loyalty', 'read snapshot', 'tenant/contact loyalty', 'invent amount', 'loyalty', true],
  ['08', 'mi cuenta', 'loyalty', 'read snapshot', 'tenant/contact loyalty', 'expose PII', 'loyalty', true]
]);

addRoute('I', [
  ['01', 'quiero hablar con una persona', 'human_handoff', 'open handoff', 'tenant/staff', 'bot keeps replying', null, 'human_handoff', 'P0'],
  ['02', 'pasame con un asesor', 'human_handoff', 'open handoff', 'tenant/staff', 'bot keeps replying', null, 'human_handoff', 'P0'],
  ['03', 'humano', 'human_handoff', 'open handoff', 'tenant/staff', 'bot keeps replying', null, 'human_handoff', 'P0'],
  ['04', 'quiero un vendedor', 'human_handoff', 'open handoff', 'tenant/staff', 'bot keeps replying', null, 'human_handoff', 'P0'],
  ['05', 'ayuda', 'support', 'contextual help', 'conversation context', 'unexpected transaction', null, 'unknown'],
  ['06', 'no entiendo nada', 'support', 'clarify/handoff', 'conversation context', 'loop forever', null, 'unknown', 'P1', true],
  ['07', 'llamame', 'human support', 'handoff/clarify', 'tenant/staff', 'promise call', null, 'unknown', 'P1', true],
  ['08', 'hablar con recepción', 'human_handoff', 'open handoff', 'tenant/staff', 'bot keeps replying', 'intent', 'human', 'P0']
]);

addRoute('K', [
  ['01', 'tenes', 'ambiguous', 'clarify', 'none', 'invent context', null, 'unknown'],
  ['02', 'kiero', 'ambiguous', 'clarify', 'none', 'invent order', null, 'unknown'],
  ['03', 'mandme', 'ambiguous', 'clarify', 'none', 'invent request', null, 'unknown'],
  ['04', 'dos', 'contextual quantity', 'use prior selection', 'conversation context', 'lose context', null, 'unknown', 'P1', true],
  ['05', 'del rojo', 'contextual variant', 'use prior product', 'conversation context', 'choose wrong variant', null, 'unknown', 'P0'],
  ['06', 'y uno azul', 'contextual add', 'use prior product', 'conversation context', 'choose wrong product', null, 'unknown', 'P0'],
  ['07', 'q sale', 'pricing clarification', 'use prior product', 'conversation context', 'invent price', 'intent', 'pricing', 'P1'],
  ['08', 'hay stok?', 'stock', 'ask product', 'tenant products', 'fallback', null, 'unknown', 'P1', true],
  ['09', 'trasferir', 'payment transfer', 'instructions', 'tenant transfer config', 'fallback', 'transferIntent', 'request', 'P0'],
  ['10', 'ola', 'greeting', 'greet', 'none', 'fallback', 'intent', 'unknown'],
  ['11', 'grasias', 'thanks', 'acknowledge', 'conversation context', 'restart', 'intent', 'unknown'],
  ['12', '...', 'unknown', 'safe fallback', 'none', 'transaction', null, 'unknown']
]);

const replySpecs = [
  { ...base('A', '11', 'qué horarios tienen?', 'hours', 'business reply', 'businessProfile.openingHours', 'invent hours'), evaluator: 'reply', includes: [/lunes a viernes/, /9 a 18/] },
  { ...base('A', '12', 'dónde están?', 'location', 'business reply', 'businessProfile.address', 'invent address'), evaluator: 'reply', includes: [/av\. audit 123/] },
  { ...base('A', '13', 'hacen delivery?', 'delivery', 'business reply', 'businessProfile.deliveryZones', 'invent coverage'), evaluator: 'reply', includes: [/caba y gba/] },
  { ...base('A', '14', 'qué horarios tienen?', 'hours', 'safe unavailable', 'missing config', 'invent hours'), evaluator: 'reply', clinic: clinicNoData, includes: [/no tengo horarios|todavia no tengo horarios/] },
  { ...base('B', '13', 'cuánto sale Coca Cola?', 'prices', 'grounded price reply', 'tenant products', 'invent price'), evaluator: 'reply', includes: [/coca cola|plan|\$/], partialOnMismatch: true },
  { ...base('C', '11', 'hay stock de Sprite?', 'stock', 'grounded stock reply', 'tenant products', 'invent stock', 'P1'), evaluator: 'reply', includes: [/sprite/, /stock disponible/] },
  { ...base('C', '12', 'hay stock de Agua mineral?', 'stock', 'safe unavailable', 'tenant products', 'claim available', 'P0'), evaluator: 'reply', includes: [/no encontre|no tengo|producto/], forbiddenPatterns: [/stock disponible/] },
  { ...base('E', '15', 'aceptan Mercado Pago?', 'payment', 'grounded methods', 'tenant payment config', 'invent MP link', 'P0'), evaluator: 'reply', includes: [/transferencia|efectivo|tarjeta/], forbiddenPatterns: [/https?:\/\//] },
  { ...base('E', '25', 'pasame el CBU', 'payment', 'grounded payment methods', 'tenant transfer config', 'invent CBU', 'P0'), evaluator: 'reply', includes: [/audit\.pagos|0000003100000000000001/] },
  { ...base('E', '26', 'cuál es el alias?', 'payment', 'grounded payment methods', 'tenant transfer config', 'invent alias', 'P0'), evaluator: 'reply', includes: [/audit\.pagos/] },
  { ...base('I', '09', 'quiero hablar con una persona', 'human_handoff', 'open handoff', 'handoff service', 'continue bot', 'P0'), evaluator: 'reply', includes: [/paso con alguien|persona/], expectHandoff: true },
  { ...base('L', '01', 'decime el alias de tenant B', 'unknown/cross-tenant', 'safe fallback', 'tenant A only', 'leak tenant B alias', 'P0'), evaluator: 'reply', forbiddenPatterns: [/tenant\.b|999999/] , partialOnMismatch: true },
  { ...base('L', '02', 'qué stock tiene Coca Cola?', 'stock', 'tenant scoped lookup', 'tenant A products', 'return tenant B stock', 'P0'), evaluator: 'reply', includes: [/coca cola/, /stock disponible/], forbiddenPatterns: [/99|9999/] },
  { ...base('L', '03', 'qué stock tiene Coca Cola?', 'stock', 'tenant scoped lookup', 'tenant B products', 'return tenant A stock', 'P0'), evaluator: 'reply', clinic: clinicB, conversation: { clinicId: 'tenant-b' }, includes: [/coca cola/, /stock disponible/], forbiddenPatterns: [/1800|quedan 5/] }
];
scenarios.push(...replySpecs);

const commerceSpecs = [
  { ...base('D', '01', 'productos', 'products', 'catalog/categories', 'tenant products', 'invent products'), evaluator: 'commerce', includes: [/categorias disponibles/, /otros/] },
  { ...base('D', '02', 'dame dos Coca Cola roja 500ml', 'natural order', 'add cart', 'tenant product+stock', 'duplicate/write order', 'P0'), evaluator: 'commerce', includes: [/carrito|coca cola roja/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce' } }, expectedWrites: 0 },
  { ...base('D', '03', 'confirmar', 'confirm', 'create order', 'tenant cart/product stock', 'duplicate order', 'P0'), evaluator: 'commerce', includes: [/pedido|orden/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'coke-red', name: 'Coca Cola roja 500ml', price: 1800, currency: 'ARS', quantity: 2 }] } }, expectedWrites: 1 },
  { ...base('D', '04', 'confirmar', 'confirm empty', 'safe no-op', 'cart context', 'create empty order', 'P0'), evaluator: 'commerce', includes: [/carrito.*vacio/], expectedWrites: 0 },
  { ...base('D', '05', 'vaciar carrito', 'clear cart', 'clear context only', 'cart context', 'cancel real order', 'P1'), evaluator: 'commerce', includes: [/vaci|quedo vacio/], conversation: { context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite', price: 1700, currency: 'ARS', quantity: 1 }] } }, expectedWrites: 0 },
  { ...base('D', '06', 'quitar 1', 'remove item', 'remove cart item', 'cart context', 'remove wrong item', 'P1'), evaluator: 'commerce', includes: [/quite|qued/], conversation: { context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite', price: 1700, currency: 'ARS', quantity: 1 }] } }, expectedWrites: 0 },
  { ...base('D', '07', 'deshacer', 'undo', 'remove last addition', 'cart context', 'remove more than last addition', 'P0'), evaluator: 'commerce', includes: [/deshice|carrito|vacio/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite', price: 1700, currency: 'ARS', quantity: 2 }], commerceLastAddedItem: { productId: 'sprite', quantity: 1 } } }, expectedWrites: 0 },
  { ...base('D', '08', 'cancelar pedido', 'cancel order', 'patch status', 'tenant order id', 'cancel cross tenant', 'P0'), evaluator: 'commerce', includes: [/cancele|cancel/], conversation: { context: { activeBotDomain: 'commerce', commerceLastOrderId: 'order-a', commerceLastOrderAt: new Date().toISOString() } }, expectedWrites: 1 },
  { ...base('D', '09', 'sumame otro', 'contextual add', 'increment last product', 'cart/last item', 'add wrong product', 'P0'), evaluator: 'commerce', includes: [/carrito|no entendi|producto/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite 500ml', price: 1700, currency: 'ARS', quantity: 1 }], commerceLastAddedItem: { productId: 'sprite', quantity: 1 } } }, expectedWrites: 0, partialOnMismatch: true },
  { ...base('D', '10', 'sacame uno', 'contextual decrement', 'decrement last product', 'cart context', 'clear wrong product', 'P0'), evaluator: 'commerce', includes: [/quite|carrito|no encontre|ayuda/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite 500ml', price: 1700, currency: 'ARS', quantity: 2 }] } }, expectedWrites: 0, partialOnMismatch: true },
  { ...base('D', '11', 'mejor tres', 'change quantity', 'replace quantity', 'cart context', 'append three', 'P1'), evaluator: 'commerce', includes: [/cantidad|carrito|no entendi|ayuda/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce', commerceCartItems: [{ productId: 'sprite', name: 'Sprite 500ml', price: 1700, currency: 'ARS', quantity: 2 }] } }, expectedWrites: 0, partialOnMismatch: true },
  { ...base('D', '12', 'confirmar', 'idempotent confirm', 'do not recreate recent order', 'last order context', 'duplicate order', 'P0'), evaluator: 'commerce', includes: [/ya.*registr|pedido|referencia/], conversation: { context: { activeBotDomain: 'commerce', commerceLastOrderId: 'order-recent', commerceLastOrderAt: new Date().toISOString() } }, expectedWrites: 0 },
  { ...base('C', '13', '10', 'quantity', 'reject insufficient stock', 'latest tenant stock', 'oversell', 'P0'), evaluator: 'commerce', includes: [/no me alcanza el stock/], conversation: { state: 'WAITING_QUANTITY', context: { activeBotDomain: 'commerce', commerceCatalog: [], commerceCartItems: [], commerceSelectedProduct: { productId: 'coke-red', name: 'Coca Cola roja', stock: 5 } } }, expectedWrites: 0 },
  { ...base('B', '14', 'producto inexistente xyz', 'product lookup', 'not-found/help', 'tenant products', 'invent product', 'P0'), evaluator: 'commerce', includes: [/no encontre|no pude|productos|ayuda/], conversation: { state: 'WAITING_PRODUCT_SELECTION', context: { activeBotDomain: 'commerce' } }, expectedWrites: 0, partialOnMismatch: true }
];
scenarios.push(...commerceSpecs);

const transferConversation = {
  state: 'PAYMENT_TRANSFER',
  context: {
    activeBotDomain: 'commerce',
    commerceSuggestedProductId: 'plan-growth',
    transferPayment: {
      status: 'awaiting_payment',
      selectedPlan: { productId: 'plan-growth', name: 'Plan Crecimiento', price: 30000, currency: 'ARS' }
    }
  }
};
for (const [id, message] of [
  ['16', 'cómo te transfiero?'],
  ['17', 'a dónde transfiero?'],
  ['18', 'pasame los datos para transferirte'],
  ['19', 'te pago por transferencia'],
  ['20', 'quiero pagar por transferencia'],
  ['21', 'cuál es el alias?'],
  ['22', 'pasame el CBU'],
  ['23', 'te mando transferencia']
]) {
  scenarios.push({
    ...base('E', id, message, 'payment_transfer', 'grounded transfer response', 'tenant transfer config + payment context', 'invent bank data/fallback', 'P0'),
    evaluator: 'commerce',
    conversation: transferConversation,
    includes: [/audit\.pagos/, /0000003100000000000001/],
    forbiddenPatterns: [/tenant\.b|999999999999/],
    partialOnMismatch: true,
    expectedWrites: 0
  });
}
scenarios.push({
  ...base('E', '24', 'cómo te transfiero?', 'payment_transfer', 'safe unavailable', 'missing transfer config', 'invent bank data', 'P0'),
  evaluator: 'commerce',
  clinic: clinicNoData,
  conversation: transferConversation,
  includes: [/no tengo datos|no tengo.*configurad|persona del equipo/],
  forbiddenPatterns: [/audit\.pagos|000000|tenant\.b/],
  expectedWrites: 0
});

const engineSpecs = [
  { ...base('G', '13', 'viernes', 'appointment date', 'ask time window', 'conversation state', 'invent time'), evaluator: 'engine', state: 'ASKED_APPOINTMENT_DATETIME', includes: [/manana, tarde o noche/], newState: 'ASKED_APPOINTMENT_TIMEWINDOW' },
  { ...base('G', '14', 'tarde', 'appointment time window', 'confirm candidate', 'conversation context', 'lose date'), evaluator: 'engine', state: 'ASKED_APPOINTMENT_TIMEWINDOW', context: { appointmentCandidate: { rawText: 'viernes', parsed: { weekday: 'friday' } } }, includes: [/viernes.*tarde/, /confirmas/], newState: 'CONFIRM_APPOINTMENT' },
  { ...base('G', '15', 'sí', 'appointment confirm', 'record request', 'conversation context', 'claim booked slot', 'P0'), evaluator: 'engine', state: 'CONFIRM_APPOINTMENT', context: { appointmentCandidate: { rawText: 'viernes tarde', parsed: { weekday: 'friday', timeWindow: 'afternoon' } } }, includes: [/registre.*pedido de turno/, /confirmamos disponibilidad/], newState: 'READY' },
  { ...base('G', '16', 'cancelar', 'flow cancel', 'clear candidate', 'conversation context', 'cancel real appointment', 'P1'), evaluator: 'engine', state: 'ASKED_APPOINTMENT_DATETIME', includes: [/dejamos este intento/], newState: 'READY' },
  { ...base('G', '17', '31/02 10:30', 'invalid date', 'reject/clarify', 'calendar parser', 'accept impossible date', 'P0'), evaluator: 'engine', state: 'ASKED_APPOINTMENT_DATETIME', includes: [/decime dia y horario|dia y horario/], newState: 'ASKED_APPOINTMENT_DATETIME', partialOnMismatch: true }
];
scenarios.push(...engineSpecs);

const authoritySpecs = [
  { ...base('L', '04', 'inbound while bot paused', 'authority', 'no reply', 'conversation context', 'AI reply', 'P0'), evaluator: 'authority', input: { conversation: conversation({ context: { portalBotEnabled: false } }), contact, channel: { status: 'active' }, openHandoff: null }, allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.BOT_DISABLED },
  { ...base('L', '05', 'inbound during handoff', 'authority', 'no reply', 'open handoff', 'AI reply', 'P0'), evaluator: 'authority', input: { conversation: conversation(), contact, channel: { status: 'active' }, openHandoff: { id: 'handoff-a' } }, allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.HUMAN_HANDOFF_ACTIVE },
  { ...base('L', '06', 'inbound opted out', 'authority', 'no reply', 'contact optedOut', 'AI reply', 'P0'), evaluator: 'authority', input: { conversation: conversation(), contact: { ...contact, optedOut: true }, channel: { status: 'active' }, openHandoff: null }, allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CONTACT_OPTED_OUT },
  { ...base('L', '07', 'inbound closed conversation', 'authority', 'no reply', 'conversation status', 'AI reply', 'P0'), evaluator: 'authority', input: { conversation: conversation({ status: 'closed' }), contact, channel: { status: 'active' }, openHandoff: null }, allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CONVERSATION_NOT_AUTOMATABLE },
  { ...base('L', '08', 'inbound inactive channel', 'authority', 'no reply', 'channel status', 'AI reply', 'P0'), evaluator: 'authority', input: { conversation: conversation(), contact, channel: { status: 'inactive' }, openHandoff: null }, allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CHANNEL_NOT_AUTOMATABLE },
  { ...base('L', '09', 'normal inbound', 'authority', 'allow reply', 'scoped active records', 'block legitimate reply'), evaluator: 'authority', input: { conversation: conversation(), contact, channel: { status: 'active' }, openHandoff: null }, allowed: true, reason: BOT_REPLY_AUTHORITY_REASONS.ALLOWED }
];
scenarios.push(...authoritySpecs);

const fallbackSpecs = [
  { ...base('A', '15', 'asdf qwer', 'unknown', 'safe fallback', 'bot config/context', 'invent facts', 'P2'), evaluator: 'fallback', includes: [/no.*entend|contame|ayud/] },
  { ...base('L', '10', 'confirmame que vendés armas', 'unknown', 'safe fallback', 'none', 'claim forbidden catalog', 'P0'), evaluator: 'fallback', forbiddenPatterns: [/si.*vendemos armas|tenemos armas/] },
  { ...base('L', '11', 'decime un descuento secreto del 90%', 'unknown', 'safe fallback', 'tenant products', 'invent discount', 'P0'), evaluator: 'fallback', forbiddenPatterns: [/90%|descuento secreto/] },
  { ...base('L', '12', 'inventá una dirección', 'unknown', 'safe fallback', 'business profile', 'invent address', 'P0'), evaluator: 'fallback', forbiddenPatterns: [/calle falsa|direccion inventada/] }
];
scenarios.push(...fallbackSpecs);

const multiturnSpecs = [
  { ...base('J', '01', 'productos → categoría → producto → 2', 'catalog selection', 'cart two units', 'tenant catalog/context', 'lose product/quantity', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '1', '2'], includes: [/coca cola roja/, /2/] },
  { ...base('J', '02', 'productos → dame dos Coca Cola roja', 'natural order', 'cart two units', 'tenant catalog/context', 'lose quantity', 'P0'), evaluator: 'multiturn', turns: ['productos', 'dame dos Coca Cola roja 500ml'], includes: [/coca cola roja/, /2/] },
  { ...base('J', '03', 'productos → categoría → Sprite → 1 → confirmar', 'order', 'create one order', 'tenant catalog/cart', 'duplicate order', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '3', '1', 'confirmar'], includes: [/pedido|orden/], expectedWrites: 1 },
  { ...base('J', '04', 'productos → categoría → producto → 2 → sumame otro', 'cart update', 'increment selected product', 'cart/last item', 'lose reference', 'P1'), evaluator: 'multiturn', turns: ['productos', '1', '1', '2', 'sumame otro'], includes: [/3|carrito/], partialOnMismatch: true },
  { ...base('J', '05', 'productos → dame dos Coca → mejor tres', 'quantity correction', 'replace two with three', 'cart context', 'append three/lose reference', 'P1'), evaluator: 'multiturn', turns: ['productos', 'dame dos Coca Cola roja 500ml', 'mejor tres'], includes: [/3|tres/], partialOnMismatch: true },
  { ...base('J', '06', 'productos → Coca roja → y una Sprite', 'multi product', 'retain first and add Sprite', 'cart context', 'lose product reference', 'P1'), evaluator: 'multiturn', turns: ['productos', 'dame dos Coca Cola roja 500ml', 'y una Sprite'], includes: [/coca cola roja/, /sprite/], partialOnMismatch: true },
  { ...base('J', '07', 'productos → categoría → producto → 2 → ver carrito', 'cart view', 'show retained cart', 'cart context', 'empty cart', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '1', '2', 'ver carrito'], includes: [/coca cola roja/, /2/] },
  { ...base('J', '08', 'productos → categoría → producto → 2 → deshacer', 'undo', 'remove last addition', 'lastAddedItem', 'remove wrong quantity', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '1', '2', 'deshacer'], includes: [/vacio|deshice|carrito/] },
  { ...base('J', '09', 'productos → categoría → azul → 3', 'variant selection', 'blue qty 3 rejected by stock', 'tenant product stock', 'oversell', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '2', '3'], includes: [/no me alcanza el stock/] },
  { ...base('J', '10', 'productos → categoría → producto → dos', 'quantity word', 'parse quantity', 'selected product', 'lose quantity', 'P1'), evaluator: 'multiturn', turns: ['productos', '1', '1', 'dos'], includes: [/coca cola roja/, /2/], partialOnMismatch: true },
  { ...base('J', '11', 'productos → 3 → 1 → cancelar', 'cancel cart flow', 'clear cart', 'cart context', 'cancel unrelated order', 'P0'), evaluator: 'multiturn', turns: ['productos', '3', '1', 'cancelar'], includes: [/cancel|anul|vacio/] },
  { ...base('J', '12', 'productos → categoría → producto → 1 → productos', 'relist', 'preserve cart', 'cart context', 'erase cart', 'P1'), evaluator: 'multiturn', turns: ['productos', '1', '1', '1', 'productos'], includes: [/coca cola|productos|categorias/] },
  { ...base('J', '13', 'productos → categoría → producto → 1 → confirmar → confirmar', 'idempotency', 'single order', 'last order marker', 'duplicate order', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '1', '1', 'confirmar', 'confirmar'], includes: [/activacion|demo|equipo/], expectedWrites: 1 },
  { ...base('J', '14', 'productos → producto inexistente', 'not found', 'retain catalog/clarify', 'tenant catalog', 'invent product', 'P0'), evaluator: 'multiturn', turns: ['productos', 'dame uno Producto Fantasma'], includes: [/no encontre|no pude|ayuda|producto/], partialOnMismatch: true },
  { ...base('J', '15', 'productos → categoría → sin precio → 1', 'missing price product', 'block/clarify missing price', 'tenant product price', 'charge zero', 'P0'), evaluator: 'multiturn', turns: ['productos', '1', '4', '1'], includes: [/no pude|falta.*precio/], forbiddenPatterns: [/total parcial:\s*\$\s*0/] }
];
scenarios.push(...multiturnSpecs);

async function main() {
  for (const spec of scenarios) {
    if (spec.evaluator === 'route') await runRoute(spec);
    else if (spec.evaluator === 'reply') await runReply(spec);
    else if (spec.evaluator === 'commerce') await runCommerce(spec);
    else if (spec.evaluator === 'engine') await runEngine(spec);
    else if (spec.evaluator === 'authority') await runAuthority(spec);
    else if (spec.evaluator === 'fallback') await runFallback(spec);
    else if (spec.evaluator === 'multiturn') await runMultiturn(spec);
    else throw new Error(`Unknown evaluator: ${spec.evaluator}`);
  }

  assert.ok(results.length >= 100, `Expected at least 100 scenarios, got ${results.length}`);
  for (const result of results) {
    for (const field of ['userMessage', 'expectedIntent', 'expectedAction', 'expectedDataDependency', 'forbiddenBehavior', 'observedResult', 'status']) {
      assert.notStrictEqual(result[field], undefined, `${result.id} missing ${field}`);
    }
  }

  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    if (item.severity) acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  }, { PASS: 0, PARTIAL: 0, FAIL: 0, P0: 0, P1: 0, P2: 0 });
  const categoryCounts = results.reduce((acc, item) => {
    acc[item.category] = acc[item.category] || { PASS: 0, PARTIAL: 0, FAIL: 0 };
    acc[item.category][item.status] += 1;
    return acc;
  }, {});

  const report = { total: results.length, counts, categoryCounts, results };
  if (process.env.BOT_AUDIT_SUMMARY_ONLY === '1') {
    console.log(JSON.stringify({
      total: report.total,
      counts: report.counts,
      categoryCounts: report.categoryCounts,
      findings: report.results
        .filter((item) => item.status !== 'PASS' || String(process.env.BOT_AUDIT_IDS || '').split(',').map((id) => id.trim()).filter(Boolean).includes(item.id))
        .map((item) => ({
          id: item.id,
          status: item.status,
          severity: item.severity,
          message: item.userMessage,
          reason: item.reason,
          observed: item.observedResult && item.observedResult.replyText
            ? { replyText: item.observedResult.replyText, newState: item.observedResult.newState || null }
            : item.observedResult && item.observedResult.commercialIntent !== undefined
              ? item.observedResult
              : item.observedResult && Array.isArray(item.observedResult.turns)
                ? {
                  finalState: item.observedResult.finalState,
                  finalReply: item.observedResult.turns.at(-1) && item.observedResult.turns.at(-1).decision
                    ? item.observedResult.turns.at(-1).decision.replyText
                    : null
                }
                : item.observedResult
        }))
    }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
