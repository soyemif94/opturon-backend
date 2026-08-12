const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const NOW = '2026-08-12T12:00:00.000Z';
const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  channelA: '20000000-0000-4000-8000-000000000001',
  channelB: '20000000-0000-4000-8000-000000000002',
  rule: '30000000-0000-4000-8000-000000000001',
  recipient: '40000000-0000-4000-8000-000000000001'
});

const {
  createWhatsAppTemplateSyncService,
  META_TEMPLATE_FIELDS
} = require(path.join(root, 'src/services/whatsapp-template-sync.service.js'));
const templateDomain = require(path.join(root, 'src/whatsapp/whatsapp-template-domain.js'));
const blueprints = require(path.join(root, 'src/whatsapp/template-blueprints.js'));
const portalAlerts = require(path.join(root, 'src/services/portal-operational-alerts.service.js'));
const registry = require(path.join(root, 'src/operational-alerts/operational-alert-registry.js'));
const authority = require(path.join(root, 'src/operational-alerts/internal-operational-alert-authority.js'));
const {
  createWhatsAppTemplateSyncAdminAuthorization
} = require(path.join(root, 'src/middlewares/portal-whatsapp-template-sync-authorization.middleware.js'));

const covered = new Set();
function mark(...labels) {
  labels.forEach((label) => covered.add(label));
}

function body(count = 5, options = {}) {
  const variables = options.variables || Array.from({ length: count }, (_, index) => index + 1);
  const placeholders = variables.map((value) => `{{${value}}}`).join('\n');
  return [{ type: 'BODY', text: options.fixedText ? `Inventory alert\n${placeholders}\nReview now.` : placeholders }];
}

function inventoryTemplate(overrides = {}) {
  return {
    id: 'meta-template-1',
    name: 'inventory_lot_expiring_v1',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'IN_REVIEW',
    components: body(),
    ...overrides
  };
}

function canonicalKey(input) {
  return [input.clinicId, input.channelId, input.wabaId, input.templateKey, input.language].join('|');
}

function providerKey(input) {
  return [input.clinicId, input.channelId, input.wabaId, input.metaTemplateName, input.language].join('|');
}

function mergeSyncedRow(existing, input, rowId) {
  const existingDefinition = existing && existing.definition && typeof existing.definition === 'object'
    ? existing.definition
    : {};
  const existingMetadata = existing && existing.metadata && typeof existing.metadata === 'object'
    ? existing.metadata
    : {};
  const localDefinition = existing ? existingDefinition : input.localDefinition || {};
  const localMetadata = existing ? existingMetadata : input.localMetadata || {};
  return {
    ...(existing || {}),
    id: existing ? existing.id : rowId,
    clinicId: input.clinicId,
    externalTenantId: input.externalTenantId,
    channelId: input.channelId,
    wabaId: input.wabaId,
    templateKey: input.templateKey,
    metaTemplateId: input.metaTemplateId,
    metaTemplateName: input.metaTemplateName,
    language: input.language,
    category: templateDomain.normalizeWhatsAppTemplateCategory(input.category),
    status: templateDomain.normalizeWhatsAppTemplateStatus(input.status),
    rejectionReason: input.rejectionReason || null,
    definition: { ...localDefinition, provider: JSON.parse(JSON.stringify(input.providerDefinition)) },
    lastSyncedAt: input.lastSyncedAt,
    metadata: { ...localMetadata, providerSync: JSON.parse(JSON.stringify(input.providerMetadata)) }
  };
}

function page(items, after = null) {
  return {
    ok: true,
    status: 200,
    data: {
      data: items,
      ...(after ? {
        paging: {
          next: `https://graph.facebook.com/v99.0/waba-a/message_templates?after=${after}`,
          cursors: { after }
        }
      } : {})
    }
  };
}

