const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const migrationPath = path.join(root, 'db/migrations/074_operational_alerts_foundation.sql');
const NOW = new Date().toISOString();
const CONSENTED_AT = '2026-08-10T12:00:00.000Z';
const covered = new Set();

const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  clinicC: '10000000-0000-4000-8000-000000000003',
  clinicD: '10000000-0000-4000-8000-000000000004',
  staffActive: '20000000-0000-4000-8000-000000000001',
  staffInactive: '20000000-0000-4000-8000-000000000002',
  channelA: '30000000-0000-4000-8000-000000000001',
  channelB: '30000000-0000-4000-8000-000000000002'
});

function mark(...labels) {
  labels.forEach((label) => covered.add(label));
}

function clearModule(relativePath) {
  try {
    delete require.cache[require.resolve(path.join(root, relativePath))];
  } catch {}
}

function mockModule(relativePath, exportsValue) {
  const fullPath = path.join(root, relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

function installDbClientStub(db) {
  mockModule('src/db/client.js', {
    query: (text, params) => db.query(text, params),
    withTransaction: async (work) => {
      await db.exec('BEGIN');
      try {
        const client = { query: (text, params) => db.query(text, params) };
        const result = await work(client);
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }
  });
}

function loadRuntime(db) {
  const paths = [
    'src/db/client.js',
    'src/repositories/operational-alert-recipients.repository.js',
    'src/repositories/operational-alert-rules.repository.js',
    'src/repositories/operational-alert-events.repository.js',
    'src/repositories/operational-alert-instances.repository.js',
    'src/repositories/operational-alert-deliveries.repository.js',
    'src/repositories/staff.repository.js',
    'src/repositories/tenant.repository.js',
    'src/repositories/whatsapp-templates.repository.js',
    'src/services/operational-alert-event-processor.service.js',
    'src/services/operational-alert-delivery-processor.service.js',
    'src/services/operational-alert-scheduled-evaluator.service.js',
    'src/services/order-customer-notification-status.service.js'
  ];
  paths.forEach(clearModule);
  installDbClientStub(db);
  mockModule('src/whatsapp/whatsapp.service.js', {
    sendChannelScopedMessage: async () => {
      throw new Error('real_graph_forbidden_in_operational_alert_test');
    }
  });
  return {
    recipients: require(path.join(root, paths[1])),
    rules: require(path.join(root, paths[2])),
    events: require(path.join(root, paths[3])),
    instances: require(path.join(root, paths[4])),
    deliveries: require(path.join(root, paths[5])),
    eventProcessor: require(path.join(root, paths[9])),
    deliveryProcessor: require(path.join(root, paths[10])),
    scheduler: require(path.join(root, paths[11])),
    statusService: require(path.join(root, paths[12])),
    authority: require(path.join(root, 'src/operational-alerts/internal-operational-alert-authority.js')),
    formatter: require(path.join(root, 'src/operational-alerts/operational-alert-formatter.js')),
    registry: require(path.join(root, 'src/operational-alerts/operational-alert-registry.js'))
  };
}

async function createBaseSchema(db) {
  await db.exec(`
    CREATE FUNCTION gen_random_uuid() RETURNS uuid AS $$
      SELECT (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
        '4' || substr(md5(random()::text || clock_timestamp()::text), 1, 3) || '-' ||
        '8' || substr(md5(random()::text || clock_timestamp()::text), 1, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 1, 12)
      )::uuid;
    $$ LANGUAGE SQL;

    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
      "externalTenantId" TEXT NULL,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE staff_users (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      name TEXT NOT NULL,
      email TEXT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      "accountType" TEXT NOT NULL DEFAULT 'internal_staff',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE channels (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      type TEXT NOT NULL DEFAULT 'whatsapp',
      provider TEXT NOT NULL DEFAULT 'whatsapp_cloud',
      "phoneNumberId" TEXT NULL,
      "externalId" TEXT NULL,
      "externalPageId" TEXT NULL,
      "externalPageName" TEXT NULL,
      "instagramUserId" TEXT NULL,
      "instagramUsername" TEXT NULL,
      "displayPhoneNumber" TEXT NULL,
      "verifiedName" TEXT NULL,
      "wabaId" TEXT NULL,
      "accessToken" TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_channels_id_clinic_id ON channels(id, "clinicId");

    CREATE TABLE products (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      name TEXT NOT NULL,
      sku TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      "deletedAt" TIMESTAMPTZ NULL,
      UNIQUE (id, "clinicId")
    );

    CREATE TABLE inventory_locations (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL REFERENCES clinics(id),
      name TEXT NOT NULL,
      UNIQUE (id, "tenantId")
    );

    CREATE TABLE inventory_lots (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL REFERENCES clinics(id),
      "productId" UUID NOT NULL,
      "locationId" UUID NULL,
      "lotNumber" TEXT NULL,
      "supplierName" TEXT NULL,
      "expiresAt" DATE NULL,
      "availableQuantity" NUMERIC(14,3) NOT NULL DEFAULT 0,
      "warehouseName" TEXT NULL,
      "locationName" TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      "operationalStatus" TEXT NULL
    );

    CREATE TABLE inventory_lot_allocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" UUID NOT NULL,
      "lotId" UUID NOT NULL,
      quantity NUMERIC(14,3) NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE whatsapp_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      "externalTenantId" TEXT NOT NULL,
      "channelId" UUID NULL REFERENCES channels(id),
      "wabaId" TEXT NOT NULL,
      "templateKey" TEXT NOT NULL,
      "metaTemplateId" TEXT NULL,
      "metaTemplateName" TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      "rejectionReason" TEXT NULL,
      definition JSONB NOT NULL,
      "lastSyncedAt" TIMESTAMPTZ NULL,
      metadata JSONB NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE ("clinicId", "templateKey", language),
      UNIQUE ("clinicId", "metaTemplateName")
    );
  `);
  const migration = fs.readFileSync(migrationPath, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/gi, '');
  await db.exec(migration);
}

async function seedBase(db) {
  await db.query(
    `INSERT INTO clinics (id, name, "externalTenantId", settings) VALUES
       ($1::uuid, 'Tenant A', 'tenant-a', '{"operationalAlertsEnabled":true}'::jsonb),
       ($2::uuid, 'Tenant B', 'tenant-b', '{"operationalAlertsEnabled":true}'::jsonb),
       ($3::uuid, 'Tenant C', 'tenant-c', '{"operationalAlertsEnabled":false}'::jsonb),
       ($4::uuid, 'Tenant D', 'tenant-d', '{}'::jsonb)`,
    [ids.clinicA, ids.clinicB, ids.clinicC, ids.clinicD]
  );
  await db.query(
    `INSERT INTO staff_users (id, "clinicId", name, active) VALUES
       ($1::uuid, $2::uuid, 'Active Staff', TRUE),
       ($3::uuid, $2::uuid, 'Inactive Staff', FALSE)`,
    [ids.staffActive, ids.clinicA, ids.staffInactive]
  );
  await db.query(
    `INSERT INTO channels (
       id, "clinicId", provider, "phoneNumberId", "displayPhoneNumber", "wabaId", "accessToken", status
     ) VALUES
       ($1::uuid, $2::uuid, 'whatsapp_cloud', 'phone-a', '+5491100000099', 'waba-a', 'fixture-secret-token-a', 'active'),
       ($3::uuid, $4::uuid, 'whatsapp_cloud', 'phone-b', '+5491100000088', 'waba-b', 'fixture-secret-token-b', 'active')`,
    [ids.channelA, ids.clinicA, ids.channelB, ids.clinicB]
  );
  await insertTemplate(db, {
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    key: 'cash_alert',
    name: 'cash_alert_fixture',
    placeholders: 4
  });
  await insertTemplate(db, {
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    key: 'inventory_lot_expiring_v1',
    name: 'inventory_lot_expiring_v1_fixture',
    placeholders: 5
  });
}

async function insertTemplate(db, {
  clinicId,
  channelId,
  wabaId,
  key,
  name,
  placeholders,
  status = 'approved',
  contract = 'operational_alert_body_parameters_v1'
}) {
  const body = Array.from({ length: placeholders }, (_, index) => `{{${index + 1}}}`).join(' ');
  await db.query(
      `INSERT INTO whatsapp_templates (
       "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey",
       "metaTemplateName", language, category, status, definition, metadata, "lastSyncedAt"
      ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, 'es_AR', 'UTILITY', $7, $8::jsonb, $9::jsonb, $10::timestamptz)`,
    [
      clinicId,
      clinicId === ids.clinicA ? 'tenant-a' : 'tenant-b',
      channelId,
      wabaId,
      key,
      name,
      status,
      JSON.stringify({ components: [{ type: 'BODY', text: body }] }),
      JSON.stringify({ operationalAlertContract: contract }),
      NOW
    ]
  );
}

async function scalar(db, text, params = []) {
  const result = await db.query(text, params);
  const row = result.rows[0] || {};
  return row[Object.keys(row)[0]];
}

function cashRuleInput(clinicId, channelId, overrides = {}) {
  return {
    clinicId,
    name: `Cash fixture ${Math.random().toString(36).slice(2)}`,
    eventType: 'cash.session_closed',
    eventVersion: 1,
    triggerMode: 'event_driven',
    conditions: { minimumAbsoluteDifference: 1, onlyWithDifference: true },
    schedule: {},
    deliveryPolicy: { maxAttempts: 5 },
    channelId,
    templateKey: 'cash_alert',
    templateLanguage: 'es_AR',
    formatterKey: 'cash_session_closed',
    formatterVersion: 1,
    ...overrides
  };
}

function inventoryRuleInput(overrides = {}) {
  return {
    clinicId: ids.clinicA,
    name: `Inventory fixture ${Math.random().toString(36).slice(2)}`,
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerMode: 'scheduled',
    conditions: {
      daysBefore: 30,
      minimumAvailableQuantity: 1,
      quantityBasis: 'physical',
      repeatPolicy: 'once_per_threshold'
    },
    schedule: { frequency: 'daily', sendAt: '08:00', timezone: 'tenant' },
    deliveryPolicy: { maxAttempts: 5 },
    channelId: ids.channelA,
    templateKey: 'inventory_lot_expiring_v1',
    templateLanguage: 'es_AR',
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1,
    nextEvaluationAt: '2020-01-01T00:00:00.000Z',
    ...overrides
  };
}

function cashEventInput(clinicId, key, targetRuleId = null, differenceAmount = 50) {
  return {
    clinicId,
    eventType: 'cash.session_closed',
    eventVersion: 1,
    entityType: 'cash_session',
    entityId: key,
    occurredAt: NOW,
    payload: {
      sessionId: key,
      closedAt: NOW,
      currency: 'ARS',
      differenceAmount
    },
    deduplicationKey: `cash.session_closed:${key}:v1`,
    targetRuleId,
    source: 'synthetic_fixture',
    availableAt: '2020-01-01T00:00:00.000Z'
  };
}

async function createRecipient(runtime, clinicId, phoneE164, overrides = {}) {
  return runtime.recipients.createOperationalAlertRecipient({
    clinicId,
    name: overrides.name || 'Fixture Recipient',
    phoneE164,
    roleLabel: overrides.roleLabel || 'owner',
    areaKeys: ['cash'],
    active: overrides.active === undefined ? true : overrides.active,
    consentStatus: overrides.consentStatus || 'granted',
    consentSource: 'synthetic_test',
    consentedAt: overrides.consentStatus === 'pending' ? null : CONSENTED_AT,
    revokedAt: overrides.consentStatus === 'revoked' ? NOW : null,
    staffUserId: overrides.staffUserId || null
  });
}

async function createRule(runtime, db, input, recipientIds = [], enabled = true) {
  let rule = await runtime.rules.createOperationalAlertRule(input);
  if (recipientIds.length) {
    await runtime.rules.replaceOperationalAlertRuleRecipients(rule.id, rule.clinicId, recipientIds);
  }
  if (enabled) {
    await db.query(
      `UPDATE operational_alert_rules
       SET enabled = TRUE, "enabledAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [rule.id]
    );
  }
  rule = await runtime.rules.findOperationalAlertRuleById(rule.id, rule.clinicId);
  return rule;
}

async function materialize(runtime, eventInput, workerId = 'event-worker') {
  const stored = await runtime.events.insertOperationalAlertEvent(eventInput);
  await runtime.eventProcessor.processAvailableOperationalAlertEvents({ workerId, limit: 20, now: NOW });
  const instanceResult = await runtime.instances.listOperationalAlertInstances(eventInput.clinicId, {
    eventId: stored.event.id,
    limit: 20
  });
  const deliveries = [];
  for (const instance of instanceResult) {
    deliveries.push(...await runtime.deliveries.listOperationalAlertDeliveries(eventInput.clinicId, {
      instanceId: instance.id,
      limit: 20
    }));
  }
  return { stored, instances: instanceResult, deliveries };
}

function buildStatusPayload(providerMessageId, status, errors = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'phone-a' },
          statuses: [{ id: providerMessageId, status, timestamp: '1786460400', errors }]
        }
      }]
    }]
  };
}

function validAuthorityFixture() {
  return {
    clinic: { id: ids.clinicA, settings: { operationalAlertsEnabled: true } },
    currentRule: { id: 'rule-a', clinicId: ids.clinicA, enabled: true, archivedAt: null },
    ruleSnapshot: {
      id: 'rule-a',
      channelId: ids.channelA,
      templateKey: 'cash_alert',
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
      id: 'recipient-a',
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
      accessToken: 'fixture-secret-token-a',
      wabaId: 'waba-a'
    },
    template: {
      clinicId: ids.clinicA,
      channelId: ids.channelA,
      wabaId: 'waba-a',
      templateKey: 'cash_alert',
      language: 'es_AR',
      status: 'approved',
      category: 'UTILITY',
      metaTemplateName: 'cash_alert_fixture',
      lastSyncedAt: NOW,
      metadata: { operationalAlertContract: 'operational_alert_body_parameters_v1' }
    },
    workerId: 'worker-a',
    now: NOW
  };
}

async function testWhatsAppRoutingLogRedaction() {
  clearModule('src/whatsapp/whatsapp.service.js');
  clearModule('src/whatsapp/whatsapp-graph.client.js');
  mockModule('src/whatsapp/whatsapp-graph.client.js', {
    buildMessagesEndpointUrl: () => 'https://graph.example/phone-a/messages',
    sendTemplateMessageViaGraphScoped: async () => ({
      ok: false,
      status: 503,
      raw: JSON.stringify({
        error: {
          code: 2,
          message: 'fixture-secret-token-a +5491100000001 phone-a'
        }
      })
    })
  });
  const { sendChannelScopedMessage } = require(path.join(root, 'src/whatsapp/whatsapp.service.js'));
  const observed = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => observed.push(args.map(String).join(' '));
  console.warn = (...args) => observed.push(args.map(String).join(' '));
  console.error = (...args) => observed.push(args.map(String).join(' '));
  try {
    await assert.rejects(
      () => sendChannelScopedMessage({
        to: '5491100000001',
        templateName: 'cash_alert_fixture',
        languageCode: 'es_AR',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'fixture' }] }]
      }, {
        requestId: 'operational-alert:12345678',
        suppressRoutingDiagnostics: true,
        credentials: {
          tenantId: 'tenant-a',
          clinicId: ids.clinicA,
          channelId: ids.channelA,
          accessToken: 'fixture-secret-token-a',
          phoneNumberId: 'phone-a',
          provider: 'whatsapp_cloud',
          status: 'active',
          wabaId: 'waba-a'
        }
      }),
      /status 503/i
    );
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const logs = observed.join('\n');
  assert.doesNotMatch(logs, /5491100000001|0001|fixture-secret-token-a|phone-a|waba-a|tenant-a/);
  assert.match(logs, /\[redacted\]/i);

  clearModule('src/whatsapp/whatsapp-graph.client.js');
  const graphClient = require(path.join(root, 'src/whatsapp/whatsapp-graph.client.js'));
  const graphLogs = [];
  const originalFetch = global.fetch;
  console.log = (...args) => graphLogs.push(args.map(String).join(' '));
  console.warn = (...args) => graphLogs.push(args.map(String).join(' '));
  try {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { code: 2, message: 'fixture graph failure' } })
    });
    await graphClient.sendTemplateMessageViaGraphScoped({
      phoneNumberId: 'phone-a',
      to: '5491100000001',
      templateName: 'cash_alert_fixture',
      languageCode: 'es_AR',
      components: [],
      requestId: 'operational-alert:12345678',
      credentials: {
        channelId: ids.channelA,
        accessToken: 'fixture-secret-token-a',
        phoneNumberId: 'phone-a',
        suppressRoutingDiagnostics: true
      }
    });
  } finally {
    global.fetch = originalFetch;
    console.log = original.log;
    console.warn = original.warn;
  }
  const lowerLogs = graphLogs.join('\n');
  assert.doesNotMatch(lowerLogs, /5491100000001|0001|fixture-secret-token-a|phone-a/);
  assert.match(lowerLogs, /\[redacted\]/i);
}

async function testAuthorityMatrix(runtime) {
  const evaluate = runtime.authority.evaluateInternalOperationalAlertAuthority;
  const valid = validAuthorityFixture();
  assert.strictEqual(evaluate(valid).allowed, true);
  assert.strictEqual(evaluate({
    ...valid,
    workerId: 'different-worker'
  }).resultCode, 'delivery_lease_not_owned');

  assert.strictEqual(evaluate({ ...valid, clinic: { id: ids.clinicA, settings: {} } }).resultCode, 'feature_disabled');
  mark('A');
  assert.strictEqual(evaluate({
    ...valid,
    clinic: { id: ids.clinicA, settings: { operationalAlertsEnabled: false } }
  }).resultCode, 'feature_disabled');
  mark('B');
  assert.strictEqual(evaluate({ ...valid, recipient: { ...valid.recipient, active: false } }).resultCode, 'recipient_inactive');
  mark('G');
  assert.strictEqual(evaluate({
    ...valid,
    recipient: { ...valid.recipient, consentStatus: 'pending' }
  }).resultCode, 'recipient_consent_missing');
  mark('H');
  assert.strictEqual(evaluate({
    ...valid,
    recipient: { ...valid.recipient, consentStatus: 'revoked' }
  }).resultCode, 'recipient_consent_revoked');
  mark('I');
  assert.strictEqual(evaluate({
    ...valid,
    recipient: { ...valid.recipient, staffUserId: ids.staffInactive },
    staff: { id: ids.staffInactive, clinicId: ids.clinicA, active: false }
  }).resultCode, 'staff_inactive');
  mark('J');
  assert.strictEqual(evaluate({
    ...valid,
    channel: { ...valid.channel, clinicId: ids.clinicB }
  }).resultCode, 'channel_scope_invalid');
  mark('L');
  assert.strictEqual(evaluate({
    ...valid,
    channel: { ...valid.channel, status: 'inactive' }
  }).resultCode, 'channel_not_active');
  mark('M');
  assert.strictEqual(evaluate({ ...valid, template: null }).resultCode, 'template_not_configured');
  assert.strictEqual(evaluate({
    ...valid,
    template: { ...valid.template, status: 'rejected' }
  }).resultCode, 'template_not_approved');
  mark('N');
  assert.strictEqual(evaluate({
    ...valid,
    template: { ...valid.template, wabaId: 'wrong-waba' }
  }).resultCode, 'template_scope_mismatch');
  mark('O');
}

async function main() {
  const db = new PGlite();
  try {
    await createBaseSchema(db);
    await seedBase(db);
    const runtime = loadRuntime(db);
    await testAuthorityMatrix(runtime);

    const inventoryEvaluation = runtime.registry.evaluateOperationalAlertCondition(
      inventoryRuleInput(),
      {
        eventType: 'inventory.lot_expiring',
        eventVersion: 1,
        payload: {
          evaluatedAt: '2026-08-11T12:00:00.000Z',
          localDate: '2026-08-11',
          daysBefore: 30,
          quantityBasis: 'physical',
          minimumAvailableQuantity: 1,
          repeatPolicy: 'once_per_threshold',
          configVersion: 1,
          thresholdIdentity: 'days-30-once_per_threshold',
          evaluationWindowKey: '2026-08-11',
          totalLots: 1,
          totalProducts: 1,
          items: [{
            lotId: '60000000-0000-4000-8000-000000000001',
            productId: '70000000-0000-4000-8000-000000000001',
            productName: 'Resina',
            sku: 'RES-1',
            lotCode: 'L-1',
            expiresAt: '2026-09-10',
            daysRemaining: 30,
            relevantQuantity: 4,
            supplierName: null,
            locationName: null
          }],
          truncation: { itemLimit: 250, omittedLots: 0 }
        }
      }
    );
    assert.strictEqual(inventoryEvaluation.outcome, 'MATCH');
    const inventoryFormatted = runtime.formatter.formatOperationalAlertMessage({
      rule: {
        eventType: 'inventory.lot_expiring',
        eventVersion: 1,
        formatterKey: 'inventory_lot_expiring',
        formatterVersion: 1,
        templateKey: 'inventory_lot_expiring_v1',
        templateLanguage: 'es_AR'
      },
      event: { material: inventoryEvaluation.material }
    });
    assert.strictEqual(inventoryFormatted.ok, true);
    assert.strictEqual(inventoryFormatted.value.components[0].parameters.length, 5);
    assert.strictEqual(runtime.registry.evaluateOperationalAlertCondition(
      cashRuleInput(ids.clinicA, ids.channelA),
      { eventType: 'cash.session_closed', eventVersion: 1, payload: {} }
    ).outcome, 'INVALID_CONFIGURATION');
    assert.strictEqual(runtime.registry.evaluateOperationalAlertCondition(
      cashRuleInput(ids.clinicA, ids.channelA),
      {
        eventType: 'cash.session_closed',
        eventVersion: 1,
        payload: { sessionId: 'cash-no-match', closedAt: NOW, currency: 'ARS', differenceAmount: 0 }
      }
    ).outcome, 'NO_MATCH');

    const recipientA = await createRecipient(runtime, ids.clinicA, '+5491100000001');
    const recipientB = await createRecipient(runtime, ids.clinicB, '+5491100000001');
    assert.notStrictEqual(recipientA.id, recipientB.id);
    mark('AD');

    const baselineRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );

    const duplicateInput = cashEventInput(ids.clinicA, 'e2e-one', baselineRule.id);
    const firstInsert = await runtime.events.insertOperationalAlertEvent(duplicateInput);
    const duplicateInsert = await runtime.events.insertOperationalAlertEvent(duplicateInput);
    assert.strictEqual(firstInsert.inserted, true);
    assert.strictEqual(duplicateInsert.inserted, false);
    mark('D');

    await runtime.eventProcessor.processAvailableOperationalAlertEvents({
      workerId: 'event-worker-e2e',
      limit: 10,
      now: NOW
    });
    let e2eInstances = await runtime.instances.listOperationalAlertInstances(ids.clinicA, {
      eventId: firstInsert.event.id
    });
    assert.strictEqual(e2eInstances.length, 1);
    let e2eDeliveries = await runtime.deliveries.listOperationalAlertDeliveries(ids.clinicA, {
      instanceId: e2eInstances[0].id
    });
    assert.strictEqual(e2eDeliveries.length, 1);

    const graphCalls = [];
    const sendSuccess = async (payload, context) => {
      graphCalls.push({ payload: JSON.parse(JSON.stringify(payload)), context: JSON.parse(JSON.stringify(context)) });
      return { messageId: `wamid-operational-${graphCalls.length}`, status: 200 };
    };
    const capturedLogs = [];
    const originalLog = console.log;
    console.log = (...args) => capturedLogs.push(args.map(String).join(' '));
    try {
      const sentStats = await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
        workerId: 'delivery-worker-e2e',
        limit: 10,
        now: NOW,
        dependencies: { sendChannelScopedMessage: sendSuccess }
      });
      assert.strictEqual(sentStats.sent, 1);
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(graphCalls.length, 1);
    assert.strictEqual(graphCalls[0].payload.templateName, 'cash_alert_fixture');
    assert.ok(Array.isArray(graphCalls[0].payload.components));
    assert.ok(!Object.prototype.hasOwnProperty.call(graphCalls[0].payload, 'text'));
    assert.strictEqual(graphCalls[0].context.suppressRoutingDiagnostics, true);
    assert.doesNotMatch(capturedLogs.join('\n'), /\+5491100000001|fixture-secret-token-a|differenceAmount|"payload"/);
    mark('AC', 'AH');

    e2eDeliveries = await runtime.deliveries.listOperationalAlertDeliveries(ids.clinicA, {
      instanceId: e2eInstances[0].id
    });
    assert.strictEqual(e2eDeliveries[0].status, 'sent');
    assert.ok(e2eDeliveries[0].graphRequestStartedAt);
    assert.ok(e2eDeliveries[0].providerMessageId);
    assert.ok(e2eDeliveries[0].messageSnapshot);

    await runtime.statusService.reconcileOrderCustomerNotificationStatuses(
      buildStatusPayload(e2eDeliveries[0].providerMessageId, 'delivered'),
      { dependencies: { reconcileStatus: async () => null } }
    );
    await runtime.statusService.reconcileOrderCustomerNotificationStatuses(
      buildStatusPayload(e2eDeliveries[0].providerMessageId, 'read'),
      { dependencies: { reconcileStatus: async () => null } }
    );
    await runtime.statusService.reconcileOrderCustomerNotificationStatuses(
      buildStatusPayload(e2eDeliveries[0].providerMessageId, 'sent'),
      { dependencies: { reconcileStatus: async () => null } }
    );
    e2eDeliveries = await runtime.deliveries.listOperationalAlertDeliveries(ids.clinicA, {
      instanceId: e2eInstances[0].id
    });
    assert.strictEqual(e2eDeliveries[0].status, 'read');
    mark('W');

    let operationalFallbackCalls = 0;
    const orderStatusStats = await runtime.statusService.reconcileOrderCustomerNotificationStatuses(
      buildStatusPayload('wamid-order-summary', 'delivered'),
      {
        dependencies: {
          findChannelByPhoneNumberId: async () => ({ id: ids.channelA, clinicId: ids.clinicA }),
          reconcileStatus: async () => ({ id: 'order-summary-notification', status: 'delivered' }),
          reconcileOperationalStatus: async () => {
            operationalFallbackCalls += 1;
            return null;
          }
        }
      }
    );
    assert.strictEqual(orderStatusStats.orderSummaryMatched, 1);
    assert.strictEqual(operationalFallbackCalls, 0);
    mark('X');

    const secondRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );
    const twoRuleEvent = await materialize(runtime, cashEventInput(ids.clinicA, 'two-rules'));
    assert.strictEqual(twoRuleEvent.instances.length, 2);
    mark('E');
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-two-rules',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });

    const recipientA2 = await createRecipient(runtime, ids.clinicA, '+5491100000002');
    await runtime.rules.replaceOperationalAlertRuleRecipients(
      secondRule.id,
      ids.clinicA,
      [recipientA.id, recipientA2.id]
    );
    const refreshedSecondRule = await runtime.rules.findOperationalAlertRuleById(secondRule.id, ids.clinicA);
    const twoRecipientEvent = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'two-recipients', refreshedSecondRule.id)
    );
    assert.strictEqual(twoRecipientEvent.instances.length, 1);
    assert.strictEqual(twoRecipientEvent.deliveries.length, 2);
    mark('F');
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-two-recipients',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });

    const disabledRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id],
      false
    );
    const disabledEvent = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'disabled-rule', disabledRule.id)
    );
    assert.strictEqual(disabledEvent.instances.length, 0);
    assert.strictEqual(disabledEvent.deliveries.length, 0);
    mark('C');

    const falseTenantRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicC, null, { templateKey: null, templateLanguage: null }),
      []
    );
    const falseTenantEvent = await materialize(
      runtime,
      cashEventInput(ids.clinicC, 'feature-false', falseTenantRule.id)
    );
    assert.strictEqual(falseTenantEvent.instances.length, 0);

    const changingRecipient = await createRecipient(runtime, ids.clinicA, '+5491100000010');
    const changeRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [changingRecipient.id]
    );
    const changeMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'recipient-change', changeRule.id)
    );
    const frozenRecipientSnapshot = JSON.parse(JSON.stringify(changeMaterialized.deliveries[0].recipientSnapshot));
    await runtime.recipients.updateOperationalAlertRecipient(changingRecipient.id, ids.clinicA, {
      phoneE164: '+5491100000011'
    });
    const graphBeforeRecipientChange = graphCalls.length;
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-recipient-change',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });
    const changedDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(
      changeMaterialized.deliveries[0].id,
      ids.clinicA
    );
    assert.strictEqual(graphCalls.length, graphBeforeRecipientChange);
    assert.strictEqual(changedDelivery.resultCode, 'recipient_changed_before_send');
    assert.deepStrictEqual(changedDelivery.recipientSnapshot, frozenRecipientSnapshot);
    mark('K', 'Z');

    const retryRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );
    const retryMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'graph-503', retryRule.id)
    );
    const graph503 = new Error('fixture graph 503');
    graph503.graphStatus = 503;
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-503',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: async () => { throw graph503; } }
    });
    let retryDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(
      retryMaterialized.deliveries[0].id,
      ids.clinicA
    );
    assert.strictEqual(retryDelivery.status, 'failed_retryable');
    const retrySnapshot = JSON.parse(JSON.stringify(retryDelivery.messageSnapshot));
    mark('P');

    await runtime.rules.updateOperationalAlertRuleConfig(retryRule.id, ids.clinicA, {
      conditions: { minimumAbsoluteDifference: 25, onlyWithDifference: true }
    });
    await db.query(
      `UPDATE operational_alert_deliveries SET "availableAt" = NOW() WHERE id = $1::uuid`,
      [retryDelivery.id]
    );
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-503-retry',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });
    retryDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(retryDelivery.id, ids.clinicA);
    assert.strictEqual(retryDelivery.status, 'sent');
    assert.deepStrictEqual(retryDelivery.messageSnapshot, retrySnapshot);
    mark('Y');

    const oneAttemptRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA, { deliveryPolicy: { maxAttempts: 1 } }),
      [recipientA.id]
    );
    const oneAttemptMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'graph-503-one-attempt', oneAttemptRule.id)
    );
    let oneAttemptGraphCalls = 0;
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-503-one-attempt',
      limit: 10,
      now: NOW,
      dependencies: {
        sendChannelScopedMessage: async () => {
          oneAttemptGraphCalls += 1;
          throw graph503;
        }
      }
    });
    let oneAttemptDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(
      oneAttemptMaterialized.deliveries[0].id,
      ids.clinicA
    );
    assert.strictEqual(oneAttemptGraphCalls, 1);
    assert.strictEqual(oneAttemptDelivery.status, 'failed_permanent');
    assert.strictEqual(oneAttemptDelivery.resultCode, 'retry_attempts_exhausted');
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-503-one-attempt-repeat',
      limit: 10,
      now: NOW,
      dependencies: {
        sendChannelScopedMessage: async () => {
          oneAttemptGraphCalls += 1;
          throw graph503;
        }
      }
    });
    oneAttemptDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(
      oneAttemptDelivery.id,
      ids.clinicA
    );
    assert.strictEqual(oneAttemptGraphCalls, 1);
    assert.strictEqual(oneAttemptDelivery.status, 'failed_permanent');
    mark('AI');

    const permanentRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );
    const permanentMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'graph-400', permanentRule.id)
    );
    const graph400 = new Error('fixture graph 400');
    graph400.graphStatus = 400;
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-400',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: async () => { throw graph400; } }
    });
    assert.strictEqual(
      (await runtime.deliveries.findOperationalAlertDeliveryById(permanentMaterialized.deliveries[0].id, ids.clinicA)).status,
      'failed_permanent'
    );
    mark('Q');

    const timeoutRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );
    const timeoutMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'graph-timeout', timeoutRule.id)
    );
    const timeoutError = new Error('fixture timeout');
    timeoutError.code = 'ETIMEDOUT';
    const graphBeforeTimeout = graphCalls.length;
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-timeout',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: async () => { throw timeoutError; } }
    });
    const timeoutDelivery = await runtime.deliveries.findOperationalAlertDeliveryById(
      timeoutMaterialized.deliveries[0].id,
      ids.clinicA
    );
    assert.strictEqual(timeoutDelivery.status, 'unknown_delivery');
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-timeout-second',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });
    assert.strictEqual(graphCalls.length, graphBeforeTimeout);
    mark('R');

    const leaseRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id]
    );
    const preGraphMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'lease-pre', leaseRule.id)
    );
    await db.query(
      `UPDATE operational_alert_deliveries
       SET status = 'sending', "attemptCount" = 1, "lockedAt" = '2020-01-01T00:00:00Z',
           "lockedBy" = 'dead-worker', "leaseExpiresAt" = '2020-01-01T00:01:00Z',
           "graphRequestStartedAt" = NULL
       WHERE id = $1::uuid`,
      [preGraphMaterialized.deliveries[0].id]
    );
    const preRecovery = await runtime.deliveryProcessor.recoverOperationalAlertDeliveries();
    assert.strictEqual(preRecovery.preGraph, 1);
    assert.strictEqual(
      (await runtime.deliveries.findOperationalAlertDeliveryById(preGraphMaterialized.deliveries[0].id, ids.clinicA)).status,
      'failed_retryable'
    );
    mark('S');

    const postGraphMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'lease-post', leaseRule.id)
    );
    await db.query(
      `UPDATE operational_alert_deliveries
       SET status = 'sending', "attemptCount" = 1, "lockedAt" = '2020-01-01T00:00:00Z',
           "lockedBy" = 'dead-worker', "leaseExpiresAt" = '2020-01-01T00:01:00Z',
           "graphRequestStartedAt" = '2020-01-01T00:00:30Z', "providerMessageId" = NULL
       WHERE id = $1::uuid`,
      [postGraphMaterialized.deliveries[0].id]
    );
    const postRecovery = await runtime.deliveryProcessor.recoverOperationalAlertDeliveries();
    assert.strictEqual(postRecovery.postGraph, 1);
    assert.strictEqual(
      (await runtime.deliveries.findOperationalAlertDeliveryById(postGraphMaterialized.deliveries[0].id, ids.clinicA)).status,
      'unknown_delivery'
    );
    mark('T');

    const providerKnownMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'lease-known', leaseRule.id)
    );
    await db.query(
      `UPDATE operational_alert_deliveries
       SET status = 'sending', "attemptCount" = 1, "lockedAt" = '2020-01-01T00:00:00Z',
           "lockedBy" = 'dead-worker', "leaseExpiresAt" = '2020-01-01T00:01:00Z',
           "graphRequestStartedAt" = '2020-01-01T00:00:30Z', "providerMessageId" = 'wamid-known'
       WHERE id = $1::uuid`,
      [providerKnownMaterialized.deliveries[0].id]
    );
    const knownRecovery = await runtime.deliveryProcessor.recoverOperationalAlertDeliveries();
    assert.strictEqual(knownRecovery.providerKnown, 1);
    assert.strictEqual(
      (await runtime.deliveries.findOperationalAlertDeliveryById(providerKnownMaterialized.deliveries[0].id, ids.clinicA)).status,
      'sent'
    );
    mark('V');

    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'delivery-worker-pre-recovered',
      limit: 10,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });

    const concurrentMaterialized = await materialize(
      runtime,
      cashEventInput(ids.clinicA, 'concurrent-claim', leaseRule.id)
    );
    const firstClaim = await runtime.deliveries.claimOperationalAlertDeliveries({
      workerId: 'concurrent-worker-1',
      limit: 1
    });
    const secondClaim = await runtime.deliveries.claimOperationalAlertDeliveries({
      workerId: 'concurrent-worker-2',
      limit: 1
    });
    assert.strictEqual(firstClaim.length + secondClaim.length, 1);
    const graphBeforeConcurrent = graphCalls.length;
    const concurrentClaim = firstClaim[0] || secondClaim[0];
    await Promise.all([
      runtime.deliveryProcessor.processOperationalAlertDelivery(concurrentClaim, {
        now: NOW,
        dependencies: { sendChannelScopedMessage: sendSuccess }
      }),
      runtime.deliveryProcessor.processOperationalAlertDelivery(concurrentClaim, {
        now: NOW,
        dependencies: { sendChannelScopedMessage: sendSuccess }
      })
    ]);
    assert.strictEqual(graphCalls.length, graphBeforeConcurrent + 1);
    assert.strictEqual(
      (await runtime.deliveries.findOperationalAlertDeliveryById(concurrentMaterialized.deliveries[0].id, ids.clinicA)).status,
      'sent'
    );
    mark('U');

    const partialRule = await createRule(
      runtime,
      db,
      cashRuleInput(ids.clinicA, ids.channelA),
      [recipientA.id, recipientA2.id]
    );
    const partial = await materialize(runtime, cashEventInput(ids.clinicA, 'partial-instance', partialRule.id));
    await runtime.deliveries.updateOperationalAlertDeliveryStatus(partial.deliveries[0].id, ids.clinicA, {
      status: 'sent',
      resultCode: 'graph_accepted',
      providerMessageId: 'wamid-partial-success'
    });
    await runtime.deliveries.updateOperationalAlertDeliveryStatus(partial.deliveries[1].id, ids.clinicA, {
      status: 'failed_permanent',
      resultCode: 'template_not_approved'
    });
    const partialInstance = await runtime.instances.aggregateOperationalAlertInstanceStatus(
      partial.instances[0].id,
      ids.clinicA
    );
    assert.strictEqual(partialInstance.status, 'completed_with_errors');
    mark('AE');

    const countInstancesBeforeRetry = Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_instances WHERE "eventId" = $1::uuid`,
      [firstInsert.event.id]
    ));
    const countDeliveriesBeforeRetry = Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_deliveries WHERE "instanceId" = $1::uuid`,
      [e2eInstances[0].id]
    ));
    await db.query(
      `UPDATE operational_alert_events
       SET status = 'failed_retryable', "availableAt" = NOW(), "processedAt" = NULL
       WHERE id = $1::uuid`,
      [firstInsert.event.id]
    );
    await runtime.eventProcessor.processAvailableOperationalAlertEvents({
      workerId: 'event-worker-retry',
      limit: 10,
      now: NOW
    });
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_instances WHERE "eventId" = $1::uuid`,
      [firstInsert.event.id]
    )), countInstancesBeforeRetry);
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_deliveries WHERE "instanceId" = $1::uuid`,
      [e2eInstances[0].id]
    )), countDeliveriesBeforeRetry);
    mark('AF');

    await assert.rejects(
      () => db.query(
        `UPDATE operational_alert_deliveries
         SET "messageSnapshot" = '{"changed":true}'::jsonb
         WHERE id = $1::uuid`,
        [e2eDeliveries[0].id]
      ),
      /identity and snapshots are immutable/i
    );
    mark('AG');

    const zeroBefore = {
      events: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_events WHERE "clinicId" = $1::uuid`, [ids.clinicD])),
      instances: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_instances WHERE "clinicId" = $1::uuid`, [ids.clinicD])),
      deliveries: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_deliveries WHERE "clinicId" = $1::uuid`, [ids.clinicD]))
    };
    const graphBeforeZero = graphCalls.length;
    await runtime.scheduler.runOperationalAlertScheduledSweep({ workerId: 'zero-worker', limit: 5, now: NOW });
    await runtime.eventProcessor.processAvailableOperationalAlertEvents({ workerId: 'zero-worker', limit: 5, now: NOW });
    await runtime.deliveryProcessor.recoverOperationalAlertDeliveries();
    await runtime.deliveryProcessor.processAvailableOperationalAlertDeliveries({
      workerId: 'zero-worker',
      limit: 5,
      now: NOW,
      dependencies: { sendChannelScopedMessage: sendSuccess }
    });
    assert.deepStrictEqual({
      events: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_events WHERE "clinicId" = $1::uuid`, [ids.clinicD])),
      instances: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_instances WHERE "clinicId" = $1::uuid`, [ids.clinicD])),
      deliveries: Number(await scalar(db, `SELECT COUNT(*)::int FROM operational_alert_deliveries WHERE "clinicId" = $1::uuid`, [ids.clinicD]))
    }, zeroBefore);
    assert.strictEqual(graphCalls.length, graphBeforeZero);
    mark('AA');

    const scheduledRule = await createRule(runtime, db, inventoryRuleInput(), [recipientA.id]);
    const scheduledStats = await runtime.scheduler.runOperationalAlertScheduledSweep({
      workerId: 'scheduled-worker',
      limit: 5,
      now: NOW
    });
    assert.strictEqual(scheduledStats.missingEvaluator, 0);
    assert.strictEqual(scheduledStats.evaluated, 1);
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_events WHERE "targetRuleId" = $1::uuid`,
      [scheduledRule.id]
    )), 0);
    assert.strictEqual(
      Boolean((await runtime.rules.findOperationalAlertRuleById(scheduledRule.id, ids.clinicA)).nextEvaluationAt),
      true
    );
    mark('AB');

    await testWhatsAppRoutingLogRedaction();

    const expectedLabels = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI'
    ];
    assert.deepStrictEqual(Array.from(covered).sort(), expectedLabels.sort());
    console.log('operational-alerts-engine.test.js passed (A-AI)');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
