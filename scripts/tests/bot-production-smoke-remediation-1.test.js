const assert = require('assert');
const path = require('path');

const planDescription = 'Plan ideal para negocios que ya venden de forma constante por WhatsApp y necesitan más seguimiento, automatización y orden comercial. Recomendado para: * locales de ropa * calzado * accesorios * venta de celulares * accesorios de teléfono * peluquerías * estética * tattoo studios * gimnasios * negocios con consultas frecuentes por WhatsApp * comercios que hacen seguimiento de clientes Este suele ser el plan más recomendado para negocios que ya tienen movimiento y quieren dejar de perder ventas o consultas. Es ideal cuando: * llegan muchas consultas por WhatsApp; * hace falta responder más rápido; * se pierden clientes por falta de seguimiento; * el dueño no quiere depender todo el tiempo de responder personalmente; * se necesita una operación comercial más ordenada. Incluye automatizaciones más avanzadas, mejor organización comercial, seguimiento de conversaciones y herramientas para automatizar parte de la venta sin perder el trato humano. Ayuda principalmente a: * recuperar ventas perdidas; * responder más rápido; * ordenar clientes y conversaciones; * automatizar consultas repetidas; * mejorar el seguimiento comercial. Suele recomendarse para negocios que ya están creciendo y quieren una operación más profesional sin ir todavía a una estructura empresarial grande.';
const distributorDescription = 'Caja mayorista pensada para comercios con rotación diaria. Incluye unidades surtidas, identificación de lote, fecha de vencimiento visible, recomendaciones de exhibición y condiciones de conservación. La entrega se coordina por zona y la disponibilidad siempre se confirma contra el stock activo del tenant.';
const products = {
  saas: [{ id: 'growth', name: 'Plan Crecimiento', description: planDescription, shortDescription: 'Automatización y seguimiento para negocios en crecimiento.', price: 68600, currency: 'ARS', stock: 20, status: 'active', image: { url: 'https://example.com/growth.jpg' } }],
  distributor: [
    { id: 'box', name: 'Caja Mayorista Surtida', description: distributorDescription, price: 24500, currency: 'ARS', stock: 8, status: 'active', image: { url: 'https://example.com/box.jpg' } },
    { id: 'jorgito', name: 'Caja de Jorgito', description: 'Caja mayorista de alfajores Jorgito con detalle de presentación y conservación.', price: 31200, currency: 'ARS', stock: 6, status: 'active', image: { url: 'https://example.com/jorgito.jpg' } }
  ]
};
const sentPayloads = [];
const persistedOutbound = [];
const runtimeConversations = new Map();
const runtimeMessages = new Map();
const runtimeClinics = new Map();

function stub(relativePath, value) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: value };
}