function createHarness(options = {}) {
  const store = options.store || new Map();
  const channels = options.channels || new Map([
    [ids.channelA, {
      id: ids.channelA,
      clinicId: ids.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      wabaId: 'waba-a',
      phoneNumberId: 'phone-a',
      accessToken: 'super-secret-token-a'
    }],
    [ids.channelB, {
      id: ids.channelB,
      clinicId: ids.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      wabaId: 'waba-b',
      phoneNumberId: 'phone-b',
      accessToken: 'super-secret-token-b'
    }]
  ]);
  const clinics = options.clinics || new Map([
    [ids.clinicA, { id: ids.clinicA, externalTenantId: 'tenant-a' }],
    [ids.clinicB, { id: ids.clinicB, externalTenantId: 'tenant-b' }]
  ]);
  let responses = options.responses || [page([inventoryTemplate()])];
  let graphIndex = 0;
  let sequence = store.size;
  const graphCalls = [];
  const logs = [];

  const service = createWhatsAppTemplateSyncService({
    findClinic: async (clinicId) => clinics.get(clinicId) || null,
    findChannel: async (channelId, clinicId) => {
      const channel = channels.get(channelId) || null;
      return channel && channel.clinicId === clinicId ? channel : null;
    },
    graphRequest: async (method, graphPath, requestOptions) => {
      graphCalls.push({ method, path: graphPath, options: requestOptions });
      const response = responses[Math.min(graphIndex, responses.length - 1)];
      graphIndex += 1;
      if (response instanceof Error) throw response;
      return typeof response === 'function'
        ? response({ method, path: graphPath, options: requestOptions, index: graphIndex - 1 })
        : response;
    },
    findByProviderIdentity: async (scope) => {
      for (const row of store.values()) {
        if (providerKey(row) === providerKey(scope)) return row;
      }
      return null;
    },
    upsertSynced: async (input) => {
      const key = canonicalKey(input);
      const existing = store.get(key) || null;
      sequence += existing ? 0 : 1;
      const row = mergeSyncedRow(existing, input, existing ? existing.id : `row-${sequence}`);
      store.set(key, row);
      return row;
    },
    withTransaction: async (work) => work({}),
    now: () => new Date(NOW),
    requestId: () => 'safe-request-id',
    logInfo: (event, data) => logs.push({ level: 'info', event, data }),
    logWarn: (event, data) => logs.push({ level: 'warn', event, data })
  });

  return {
    service,
    store,
    channels,
    graphCalls,
    logs,
    setResponses(next) {
      responses = next;
      graphIndex = 0;
    }
  };
}

function inventoryRule(overrides = {}) {
  return {
    id: ids.rule,
    clinicId: ids.clinicA,
    name: 'Inventory expiry fixture',
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerMode: 'scheduled',
    configVersion: 1,
    enabled: false,
    archivedAt: null,
    conditions: {
      daysBefore: 30,
      minimumAvailableQuantity: 1,
      quantityBasis: 'physical',
      repeatPolicy: 'once_per_threshold'
    },
    schedule: { frequency: 'daily', sendAt: '08:00', timezone: 'tenant' },
    deliveryPolicy: { maxAttempts: 3 },
    channelId: ids.channelA,
    templateKey: 'inventory_lot_expiring_v1',
    templateLanguage: 'es_AR',
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1,
    ...overrides
  };
}

function readiness(template, now = NOW) {
  return portalAlerts.__private__.buildRuleReadiness({
    now,
    clinic: {
      id: ids.clinicA,
      settings: { operationalAlertsEnabled: true }
    },
    rule: inventoryRule(),
    associations: [{ recipientId: ids.recipient }],
    recipients: [{
      id: ids.recipient,
      clinicId: ids.clinicA,
      active: true,
      consentStatus: 'granted',
      consentSource: 'fixture',
      consentedAt: NOW,
      revokedAt: null,
      staffUserId: null
    }],
    staffById: new Map(),
    channel: {
      id: ids.channelA,
      clinicId: ids.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'phone-a',
      wabaId: 'waba-a',
      accessToken: 'fixture-token'
    },
    template
  });
}

