const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const migrationPath = path.join(root, 'db/migrations/074_operational_alerts_foundation.sql');
const covered = new Set();

const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  ownerA: '20000000-0000-4000-8000-000000000001',
  managerB: '20000000-0000-4000-8000-000000000002',
  staffA: '20000000-0000-4000-8000-000000000003',
  staffB: '20000000-0000-4000-8000-000000000004',
  staffInactiveB: '20000000-0000-4000-8000-000000000005',
  channelA: '30000000-0000-4000-8000-000000000001',
  channelB: '30000000-0000-4000-8000-000000000002',
  eventB: '40000000-0000-4000-8000-000000000001',
  instanceB: '50000000-0000-4000-8000-000000000001'
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
      "externalTenantId" TEXT UNIQUE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE staff_users (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      name TEXT NOT NULL,
      email TEXT NULL,
      role TEXT NOT NULL,
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

    CREATE TABLE whatsapp_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      "externalTenantId" TEXT NULL,
      "channelId" UUID NULL,
      "wabaId" TEXT NULL,
      "templateKey" TEXT NOT NULL,
      "metaTemplateId" TEXT NULL,
      "metaTemplateName" TEXT NULL,
      language TEXT NOT NULL,
      category TEXT NULL,
      status TEXT NULL,
      "rejectionReason" TEXT NULL,
      definition JSONB NOT NULL DEFAULT '{}'::jsonb,
      "lastSyncedAt" TIMESTAMPTZ NULL,
      metadata JSONB NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE ("clinicId", "templateKey", language)
    );

    CREATE TABLE portal_user_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" TEXT NOT NULL,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      "actorUserId" UUID NULL REFERENCES staff_users(id),
      "targetUserId" UUID NULL REFERENCES staff_users(id),
      action TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migration = fs.readFileSync(migrationPath, 'utf8')
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/gi, '');
  await db.exec(migration);
}

async function seedBaseData(db) {
  await db.query(
    `INSERT INTO clinics (id, name, "externalTenantId", settings) VALUES
      ($1::uuid, 'Tenant A', 'tenant-a', '{}'::jsonb),
      ($2::uuid, 'Tenant B', 'tenant-b', '{"operationalAlertsEnabled":true}'::jsonb)`,
    [ids.clinicA, ids.clinicB]
  );
  await db.query(
    `INSERT INTO staff_users (id, "clinicId", name, email, role, "accountType", active) VALUES
      ($1::uuid, $2::uuid, 'Owner A', 'owner-a@example.test', 'owner', 'internal_staff', TRUE),
      ($3::uuid, $4::uuid, 'Manager B', 'manager-b@example.test', 'manager', 'internal_staff', TRUE),
      ($5::uuid, $2::uuid, 'Staff A', 'staff-a@example.test', 'seller', 'internal_staff', TRUE),
      ($6::uuid, $4::uuid, 'Staff B', 'staff-b@example.test', 'seller', 'internal_staff', TRUE),
      ($7::uuid, $4::uuid, 'Inactive B', 'inactive-b@example.test', 'seller', 'internal_staff', FALSE)`,
    [
      ids.ownerA,
      ids.clinicA,
      ids.managerB,
      ids.clinicB,
      ids.staffA,
      ids.staffB,
      ids.staffInactiveB
    ]
  );
  await db.query(
    `INSERT INTO channels (
       id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status
     ) VALUES
      ($1::uuid, $2::uuid, 'whatsapp_cloud', 'phone-a', 'waba-a', 'token-a', 'active'),
      ($3::uuid, $4::uuid, 'whatsapp_cloud', 'phone-b', 'waba-b', 'token-b', 'active')`,
    [ids.channelA, ids.clinicA, ids.channelB, ids.clinicB]
  );

  const validDefinition = JSON.stringify({
    components: [{ type: 'BODY', text: 'Caja {{1}} cerrada {{2}} diferencia {{3}} {{4}}' }]
  });
  const validMetadata = JSON.stringify({
    operationalAlertContract: 'operational_alert_body_parameters_v1'
  });
  await db.query(
    `INSERT INTO whatsapp_templates (
       "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey",
       "metaTemplateName", language, category, status, definition, metadata
     ) VALUES
      ($1::uuid, 'tenant-b', $2::uuid, 'waba-b', 'cash_alert', 'cash_alert_meta', 'es_AR', 'UTILITY', 'approved', $3::jsonb, $4::jsonb),
      ($1::uuid, 'tenant-b', $2::uuid, 'waba-b', 'cash_alert_pending', 'cash_alert_pending_meta', 'es_AR', 'UTILITY', 'pending', $3::jsonb, $4::jsonb)`,
    [ids.clinicB, ids.channelB, validDefinition, validMetadata]
  );
}