stub('src/repositories/products.repository.js', {
  listProductsByClinicId: async (clinicId) => products[clinicId] || [],
  findProductById: async (first, second) => {
    const clinicId = products[first] ? first : second;
    const productId = products[first] ? second : first;
    return (products[clinicId] || []).find((product) => product.id === productId) || null;
  }
});
stub('src/db/client.js', {
  pool: {
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
  },
  withTransaction: async (callback) => callback({ query: async () => ({ rows: [] }) })
});
stub('src/repositories/tenant.repository.js', {
  findChannelById: async (channelId) => ({
    id: channelId,
    clinicId: channelId.replace(/^channel-/, ''),
    provider: 'whatsapp_cloud',
    status: 'active',
    phoneNumberId: `phone-${channelId}`,
    accessToken: 'runtime-test-token'
  }),
  findPreferredWhatsAppChannelByClinicId: async () => null,
  BOT_RUNTIME_CONFIG_MUTATION_SOURCES: {}
});
stub('src/repositories/contact.repository.js', {
  findContactById: async (contactId) => ({ id: contactId, waId: '5491100000000' }),
  findContactByIdAndClinicId: async (contactId) => ({ id: contactId, waId: '5491100000000', optedOut: false }),
  updateContact: async () => null
});
stub('src/repositories/conversation.repository.js', {
  findConversationById: async (conversationId) => runtimeConversations.get(conversationId) || null,
  updateConversationStatus: async () => null,
  updateConversationStage: async (conversationId, stage) => {
    const stored = runtimeConversations.get(conversationId);
    if (stored) stored.stage = stage;
    return stored || null;
  }
});
stub('src/repositories/calendar.repository.js', {
  getOrCreateCalendarRules: async () => null,
  holdSlot: async () => null,
  bookHeldSlot: async () => null,
  releaseExpiredHolds: async () => null,
  getClinic: async (clinicId) => runtimeClinics.get(clinicId) || null,
  findBookedAppointmentByConversation: async () => null,
  cancelAppointment: async () => null
});
stub('src/repositories/handoff.repository.js', {
  openHandoff: async () => null,
  assignHandoff: async () => null,
  getOpenHandoff: async () => null
});
stub('src/repositories/lead.repository.js', {
  upsertLeadForConversation: async ({ conversationId }) => ({ id: `lead-${conversationId}` }),
  updateLeadStatus: async () => null,
  findLeadByConversation: async () => null,
  assignLead: async () => null
});
stub('src/services/ai-assist.service.js', {
  classifyCommerceAiAssist: async () => ({ ok: false, reason: 'runtime_test_low_confidence', decision: null })
});
stub('src/services/portal-orders.service.js', {
  createOrderForClinic: async () => { throw new Error('test must not create orders'); },
  patchOrderStatusForClinic: async () => ({ ok: false, reason: 'not_used' })
});
stub('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }), findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0, countEventsByType: async () => 0,
  countClinicEventsByTypeCurrentMonth: async () => 0
});
stub('src/repositories/agenda-items.repository.js', {
  listAgendaItemsByClinicAndRange: async () => [], findAgendaItemById: async () => null,
  findLatestActiveAgendaAppointmentByConversation: async () => null, listTimedAgendaConflicts: async () => [],
  createAgendaItem: async () => null, updateAgendaItemById: async () => null, deleteAgendaItemById: async () => null,
  listDueAgendaReminderCandidates: async () => [], claimAgendaItemReminder: async () => null,
  markAgendaItemReminderSent: async () => null, releaseAgendaItemReminderClaim: async () => null
});
stub('src/whatsapp/whatsapp.service.js', {
  sendChannelScopedMessage: async (payload) => {
    sentPayloads.push(JSON.parse(JSON.stringify(payload)));
    return { messageId: `wamid-${sentPayloads.length}`, status: 200, raw: {} };
  }
});
stub('src/conversations/conversation.repo.js', {
  getConversationById: async (conversationId) => {
    const stored = runtimeConversations.get(conversationId);
    return stored ? JSON.parse(JSON.stringify(stored)) : null;
  },
  getMessageById: async (messageId) => runtimeMessages.get(messageId) || null,
  hasNewerInboundMessage: async () => false,
  listConversationMessagesByClinicId: async () => [],
  findAutomationOutboundByInboundMessageId: async () => null,
  updateConversationState: async ({ conversationId, state, contextPatch }) => {
    const stored = runtimeConversations.get(conversationId);
    assert.ok(stored, `runtime conversation ${conversationId} missing`);
    stored.state = state || stored.state;
    stored.context = { ...(stored.context || {}), ...(contextPatch || {}) };
    return JSON.parse(JSON.stringify(stored));
  },
  insertOutboundMessage: async (message) => {
    persistedOutbound.push(JSON.parse(JSON.stringify(message)));
    return { inserted: true };
  },
  resolveCandidateTiming: () => null
});
stub('src/utils/logger.js', { logInfo: () => {}, logWarn: () => {}, logError: () => {} });

const { __private__: worker } = require('../../src/worker');
const contact = { id: 'qa', name: 'QA', waId: '5491100000000' };
let passed = 0;
const check = (label, condition) => { assert.ok(condition, label); passed += 1; };

function clinic(id, methods, alias, enabled = true) {
  return { id, settings: { businessProfile: { paymentMethods: methods }, bot: { transferConfig: { enabled, alias, cbu: enabled ? `${id === 'saas' ? '1' : '2'}`.repeat(22) : '' } } } };
}

function persistedConversation(id, clinicId, state = 'READY', context = { activeBotDomain: 'commerce' }) {
  return JSON.parse(JSON.stringify({ id, clinicId, state, context }));
}

async function persistedTurn(stored, targetClinic, inboundText) {
  const loaded = persistedConversation(stored.id, stored.clinicId, stored.state, stored.context);
  const decision = await worker.resolveCommerceDecision({ conversation: loaded, clinic: targetClinic, contact, inboundText });
  assert.ok(decision, `missing decision for ${inboundText}`);
  const next = persistedConversation(loaded.id, loaded.clinicId, decision.newState || loaded.state, { ...loaded.context, ...(decision.contextPatch || {}) });
  return { decision, next };
}