function onlyRow(harness) {
  assert.equal(harness.store.size, 1);
  return [...harness.store.values()][0];
}

async function testStatusAndContractMatrix() {
  const inReview = createHarness();
  const first = await inReview.service.syncWhatsAppTemplatesForChannel({
    clinicId: ids.clinicA,
    channelId: ids.channelA
  });
  assert.deepEqual(first.summary, {
    scanned: 1,
    recognized: 1,
    inserted: 1,
    updated: 0,
    unchanged: 0,
    unknown: 0,
    errors: 0
  });
  const pendingRow = onlyRow(inReview);
  assert.equal(pendingRow.status, 'in_review');
  assert.equal(pendingRow.category, 'UTILITY');
  assert.deepEqual(pendingRow.definition.provider.components, body());
  assert.equal(pendingRow.metadata.operationalAlertContract, 'operational_alert_body_parameters_v1');
  assert.equal(pendingRow.metadata.providerSync.contract.valid, true);
  assert.ok(readiness(pendingRow).blockers.some((item) => item.code === 'TEMPLATE_NOT_APPROVED'));
  mark('A', 'T');

  for (const status of [
    'PENDING',
    'IN_REVIEW',
    'REJECTED',
    'PAUSED',
    'DISABLED',
    'IN_APPEAL',
    'PENDING_DELETION',
    'FLAGGED',
    'UNKNOWN'
  ]) {
    assert.equal(templateDomain.isWhatsAppTemplateStatusUsable(status), false);
  }
  assert.equal(templateDomain.isWhatsAppTemplateStatusUsable('APPROVED'), true);

  const rejected = createHarness({
    responses: [page([inventoryTemplate({ status: 'REJECTED', rejected_reason: 'Invalid\nformat' })])]
  });
  await rejected.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(onlyRow(rejected).rejectionReason, 'Invalid format');

  inReview.setResponses([page([inventoryTemplate({ status: 'APPROVED' })])]);
  const approved = await inReview.service.syncWhatsAppTemplatesForChannel({
    clinicId: ids.clinicA,
    channelId: ids.channelA
  });
  assert.equal(approved.summary.updated, 1);
  const approvedRow = onlyRow(inReview);
  assert.equal(approvedRow.id, pendingRow.id);
  assert.equal(approvedRow.status, 'approved');
  assert.equal(readiness(approvedRow).checks.templateReady, true);
  assert.ok(!readiness(approvedRow).blockers.some((item) => item.code.startsWith('TEMPLATE_')));
  mark('B', 'C');

  const cases = [
    ['D', inventoryTemplate({ status: 'APPROVED', category: undefined }), 'UNKNOWN'],
    ['E', inventoryTemplate({ status: 'APPROVED', category: 'MARKETING' }), 'MARKETING'],
    ['G', inventoryTemplate({ status: 'APPROVED', components: body(4) }), 'UTILITY'],
    ['H', inventoryTemplate({ status: 'APPROVED', components: body(6) }), 'UTILITY'],
    ['I', inventoryTemplate({ status: 'APPROVED', components: [] }), 'UTILITY']
  ];
  for (const [label, fixture, expectedCategory] of cases) {
    const harness = createHarness({ responses: [page([fixture])] });
    const result = await harness.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
    assert.equal(result.ok, true);
    const row = onlyRow(harness);
    assert.equal(row.category, expectedCategory);
    assert.ok(readiness(row).blockers.some((item) => item.code === 'TEMPLATE_CONTRACT_MISMATCH'));
    mark(label);
  }

  const wrongLanguage = createHarness({
    responses: [page([inventoryTemplate({ language: 'es' })])]
  });
  const wrongLanguageResult = await wrongLanguage.service.syncWhatsAppTemplatesForChannel({
    clinicId: ids.clinicA,
    channelId: ids.channelA
  });
  assert.equal(wrongLanguageResult.summary.unknown, 1);
  assert.equal(wrongLanguage.store.size, 0);
  assert.ok(readiness(null).blockers.some((item) => item.code === 'TEMPLATE_MISSING'));
  mark('F');

  const fixedText = createHarness({
    responses: [page([inventoryTemplate({ status: 'APPROVED', components: body(5, { fixedText: true }) })])]
  });
  await fixedText.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(readiness(onlyRow(fixedText)).checks.templateReady, true);
  mark('J');
}

