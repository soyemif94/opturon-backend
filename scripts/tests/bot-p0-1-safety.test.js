const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const runtimeConfigSources = Object.freeze({
  CUSTOMER_CONVERSATION: 'CUSTOMER_CONVERSATION',
  AUTHORIZED_ADMIN_CONFIGURATION: 'AUTHORIZED_ADMIN_CONFIGURATION'
});

function modulePath(relativePath) {
  return path.resolve(root, relativePath);
}

function stubModule(relativePath, exportsValue) {
  const resolved = modulePath(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
}

const sampleProducts = [
  {
    id: 'plan-starter',
    productId: 'plan-starter',
    name: 'Plan Inicial',
    price: 15000,
    currency: 'ARS',
    stock: 10,
    status: 'active',
    sku: 'PLAN-STARTER',
    description: 'Base ordenada para empezar'
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
    description: 'Seguimiento comercial y mas control'
  }
];

const baseClinic = {
  id: 'clinic-1',
  timezone: 'America/Argentina/Buenos_Aires',
  settings: {
    bot: {
      mode: 'sales',
      transferConfig: {
        enabled: true,
        alias: 'OPTURON.PAGOS',
        cbu: '0000003100000000000001',
        holderName: 'Opturon SAS'
      }
    },
    businessProfile: {
      openingHours: 'Lunes a viernes de 9 a 18',
      paymentMethods: 'Transferencia y tarjeta'
    }
  }
};

const state = {
  conversation: null,
  message: null,
  contact: null,
  channel: null,
  clinic: null,
  openHandoff: null,
  aiAssistResult: { ok: false, reason: 'not_configured' },
  sends: [],
  outboundWrites: [],
  stateUpdates: [],
  doneJobs: [],
  requeuedJobs: [],
  authorityLogs: [],
  legacyAuthorityLogs: [],
  handoffOpenCalls: [],
  aiAssistCalls: 0,
  finalLlmCalls: 0,
  finalContextBuilds: 0,
  automationCalls: 0,
  runtimeMutationCalls: 0,
  products: sampleProducts
};

function resetScenario(overrides = {}) {
  state.conversation = {
    id: 'conversation-1',
    clinicId: 'clinic-1',
    channelId: 'channel-1',
    contactId: 'contact-1',
    status: 'open',
    stage: 'new',
    state: 'READY',
    context: { portalBotEnabled: true },
    ...(overrides.conversation || {})
  };
  state.message = {
    id: 'inbound-1',
    conversationId: 'conversation-1',
    direction: 'inbound',
    text: overrides.inboundText || 'Cuanto cuesta el Plan Crecimiento?',
    waMessageId: 'wamid-inbound-1',
    createdAt: new Date().toISOString()
  };
  state.contact = {
    id: 'contact-1',
    clinicId: 'clinic-1',
    waId: '5491111111111',
    phone: '5491111111111',
    name: 'Cliente',
    optedOut: false,
    ...(overrides.contact || {})
  };
  state.channel = {
    id: 'channel-1',
    clinicId: 'clinic-1',
    provider: 'whatsapp_cloud',
    status: 'active',
    phoneNumberId: 'phone-number-id-test',
    accessToken: 'test-token-not-production',
    ...(overrides.channel || {})
  };
  state.clinic = overrides.clinic || baseClinic;
  state.openHandoff = overrides.openHandoff || null;
  state.aiAssistResult = overrides.aiAssistResult || { ok: false, reason: 'not_configured' };
  state.sends = [];
  state.outboundWrites = [];
  state.stateUpdates = [];
  state.doneJobs = [];
  state.requeuedJobs = [];
  state.authorityLogs = [];
  state.legacyAuthorityLogs = [];
  state.handoffOpenCalls = [];
  state.aiAssistCalls = 0;
  state.finalLlmCalls = 0;
  state.finalContextBuilds = 0;
  state.automationCalls = 0;
  state.runtimeMutationCalls = 0;
  state.products = sampleProducts;
}

stubModule('src/config/env.js', {
  workerId: 'p0-1-test-worker',
  workerPollMs: 1000,
  workerBatchSize: 1,
  defaultAppointmentDaysAhead: 7,
  defaultHoldMinutes: 10,
  appointmentReminderLeadMinutes: 30,
  appointmentReminderSweepMs: 60000,
  appointmentReminderClaimTtlMinutes: 10,
  aiEnabled: true,
  openaiApiKey: 'test-key-not-production',
  openaiModel: 'test-model',
  openaiTimeoutMs: 100,
  aiAllowedStates: ['READY'],
  aiDeniedStates: [],
  aiAllowedJobTypes: ['conversation_reply'],
  aiMaxCallsPerConversationWindow: 5,
  aiWindowMs: 3600000,
  aiEnabledClinicIds: [],
  aiDisabledClinicIds: [],
  aiEnabledChannelIds: [],
  aiDisabledChannelIds: [],
  qaAgendaBypassContactIds: [],
  qaAgendaBypassContactWaIds: [],
  qaAgendaBypassChannelIds: []
});

stubModule('src/utils/logger.js', {
  logInfo: (event, data) => {
    if (event === 'conversation_reply_authority_blocked') {
      state.authorityLogs.push(data);
    }
    if (event === 'process_inbound_authority_blocked') {
      state.legacyAuthorityLogs.push(data);
    }
  },
  logWarn: () => {},
  logError: () => {}
});

stubModule('src/db/client.js', {
  pool: {
    connect: async () => ({
      query: async () => ({ rows: [{ locked: true }] }),
      release: () => {}
    })
  },
  withTransaction: async (callback) => callback({ query: async () => ({ rows: [] }) })
});

stubModule('src/repositories/tenant.repository.js', {
  BOT_RUNTIME_CONFIG_MUTATION_SOURCES: runtimeConfigSources,
  findChannelById: async () => state.channel,
  findPreferredWhatsAppChannelByClinicId: async () => state.channel,
  updateClinicBotRuntimeConfigById: async () => {
    state.runtimeMutationCalls += 1;
    return state.clinic;
  }
});

stubModule('src/repositories/contact.repository.js', {
  findContactById: async () => state.contact,
  findContactByIdAndClinicId: async () => state.contact,
  updateContact: async () => state.contact
});

stubModule('src/repositories/conversation.repository.js', {
  findConversationById: async () => state.conversation,
  updateConversationStatus: async (conversationId, status) => {
    state.conversation.status = status;
    return state.conversation;
  },
  updateConversationStage: async (conversationId, stage) => {
    state.conversation.stage = stage;
    return state.conversation;
  }
});

stubModule('src/repositories/message.repository.js', {
  getMessageById: async () => state.message
});

stubModule('src/conversations/conversation.repo.js', {
  getConversationById: async () => state.conversation,
  getMessageById: async () => state.message,
  hasNewerInboundMessage: async () => false,
  listConversationMessagesByClinicId: async () => [],
  findAutomationOutboundByInboundMessageId: async () => null,
  updateConversationState: async (input) => {
    state.stateUpdates.push(input);
    state.conversation.state = input.state || state.conversation.state;
    state.conversation.context = {
      ...(state.conversation.context || {}),
      ...((input && input.contextPatch) || {})
    };
    return input;
  },
  insertOutboundMessage: async (input) => {
    state.outboundWrites.push(input);
    return { inserted: true, row: { id: `outbound-${state.outboundWrites.length}` } };
  },
  getLastMessagesForAi: async () => {
    throw new Error('final LLM context must not be loaded');
  },
  resolveCandidateTiming: () => ({})
});

stubModule('src/repositories/products.repository.js', {
  listProductsByClinicId: async () => state.products,
  findProductById: async (productId) => state.products.find((item) => item.id === productId) || null
});

stubModule('src/services/portal-orders.service.js', {
  createOrderForClinic: async () => ({ ok: true }),
  patchOrderStatusForClinic: async () => ({ ok: true })
});

stubModule('src/repositories/lead.repository.js', {
  upsertLeadForConversation: async () => ({ id: 'lead-1' }),
  updateLeadStatus: async () => ({ id: 'lead-1' }),
  findLeadByConversation: async () => null,
  assignLead: async () => ({ id: 'lead-1' })
});

stubModule('src/repositories/calendar.repository.js', {
  getOrCreateCalendarRules: async () => ({}),
  holdSlot: async () => null,
  bookHeldSlot: async () => null,
  releaseExpiredHolds: async () => 0,
  getClinic: async () => state.clinic,
  findBookedAppointmentByConversation: async () => null,
  cancelAppointment: async () => null
});

stubModule('src/repositories/staff.repository.js', {
  getDefaultAssignee: async () => null
});

stubModule('src/repositories/handoff.repository.js', {
  openHandoff: async (input) => {
    state.handoffOpenCalls.push(input);
    if (state.openHandoff) return state.openHandoff;
    state.openHandoff = {
      id: 'handoff-created',
      status: 'open',
      reason: input.reason
    };
    return state.openHandoff;
  },
  assignHandoff: async () => null,
  getOpenHandoff: async () => state.openHandoff
});

stubModule('src/repositories/conversation-events.repository.js', {
  addEvent: async () => ({ ok: true }),
  findLatestEventByType: async () => null,
  countRecentEventsByType: async () => 0
});

stubModule('src/repositories/job.repository.js', {
  claimJobs: async () => [],
  markJobDone: async (jobId) => {
    state.doneJobs.push(jobId);
  },
  requeueOrFailJob: async (job, error) => {
    state.requeuedJobs.push({ job, error });
    return { status: 'failed' };
  }
});

stubModule('src/whatsapp/whatsapp.service.js', {
  sendChannelScopedMessage: async (payload) => {
    state.sends.push(payload);
    return { messageId: `wamid-outbound-${state.sends.length}`, status: 200, raw: {} };
  }
});

stubModule('src/services/automation-runtime.service.js', {
  resolveAutomationReplyForInbound: async () => {
    state.automationCalls += 1;
    return { replyText: null, contextPatch: null, matched: [], source: 'test' };
  }
});

stubModule('src/services/automation-enablement.service.js', {
  getAutomationEnablementState: async () => ({ enabled: true })
});

stubModule('src/services/ai-assist.service.js', {
  classifyCommerceAiAssist: async () => {
    state.aiAssistCalls += 1;
    return state.aiAssistResult;
  }
});

stubModule('src/ai/openai.client.js', {
  generateReply: async () => {
    state.finalLlmCalls += 1;
    return { replyText: 'HALLUCINATED FINAL RESPONSE' };
  }
});

stubModule('src/ai/context.builder.js', {
  buildAiMessages: () => {
    state.finalContextBuilds += 1;
    return { systemPrompt: 'unsafe', messages: [] };
  }
});

stubModule('src/services/portal-agenda.service.js', {
  suggestClinicAgendaSlots: async () => ({ ok: false }),
  createClinicAgendaBotReservation: async () => ({ ok: false })
});

stubModule('src/services/portal-loyalty.service.js', {
  getLoyaltyWhatsAppSnapshotByClinicId: async () => ({ ok: false })
});

stubModule('src/repositories/agenda-items.repository.js', {
  listDueAgendaReminderCandidates: async () => [],
  claimAgendaItemReminder: async () => null,
  markAgendaItemReminderSent: async () => null,
  releaseAgendaItemReminderClaim: async () => null,
  findLatestActiveAgendaAppointmentByConversation: async () => null,
  updateAgendaItemById: async () => null,
  listAgendaItemsByClinicAndRange: async () => [],
  createAgendaItem: async () => null
});

stubModule('src/services/contact-archive-cleanup.service.js', {
  maybeRunArchivedContactCleanup: async () => ({ skipped: true })
});

const worker = require('../../src/worker.js');
const {
  BOT_REPLY_AUTHORITY_REASONS,
  buildWeakSignalCommercialFallback,
  buildSafeCommercialIntentReply,
  detectCommercialIntent,
  detectIntent,
  parseTransferPaymentIntent,
  processJob,
  resolveBotReplyAuthority,
  resolveCommerceDecision,
  shouldInvokeAiAssist,
  shouldUseWeakSignalCommercialFallback
} = worker.__private__;

function buildJob() {
  return {
    id: `job-${state.message.id}`,
    type: 'conversation_reply',
    clinicId: state.conversation.clinicId,
    channelId: state.channel.id,
    attempts: 0,
    payload: {
      conversationId: state.conversation.id,
      inboundMessageId: state.message.id,
      channelId: state.channel.id,
      contactId: state.contact.id,
      waMessageId: state.message.waMessageId
    }
  };
}

function buildLegacyJob() {
  return {
    id: `legacy-job-${state.message.id}`,
    type: 'PROCESS_INBOUND_MESSAGE',
    clinicId: state.conversation.clinicId,
    channelId: state.channel.id,
    attempts: 0,
    payload: {
      conversationId: state.conversation.id,
      contactId: state.contact.id,
      dbMessageId: state.message.id,
      messageId: state.message.waMessageId
    }
  };
}

async function executeJob() {
  await processJob(buildJob());
  assert.strictEqual(state.requeuedJobs.length, 0, state.requeuedJobs[0] && state.requeuedJobs[0].error.message);
  assert.deepStrictEqual(state.doneJobs, [`job-${state.message.id}`]);
}

function assertBlocked(reason) {
  assert.strictEqual(state.sends.length, 0);
  assert.strictEqual(state.outboundWrites.length, 0);
  assert.strictEqual(state.stateUpdates.length, 0);
  assert.strictEqual(state.aiAssistCalls, 0);
  assert.strictEqual(state.finalLlmCalls, 0);
  assert.strictEqual(state.automationCalls, 0);
  assert.strictEqual(state.authorityLogs.length, 1);
  assert.strictEqual(state.authorityLogs[0].reason, reason);
}

async function run() {
  resetScenario({
    conversation: { context: { portalBotEnabled: false } }
  });
  await executeJob();
  assertBlocked(BOT_REPLY_AUTHORITY_REASONS.BOT_DISABLED);

  resetScenario({
    conversation: { context: { portalBotEnabled: false } }
  });
  await processJob(buildLegacyJob());
  assert.strictEqual(state.requeuedJobs.length, 0);
  assert.deepStrictEqual(state.doneJobs, [`legacy-job-${state.message.id}`]);
  assert.strictEqual(state.sends.length, 0);
  assert.strictEqual(state.legacyAuthorityLogs.length, 1);
  assert.strictEqual(state.legacyAuthorityLogs[0].reason, BOT_REPLY_AUTHORITY_REASONS.BOT_DISABLED);

  resetScenario({
    conversation: { status: 'needs_human', context: { portalBotEnabled: true } },
    openHandoff: { id: 'handoff-1', status: 'open' }
  });
  await executeJob();
  assertBlocked(BOT_REPLY_AUTHORITY_REASONS.HUMAN_HANDOFF_ACTIVE);

  resetScenario({ contact: { optedOut: true } });
  await executeJob();
  assertBlocked(BOT_REPLY_AUTHORITY_REASONS.CONTACT_OPTED_OUT);

  assert.deepStrictEqual(
    resolveBotReplyAuthority({
      conversation: { status: 'closed', context: { portalBotEnabled: true } },
      contact: { optedOut: false },
      channel: { status: 'active' },
      openHandoff: null
    }),
    { allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CONVERSATION_NOT_AUTOMATABLE }
  );
  assert.deepStrictEqual(
    resolveBotReplyAuthority({
      conversation: { status: 'open', context: { portalBotEnabled: true } },
      contact: { optedOut: false },
      channel: { status: 'inactive' },
      openHandoff: null
    }),
    { allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CHANNEL_NOT_AUTOMATABLE }
  );
  assert.deepStrictEqual(
    resolveBotReplyAuthority({
      conversation: { context: { portalBotEnabled: true } },
      contact: { optedOut: false },
      channel: { status: 'active' },
      openHandoff: null
    }),
    { allowed: false, reason: BOT_REPLY_AUTHORITY_REASONS.CONVERSATION_NOT_AUTOMATABLE }
  );

  resetScenario();
  const expectedPricing = await buildSafeCommercialIntentReply({
    clinic: state.clinic,
    conversation: state.conversation,
    inboundText: state.message.text
  });
  await executeJob();
  assert.strictEqual(state.sends.length, 1);
  assert.strictEqual(state.sends[0].text, expectedPricing.replyText);
  assert.strictEqual(state.handoffOpenCalls.length, 0);
  assert.strictEqual(state.finalLlmCalls, 0);
  assert.strictEqual(state.finalContextBuilds, 0);

  const activeRuntimeClinic = {
    ...baseClinic,
    settings: {
      ...baseClinic.settings,
      bot: {
        ...baseClinic.settings.bot,
        runtimeConfig: {
          enabled: true,
          templateKey: 'generated_sales_bot',
          type: 'store',
          businessType: 'comercio',
          offer: 'productos',
          welcomeMessage: 'Hola',
          offerDescription: 'Tenemos productos',
          recommendationMessage: 'Puedo recomendar una opcion',
          closingCta: 'Queres verla?'
        }
      }
    }
  };
  const runtimeEditDecision = await resolveCommerceDecision({
    conversation: state.conversation,
    clinic: activeRuntimeClinic,
    contact: state.contact,
    inboundText: 'm\u00e1s formal'
  });
  assert.match(runtimeEditDecision.replyText, /portal de administraci[oó]n/i);
  assert.doesNotMatch(runtimeEditDecision.replyText, /ya actualice|ya actualic\u00e9/i);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeEditDecision.contextPatch, 'botRuntimeConfig'), false);
  assert.strictEqual(state.runtimeMutationCalls, 0);

  const catalogDecision = await buildSafeCommercialIntentReply({
    clinic: baseClinic,
    conversation: state.conversation,
    inboundText: 'Que planes tienen?'
  });
  const stockDecision = await buildSafeCommercialIntentReply({
    clinic: baseClinic,
    conversation: state.conversation,
    inboundText: 'Hay stock del Plan Crecimiento?'
  });
  const transferDecision = await resolveCommerceDecision({
    conversation: state.conversation,
    clinic: baseClinic,
    contact: state.contact,
    inboundText: 'Cómo te transfiero?'
  });
  assert.match(catalogDecision.replyText, /Plan Inicial|Plan Crecimiento/);
  assert.match(stockDecision.replyText, /stock/i);
  assert.match(transferDecision.replyText, /OPTURON\.PAGOS/);

  const transferRequestPhrases = [
    'cómo te transfiero?',
    'a dónde transfiero?',
    'pasame los datos para transferirte',
    'te pago por transferencia',
    'quiero pagar por transferencia',
    'cuál es el alias?',
    'pasame el CBU',
    'pasame el CVU',
    'me pasás el alias',
    'dame el alias',
    'decime el CBU',
    'mandame el CVU',
    'enviame los datos bancarios',
    'necesito los datos de transferencia',
    'dónde te transfiero',
    'como hago para pagarte',
    'como abono',
    'te puedo transferir',
    'puedo transferirte',
    'aceptan transferencia',
    'puedo pagar por transferencia',
    'lo puedo pagar por transferencia',
    'pagar en transferencia',
    'transferencia',
    'transferecnia',
    'tranferencia',
    'trasferir',
    'datos para transferir',
    'datos de transferencia',
    'cómo hago para transferirte',
    'te quiero transferir',
    'transfiere',
    'transferime',
    'PASAME EL ALIAS',
    '¿CUÁL ES EL CBU?',
    'pasame alias',
    'pasame CBU'
  ];
  for (const phrase of transferRequestPhrases) {
    assert.strictEqual(parseTransferPaymentIntent(phrase), 'request', phrase);
    const decision = await buildSafeCommercialIntentReply({
      clinic: baseClinic,
      conversation: state.conversation,
      inboundText: phrase
    });
    assert.match(decision.replyText, /OPTURON\.PAGOS/, phrase);
    assert.match(decision.replyText, /0000003100000000000001/, phrase);
  }

  for (const phrase of ['quiero pagar', 'avanzar con el pago', 'contratar', 'formas de pago', 'medio de pago']) {
    assert.strictEqual(parseTransferPaymentIntent(phrase), 'request', phrase);
  }

  for (const phrase of ['ya pagué', 'ya transferí', 'hice la transferencia', 'listo pagado', 'listo transferido', 'te mando el comprobante']) {
    assert.strictEqual(parseTransferPaymentIntent(phrase), 'proof_notice', phrase);
  }

  const tenantBClinic = {
    ...baseClinic,
    id: 'clinic-2',
    settings: {
      ...baseClinic.settings,
      bot: {
        ...baseClinic.settings.bot,
        transferConfig: { enabled: true, alias: 'TENANT.B', cbu: '9999999999999999999999' }
      }
    }
  };
  const tenantBDecision = await buildSafeCommercialIntentReply({
    clinic: tenantBClinic,
    conversation: { ...state.conversation, clinicId: 'clinic-2' },
    inboundText: 'pasame el alias'
  });
  assert.match(tenantBDecision.replyText, /TENANT\.B/);
  assert.doesNotMatch(tenantBDecision.replyText, /OPTURON\.PAGOS|0000003100000000000001/);

  const missingTransferDecision = await buildSafeCommercialIntentReply({
    clinic: { ...baseClinic, settings: { ...baseClinic.settings, bot: {} } },
    conversation: state.conversation,
    inboundText: 'pasame el CBU'
  });
  assert.match(missingTransferDecision.replyText, /no tengo datos|no tengo.*configurad|equipo/i);
  assert.doesNotMatch(missingTransferDecision.replyText, /OPTURON\.PAGOS|0000003100000000000001|TENANT\.B/);

  const existingCart = [{
    productId: 'valid-product',
    name: 'Producto válido',
    price: 1250,
    currency: 'ARS',
    quantity: 1
  }];
  let rejectedPriceDecision = null;
  for (const [label, invalidPrice] of [
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['nan', Number.NaN],
    ['text', 'abc'],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative', -1]
  ]) {
    state.products = [{
      id: `invalid-${label}`,
      name: `Producto ${label}`,
      price: invalidPrice,
      currency: 'ARS',
      stock: 5,
      status: 'active'
    }];
    const decision = await resolveCommerceDecision({
      conversation: {
        ...state.conversation,
        state: 'WAITING_QUANTITY',
        context: {
          activeBotDomain: 'commerce',
          commerceCartItems: existingCart,
          commerceCatalog: state.products,
          commerceSelectedProduct: { productId: `invalid-${label}`, name: `Producto ${label}` }
        }
      },
      clinic: baseClinic,
      contact: state.contact,
      inboundText: '1'
    });
    assert.match(decision.replyText, /falta un precio válido/i, label);
    assert.deepStrictEqual(decision.contextPatch.commerceCartItems, existingCart, label);
    assert.doesNotMatch(decision.replyText, /\$\s*0/, label);
    rejectedPriceDecision = decision;
  }

  const preservedCartDecision = await resolveCommerceDecision({
    conversation: {
      ...state.conversation,
      state: rejectedPriceDecision.newState,
      context: { activeBotDomain: 'commerce', ...rejectedPriceDecision.contextPatch }
    },
    clinic: baseClinic,
    contact: state.contact,
    inboundText: 'ver carrito'
  });
  assert.match(preservedCartDecision.replyText, /Producto válido/);
  assert.match(preservedCartDecision.replyText, /1[\.,]?250/);
  assert.doesNotMatch(preservedCartDecision.replyText, /total parcial:\s*\$\s*0/i);

  state.products = [{
    id: 'catalog-missing-price',
    name: 'Producto sin cotización',
    price: null,
    currency: 'ARS',
    stock: 5,
    status: 'active'
  }];
  const catalogEntryDecision = await resolveCommerceDecision({
    conversation: { ...state.conversation, state: 'READY', context: { activeBotDomain: 'commerce' } },
    clinic: baseClinic,
    contact: state.contact,
    inboundText: 'productos'
  });
  const catalogDisplayDecision = await resolveCommerceDecision({
    conversation: {
      ...state.conversation,
      state: catalogEntryDecision.newState,
      context: { activeBotDomain: 'commerce', ...catalogEntryDecision.contextPatch }
    },
    clinic: baseClinic,
    contact: state.contact,
    inboundText: '1'
  });
  assert.match(catalogDisplayDecision.replyText, /Producto sin cotización/);
  assert.match(catalogDisplayDecision.replyText, /precio no disponible/i);
  assert.doesNotMatch(catalogDisplayDecision.replyText, /\$\s*0/);

  const invalidCartConfirmation = await resolveCommerceDecision({
    conversation: {
      ...state.conversation,
      state: 'WAITING_PRODUCT_SELECTION',
      context: {
        activeBotDomain: 'commerce',
        commerceCartItems: [
          ...existingCart,
          { productId: 'catalog-missing-price', name: 'Producto sin cotización', price: null, currency: 'ARS', quantity: 1 }
        ]
      }
    },
    clinic: baseClinic,
    contact: state.contact,
    inboundText: 'confirmar'
  });
  assert.match(invalidCartConfirmation.replyText, /falta un precio válido/i);
  assert.deepStrictEqual(invalidCartConfirmation.contextPatch.commerceCartItems, existingCart);

  for (const explicitZero of [0, '0', '0.00']) {
    state.products = [{
      id: 'free-product',
      name: 'Producto bonificado',
      price: explicitZero,
      currency: 'ARS',
      stock: 5,
      status: 'active'
    }];
    const decision = await resolveCommerceDecision({
      conversation: {
        ...state.conversation,
        state: 'WAITING_QUANTITY',
        context: {
          activeBotDomain: 'commerce',
          commerceCartItems: existingCart,
          commerceCatalog: state.products,
          commerceSelectedProduct: { productId: 'free-product', name: 'Producto bonificado' }
        }
      },
      clinic: baseClinic,
      contact: state.contact,
      inboundText: '1'
    });
    const freeItem = decision.contextPatch.commerceCartItems.find((item) => item.productId === 'free-product');
    assert.ok(freeItem, String(explicitZero));
    assert.strictEqual(freeItem.price, 0, String(explicitZero));
    assert.ok(decision.contextPatch.commerceCartItems.some((item) => item.productId === 'valid-product'));
  }
  state.products = sampleProducts;

  const workerSource = fs.readFileSync(modulePath('src/worker.js'), 'utf8');
  const webhookSource = fs.readFileSync(modulePath('src/controllers/webhook.controller.js'), 'utf8');
  assert.doesNotMatch(workerSource, /require\('\.\/ai\/openai\.client'\)/);
  assert.doesNotMatch(workerSource, /require\('\.\/ai\/context\.builder'\)/);
  assert.match(workerSource, /deterministic_reply_authoritative/);
  assert.doesNotMatch(webhookSource, /sendChannelScopedMessage/);
  assert.match(webhookSource, /reason: 'authoritative_worker_only'/);
  assert.match(webhookSource, /automaticFinalReplyOwner: 'conversation_reply_worker'/);

  const aiAssistInbound = 'Tengo un lubricentro';
  const aiAssistInvocation = shouldInvokeAiAssist({
    botRoute: null,
    intent: detectIntent(aiAssistInbound),
    commercialIntent: detectCommercialIntent(aiAssistInbound),
    transferPaymentIntent: parseTransferPaymentIntent(aiAssistInbound),
    inboundText: aiAssistInbound,
    safeContext: {}
  });
  const aiAssistFailure = {
    ok: false,
    failed: true,
    reason: 'ai_assist_timeout'
  };
  assert.strictEqual(aiAssistInvocation.ok, true);
  assert.strictEqual(shouldUseWeakSignalCommercialFallback(aiAssistInvocation, aiAssistFailure), true);
  const aiAssistFallback = buildWeakSignalCommercialFallback({
    inboundText: aiAssistInbound,
    safeContext: {},
    signal: aiAssistInvocation.signal
  });
  assert.ok(aiAssistFallback);
  assert.doesNotMatch(aiAssistFallback.replyText, /HALLUCINATED/);
  assert.strictEqual(state.finalLlmCalls, 0);

  resetScenario({
    conversation: {
      context: {
        portalBotEnabled: true,
        activeBotDomain: 'commerce'
      }
    },
    inboundText: 'Necesito orientacion adicional',
    aiAssistResult: aiAssistFailure
  });
  await executeJob();
  assert.strictEqual(state.aiAssistCalls, 1);
  assert.strictEqual(state.finalLlmCalls, 0);
  assert.strictEqual(state.sends.length, 1);
  assert.doesNotMatch(String(state.sends[0].text || ''), /HALLUCINATED/);

  const discoveryNow = new Date().toISOString();
  resetScenario({
    conversation: {
      context: {
        portalBotEnabled: true,
        activeBotDomain: 'commerce',
        commercialSalesContext: {
          groundedFacts: {
            businessType: { value: 'local de insumos para trabajos con resina', source: 'STRUCTURED' },
            objective: { value: 'alinear stock tienda online y local fisico', source: 'STRUCTURED' },
            ecommercePlatform: { value: 'empretienda', source: 'EXPLICIT' },
            physicalStoreSystem: { value: 'cianbox', source: 'EXPLICIT' },
            stockSourceOfTruth: { value: 'cianbox', source: 'EXPLICIT' },
            stockUpdateMode: { value: 'manual', source: 'EXPLICIT' },
            systems: [
              { value: 'empretienda', source: 'EXPLICIT' },
              { value: 'cianbox', source: 'EXPLICIT' }
            ]
          },
          updatedAt: discoveryNow
        },
        commercialDiscoveryPending: {
          id: 'commercial_discovery:shared_sku_catalog:test',
          field: 'shared_sku_catalog',
          expectedField: 'shared_sku_catalog',
          evidenceGap: 'shared_sku_catalog',
          askedAt: discoveryNow,
          status: 'pending',
          provenance: 'BOT_ASKED',
          sourceIntent: 'portfolio_discovery',
          meta: {
            questionKind: 'binary',
            affirmativeValue: 'yes',
            negativeValue: 'no'
          }
        }
      }
    },
    inboundText: 'si'
  });
  await executeJob();
  assert.strictEqual(state.handoffOpenCalls.length, 1);
  assert.strictEqual(state.handoffOpenCalls[0].reason, 'capability_verification_required');
  assert.strictEqual(state.openHandoff.reason, 'capability_verification_required');
  assert.strictEqual(state.conversation.status, 'needs_human');
  assert.strictEqual(state.conversation.stage, 'handoff');
  assert.strictEqual(state.sends.length, 1);
  assert.match(state.sends[0].text, /asesor/i);
  assert.doesNotMatch(state.sends[0].text, /Opturon (?:ya )?(?:integra|sincroniza)/i);
  const sufficientStateUpdate = state.stateUpdates.find(
    (item) => item.contextPatch && item.contextPatch.commercialDiscoveryState &&
      item.contextPatch.commercialDiscoveryState.status === 'DISCOVERY_SUFFICIENT'
  );
  assert.ok(sufficientStateUpdate);
  assert.strictEqual(
    sufficientStateUpdate.contextPatch.commercialDiscoveryState.handoffReason,
    'capability_verification_required'
  );

  state.sends = [];
  state.outboundWrites = [];
  state.stateUpdates = [];
  state.doneJobs = [];
  state.requeuedJobs = [];
  state.authorityLogs = [];
  state.aiAssistCalls = 0;
  state.finalLlmCalls = 0;
  state.finalContextBuilds = 0;
  state.automationCalls = 0;
  await executeJob();
  assertBlocked(BOT_REPLY_AUTHORITY_REASONS.HUMAN_HANDOFF_ACTIVE);
  assert.strictEqual(state.handoffOpenCalls.length, 1);

  console.log('BOT.P0.1.SAFETY validation passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
