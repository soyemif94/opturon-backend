const assert = require('assert');
const path = require('path');

const planDescription = 'Plan ideal para negocios que ya venden de forma constante por WhatsApp y necesitan más seguimiento, automatización y orden comercial. Recomendado para: * locales de ropa * calzado * accesorios * venta de celulares * accesorios de teléfono * peluquerías * estética * tattoo studios * gimnasios * negocios con consultas frecuentes por WhatsApp * comercios que hacen seguimiento de clientes Este suele ser el plan más recomendado para negocios que ya tienen movimiento y quieren dejar de perder ventas o consultas. Es ideal cuando: * llegan muchas consultas por WhatsApp; * hace falta responder más rápido; * se pierden clientes por falta de seguimiento; * el dueño no quiere depender todo el tiempo de responder personalmente; * se necesita una operación comercial más ordenada. Incluye automatizaciones más avanzadas, mejor organización comercial, seguimiento de conversaciones y herramientas para automatizar parte de la venta sin perder el trato humano. Ayuda principalmente a: * recuperar ventas perdidas; * responder más rápido; * ordenar clientes y conversaciones; * automatizar consultas repetidas; * mejorar el seguimiento comercial. Suele recomendarse para negocios que ya están creciendo y quieren una operación más profesional sin ir todavía a una estructura empresarial grande.';
const distributorDescription = 'Caja mayorista pensada para comercios con rotación diaria. Incluye unidades surtidas, identificación de lote, fecha de vencimiento visible, recomendaciones de exhibición y condiciones de conservación. La entrega se coordina por zona y la disponibilidad siempre se confirma contra el stock activo del tenant.';
const products = {
  saas: [{ id: 'growth', name: 'Plan Crecimiento', description: planDescription, shortDescription: 'Automatización y seguimiento para negocios en crecimiento.', price: 68600, currency: 'ARS', stock: 20, status: 'active', image: { url: 'https://example.com/growth.jpg' } }],
  distributor: [{ id: 'box', name: 'Caja Mayorista Surtida', description: distributorDescription, price: 24500, currency: 'ARS', stock: 8, status: 'active', image: { url: 'https://example.com/box.jpg' } }]
};
const sentPayloads = [];
const persistedOutbound = [];

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
  insertOutboundMessage: async (message) => { persistedOutbound.push(JSON.parse(JSON.stringify(message))); return { inserted: true }; }
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
  check(`${targetClinic.id} payment context persisted`, Boolean(stored.context.commercialPaymentContext && stored.context.commercialPaymentContext.subjectProductId));
  const paymentStored = persistedConversation(stored.id, stored.clinicId, stored.state, stored.context);
  turn = await persistedTurn(stored, targetClinic, 'Pasame los datos');
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
  const reported = await persistedTurn(persistedConversation('reported', 'saas', 'PAYMENT_TRANSFER', { transferPayment: { status: 'payment_requested', requestedAt: new Date().toISOString() } }), saasClinic, 'ya transferí');
  check(`payment reported requires proof/human validation: ${reported.decision.replyText}`, /comprobante|valid|revis/i.test(reported.decision.replyText));

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