async function testPaginationAndFailures() {
  const paged = createHarness({
    responses: [
      page([{ id: 'unknown-1', name: 'other_template', language: 'es_AR', status: 'APPROVED', category: 'UTILITY', components: [] }], 'page-2'),
      page([inventoryTemplate({ status: 'APPROVED' })])
    ]
  });
  const result = await paged.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(result.summary.scanned, 2);
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.summary.inserted, 1);
  assert.equal(paged.graphCalls[1].options.query.after, 'page-2');
  mark('K');

  const existing = mergeSyncedRow(null, {
    clinicId: ids.clinicA,
    externalTenantId: 'tenant-a',
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateId: 'existing-id',
    metaTemplateName: 'inventory_lot_expiring_v1',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'APPROVED',
    rejectionReason: null,
    localDefinition: { source: 'sync_only_blueprint' },
    providerDefinition: { components: body() },
    lastSyncedAt: new Date(NOW),
    localMetadata: { operationalAlertContract: 'operational_alert_body_parameters_v1' },
    providerMetadata: { source: 'previous' }
  }, 'existing-row');
  const failureCases = [
    ['L', [page([inventoryTemplate({ status: 'IN_REVIEW' })], 'page-2'), { ok: false, status: 500, errorCategory: 'transient' }]],
    ['M', [{ ok: false, status: 500, errorCategory: 'transient' }]],
    ['M', [{ ok: false, status: 429, errorCategory: 'rate_limit' }]],
    ['M', [new Error('simulated timeout')]],
    ['N', [{ ok: false, status: 403, errorCategory: 'auth_error' }]]
  ];
  for (const [label, responses] of failureCases) {
    const store = new Map([[canonicalKey(existing), JSON.parse(JSON.stringify(existing))]]);
    const before = JSON.stringify([...store.values()]);
    const harness = createHarness({ store, responses });
    const failed = await harness.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify([...store.values()]), before);
    mark(label);
  }
}