function resolveRoute(stored, targetClinic, inboundText) {
  const commercialIntent = worker.detectCommercialIntent(inboundText);
  return worker.resolveBotDomainRoute({
    clinic: targetClinic,
    currentState: String(stored.state || '').toUpperCase(),
    safeContext: stored.context || {},
    inboundText,
    intent: worker.detectIntent(inboundText),
    commercialIntentType: commercialIntent.type,
    transferPaymentIntent: worker.parseTransferPaymentIntent(inboundText),
    managementIntent: null,
    inboundLooksLikeCommerce: worker.isCommerceEntryIntent(inboundText),
    inboundLooksLikeCommerceCancel: false
  });
}

async function routedPersistedTurn(stored, targetClinic, inboundText) {
  const route = resolveRoute(stored, targetClinic, inboundText);
  assert.strictEqual(route.domain, 'commerce', `router did not preserve commerce for ${inboundText}`);
  assert.strictEqual(route.allowCommerce, true, `router blocked commerce for ${inboundText}`);
  return persistedTurn(stored, targetClinic, inboundText);
}

async function withFakeNow(iso, callback) {
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [iso]));
    }

    static now() {
      return RealDate.parse(iso);
    }
  }

  global.Date = FakeDate;
  try {
    return await callback();
  } finally {
    global.Date = RealDate;
  }
}

async function fullRuntimeTurn(stored, targetClinic, inboundText, sequence) {
  const conversationId = stored.id;
  const messageId = `${conversationId}-inbound-${sequence}`;
  const channelId = `channel-${targetClinic.id}`;
  runtimeClinics.set(targetClinic.id, targetClinic);
  runtimeConversations.set(conversationId, JSON.parse(JSON.stringify({
    ...stored,
    contactId: `contact-${targetClinic.id}`,
    channelId,
    status: 'open'
  })));
  runtimeMessages.set(messageId, { id: messageId, conversationId, type: 'text', text: inboundText });
  const outboundStart = persistedOutbound.length;

  await worker.processConversationReplyJob({
    id: `job-${sequence}`,
    clinicId: targetClinic.id,
    channelId,
    attempts: 0,
    payload: {
      conversationId,
      inboundMessageId: messageId,
      channelId,
      contactId: `contact-${targetClinic.id}`,
      waMessageId: `wamid-inbound-${sequence}`
    }
  });

  const outbound = persistedOutbound.slice(outboundStart);
  assert.ok(outbound.length, `full runtime produced no outbound for ${inboundText}`);
  return {
    next: JSON.parse(JSON.stringify(runtimeConversations.get(conversationId))),
    outbound,
    replyText: outbound.map((message) => message.text || '').join('\n'),
    source: outbound[outbound.length - 1].raw && outbound[outbound.length - 1].raw.automation
      ? outbound[outbound.length - 1].raw.automation.source
      : null
  };
}

async function runPaymentSequence(targetClinic, entityName, expectedMethod, expectedAlias) {
  let stored = persistedConversation(`conv-${targetClinic.id}`, targetClinic.id);
  let turn = await persistedTurn(stored, targetClinic, `dame más detalles de ${entityName}`);
  stored = turn.next;
  turn = await persistedTurn(stored, targetClinic, 'me interesa');
  stored = turn.next;
  check(`${targetClinic.id} referent survives interest: ${turn.decision.replyText}; context=${JSON.stringify(stored.context)}`, turn.decision.replyText.includes(entityName));
  turn = await persistedTurn(stored, targetClinic, '¿cómo lo pago?');
  stored = turn.next;
  check(`${targetClinic.id} methods are direct and tenant scoped`, turn.decision.replyText.includes(expectedMethod));
  check(`${targetClinic.id} configured transfer data is direct`, turn.decision.replyText.includes(expectedAlias));
  check(`${targetClinic.id} payment context persisted`, Boolean(stored.context.commercialPaymentContext && stored.context.commercialPaymentContext.subjectProductId));
  const paymentStored = persistedConversation(stored.id, stored.clinicId, stored.state, stored.context);
  turn = await routedPersistedTurn(stored, targetClinic, 'Pasame los datos');
  check(`${targetClinic.id} contextual data resolves after reload`, turn.decision.replyText.includes(expectedAlias));
  return { replyText: turn.decision.replyText, paymentStored };
}