function loadService(db) {
  [
    'src/db/client.js',
    'src/repositories/tenant.repository.js',
    'src/repositories/staff.repository.js',
    'src/repositories/whatsapp-templates.repository.js',
    'src/repositories/portal-user-audit.repository.js',
    'src/repositories/operational-alert-recipients.repository.js',
    'src/repositories/operational-alert-rules.repository.js',
    'src/repositories/operational-alert-admin.repository.js',
    'src/services/portal-operational-alerts.service.js'
  ].forEach(clearModule);
  installDbClientStub(db);
  return require(path.join(root, 'src/services/portal-operational-alerts.service.js'));
}

async function expectError(work, code, status = null) {
  let captured = null;
  try {
    await work();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, `Expected ${code} to be rejected`);
  assert.equal(captured.code, code);
  if (status !== null) assert.equal(captured.status, status);
  return captured;
}

async function countRows(db, table) {
  const result = await db.query(`SELECT COUNT(*)::int AS total FROM ${table}`);
  return Number(result.rows[0].total);
}

function cashRuleInput(overrides = {}) {
  return {
    name: 'Cash session difference',
    eventType: 'cash.session_closed',
    eventVersion: 1,
    triggerMode: 'event_driven',
    conditions: { minimumAbsoluteDifference: 0, onlyWithDifference: false },
    schedule: {},
    deliveryPolicy: { maxAttempts: 3 },
    channelId: ids.channelB,
    templateKey: 'cash_alert',
    templateLanguage: 'es_AR',
    formatterKey: 'cash_session_closed',
    formatterVersion: 1,
    ...overrides
  };
}

async function testAuthorization() {
  let actor = { id: ids.ownerA, tenantId: 'tenant-a', role: 'owner', isAdmin: false };
  let internalAuth = true;
  mockModule('src/services/portal-active-tenant.service.js', {
    hasPortalInternalAuth: () => internalAuth,
    findPortalActorContext: async () => actor
  });
  clearModule('src/middlewares/portal-operational-alerts-authorization.middleware.js');
  const {
    requireOperationalAlertsReadPermission,
    requireOperationalAlertsWritePermission
  } = require(path.join(root, 'src/middlewares/portal-operational-alerts-authorization.middleware.js'));

  function request(targetTenant = 'tenant-a', activeContext = null) {
    return {
      params: { tenantId: targetTenant },
      activeTenantId: targetTenant,
      activeTenantContext: activeContext,
      get: (name) => (name === 'x-portal-actor-id' ? actor.id : '')
    };
  }
  function response() {
    return {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return payload;
      }
    };
  }

  let nextCalled = false;
  await requireOperationalAlertsReadPermission()(request(), response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  mark('A');

  actor = { ...actor, role: 'viewer' };
  const viewerRes = response();
  await requireOperationalAlertsWritePermission()(request(), viewerRes, () => {});
  assert.equal(viewerRes.statusCode, 403);
  mark('B');

  actor = { ...actor, role: 'owner', tenantId: 'tenant-a' };
  const crossTenantRes = response();
  await requireOperationalAlertsReadPermission()(request('tenant-b'), crossTenantRes, () => {});
  assert.equal(crossTenantRes.statusCode, 403);
  mark('C');

  actor = { id: ids.ownerA, tenantId: 'admin-tenant', role: 'owner', isAdmin: true };
  const directAdminRes = response();
  await requireOperationalAlertsReadPermission()(request('tenant-b'), directAdminRes, () => {});
  assert.equal(directAdminRes.statusCode, 403);
  nextCalled = false;
  await requireOperationalAlertsReadPermission()(
    request('tenant-b', {
      source: 'active_tenant',
      actorUserId: actor.id,
      activeTenantId: 'tenant-b'
    }),
    response(),
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);

  internalAuth = false;
  const noInternalAuthRes = response();
  await requireOperationalAlertsReadPermission()(request('tenant-b'), noInternalAuthRes, () => {});
  assert.equal(noInternalAuthRes.statusCode, 403);
}