async function testIdempotencyIsolationAndSafety() {
  const crossTenant = createHarness();
  const crossTenantResult = await crossTenant.service.syncWhatsAppTemplatesForChannel({
    clinicId: ids.clinicB,
    channelId: ids.channelA
  });
  assert.equal(crossTenantResult.reason, 'whatsapp_channel_not_found');
  assert.equal(crossTenant.graphCalls.length, 0);

  const wrongProviderChannels = new Map([[ids.channelA, {
    id: ids.channelA,
    clinicId: ids.clinicA,
    provider: 'instagram',
    status: 'active',
    wabaId: 'waba-a',
    accessToken: 'must-not-be-used'
  }]]);
  const wrongProvider = createHarness({ channels: wrongProviderChannels });
  const wrongProviderResult = await wrongProvider.service.syncWhatsAppTemplatesForChannel({
    clinicId: ids.clinicA,
    channelId: ids.channelA
  });
  assert.equal(wrongProviderResult.reason, 'whatsapp_channel_provider_invalid');
  assert.equal(wrongProvider.graphCalls.length, 0);

  const duplicate = createHarness({ responses: [page([inventoryTemplate({ status: 'APPROVED' })])] });
  await duplicate.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  duplicate.setResponses([page([inventoryTemplate({ status: 'APPROVED' })])]);
  const again = await duplicate.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(duplicate.store.size, 1);
  assert.equal(again.summary.unchanged, 1);
  mark('O');

  const concurrent = createHarness({ responses: [page([inventoryTemplate({ status: 'APPROVED' })])] });
  await Promise.all([
    concurrent.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA }),
    concurrent.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA })
  ]);
  assert.equal(concurrent.store.size, 1);

  const isolated = createHarness({
    responses: [({ options }) => page([inventoryTemplate({
      id: options.credentials.phoneNumberId === 'phone-a' ? 'meta-a' : 'meta-b',
      status: 'APPROVED'
    })])]
  });
  await isolated.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  isolated.setResponses([({ options }) => page([inventoryTemplate({ id: `meta-${options.credentials.phoneNumberId}`, status: 'IN_REVIEW' })])]);
  await isolated.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelB });
  assert.equal(isolated.store.size, 2);
  const channelA = [...isolated.store.values()].find((row) => row.channelId === ids.channelA);
  const channelB = [...isolated.store.values()].find((row) => row.channelId === ids.channelB);
  assert.equal(channelA.status, 'approved');
  assert.equal(channelB.status, 'in_review');
  assert.equal(channelA.wabaId, 'waba-a');
  assert.equal(channelB.wabaId, 'waba-b');
  mark('P', 'Q');

  const languageStore = new Map();
  const enRow = { ...channelA, id: 'row-en', language: 'en_US' };
  languageStore.set(canonicalKey(enRow), enRow);
  const languageHarness = createHarness({ store: languageStore, responses: [page([inventoryTemplate({ status: 'APPROVED' })])] });
  await languageHarness.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(languageStore.size, 2);
  assert.equal(languageStore.get(canonicalKey(enRow)).language, 'en_US');
  mark('R');

  const unknown = createHarness({
    responses: [page([{ id: 'unknown', name: 'unknown_provider_template', language: 'es_AR', status: 'APPROVED', category: 'UTILITY', components: body() }])]
  });
  const unknownResult = await unknown.service.syncWhatsAppTemplatesForChannel({ clinicId: ids.clinicA, channelId: ids.channelA });
  assert.equal(unknownResult.summary.unknown, 1);
  assert.equal(unknown.store.size, 0);
  mark('S');

  assert.equal(blueprints.findTemplateBlueprintByKey('inventory_lot_expiring_v1'), null);
  assert.ok(!blueprints.listTemplateBlueprints().some((item) => item.key === 'inventory_lot_expiring_v1'));
  mark('U');

  const calls = duplicate.graphCalls;
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.ok(calls.every((call) => call.path === '/waba-a/message_templates'));
  assert.ok(calls.every((call) => call.options.query.fields === META_TEMPLATE_FIELDS));
  assert.equal(META_TEMPLATE_FIELDS, 'id,name,status,category,language,components,rejected_reason');
  mark('V');

  const serializedLogs = JSON.stringify(duplicate.logs);
  assert.ok(!serializedLogs.includes('super-secret-token'));
  assert.ok(!serializedLogs.includes('accessToken'));
  mark('W');
}