async function main() {
  const caption = worker.buildCatalogProductImageCaption(products.saas[0]);
  check('caption stays within provider-safe limit', caption.length <= 1024);
  check('caption uses configured short description', caption.includes(products.saas[0].shortDescription));
  check('caption does not duplicate full detail', !caption.includes('Suele recomendarse'));
  const detail = worker.buildCatalogItemDetailReply(products.saas[0]);
  check('exact Plan Crecimiento detail is complete', detail.includes(planDescription));
  check('detail has no silent three-dot truncation', !detail.endsWith('...'));
  const distributorDetail = worker.buildCatalogItemDetailReply(products.distributor[0]);
  check('distributor detail is complete', distributorDetail.includes(distributorDescription));

  const longText = Array.from({ length: 90 }, (_, index) => `Párrafo ${index + 1}: contenido comercial completo con palabras indivisibles y una oración lógica.`).join('\n');
  const chunks = worker.splitWhatsAppTextChunks(longText);
  check('long text is chunked', chunks.length > 1);
  check('every chunk respects text limit', chunks.every((chunk) => chunk.length <= 4096));
  check('chunking loses no normalized content', chunks.join('\n') === longText);
  check('chunking is deterministic', JSON.stringify(chunks) === JSON.stringify(worker.splitWhatsAppTextChunks(longText)));

  const saasClinic = clinic('saas', 'Transferencia SaaS y tarjeta', 'SAAS.A');
  const distClinic = clinic('distributor', 'Transferencia Distribuidora', 'DIST.B');
  const saasResult = await runPaymentSequence(saasClinic, 'Plan Crecimiento', 'Transferencia SaaS', 'SAAS.A');
  const distResult = await runPaymentSequence(distClinic, 'Caja Mayorista Surtida', 'Transferencia Distribuidora', 'DIST.B');
  check('tenant A/B banking data does not leak', !saasResult.replyText.includes('DIST.B') && !distResult.replyText.includes('SAAS.A'));

  const paymentTtlMs = worker.COMMERCIAL_PAYMENT_CONTEXT_TTL_MS;
  check('payment context TTL is 30 minutes', paymentTtlMs === 30 * 60 * 1000);
  const boundaryBaseMs = Date.parse('2026-08-24T05:04:43.681Z');
  const boundaryContext = {
    commercialPaymentContext: {
      activeAt: new Date(boundaryBaseMs).toISOString(),
      status: 'methods_presented',
      subjectProductId: 'growth',
      subjectName: 'Plan Crecimiento'
    }
  };
  const activeOffsets = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000, paymentTtlMs - 1];
  for (const offsetMs of activeOffsets) {
    await withFakeNow(new Date(boundaryBaseMs + offsetMs).toISOString(), async () => {
      check(`payment context active at +${offsetMs}ms`, Boolean(worker.getActiveCommercialPaymentContext(boundaryContext)));
      const route = resolveRoute(persistedConversation(`boundary-${offsetMs}`, 'saas', 'READY', boundaryContext), saasClinic, 'Pasame los datos');
      check(`payment follow-up routes to commerce at +${offsetMs}ms`, route.domain === 'commerce' && route.allowCommerce === true);
    });
  }
  await withFakeNow(new Date(boundaryBaseMs + 5 * 60 * 1000).toISOString(), async () => {
    const changedDomainContext = { ...boundaryContext, botDomainOverride: 'agenda' };
    const changedDomainRoute = resolveRoute(
      persistedConversation('changed-domain', 'saas', 'READY', changedDomainContext),
      saasClinic,
      'Pasame los datos'
    );
    check('explicit agenda domain change blocks transfer-data continuation', changedDomainRoute.domain === 'agenda' && changedDomainRoute.allowCommerce === false);
  });
  await withFakeNow(new Date(boundaryBaseMs + paymentTtlMs + 1).toISOString(), async () => {
    check('payment context expires just after boundary', worker.getActiveCommercialPaymentContext(boundaryContext) === null);
    const expiredStored = persistedConversation('expired', 'saas', 'READY', boundaryContext);
    check('expired vague follow-up fails closed at router', resolveRoute(expiredStored, saasClinic, 'Pasame los datos').domain === 'neutral');
    const expiredDecision = await persistedTurn(expiredStored, saasClinic, 'Pasame los datos');
    check('expired vague follow-up does not reveal banking data', !expiredDecision.decision.replyText.includes('SAAS.A'));
  });

  const realSequenceBaseMs = Date.parse('2026-08-24T06:00:00.000Z');
  let delayedStored = persistedConversation('five-minute-real-sequence', 'saas');
  await withFakeNow(new Date(realSequenceBaseMs).toISOString(), async () => {
    delayedStored = (await persistedTurn(delayedStored, saasClinic, 'dame más detalles de Plan Crecimiento')).next;
  });
  await withFakeNow(new Date(realSequenceBaseMs + 5 * 60 * 1000).toISOString(), async () => {
    delayedStored = (await persistedTurn(delayedStored, saasClinic, 'me interesa')).next;
  });
  const paymentTurnMs = realSequenceBaseMs + 10 * 60 * 1000;
  await withFakeNow(new Date(paymentTurnMs).toISOString(), async () => {
    const paymentTurn = await persistedTurn(delayedStored, saasClinic, '¿cómo lo pago?');
    delayedStored = paymentTurn.next;
    check('payment turn refreshes timestamp at T2', delayedStored.context.commercialPaymentContext.activeAt === new Date(paymentTurnMs).toISOString());
  });
  await withFakeNow(new Date(paymentTurnMs + 5 * 60 * 1000).toISOString(), async () => {
    const delayedFollowUp = await routedPersistedTurn(delayedStored, saasClinic, 'Pasame los datos');
    check('real persisted/reloaded +5m follow-up returns tenant data', delayedFollowUp.decision.replyText.includes('SAAS.A'));
    check('real persisted/reloaded +5m follow-up avoids fallback', !/No llegué a entenderte|planes, pagos/i.test(delayedFollowUp.decision.replyText));
  });

  let exactRuntimeStored = persistedConversation('exact-full-runtime-saas', 'saas', 'NEW', {});
  await withFakeNow(new Date(realSequenceBaseMs).toISOString(), async () => {
    const selected = await fullRuntimeTurn(exactRuntimeStored, saasClinic, 'Dame más detalles del Plan Crecimiento', 'exact-select');
    exactRuntimeStored = selected.next;
    check('exact runtime turn 1 selects Plan Crecimiento', Boolean(
      exactRuntimeStored.context.commercialShortMemory || exactRuntimeStored.context.commercialPlanContext
    ));
  });
  const exactPaymentTurnMs = realSequenceBaseMs + 60 * 1000;
  await withFakeNow(new Date(exactPaymentTurnMs).toISOString(), async () => {
    const payment = await fullRuntimeTurn(exactRuntimeStored, saasClinic, '¿Cómo lo pago?', 'exact-payment');
    exactRuntimeStored = payment.next;
    check('exact runtime turn 2 delivers tenant payment data', payment.replyText.includes('SAAS.A'));
    check('exact runtime turn 2 persists payment context', Boolean(exactRuntimeStored.context.commercialPaymentContext));
    check('exact runtime payment context anchors at turn 2', exactRuntimeStored.context.commercialPaymentContext.activeAt === new Date(exactPaymentTurnMs).toISOString());
  });
  await withFakeNow(new Date(exactPaymentTurnMs + 5 * 60 * 1000).toISOString(), async () => {
    const repeated = await fullRuntimeTurn(exactRuntimeStored, saasClinic, 'Pasame los datos', 'exact-repeat-plus-5m');
    exactRuntimeStored = repeated.next;
    check('exact runtime reload +5m repeats payment data', repeated.replyText.includes('SAAS.A'));
    check('exact runtime reload +5m has zero fallback', repeated.source === 'commerce');
  });
  await withFakeNow(new Date(exactPaymentTurnMs + 7 * 60 * 1000).toISOString(), async () => {
    const repeatedAgain = await fullRuntimeTurn(exactRuntimeStored, saasClinic, 'Mandamelos de nuevo', 'exact-repeat-plus-7m');
    exactRuntimeStored = repeatedAgain.next;
    check('exact runtime second repeat +2m returns data', repeatedAgain.replyText.includes('SAAS.A'));
    check('exact runtime second repeat keeps original expiry anchor', exactRuntimeStored.context.commercialPaymentContext.activeAt === new Date(exactPaymentTurnMs).toISOString());
  });

  const runtimePaymentContext = {
    commercialPaymentContext: {
      activeAt: new Date(paymentTurnMs).toISOString(),
      status: 'methods_presented',
      subjectProductId: 'growth',
      subjectName: 'Plan Crecimiento'
    },
    activeBotDomain: null
  };
  let runtimeStored = persistedConversation('full-runtime-saas', 'saas', 'NEW', runtimePaymentContext);
  await withFakeNow(new Date(paymentTurnMs + 5 * 60 * 1000).toISOString(), async () => {
    const result = await fullRuntimeTurn(runtimeStored, saasClinic, 'Pasame los datos', 'saas-plus-5m');
    runtimeStored = result.next;
    check('full runtime +5m reaches commerce instead of intelligent fallback', result.source === 'commerce');
    check('full runtime +5m returns tenant transfer data', result.replyText.includes('SAAS.A'));
    check('full runtime repeat keeps NEW/READY state', ['NEW', 'READY'].includes(runtimeStored.state));
    check('full runtime repeat does not create transferPayment', !runtimeStored.context.transferPayment);
    check('full runtime repeat preserves original TTL anchor', runtimeStored.context.commercialPaymentContext.activeAt === new Date(paymentTurnMs).toISOString());
  });
  await withFakeNow(new Date(paymentTurnMs + 7 * 60 * 1000).toISOString(), async () => {
    const result = await fullRuntimeTurn(runtimeStored, saasClinic, 'Mandamelos de nuevo', 'saas-plus-7m');
    runtimeStored = result.next;
    check('full runtime second repeat +2m reaches commerce', result.source === 'commerce');
    check('full runtime second repeat returns data again', result.replyText.includes('SAAS.A'));
    check('second repeat still does not create payment state', !runtimeStored.context.transferPayment && ['NEW', 'READY'].includes(runtimeStored.state));
    check('second repeat does not refresh TTL', runtimeStored.context.commercialPaymentContext.activeAt === new Date(paymentTurnMs).toISOString());
  });
  await withFakeNow(new Date(paymentTurnMs + paymentTtlMs + 1).toISOString(), async () => {
    const result = await fullRuntimeTurn(runtimeStored, saasClinic, 'Pasame los datos', 'saas-expired');
    check('full runtime expired repeat fails closed', !result.replyText.includes('SAAS.A'));
    check('full runtime expired repeat uses clarification fallback', result.source === 'intelligent_fallback');
  });

  const distributorRuntimeStored = persistedConversation('full-runtime-distributor', 'distributor', 'READY', {
    commercialPaymentContext: {
      activeAt: new Date(paymentTurnMs).toISOString(),
      status: 'methods_presented',
      subjectProductId: 'box',
      subjectName: 'Caja Mayorista Surtida'
    },
    activeBotDomain: null
  });
  await withFakeNow(new Date(paymentTurnMs + 5 * 60 * 1000).toISOString(), async () => {
    const result = await fullRuntimeTurn(distributorRuntimeStored, distClinic, 'Pasame los datos', 'dist-plus-5m');
    check('full runtime distributor uses tenant B data', result.replyText.includes('DIST.B'));
    check('full runtime distributor does not leak tenant A data', !result.replyText.includes('SAAS.A'));
  });
  for (const followUp of ['mandame los datos', 'pasamelos', 'dale, pasamelos', 'mandamelos', 'por transferencia', 'transferencia', 'el alias', 'el cbu']) {
    const resolved = await persistedTurn(saasResult.paymentStored, saasClinic, followUp);
    check(`payment follow-up resolves: ${followUp}`, resolved.decision.replyText.includes('SAAS.A'));
  }

  const noContext = await persistedTurn(persistedConversation('ambiguous', 'saas'), saasClinic, 'pasame los datos');
  check('vague data request without payment context asks clarification', !noContext.decision.replyText.includes('SAAS.A'));
  const missingConfigClinic = clinic('saas', 'Transferencia', 'SAAS.A', false);
  let missingStored = persistedConversation('missing', 'saas');
  for (const text of ['dame más detalles de Plan Crecimiento', 'me interesa', '¿cómo lo pago?']) {
    const result = await persistedTurn(missingStored, missingConfigClinic, text); missingStored = result.next;
  }
  const missing = await persistedTurn(missingStored, missingConfigClinic, 'pasame los datos');
  check('missing bank config fails closed', !/SAAS\.A|1{22}/.test(missing.decision.replyText));
  const reported = await persistedTurn(persistedConversation('reported', 'saas', 'PAYMENT_TRANSFER', {
    transferPayment: { status: 'payment_requested', requestedAt: new Date().toISOString() },
    commercialPaymentContext: saasResult.paymentStored.context.commercialPaymentContext
  }), saasClinic, 'ya transferí');
  check(`payment reported requires proof/human validation: ${reported.decision.replyText}`, /comprobante|valid|revis/i.test(reported.decision.replyText));
  check('payment reported invalidates short-lived banking disclosure context', reported.next.context.commercialPaymentContext === null);
  const cancelled = await persistedTurn(saasResult.paymentStored, saasClinic, 'cancelar');
  check('explicit commerce cancellation invalidates payment context', cancelled.next.context.commercialPaymentContext === null);

  const exactCompound = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('compound-exact', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa Crecimiento, ¿me das más detalles?'
  });
  check('exact compound smoke resolves Plan Crecimiento detail', exactCompound.replyText.includes(planDescription));
  check('exact compound smoke prioritizes detail over activation', !/activar|avanzar con la activaci[oó]n|completar el pago/i.test(exactCompound.replyText));
  check('compound detail persists interest signal', exactCompound.contextPatch.commercialInterest === true);
  check('compound detail persists selected referent', exactCompound.contextPatch.commercialInterestProductId === 'growth');
  check('compound detail preserves media contract', exactCompound.outboundMedia.length === 1 && exactCompound.sendTextWithMedia === true);

  const exactCompoundRuntime = await fullRuntimeTurn(
    persistedConversation('compound-exact-runtime', 'saas', 'READY', {}),
    saasClinic,
    'Me interesa Crecimiento, ¿me das más detalles?',
    'compound-exact-runtime'
  );
  check('exact compound traverses full worker runtime', exactCompoundRuntime.source === 'safe_commercial_reply');
  check('full runtime compound returns full detail', exactCompoundRuntime.replyText.includes(planDescription));
  check('full runtime compound persists interest and referent', exactCompoundRuntime.next.context.commercialInterest === true && exactCompoundRuntime.next.context.commercialInterestProductId === 'growth');

  const compoundStored = persistedConversation('compound-next-turn', 'saas', 'READY', exactCompound.contextPatch);
  const compoundAdvance = await persistedTurn(compoundStored, saasClinic, 'dale, avancemos');
  check('compound detail allows natural next-turn advance', compoundAdvance.decision.replyText.includes('Plan Crecimiento'));
  const compoundPayment = await persistedTurn(compoundStored, saasClinic, '¿cómo lo pago?');
  check('compound referent survives into next-turn payment', compoundPayment.decision.replyText.includes('Plan Crecimiento'));
  check('compound next-turn payment opens same referent context', compoundPayment.next.context.commercialPaymentContext.subjectProductId === 'growth');
  for (const contextualDetailText of [
    'me interesa, contame más',
    'me gusta, dame más detalles',
    'quiero ese, pero explicame mejor',
    'me interesa, ¿cómo funciona?'
  ]) {
    const contextualDetail = await worker.buildSafeCommercialIntentReply({
      clinic: saasClinic,
      conversation: compoundStored,
      contact,
      inboundText: contextualDetailText
    });
    assert.ok(contextualDetail, `missing contextual compound decision: ${contextualDetailText}`);
    check(`contextual compound detail resolves: ${contextualDetailText}`, contextualDetail.replyText.includes(planDescription));
    check(`contextual compound detail keeps interest: ${contextualDetailText}`, contextualDetail.contextPatch.commercialInterest === true);
  }

  const compoundPrice = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('compound-price', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa Crecimiento, ¿cuánto sale?'
  });
  check('interest + price answers grounded selected price', compoundPrice.replyText.includes('68.600'));
  check('interest + price persists selected referent', compoundPrice.contextPatch.commercialInterestProductId === 'growth');

  const compoundStock = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('compound-stock', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa Crecimiento, ¿hay stock?'
  });
  check('interest + stock answers stock instead of activation', /stock|disponib/i.test(compoundStock.replyText) && !/activar/i.test(compoundStock.replyText));
  check('interest + stock persists selected referent', compoundStock.contextPatch.commercialInterestProductId === 'growth');

  const compoundDelivery = await worker.buildSafeCommercialIntentReply({
    clinic: distClinic,
    conversation: persistedConversation('compound-delivery', 'distributor', 'READY', {}),
    contact,
    inboundText: 'Me interesa la Caja de Jorgito, ¿hacen envíos?'
  });
  check('interest + delivery prioritizes delivery answer', /env[ií]os|confirmado/i.test(compoundDelivery.replyText) && !/activar/i.test(compoundDelivery.replyText));
  check('interest + delivery persists tenant referent', compoundDelivery.contextPatch.commercialInterestProductId === 'jorgito');

  const compoundPaymentDirect = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('compound-payment', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa Crecimiento, ¿cómo lo pago?'
  });
  check('interest + payment resolves enabled methods', compoundPaymentDirect.replyText.includes('Transferencia SaaS'));
  check('interest + payment preserves referent', compoundPaymentDirect.contextPatch.commercialPaymentContext.subjectProductId === 'growth');

  const interestOnly = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('interest-only', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa Crecimiento'
  });
  check('interest-only keeps existing activation behavior', /activar|avanzar|pago/i.test(interestOnly.replyText));

  const ambiguousCompound = await worker.buildSafeCommercialIntentReply({
    clinic: saasClinic,
    conversation: persistedConversation('compound-ambiguous', 'saas', 'READY', {}),
    contact,
    inboundText: 'Me interesa uno, dame más detalles'
  });
  check('ambiguous compound referent asks clarification', /de qu[eé] plan o producto/i.test(ambiguousCompound.replyText));
  check('ambiguous compound does not invent referent', ambiguousCompound.contextPatch.commercialInterestProductId === null);
  products['multi-plan'] = [
    { id: 'initial', name: 'Plan Inicial', description: 'Plan inicial de prueba.', price: 25000, currency: 'ARS', stock: 10, status: 'active' },
    products.saas[0]
  ];
  const multiMatchCompound = await worker.buildSafeCommercialIntentReply({
    clinic: {
      ...saasClinic,
      id: 'multi-plan'
    },
    conversation: persistedConversation('compound-multi-match', 'multi-plan', 'READY', {}),
    contact,
    inboundText: 'Me interesa Inicial o Crecimiento, dame más detalles'
  });
  check('multiple named referents ask clarification', /de cu[aá]l/i.test(multiMatchCompound.replyText));

  const distributorCompound = await worker.buildSafeCommercialIntentReply({
    clinic: distClinic,
    conversation: persistedConversation('compound-distributor', 'distributor', 'READY', {}),
    contact,
    inboundText: 'Me interesa la caja de Jorgito, contame más'
  });
  check('distributor compound resolves its tenant entity', distributorCompound.replyText.includes('Caja mayorista de alfajores Jorgito'));
  check('distributor compound persists its tenant referent', distributorCompound.contextPatch.commercialInterestProductId === 'jorgito');
  check('compound cross-tenant detail has zero SaaS leakage', !distributorCompound.replyText.includes('Plan Crecimiento') && !exactCompound.replyText.includes('Jorgito'));

  const mediaDecision = await worker.buildSafeCommercialIntentReply({ clinic: saasClinic, conversation: persistedConversation('media', 'saas'), contact, inboundText: 'más detalles de Plan Crecimiento' });
  check('media detail sends image before full text contract', mediaDecision.outboundMedia.length === 1 && mediaDecision.sendTextWithMedia === true);
  check('media decision preserves referent context', Boolean(mediaDecision.contextPatch.commercialShortMemory || mediaDecision.contextPatch.commercialPlanContext));
  sentPayloads.length = 0;
  persistedOutbound.length = 0;
  await worker.sendAndPersistReply({
    clinicId: 'saas',
    channel: { id: 'channel-a', clinicId: 'saas', accessToken: 'test-only', phoneNumberId: 'phone-a', provider: 'whatsapp_cloud', status: 'active' },
    conversationId: 'media', contact, text: mediaDecision.replyText, requestId: 'qa-order',
    outboundMedia: mediaDecision.outboundMedia, sendTextWithMedia: mediaDecision.sendTextWithMedia
  });
  check('delivery order is image then full text', sentPayloads.length === 2 && Boolean(sentPayloads[0].image) && sentPayloads[1].text.includes(planDescription));
  check('image and full text are both persisted', persistedOutbound.length === 2 && persistedOutbound[0].type === 'image' && persistedOutbound[1].text.includes(planDescription));
  console.log(JSON.stringify({ passed, verdict: 'PASS' }));
}

main().catch((error) => { console.error(error); process.exit(1); });