async function testAdminService(db, service) {
  const actorA = { id: ids.ownerA, role: 'owner', tenantId: 'tenant-a' };
  const actorB = { id: ids.managerB, role: 'manager', tenantId: 'tenant-b' };

  const catalog = await service.getEventTypes('tenant-b');
  assert.equal(catalog.items.length, 2);
  assert.ok(catalog.items.every((item) => item.producer.status === 'CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE'));
  assert.ok(catalog.items.every((item) => item.conditionsContract && item.scheduleContract));

  const settingsA = await service.getSettings('tenant-a');
  assert.equal(settingsA.operationalAlertsEnabled, false);
  assert.equal(settingsA.mutable, false);
  mark('AG');

  const recipientA = await service.createRecipient('tenant-a', {
    name: 'Responsible A',
    phoneE164: '+5491100000001',
    areaKeys: ['inventory']
  }, actorA);
  assert.equal(recipientA.active, false);
  assert.equal(recipientA.consent.status, 'pending');
  mark('D');

  await expectError(
    () => service.createRecipient('tenant-a', {
      name: 'Duplicate A',
      phoneE164: '+5491100000001'
    }, actorA),
    'operational_alert_recipient_phone_already_exists',
    409
  );
  mark('E');

  let recipientB = await service.createRecipient('tenant-b', {
    name: 'Responsible B',
    phoneE164: '+5491100000001',
    staffUserId: ids.staffB,
    areaKeys: ['cash']
  }, actorB);
  assert.notEqual(recipientA.id, recipientB.id);
  mark('F');

  await expectError(
    () => service.createRecipient('tenant-b', {
      name: 'Unsafe consent create',
      phoneE164: '+5491100000099',
      active: true
    }, actorB),
    'operational_alert_recipient_create_payload_invalid_unknown_key'
  );

  recipientB = await service.updateRecipient('tenant-b', recipientB.id, {
    active: true,
    expectedVersion: recipientB.version
  }, actorB);
  assert.equal(recipientB.active, true);
  assert.equal(recipientB.consent.status, 'pending');
  mark('G');

  await expectError(
    () => service.updateRecipient('tenant-b', recipientB.id, {
      name: 'Stale update',
      expectedVersion: 1
    }, actorB),
    'operational_alert_recipient_version_conflict',
    409
  );
  mark('J');

  await expectError(
    () => service.updateRecipientConsent('tenant-b', recipientB.id, {
      status: 'granted',
      expectedVersion: recipientB.version
    }, actorB),
    'operational_alert_consent_source_required'
  );
  await expectError(
    () => service.updateRecipientConsent('tenant-b', recipientB.id, {
      status: 'granted',
      consentSource: 'written_authorization',
      expectedVersion: recipientB.version
    }, actorB),
    'operational_alert_consented_at_required'
  );
  mark('H');

  recipientB = await service.updateRecipientConsent('tenant-b', recipientB.id, {
    status: 'granted',
    consentSource: 'written_authorization',
    consentedAt: '2026-08-11T12:00:00.000Z',
    expectedVersion: recipientB.version
  }, actorB);
  assert.equal(recipientB.consent.status, 'granted');

  await expectError(
    () => service.updateRecipient('tenant-b', recipientB.id, {
      staffUserId: ids.staffA,
      expectedVersion: recipientB.version
    }, actorB),
    'operational_alert_recipient_staff_user_not_found'
  );
  const afterStaffRollback = await service.getRecipient('tenant-b', recipientB.id);
  assert.equal(afterStaffRollback.staff.id, ids.staffB);
  assert.equal(afterStaffRollback.version, recipientB.version);
  mark('K');

  let pendingB = await service.createRecipient('tenant-b', {
    name: 'Pending B',
    phoneE164: '+5491100000002'
  }, actorB);
  pendingB = await service.updateRecipient('tenant-b', pendingB.id, {
    active: true,
    expectedVersion: pendingB.version
  }, actorB);

  let inactiveB = await service.createRecipient('tenant-b', {
    name: 'Inactive B',
    phoneE164: '+5491100000003',
    staffUserId: ids.staffInactiveB
  }, actorB);
  inactiveB = await service.updateRecipientConsent('tenant-b', inactiveB.id, {
    status: 'granted',
    consentSource: 'written_authorization',
    consentedAt: '2026-08-11T12:10:00.000Z',
    expectedVersion: inactiveB.version
  }, actorB);

  let revokedB = await service.createRecipient('tenant-b', {
    name: 'Revoked B',
    phoneE164: '+5491100000004'
  }, actorB);
  revokedB = await service.updateRecipient('tenant-b', revokedB.id, {
    active: true,
    expectedVersion: revokedB.version
  }, actorB);
  revokedB = await service.updateRecipientConsent('tenant-b', revokedB.id, {
    status: 'granted',
    consentSource: 'written_authorization',
    consentedAt: '2026-08-11T12:20:00.000Z',
    expectedVersion: revokedB.version
  }, actorB);
  revokedB = await service.updateRecipientConsent('tenant-b', revokedB.id, {
    status: 'revoked',
    revokedAt: '2026-08-11T12:30:00.000Z',
    expectedVersion: revokedB.version
  }, actorB);
  assert.equal(revokedB.consent.status, 'revoked');

  await expectError(
    () => service.createRule('tenant-b', { ...cashRuleInput(), enabled: true }, actorB),
    'operational_alert_rule_create_payload_invalid_unknown_key'
  );
  let mainRule = await service.createRule('tenant-b', cashRuleInput(), actorB);
  assert.equal(mainRule.enabled, false);
  assert.equal(mainRule.configVersion, 1);
  mark('L');

  await expectError(
    () => service.createRule('tenant-b', cashRuleInput({ eventType: 'cash.unknown' }), actorB),
    'operational_alert_rule_event_type_unknown'
  );
  mark('M');
  await expectError(
    () => service.createRule('tenant-b', cashRuleInput({ conditions: { minimumAbsoluteDifference: 'many' } }), actorB),
    'operational_alert_rule_conditions_minimum_difference_invalid'
  );
  mark('N');
  await expectError(
    () => service.createRule('tenant-b', cashRuleInput({ triggerMode: 'scheduled' }), actorB),
    'operational_alert_rule_trigger_mode_invalid'
  );
  mark('O');

  mainRule = await service.replaceRuleRecipients('tenant-b', mainRule.id, {
    recipientIds: [recipientB.id],
    expectedConfigVersion: mainRule.configVersion
  }, actorB);
  assert.deepEqual(mainRule.recipientIds, [recipientB.id]);
  assert.equal(mainRule.configVersion, 2);
  mark('P');

  await expectError(
    () => service.replaceRuleRecipients('tenant-b', mainRule.id, {
      recipientIds: [recipientA.id],
      expectedConfigVersion: mainRule.configVersion
    }, actorB),
    'operational_alert_rule_recipient_not_found'
  );
  const afterMembershipRollback = await service.getRule('tenant-b', mainRule.id);
  assert.deepEqual(afterMembershipRollback.recipientIds, [recipientB.id]);
  assert.equal(afterMembershipRollback.configVersion, 2);
  mark('Q');

  mainRule = await service.updateRule('tenant-b', mainRule.id, {
    conditions: { minimumAbsoluteDifference: 10, onlyWithDifference: false },
    expectedConfigVersion: mainRule.configVersion
  }, actorB);
  assert.equal(mainRule.configVersion, 3);
  mark('R');

  await expectError(
    () => service.updateRule('tenant-b', mainRule.id, {
      name: 'Stale rule update',
      expectedConfigVersion: 2
    }, actorB),
    'operational_alert_rule_version_conflict',
    409
  );

  const ruleA = await service.createRule('tenant-a', cashRuleInput({
    name: 'Feature disabled rule',
    channelId: ids.channelA,
    templateKey: null,
    templateLanguage: null
  }), actorA);
  const readinessA = await service.getRuleReadiness('tenant-a', ruleA.id);
  assert.ok(readinessA.blockers.some((item) => item.code === 'FEATURE_DISABLED'));
  mark('S');

  const inactiveRule = await service.createRule('tenant-b', cashRuleInput({ name: 'Inactive recipient rule' }), actorB);
  const inactiveRuleWithRecipient = await service.replaceRuleRecipients('tenant-b', inactiveRule.id, {
    recipientIds: [inactiveB.id],
    expectedConfigVersion: inactiveRule.configVersion
  }, actorB);
  const inactiveReadiness = await service.getRuleReadiness('tenant-b', inactiveRule.id);
  assert.ok(inactiveReadiness.blockers.some((item) => item.code === 'RECIPIENT_INACTIVE'));
  assert.equal(inactiveRuleWithRecipient.enabled, false);
  mark('U');

  const pendingRule = await service.createRule('tenant-b', cashRuleInput({ name: 'Pending consent rule' }), actorB);
  await service.replaceRuleRecipients('tenant-b', pendingRule.id, {
    recipientIds: [pendingB.id],
    expectedConfigVersion: pendingRule.configVersion
  }, actorB);
  const pendingReadiness = await service.getRuleReadiness('tenant-b', pendingRule.id);
  assert.ok(pendingReadiness.blockers.some((item) => item.code === 'RECIPIENT_CONSENT_MISSING'));
  mark('V');

  const revokedRule = await service.createRule('tenant-b', cashRuleInput({ name: 'Revoked consent rule' }), actorB);
  await service.replaceRuleRecipients('tenant-b', revokedRule.id, {
    recipientIds: [revokedB.id],
    expectedConfigVersion: revokedRule.configVersion
  }, actorB);
  const revokedReadiness = await service.getRuleReadiness('tenant-b', revokedRule.id);
  assert.ok(revokedReadiness.blockers.some((item) => item.code === 'RECIPIENT_CONSENT_MISSING'));
  mark('I');

  await db.query(
    `UPDATE operational_alert_recipients
     SET "consentSource" = NULL
     WHERE id = $1::uuid`,
    [recipientB.id]
  );
  const incompleteConsentReadiness = await service.getRuleReadiness('tenant-b', mainRule.id);
  assert.ok(incompleteConsentReadiness.blockers.some((item) => item.code === 'RECIPIENT_CONSENT_MISSING'));
  await db.query(
    `UPDATE operational_alert_recipients
     SET "consentSource" = 'written_authorization'
     WHERE id = $1::uuid`,
    [recipientB.id]
  );

  const missingChannelRule = await service.createRule('tenant-b', cashRuleInput({
    name: 'Missing channel rule',
    channelId: null,
    templateKey: null,
    templateLanguage: null
  }), actorB);
  const missingChannelReadiness = await service.getRuleReadiness('tenant-b', missingChannelRule.id);
  assert.ok(missingChannelReadiness.blockers.some((item) => item.code === 'CHANNEL_MISSING'));
  mark('W');

  const missingTemplateRule = await service.createRule('tenant-b', cashRuleInput({
    name: 'Missing template rule',
    templateKey: 'not_registered',
    templateLanguage: 'es_AR'
  }), actorB);
  const missingTemplateReadiness = await service.getRuleReadiness('tenant-b', missingTemplateRule.id);
  assert.ok(missingTemplateReadiness.blockers.some((item) => item.code === 'TEMPLATE_MISSING'));
  mark('X');

  const mainReadiness = await service.getRuleReadiness('tenant-b', mainRule.id);
  assert.equal(mainReadiness.ready, false);
  assert.deepEqual(mainReadiness.blockers.map((item) => item.code), ['PRODUCER_NOT_AVAILABLE']);
  mark('T', 'Y');

  const enableError = await expectError(
    () => service.enableRule('tenant-b', mainRule.id, {
      expectedConfigVersion: mainRule.configVersion
    }, actorB),
    'operational_alert_rule_not_ready',
    409
  );
  assert.ok(enableError.details.blockers.some((item) => item.code === 'PRODUCER_NOT_AVAILABLE'));
  assert.equal((await service.getRule('tenant-b', mainRule.id)).enabled, false);
  mark('Z');

  const beforePreview = {
    events: await countRows(db, 'operational_alert_events'),
    instances: await countRows(db, 'operational_alert_instances'),
    deliveries: await countRows(db, 'operational_alert_deliveries')
  };
  const fixture = {
    sessionId: 'session-preview-1',
    closedAt: '2026-08-11T13:00:00.000Z',
    currency: 'ARS',
    differenceAmount: 250
  };
  const preview = await service.previewRule('tenant-b', mainRule.id, { payload: fixture });
  const previewAgain = await service.previewRule('tenant-b', mainRule.id, { payload: fixture });
  assert.equal(preview.matched, true);
  assert.match(preview.renderedPreview.auditText, /Caja session-preview-1 cerrada/);
  assert.deepEqual(preview.renderedPreview, previewAgain.renderedPreview);
  assert.deepEqual({
    events: await countRows(db, 'operational_alert_events'),
    instances: await countRows(db, 'operational_alert_instances'),
    deliveries: await countRows(db, 'operational_alert_deliveries')
  }, beforePreview);
  mark('AA', 'AB');

  assert.equal(await countRows(db, 'operational_alert_events'), 0);
  assert.equal(await countRows(db, 'operational_alert_instances'), 0);
  assert.equal(await countRows(db, 'operational_alert_deliveries'), 0);
  mark('AH');

  await db.query(
    `INSERT INTO operational_alert_events (
       id, "clinicId", "eventType", "eventVersion", "entityType", "entityId",
       "occurredAt", payload, "deduplicationKey", source, status, "processedAt"
     ) VALUES (
       $1::uuid, $2::uuid, 'cash.session_closed', 1, 'cash_session', 'session-history-1',
       '2026-08-11T14:00:00.000Z', '{"safe":true}'::jsonb, 'history-1', 'test', 'processed', NOW()
     )`,
    [ids.eventB, ids.clinicB]
  );
  await db.query(
    `INSERT INTO operational_alert_instances (
       id, "clinicId", "ruleId", "eventId", "ruleVersion", "occurrenceKey",
       "snapshotVersion", snapshot, status, "completedAt"
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'history-occurrence-1', 1,
       $6::jsonb, 'completed_with_errors', NOW()
     )`,
    [
      ids.instanceB,
      ids.clinicB,
      mainRule.id,
      ids.eventB,
      mainRule.configVersion,
      JSON.stringify({
        schemaVersion: 1,
        accessToken: 'must-not-leak',
        access_token: 'snake-case-must-not-leak',
        authorization: 'bearer-must-not-leak',
        nested: {
          client_secret: 'nested-secret-must-not-leak',
          phoneE164: '+5491199999999'
        },
        rule: { id: mainRule.id, eventType: 'cash.session_closed' },
        event: { material: { sessionId: 'session-history-1', currency: 'ARS' } }
      })
    ]
  );

  const deliveryFixtures = [
    [recipientB, 'sent', 'sent-ok'],
    [pendingB, 'read', 'read-ok'],
    [inactiveB, 'failed_permanent', 'graph-secret-payload-must-not-leak']
  ];
  for (let index = 0; index < deliveryFixtures.length; index += 1) {
    const [recipient, status, lastError] = deliveryFixtures[index];
    await db.query(
      `INSERT INTO operational_alert_deliveries (
         "clinicId", "instanceId", "recipientId", "recipientVersion", "channelId",
         "idempotencyKey", status, "recipientSnapshot", "templateKey", "templateLanguage",
         "formatterKey", "formatterVersion", "attemptCount", "resultCode", "lastError",
         "sentAt", "deliveredAt", "readAt"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::jsonb,
         'cash_alert', 'es_AR', 'cash_session_closed', 1, 1, $9, $10,
         CASE WHEN $7 IN ('sent', 'delivered', 'read') THEN NOW() ELSE NULL END,
         CASE WHEN $7 IN ('delivered', 'read') THEN NOW() ELSE NULL END,
         CASE WHEN $7 = 'read' THEN NOW() ELSE NULL END
       )`,
      [
        ids.clinicB,
        ids.instanceB,
        recipient.id,
        recipient.version,
        ids.channelB,
        `history-delivery-${index}`,
        status,
        JSON.stringify({
          recipientId: recipient.id,
          name: recipient.name,
          phoneE164: recipient.phoneE164,
          roleLabel: recipient.roleLabel,
          version: recipient.version
        }),
        status === 'failed_permanent' ? 'graph_failed' : status,
        lastError
      ]
    );
  }

  const historyB = await service.getHistory('tenant-b', { page: 1, pageSize: 20 });
  assert.equal(historyB.pagination.total, 1);
  assert.deepEqual(historyB.items[0].deliverySummary, {
    total: 3,
    sent: 1,
    delivered: 0,
    read: 1,
    failed: 1,
    skipped: 0,
    unknown: 0
  });
  mark('AD');

  const historyA = await service.getHistory('tenant-a', {});
  assert.equal(historyA.pagination.total, 0);
  await expectError(
    () => service.getHistoryDetail('tenant-a', ids.instanceB),
    'operational_alert_history_instance_not_found',
    404
  );
  mark('AC');

  const detail = await service.getHistoryDetail('tenant-b', ids.instanceB);
  const serializedDetail = JSON.stringify(detail);
  assert.doesNotMatch(serializedDetail, /must-not-leak/);
  assert.doesNotMatch(serializedDetail, /\+5491100000001/);
  assert.doesNotMatch(serializedDetail, /\+5491199999999/);
  assert.match(detail.snapshot.nested.phoneE164, /\*+99$/);
  assert.equal(detail.deliveries.length, 3);
  assert.ok(detail.deliveries.every((item) => item.recipient.phoneMasked));
  assert.ok(!Object.prototype.hasOwnProperty.call(detail.deliveries[0], 'lastError'));
  mark('AE');

  const auditResult = await db.query(
    `SELECT action, payload
     FROM portal_user_audit_log
     ORDER BY "createdAt" ASC, id ASC`
  );
  const actions = new Set(auditResult.rows.map((row) => row.action));
  for (const expectedAction of [
    'operational_alert_recipient_created',
    'operational_alert_recipient_updated',
    'operational_alert_consent_updated',
    'operational_alert_rule_created',
    'operational_alert_rule_updated',
    'operational_alert_rule_recipients_updated'
  ]) {
    assert.ok(actions.has(expectedAction), `Missing audit action ${expectedAction}`);
  }
  assert.ok(auditResult.rows.every((row) => !JSON.stringify(row.payload).includes('+549')));
  mark('AF');

  const crossTenantRecipient = await service.getRecipient('tenant-a', recipientB.id).catch((error) => error);
  assert.equal(crossTenantRecipient.code, 'operational_alert_recipient_not_found');
}