function testParserFreshnessAndRegistry() {
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract(body(5, { fixedText: true }), 5).ok, true);
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract(body(4), 5).ok, false);
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract(body(6), 5).ok, false);
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract(body(4, { variables: [1, 2, 3, 5] }), 5).ok, false);
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract(body(5, { variables: [1, 2, 3, 4, 4] }), 5).ok, false);
  assert.equal(templateDomain.validateWhatsAppTemplateBodyContract([], 5).ok, false);

  const current = {
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'approved',
    definition: { provider: { components: body() } },
    metadata: { operationalAlertContract: 'operational_alert_body_parameters_v1' },
    lastSyncedAt: NOW
  };
  assert.equal(readiness(current).checks.templateReady, true);
  mark('X');
  const stale = { ...current, lastSyncedAt: '2026-08-10T11:59:59.000Z' };
  assert.ok(readiness(stale).blockers.some((item) => item.code === 'TEMPLATE_SYNC_STALE'));
  const authorityResult = authority.evaluateInternalOperationalAlertAuthority({
    now: NOW,
    workerId: 'worker-a',
    clinic: { id: ids.clinicA, settings: { operationalAlertsEnabled: true } },
    currentRule: { id: ids.rule, clinicId: ids.clinicA, enabled: true, archivedAt: null },
    ruleSnapshot: {
      id: ids.rule,
      channelId: ids.channelA,
      templateKey: 'inventory_lot_expiring_v1',
      templateLanguage: 'es_AR'
    },
    delivery: {
      clinicId: ids.clinicA,
      status: 'sending',
      lockedBy: 'worker-a',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      recipientVersion: 1,
      channelId: ids.channelA,
      recipientSnapshot: { phoneE164: '+5491100000001' }
    },
    recipient: {
      id: ids.recipient,
      clinicId: ids.clinicA,
      active: true,
      consentStatus: 'granted',
      version: 1,
      phoneE164: '+5491100000001',
      staffUserId: null
    },
    staff: null,
    channel: {
      id: ids.channelA,
      clinicId: ids.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'phone-a',
      accessToken: 'fixture-token',
      wabaId: 'waba-a'
    },
    template: stale
  });
  assert.equal(authorityResult.resultCode, 'template_sync_stale');
  mark('Y');

  const definitions = registry.listOperationalAlertDefinitions();
  assert.equal(definitions.find((item) => item.eventType === 'inventory.lot_expiring').producer.status, 'PRODUCER_AVAILABLE');
  assert.equal(definitions.find((item) => item.eventType === 'cash.session_closed').producer.status, 'CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE');
  mark('Z', 'AA');
}

async function invokeAuthorization(middleware, request) {
  const result = { status: null, body: null, next: false };
  const req = {
    params: request.params || {},
    activeTenantId: request.activeTenantId,
    activeTenantContext: request.activeTenantContext,
    get: (name) => request.headers && request.headers[name.toLowerCase()]
  };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(bodyValue) {
      result.body = bodyValue;
      return this;
    }
  };
  await middleware(req, res, () => { result.next = true; });
  return result;
}

async function testAdminAndRouteSafety() {
  const actors = new Map([
    ['admin', { id: 'admin', tenantId: 'admin-tenant', isAdmin: true }],
    ['client', { id: 'client', tenantId: 'tenant-a', isAdmin: false }]
  ]);
  const middleware = createWhatsAppTemplateSyncAdminAuthorization({
    hasInternalAuth: () => true,
    findActor: async (id) => actors.get(id) || null
  });
  const denied = await invokeAuthorization(middleware, {
    params: { tenantId: 'tenant-a' },
    headers: { 'x-portal-actor-id': 'client' }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.next, false);

  const selected = await invokeAuthorization(middleware, {
    params: { tenantId: 'admin-tenant' },
    activeTenantId: 'tenant-a',
    activeTenantContext: {
      source: 'active_tenant',
      actorUserId: 'admin',
      activeTenantId: 'tenant-a'
    },
    headers: { 'x-portal-actor-id': 'admin' }
  });
  assert.equal(selected.next, true);

  const spoofed = await invokeAuthorization(middleware, {
    params: { tenantId: 'tenant-a' },
    headers: { 'x-portal-actor-id': 'admin' }
  });
  assert.equal(spoofed.status, 403);

  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /router\.use\('\/tenants\/:tenantId\/whatsapp\/templates\/sync', whatsappTemplateSyncNoStore\)/);
  assert.match(routes, /router\.post\([\s\S]*whatsapp\/templates\/sync'[\s\S]*requirePortalInternalAuth[\s\S]*requireWhatsAppTemplateSyncAdmin[\s\S]*postPortalWhatsAppTemplatesSync/);
  mark('AC');
}

async function main() {
  await testStatusAndContractMatrix();
  await testPaginationAndFailures();
  await testIdempotencyIsolationAndSafety();
  testParserFreshnessAndRegistry();
  await testAdminAndRouteSafety();

  const phaseLabels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AC'];
  assert.deepEqual([...covered].sort(), [...new Set(phaseLabels)].sort());
  console.log('WhatsApp template sync tests PASS (A-AA, AC; AB/AD covered by regression suites)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
