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
  CAPABILITY_STATUSES,
  buildTenantCapabilitySnapshot,
  resolveCapability,
  buildSafeCapabilityReply
} = require('../../src/services/capability-resolver.service');
const {
  buildHandoffSummary,
  sanitizeHandoffSummary,
  getOwnedHandoffSummary
} = require('../../src/services/handoff-summary.service');
const { openHandoff } = require('../../src/repositories/handoff.repository');
const { buildSafeCommercialIntentReply } = require('../../src/worker').__private__;

const allCapabilities = [
  'inbox',
  'catalog',
  'inventory',
  'orders',
  'appointments',
  'loyalty',
  'automations',
  'payments'
];

function buildClinic(id = 'tenant-a') {
  return {
    id,
    settings: {
      businessProfile: {},
      bot: {},
      portal: {
        policy: {
          policyVersion: 1,
          capabilities: allCapabilities,
          enabledModules: {
            inbox: true,
            catalog: true,
            inventory: true,
            orders: true,
            agenda: true,
            loyalty: true,
            automations: true,
            payments: true
          }
        }
      }
    }
  };
}

function buildChannel(clinicId = 'tenant-a') {
  return {
    id: `channel-${clinicId}`,
    clinicId,
    type: 'whatsapp',
    provider: 'whatsapp_cloud',
    status: 'active',
    phoneNumberId: 'phone-number-id-test',
    accessToken: 'test-secret-token'
  };
}