function testStaticContracts() {
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'src/controllers/portal-operational-alerts.controller.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'src/services/portal-operational-alerts.service.js'), 'utf8');
  assert.match(routes, /operational-alerts\/event-types/);
  assert.match(routes, /operational-alerts\/recipients\/:recipientId\/consent/);
  assert.match(routes, /operational-alerts\/rules\/:ruleId\/readiness/);
  assert.match(routes, /operational-alerts\/rules\/:ruleId\/preview/);
  assert.match(routes, /operational-alerts\/history\/:instanceId/);
  assert.doesNotMatch(routes, /patch\('\/tenants\/:tenantId\/operational-alerts\/settings/);
  assert.doesNotMatch(routes, /operational-alerts\/test-send/);
  assert.match(routes, /router\.use\('\/tenants\/:tenantId\/operational-alerts', operationalAlertsNoStore\)/);
  assert.match(controller, /private, no-store/);
  assert.match(service, /operational_alert_rule_enabled/);
  assert.match(service, /operational_alert_rule_disabled/);
  assert.match(service, /PRODUCER_NOT_AVAILABLE/);
  assert.equal(fs.existsSync(path.join(root, 'db/migrations/075_operational_alerts_admin.sql')), false);
}

async function run() {
  const db = new PGlite();
  try {
    await createBaseSchema(db);
    await seedBaseData(db);
    const service = loadService(db);
    await testAdminService(db, service);
    await testAuthorization();
    testStaticContracts();
    for (const label of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').slice(0, 26)) {
      assert.ok(covered.has(label), `Missing matrix coverage ${label}`);
    }
    for (const label of ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH']) {
      assert.ok(covered.has(label), `Missing matrix coverage ${label}`);
    }
    console.log('operational-alerts-admin-api.test.js passed (A-AH)');
  } finally {
    await db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