function normalizeForAssertion(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildCapabilityTenant({
  id = 'tenant-a',
  channels = [buildChannel(id)],
  configuration = {
    transferDataConfigured: true,
    aiProviderConfigured: true,
    aiEnabled: true
  }
} = {}) {
  return buildTenantCapabilitySnapshot({
    clinic: buildClinic(id),
    channels: channels.map((channel) => ({
      ...channel,
      credentialsConfigured: Boolean(channel.accessToken)
    })),
    configuration
  });
}

async function sendTurn({ context, inboundText, clinic, contact, channel }) {
  const reply = await buildSafeCommercialIntentReply({
    clinic,
    conversation: {
      id: 'conversation-capability',
      clinicId: clinic.id,
      context
    },
    contact,
    channel,
    inboundText
  });
  return {
    reply,
    context: JSON.parse(JSON.stringify({
      ...(context || {}),
      ...((reply && reply.contextPatch) || {})
    }))
  };
}

async function runCapabilityModelAssertions() {
  const tenant = buildCapabilityTenant();
  for (const capability of [
    'inbox',
    'catalog',
    'internal_inventory',
    'orders',
    'agenda',
    'loyalty',
    'automations',
    'whatsapp_messaging'
  ]) {
    const decision = resolveCapability({ tenant, capability });
    assert.strictEqual(decision.status, CAPABILITY_STATUSES.AVAILABLE_NOW, capability);
  }

  const instagramTenant = buildTenantCapabilitySnapshot({
    clinic: buildClinic('tenant-instagram'),
    channels: [{
      clinicId: 'tenant-instagram',
      type: 'instagram',
      provider: 'instagram_graph',
      status: 'active',
      instagramUserId: 'ig-user-test',
      credentialsConfigured: true
    }],
    configuration: {
      transferDataConfigured: true,
      aiProviderConfigured: true,
      aiEnabled: true
    }
  });
  assert.strictEqual(
    resolveCapability({ tenant: instagramTenant, capability: 'instagram_inbox' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
  assert.strictEqual(
    resolveCapability({ tenant, capability: 'transfer_payment_instructions' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
  assert.strictEqual(
    resolveCapability({ tenant, capability: 'ai_assist' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );

  const productOnlyTenant = buildTenantCapabilitySnapshot({
    clinic: buildClinic('tenant-product-only'),
    botActions: [],
    configuration: {
      transferDataConfigured: true,
      aiProviderConfigured: true,
      aiEnabled: true
    }
  });
  assert.strictEqual(
    resolveCapability({ tenant: productOnlyTenant, capability: 'inbox' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
  const disabledBotAction = resolveCapability({ tenant: productOnlyTenant, capability: 'catalog' });
  assert.strictEqual(disabledBotAction.status, CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION);
  assert.deepStrictEqual(disabledBotAction.configurationMissing, ['bot_action_catalog_read']);

  const missingConfigurationTenant = buildCapabilityTenant({
    channels: [],
    configuration: {
      transferDataConfigured: false,
      aiProviderConfigured: false,
      aiEnabled: false,
      apiKey: 'must-not-survive'
    }
  });
  const configurationDecision = resolveCapability({
    tenant: missingConfigurationTenant,
    capability: 'transfer_payment_instructions'
  });
  assert.strictEqual(configurationDecision.status, CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION);
  assert.deepStrictEqual(configurationDecision.configurationMissing, ['transfer_data']);
  assert.match(normalizeForAssertion(buildSafeCapabilityReply(configurationDecision)), /requiere completar/);
  assert.match(normalizeForAssertion(buildSafeCapabilityReply(configurationDecision)), /no voy a asumir/);
  assert.strictEqual(
    resolveCapability({ tenant: missingConfigurationTenant, capability: 'whatsapp_messaging' }).status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION
  );
  assert.strictEqual(
    resolveCapability({ tenant: missingConfigurationTenant, capability: 'instagram_inbox' }).status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION
  );
  assert.strictEqual(
    resolveCapability({ tenant: missingConfigurationTenant, capability: 'ai_assist' }).status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION
  );
  assert.doesNotMatch(JSON.stringify(missingConfigurationTenant), /must-not-survive/);

  const integrationDecision = resolveCapability({
    tenant,
    capability: 'external_inventory_sync',
    context: { requestedSystems: ['Empretienda', 'Cianbox'] }
  });
  assert.strictEqual(integrationDecision.status, CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION);
  assert.deepStrictEqual(integrationDecision.integrationRequired, [
    'supported_external_inventory_adapter',
    'empretienda_adapter',
    'cianbox_adapter'
  ]);
  const integrationReply = normalizeForAssertion(buildSafeCapabilityReply(integrationDecision));
  assert.match(integrationReply, /requiere una integracion especifica/);
  assert.match(integrationReply, /no puedo confirmar/);
  assert.doesNotMatch(integrationReply, /(?:hay|ya existe|tenemos) un adaptador/);

  for (const capability of [
    'empretienda_inventory_adapter',
    'tiendanube_inventory_adapter',
    'cianbox_inventory_adapter',
    'automatic_payment_validation',
    'fiscal_receipt_issuance',
    'cash_management_bot',
    'supplier_management_bot',
    'instagram_automatic_replies'
  ]) {
    const decision = resolveCapability({ tenant, capability });
    assert.strictEqual(decision.status, CAPABILITY_STATUSES.NOT_SUPPORTED, capability);
    assert.match(normalizeForAssertion(buildSafeCapabilityReply(decision)), /no esta soportado/);
  }

  const disabledOrderNotification = resolveCapability({
    tenant,
    capability: 'order_customer_notification'
  });
  assert.strictEqual(disabledOrderNotification.status, CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION);
  assert.deepStrictEqual(disabledOrderNotification.configurationMissing, ['order_customer_notification_enablement']);

  const orderNotificationClinic = buildClinic('tenant-order-notification');
  orderNotificationClinic.settings.orderCustomerNotificationEnabled = true;
  const orderNotificationTenant = buildTenantCapabilitySnapshot({
    clinic: orderNotificationClinic,
    channels: [{
      ...buildChannel('tenant-order-notification'),
      credentialsConfigured: true
    }]
  });
  assert.strictEqual(
    resolveCapability({
      tenant: orderNotificationTenant,
      capability: 'order_customer_notification'
    }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );

  const unknownDecision = resolveCapability({ tenant, capability: 'unregistered_future_action' });
  assert.strictEqual(unknownDecision.status, CAPABILITY_STATUSES.UNKNOWN);
  assert.match(normalizeForAssertion(buildSafeCapabilityReply(unknownDecision)), /no tengo una fuente controlada/);

  const tenantB = buildCapabilityTenant({
    id: 'tenant-b',
    channels: [buildChannel('tenant-a')]
  });
  assert.strictEqual(
    resolveCapability({ tenant, capability: 'whatsapp_messaging' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
  const tenantBWhatsApp = resolveCapability({ tenant: tenantB, capability: 'whatsapp_messaging' });
  assert.strictEqual(tenantBWhatsApp.status, CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION);
  assert.deepStrictEqual(tenantBWhatsApp.configurationMissing, ['active_whatsapp_channel']);
}

async function runRealInventoryCaseAssertions() {
  const clinic = buildClinic('tenant-real-case');
  const contact = { id: 'contact-real-case', name: 'Prospecto resina' };
  const channel = buildChannel(clinic.id);
  const directCompatibility = await sendTurn({
    context: { activeBotDomain: 'commerce' },
    inboundText: 'Opturon se integra con Empretienda online y Cianbox en el local para sincronizar stock?',
    clinic,
    contact,
    channel
  });
  const directText = normalizeForAssertion(directCompatibility.reply.replyText);
  assert.strictEqual(directCompatibility.reply.type, 'integration_compatibility');
  assert.strictEqual(
    directCompatibility.context.commercialCapabilityDecision.status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION
  );
  assert.match(directText, /requiere una integracion especifica/);
  assert.match(directText, /no puedo confirmar que exista un adaptador conectado o compatible/);
  assert.notStrictEqual(directCompatibility.reply.triggerHandoff, true);

  const portfolioInput = [
    'Hola Opturon. Vengo desde Portfolio y quiero probar como funciona el sistema.',
    'Rubro: Local de insumos para trabajos con resina',
    'Tipo de consultas que recibo: Compras de productos varios',
    'Objetivo principal: alinear stock tienda online y local fisico'
  ].join('\n');

  const initial = await sendTurn({
    context: { activeBotDomain: 'commerce' },
    inboundText: portfolioInput,
    clinic,
    contact,
    channel
  });
  const platforms = await sendTurn({
    context: initial.context,
    inboundText: 'Empretienda online y Cianbox en el local',
    clinic,
    contact,
    channel
  });
  const stockSource = await sendTurn({
    context: platforms.context,
    inboundText: 'Cianbox',
    clinic,
    contact,
    channel
  });
  const updateMode = await sendTurn({
    context: stockSource.context,
    inboundText: 'si',
    clinic,
    contact,
    channel
  });
  const completed = await sendTurn({
    context: updateMode.context,
    inboundText: 'si',
    clinic,
    contact,
    channel
  });

  const replyText = normalizeForAssertion(completed.reply.replyText);
  const summary = completed.context.handoffSummary;
  assert.strictEqual(completed.reply.triggerHandoff, true);
  assert.strictEqual(completed.reply.handoffReason, 'capability_verification_required');
  assert.strictEqual(
    completed.context.commercialDiscoveryState.capabilityStatus,
    CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION
  );
  assert.strictEqual(
    completed.context.commercialCapabilityDecision.status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION
  );
  assert.match(replyText, /requiere una integracion especifica/);
  assert.match(replyText, /no puedo confirmar que exista un adaptador conectado o compatible/);
  assert.doesNotMatch(replyText, /opturon (?:ya )?(?:integra|sincroniza)/);

  assert.ok(summary);
  assert.strictEqual(summary.tenantId, clinic.id);
  assert.strictEqual(summary.conversationId, 'conversation-capability');
  assert.deepStrictEqual(summary.contact, { id: contact.id, name: contact.name });
  assert.strictEqual(summary.channel.id, channel.id);
  assert.strictEqual(summary.channel.type, 'whatsapp');
  assert.match(normalizeForAssertion(summary.industry), /local de insumos para trabajos con resina/);
  assert.match(normalizeForAssertion(summary.objective), /stock.*tienda online.*local fisico/);
  assert.deepStrictEqual(summary.systems, ['empretienda', 'cianbox']);
  assert.strictEqual(summary.collectedInformation.ecommercePlatform, 'empretienda');
  assert.strictEqual(summary.collectedInformation.physicalStoreSystem, 'cianbox');
  assert.strictEqual(summary.collectedInformation.stockSourceOfTruth, 'cianbox');
  assert.strictEqual(summary.collectedInformation.stockUpdateMode, 'manual');
  assert.strictEqual(summary.collectedInformation.sharedSkuCatalog, 'yes');
  assert.strictEqual(summary.capability.capability, 'external_inventory_sync');
  assert.strictEqual(summary.capability.status, CAPABILITY_STATUSES.AVAILABLE_WITH_INTEGRATION);
  assert.strictEqual(summary.escalationReason, 'capability_verification_required');
  assert.strictEqual(summary.latestRelevantExchange.expectedField, 'shared_sku_catalog');
  assert.strictEqual(summary.latestRelevantExchange.answer, 'si');
  assert.strictEqual(summary.suggestedAction, 'verify_integration_feasibility_and_contact_customer');
  assert.ok(summary.explicitFacts.length >= 7);
  assert.doesNotMatch(JSON.stringify(summary), /test-secret-token/);
  assert.deepStrictEqual(
    getOwnedHandoffSummary(summary, {
      tenantId: clinic.id,
      conversationId: 'conversation-capability',
      contactId: contact.id,
      channelId: channel.id
    }),
    summary
  );
  assert.strictEqual(
    getOwnedHandoffSummary(summary, {
      tenantId: 'other-tenant',
      conversationId: 'conversation-capability',
      contactId: contact.id,
      channelId: channel.id
    }),
    null
  );
}

async function runHandoffIdempotencyAssertions() {
  let storedHandoff = null;
  let insertCount = 0;
  const client = {
    query: async (sql, params) => {
      if (/SELECT id,[\s\S]+FROM handoff_requests/.test(sql)) {
        return { rows: storedHandoff ? [storedHandoff] : [] };
      }
      if (/INSERT INTO handoff_requests/.test(sql)) {
        if (storedHandoff) return { rows: [] };
        insertCount += 1;
        storedHandoff = {
          id: 'handoff-idempotent',
          clinicId: params[0],
          conversationId: params[1],
          contactId: params[2],
          leadId: params[3],
          status: 'open',
          assignedTo: null,
          reason: params[4]
        };
        return { rows: [storedHandoff] };
      }
      throw new Error(`Unexpected handoff query: ${sql}`);
    }
  };
  const input = {
    clinicId: 'tenant-a',
    conversationId: 'conversation-a',
    contactId: 'contact-a',
    leadId: null,
    reason: 'capability_verification_required'
  };
  const first = await openHandoff(input, client);
  const second = await openHandoff(input, client);
  assert.strictEqual(first.created, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(insertCount, 1);
}

function runSummaryEnrichmentAssertions() {
  const first = buildHandoffSummary({
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    contact: { id: 'contact-a', name: 'Cliente A' },
    channel: { id: 'channel-a', clinicId: 'tenant-a', provider: 'whatsapp_cloud' },
    salesContext: {
      groundedFacts: {
        businessType: { value: 'Comercio', source: 'STRUCTURED' },
        objective: { value: 'Sincronizar stock', source: 'STRUCTURED' },
        ecommercePlatform: { value: 'empretienda', source: 'EXPLICIT' },
        systems: [{ value: 'empretienda', source: 'EXPLICIT' }]
      }
    },
    capabilityDecision: {
      capability: 'external_inventory_sync',
      status: 'AVAILABLE_WITH_INTEGRATION',
      reason: 'supported_adapter_required',
      source: 'product_capability_registry',
      integrationRequired: ['supported_external_inventory_adapter']
    },
    escalationReason: 'capability_verification_required',
    now: '2026-08-09T10:00:00.000Z'
  });
  const enriched = buildHandoffSummary({
    existingSummary: first,
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    salesContext: {
      groundedFacts: {
        stockSourceOfTruth: { value: 'cianbox', source: 'EXPLICIT' },
        physicalStoreSystem: { value: 'cianbox', source: 'EXPLICIT' },
        systems: [{ value: 'cianbox', source: 'EXPLICIT' }]
      }
    },
    latestQuestion: { id: 'q-1', expectedField: 'stock_source_of_truth' },
    latestAnswer: 'Cianbox',
    now: '2026-08-09T10:05:00.000Z'
  });
  assert.strictEqual(enriched.createdAt, first.createdAt);
  assert.strictEqual(enriched.updatedAt, '2026-08-09T10:05:00.000Z');
  assert.deepStrictEqual(enriched.systems, ['empretienda', 'cianbox']);
  assert.strictEqual(enriched.collectedInformation.ecommercePlatform, 'empretienda');
  assert.strictEqual(enriched.collectedInformation.physicalStoreSystem, 'cianbox');
  assert.strictEqual(enriched.collectedInformation.stockSourceOfTruth, 'cianbox');
  assert.strictEqual(enriched.latestRelevantExchange.answer, 'Cianbox');

  const sanitized = sanitizeHandoffSummary({
    ...enriched,
    accessToken: 'must-not-survive',
    channel: { ...enriched.channel, accessToken: 'must-not-survive' },
    contact: { ...enriched.contact, password: 'must-not-survive' }
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /must-not-survive/);

  const tenantB = buildHandoffSummary({
    existingSummary: enriched,
    tenantId: 'tenant-b',
    conversationId: 'conversation-b',
    contact: { id: 'contact-b', name: 'Cliente B' },
    channel: { id: 'channel-a', clinicId: 'tenant-a', provider: 'whatsapp_cloud' },
    now: '2026-08-09T10:10:00.000Z'
  });
  assert.deepStrictEqual(tenantB.contact, { id: 'contact-b', name: 'Cliente B' });
  assert.strictEqual(tenantB.channel.id, null);
  assert.deepStrictEqual(tenantB.systems, []);
  assert.strictEqual(tenantB.objective, null);
  assert.strictEqual(tenantB.tenantId, 'tenant-b');
  assert.strictEqual(tenantB.conversationId, 'conversation-b');
}

async function run() {
  await runCapabilityModelAssertions();
  await runRealInventoryCaseAssertions();
  await runHandoffIdempotencyAssertions();
  runSummaryEnrichmentAssertions();
  console.log('bot-p1-2-capability-handoff.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
