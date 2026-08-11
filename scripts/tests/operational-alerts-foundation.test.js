const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const migrationPath = 'db/migrations/074_operational_alerts_foundation.sql';

const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  staffA: '20000000-0000-4000-8000-000000000001',
  staffB: '20000000-0000-4000-8000-000000000002',
  channelA: '30000000-0000-4000-8000-000000000001',
  channelB: '30000000-0000-4000-8000-000000000002'
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sanitizeMigration(source) {
  return source.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/gi, '');
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function installDbClientStub(db) {
  const modulePath = path.join(root, 'src/db/client.js');
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
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
    }
  };
}

function loadFoundationRepositories(db) {
  const modules = [
    './src/db/client.js',
    './src/repositories/operational-alert-recipients.repository.js',
    './src/repositories/operational-alert-rules.repository.js',
    './src/repositories/operational-alert-events.repository.js',
    './src/repositories/operational-alert-instances.repository.js',
    './src/repositories/operational-alert-deliveries.repository.js'
  ];
  modules.forEach(clearModule);
  installDbClientStub(db);
  return {
    recipients: require(path.join(root, modules[1])),
    rules: require(path.join(root, modules[2])),
    events: require(path.join(root, modules[3])),
    instances: require(path.join(root, modules[4])),
    deliveries: require(path.join(root, modules[5]))
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
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE staff_users (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE channels (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'whatsapp_cloud',
      status TEXT NOT NULL DEFAULT 'active',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX uq_channels_id_clinic_id
      ON channels(id, "clinicId");
  `);
}

async function applyMigration(db) {
  await db.exec('BEGIN');
  try {
    await db.exec(sanitizeMigration(read(migrationPath)));
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

async function scalar(db, text, params = []) {
  const result = await db.query(text, params);
  const row = result.rows[0] || {};
  return row[Object.keys(row)[0]];
}

async function expectReject(work, pattern) {
  await assert.rejects(work, pattern);
}

async function seedParents(db) {
  await db.query(
    `INSERT INTO clinics (id, name) VALUES
      ($1::uuid, 'Tenant A'),
      ($2::uuid, 'Tenant B')`,
    [ids.clinicA, ids.clinicB]
  );
  await db.query(
    `INSERT INTO staff_users (id, "clinicId", name) VALUES
      ($1::uuid, $2::uuid, 'Staff A'),
      ($3::uuid, $4::uuid, 'Staff B')`,
    [ids.staffA, ids.clinicA, ids.staffB, ids.clinicB]
  );
  await db.query(
    `INSERT INTO channels (id, "clinicId") VALUES
      ($1::uuid, $2::uuid),
      ($3::uuid, $4::uuid)`,
    [ids.channelA, ids.clinicA, ids.channelB, ids.clinicB]
  );
}

function inventoryRuleInput(overrides = {}) {
  return {
    clinicId: ids.clinicA,
    name: 'Expiring inventory lots',
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
    deliveryPolicy: { aggregationMode: 'daily_digest', maxItems: 50, maxAttempts: 3 },
    channelId: ids.channelA,
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1,
    ...overrides
  };
}

function eventInput(ruleId, overrides = {}) {
  return {
    clinicId: ids.clinicA,
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    entityType: 'inventory_lot',
    entityId: 'lot-001',
    occurredAt: '2026-08-11T12:00:00.000Z',
    payload: { lotId: 'lot-001', daysRemaining: 30, availableQuantity: 5 },
    deduplicationKey: 'inventory.lot_expiring:lot-001:v1:window=2026-08-11',
    targetRuleId: ruleId,
    source: 'inventory_projection',
    availableAt: '2026-08-11T12:00:00.000Z',
    ...overrides
  };
}

async function assertSchema(db) {
  const expectedTables = [
    'operational_alert_deliveries',
    'operational_alert_events',
    'operational_alert_instances',
    'operational_alert_recipients',
    'operational_alert_rule_recipients',
    'operational_alert_rules'
  ];
  const tables = await db.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'operational_alert_%'
    ORDER BY table_name
  `);
  assert.deepStrictEqual(tables.rows.map((row) => row.table_name), expectedTables);

  const triggers = await db.query(`
    SELECT tgname
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname LIKE 'trg_operational_alert_%'
    ORDER BY tgname
  `);
  assert.deepStrictEqual(
    triggers.rows.map((row) => row.tgname),
    [
      'trg_operational_alert_delivery_snapshot_immutable',
      'trg_operational_alert_event_payload_immutable',
      'trg_operational_alert_instance_snapshot_immutable'
    ]
  );

  const indexes = String((await db.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname LIKE '%operational_alert%'
    ORDER BY indexname
  `)).rows.map((row) => row.indexname));
  for (const name of [
    'uq_operational_alert_recipients_clinic_phone',
    'idx_operational_alert_rules_scheduled_due',
    'idx_operational_alert_events_available',
    'uq_operational_alert_instances_occurrence',
    'uq_operational_alert_deliveries_provider_message'
  ]) {
    assert.match(indexes, new RegExp(name));
  }

  const defaults = await db.query(`
    SELECT table_name, column_name, column_default
    FROM information_schema.columns
    WHERE (table_name = 'operational_alert_recipients' AND column_name IN ('active', 'consentStatus'))
       OR (table_name = 'operational_alert_rules' AND column_name = 'enabled')
    ORDER BY table_name, column_name
  `);
  const defaultByColumn = new Map(
    defaults.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.column_default])
  );
  assert.match(defaultByColumn.get('operational_alert_recipients.active'), /false/i);
  assert.match(defaultByColumn.get('operational_alert_recipients.consentStatus'), /pending/i);
  assert.match(defaultByColumn.get('operational_alert_rules.enabled'), /false/i);
}

async function main() {
  const migration = read(migrationPath);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(migration, /\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i);
  assert.doesNotMatch(migration, /settings|whatsapp|graph\s*api/i);

  const workerSource = read('src/worker.js');
  assert.doesNotMatch(workerSource, /operational_alert|operational-alert/i);

  const {
    validateOperationalAlertEvent
  } = require(path.join(root, 'src/operational-alerts/operational-alert-contracts.js'));
  const {
    validateOperationalAlertRuleConfig,
    listOperationalAlertDefinitions
  } = require(path.join(root, 'src/operational-alerts/operational-alert-registry.js'));
  const {
    validateOperationalAlertRecipient
  } = require(path.join(root, 'src/operational-alerts/operational-alert-recipient-contract.js'));
  const {
    buildOperationalAlertEventDeduplicationKey,
    buildOperationalAlertOccurrenceKey,
    buildOperationalAlertDeliveryIdempotencyKey
  } = require(path.join(root, 'src/operational-alerts/operational-alert-idempotency.js'));

  assert.deepStrictEqual(
    listOperationalAlertDefinitions().map((item) => `${item.eventType}@${item.eventVersion}`),
    ['inventory.lot_expiring@1', 'cash.session_closed@1']
  );
  assert.strictEqual(validateOperationalAlertEvent(eventInput(null)).ok, true);
  assert.strictEqual(validateOperationalAlertEvent({ ...eventInput(null), payload: [] }).ok, false);
  assert.strictEqual(validateOperationalAlertRecipient({
    clinicId: ids.clinicA,
    name: 'Invalid phone',
    phoneE164: '5491100000000'
  }).ok, false);
  assert.strictEqual(
    buildOperationalAlertEventDeduplicationKey({
      eventType: 'cash.session_closed',
      entityId: 'session-001',
      eventVersion: 1
    }),
    'cash.session_closed:session-001:v1'
  );
  assert.strictEqual(
    buildOperationalAlertOccurrenceKey({
      eventDeduplicationKey: 'cash.session_closed:session-001:v1',
      evaluationWindowKey: '2026-08-11'
    }),
    'cash.session_closed:session-001:v1:window=2026-08-11'
  );

  const db = new PGlite();
  try {
    await createBaseSchema(db);
    await applyMigration(db);
    await applyMigration(db);
    await assertSchema(db);

    for (const table of [
      'operational_alert_recipients',
      'operational_alert_rules',
      'operational_alert_rule_recipients',
      'operational_alert_events',
      'operational_alert_instances',
      'operational_alert_deliveries'
    ]) {
      assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int FROM ${table}`)), 0);
    }

    await seedParents(db);
    const repositories = loadFoundationRepositories(db);
    const { recipients, rules, events, instances, deliveries } = repositories;

    let recipientA = await recipients.createOperationalAlertRecipient({
      clinicId: ids.clinicA,
      staffUserId: ids.staffA,
      name: 'Owner A',
      phoneE164: '+5491100000001',
      roleLabel: 'owner',
      areaKeys: ['inventory'],
      active: true,
      consentStatus: 'pending'
    });
    assert.strictEqual(recipientA.active, true);
    assert.strictEqual(recipientA.consentStatus, 'pending');
    assert.strictEqual(recipientA.consentedAt, null);

    await expectReject(
      () => recipients.createOperationalAlertRecipient({
        clinicId: ids.clinicA,
        name: 'Duplicate A',
        phoneE164: '+5491100000001'
      }),
      /duplicate key|unique constraint/i
    );

    const recipientB = await recipients.createOperationalAlertRecipient({
      clinicId: ids.clinicB,
      staffUserId: ids.staffB,
      name: 'Owner B',
      phoneE164: '+5491100000001'
    });
    assert.strictEqual(recipientB.clinicId, ids.clinicB);

    await expectReject(
      () => recipients.createOperationalAlertRecipient({
        clinicId: ids.clinicA,
        staffUserId: ids.staffB,
        name: 'Cross tenant staff',
        phoneE164: '+5491100000009'
      }),
      /foreign key constraint/i
    );

    const recipientA2 = await recipients.createOperationalAlertRecipient({
      clinicId: ids.clinicA,
      name: 'Manager A',
      phoneE164: '+5491100000002',
      areaKeys: ['cash']
    });
    assert.strictEqual(recipientA2.active, false);
    assert.strictEqual(recipientA2.consentStatus, 'pending');

    const renamedRecipient = await recipients.updateOperationalAlertRecipient(
      recipientA.id,
      ids.clinicA,
      { name: 'Primary Owner A' }
    );
    assert.strictEqual(renamedRecipient.version, 1);
    recipientA = await recipients.updateOperationalAlertRecipient(
      recipientA.id,
      ids.clinicA,
      { phoneE164: '+5491100000003' }
    );
    assert.strictEqual(recipientA.version, 2);
    assert.strictEqual(
      await recipients.findOperationalAlertRecipientById(recipientA.id, ids.clinicB),
      null
    );

    let ruleA = await rules.createOperationalAlertRule(inventoryRuleInput());
    assert.strictEqual(ruleA.enabled, false);
    assert.strictEqual(ruleA.enabledAt, null);
    assert.strictEqual(ruleA.configVersion, 1);

    await expectReject(
      () => rules.createOperationalAlertRule(inventoryRuleInput({
        name: 'Cross tenant channel',
        channelId: ids.channelB
      })),
      /foreign key constraint/i
    );
    assert.strictEqual((await rules.updateOperationalAlertRuleConfig(
      ruleA.id,
      ids.clinicA,
      { name: 'Inventory expiry alerts' }
    )).configVersion, 1);
    ruleA = await rules.updateOperationalAlertRuleConfig(ruleA.id, ids.clinicA, {
      conditions: { ...ruleA.conditions, daysBefore: 14 }
    });
    assert.strictEqual(ruleA.configVersion, 2);

    const assigned = await rules.replaceOperationalAlertRuleRecipients(
      ruleA.id,
      ids.clinicA,
      [recipientA2.id, recipientA.id]
    );
    assert.deepStrictEqual(assigned.map((item) => item.recipientId), [recipientA2.id, recipientA.id]);
    ruleA = await rules.findOperationalAlertRuleById(ruleA.id, ids.clinicA);
    assert.strictEqual(ruleA.configVersion, 3);
    await rules.replaceOperationalAlertRuleRecipients(
      ruleA.id,
      ids.clinicA,
      [recipientA2.id, recipientA.id]
    );
    assert.strictEqual((await rules.findOperationalAlertRuleById(ruleA.id, ids.clinicA)).configVersion, 3);

    await expectReject(
      () => rules.replaceOperationalAlertRuleRecipients(ruleA.id, ids.clinicA, [recipientB.id]),
      /foreign key constraint/i
    );
    assert.deepStrictEqual(
      (await rules.listOperationalAlertRuleRecipients(ruleA.id, ids.clinicA)).map((item) => item.recipientId),
      [recipientA2.id, recipientA.id]
    );

    assert.strictEqual(validateOperationalAlertRuleConfig({
      ...inventoryRuleInput(),
      eventType: 'inventory.unknown_event'
    }).ok, false);
    assert.strictEqual(validateOperationalAlertRuleConfig({
      ...inventoryRuleInput(),
      conditions: { daysBefore: 'tomorrow' }
    }).ok, false);
    await expectReject(
      () => rules.createOperationalAlertRule(inventoryRuleInput({
        name: 'Unknown event',
        eventType: 'inventory.unknown_event'
      })),
      /operational_alert_rule_event_type_unknown/
    );
    await expectReject(
      () => rules.createOperationalAlertRule(inventoryRuleInput({
        name: 'Malformed conditions',
        conditions: { daysBefore: 30, executable: 'return true' }
      })),
      /operational_alert_rule_conditions_unknown_key/
    );
    await expectReject(
      () => events.insertOperationalAlertEvent({
        ...eventInput(ruleA.id),
        eventType: 'inventory.not_registered',
        deduplicationKey: 'inventory.not_registered:lot-001:v1'
      }),
      /operational_alert_event_type_unknown/
    );
    await expectReject(
      () => db.query(
        `UPDATE operational_alert_rules SET conditions = '[]'::jsonb WHERE id = $1::uuid`,
        [ruleA.id]
      ),
      /check constraint/i
    );

    const firstEventInput = eventInput(ruleA.id);
    const firstEvent = await events.insertOperationalAlertEvent(firstEventInput);
    const repeatedEvent = await events.insertOperationalAlertEvent(firstEventInput);
    assert.strictEqual(firstEvent.inserted, true);
    assert.strictEqual(repeatedEvent.inserted, false);
    assert.strictEqual(repeatedEvent.event.id, firstEvent.event.id);
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_events
       WHERE "clinicId" = $1::uuid AND "deduplicationKey" = $2`,
      [ids.clinicA, firstEventInput.deduplicationKey]
    )), 1);
    await expectReject(
      () => events.insertOperationalAlertEvent({
        ...firstEventInput,
        payload: { ...firstEventInput.payload, daysRemaining: 29 }
      }),
      /operational_alert_event_idempotency_conflict/
    );
    await expectReject(
      () => events.insertOperationalAlertEvent(eventInput(ruleA.id, {
        clinicId: ids.clinicB,
        entityId: 'cross-tenant-lot',
        deduplicationKey: 'inventory.lot_expiring:cross-tenant-lot:v1'
      })),
      /foreign key constraint/i
    );

    const occurrenceKey = buildOperationalAlertOccurrenceKey({
      eventDeduplicationKey: firstEventInput.deduplicationKey,
      thresholdIdentity: 'days-14',
      evaluationWindowKey: '2026-08-11'
    });
    const instanceInput = {
      clinicId: ids.clinicA,
      ruleId: ruleA.id,
      eventId: firstEvent.event.id,
      ruleVersion: ruleA.configVersion,
      occurrenceKey,
      evaluationWindowKey: '2026-08-11',
      snapshotVersion: 1,
      snapshot: {
        rule: { configVersion: ruleA.configVersion, daysBefore: 14 },
        event: firstEventInput.payload
      }
    };
    const firstInstance = await instances.insertOperationalAlertInstance(instanceInput);
    const repeatedInstance = await instances.insertOperationalAlertInstance(instanceInput);
    assert.strictEqual(firstInstance.inserted, true);
    assert.strictEqual(repeatedInstance.inserted, false);
    assert.strictEqual(repeatedInstance.instance.id, firstInstance.instance.id);
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_instances
       WHERE "clinicId" = $1::uuid AND "ruleId" = $2::uuid AND "occurrenceKey" = $3`,
      [ids.clinicA, ruleA.id, occurrenceKey]
    )), 1);
    await expectReject(
      () => instances.insertOperationalAlertInstance({
        ...instanceInput,
        snapshot: { ...instanceInput.snapshot, conflicting: true }
      }),
      /operational_alert_instance_idempotency_conflict/
    );
    await expectReject(
      () => instances.insertOperationalAlertInstance({
        ...instanceInput,
        clinicId: ids.clinicB,
        occurrenceKey: `${occurrenceKey}:cross-tenant`
      }),
      /foreign key constraint/i
    );

    const deliveryKey = buildOperationalAlertDeliveryIdempotencyKey({
      instanceId: firstInstance.instance.id,
      recipientId: recipientA.id,
      version: 1
    });
    const deliveryInput = {
      clinicId: ids.clinicA,
      instanceId: firstInstance.instance.id,
      recipientId: recipientA.id,
      recipientVersion: recipientA.version,
      channelId: ids.channelA,
      idempotencyKey: deliveryKey,
      recipientSnapshot: {
        recipientId: recipientA.id,
        version: recipientA.version,
        phoneE164: recipientA.phoneE164,
        consentStatus: recipientA.consentStatus,
        active: recipientA.active
      },
      messageSnapshot: null,
      formatterKey: ruleA.formatterKey,
      formatterVersion: ruleA.formatterVersion,
      availableAt: '2026-08-11T12:05:00.000Z'
    };
    const firstDelivery = await deliveries.insertOperationalAlertDelivery(deliveryInput);
    const repeatedDelivery = await deliveries.insertOperationalAlertDelivery(deliveryInput);
    assert.strictEqual(firstDelivery.inserted, true);
    assert.strictEqual(repeatedDelivery.inserted, false);
    assert.strictEqual(repeatedDelivery.delivery.id, firstDelivery.delivery.id);
    assert.strictEqual(Number(await scalar(
      db,
      `SELECT COUNT(*)::int FROM operational_alert_deliveries
       WHERE "clinicId" = $1::uuid AND "instanceId" = $2::uuid AND "recipientId" = $3::uuid`,
      [ids.clinicA, firstInstance.instance.id, recipientA.id]
    )), 1);
    await expectReject(
      () => deliveries.insertOperationalAlertDelivery({
        ...deliveryInput,
        recipientSnapshot: { ...deliveryInput.recipientSnapshot, phoneE164: '+5491199999999' }
      }),
      /operational_alert_delivery_idempotency_conflict/
    );
    await expectReject(
      () => deliveries.insertOperationalAlertDelivery({
        ...deliveryInput,
        recipientId: recipientB.id,
        idempotencyKey: `${deliveryKey}:cross-recipient`,
        recipientSnapshot: {
          recipientId: recipientB.id,
          version: recipientB.version,
          phoneE164: recipientB.phoneE164
        }
      }),
      /foreign key constraint/i
    );
    await expectReject(
      () => deliveries.insertOperationalAlertDelivery({
        ...deliveryInput,
        recipientId: recipientA2.id,
        recipientVersion: recipientA2.version,
        channelId: ids.channelB,
        idempotencyKey: `${deliveryKey}:cross-channel`,
        recipientSnapshot: {
          recipientId: recipientA2.id,
          version: recipientA2.version,
          phoneE164: recipientA2.phoneE164
        }
      }),
      /foreign key constraint/i
    );

    const secondEventInput = eventInput(ruleA.id, {
      entityId: 'lot-002',
      payload: { lotId: 'lot-002', daysRemaining: 14, availableQuantity: 2 },
      deduplicationKey: 'inventory.lot_expiring:lot-002:v1:window=2026-08-11'
    });
    const secondEvent = await events.insertOperationalAlertEvent(secondEventInput);
    const secondOccurrence = buildOperationalAlertOccurrenceKey({
      eventDeduplicationKey: secondEventInput.deduplicationKey,
      thresholdIdentity: 'days-14',
      evaluationWindowKey: '2026-08-11'
    });
    const secondInstance = await instances.insertOperationalAlertInstance({
      ...instanceInput,
      eventId: secondEvent.event.id,
      occurrenceKey: secondOccurrence,
      snapshot: { rule: { configVersion: ruleA.configVersion }, event: secondEventInput.payload }
    });
    const secondDelivery = await deliveries.insertOperationalAlertDelivery({
      ...deliveryInput,
      instanceId: secondInstance.instance.id,
      recipientId: recipientA2.id,
      recipientVersion: recipientA2.version,
      idempotencyKey: buildOperationalAlertDeliveryIdempotencyKey({
        instanceId: secondInstance.instance.id,
        recipientId: recipientA2.id,
        version: 1
      }),
      recipientSnapshot: {
        recipientId: recipientA2.id,
        version: recipientA2.version,
        phoneE164: recipientA2.phoneE164,
        consentStatus: recipientA2.consentStatus,
        active: recipientA2.active
      }
    });

    await db.query(
      `UPDATE operational_alert_deliveries
       SET "providerMessageId" = 'wamid.foundation-test', "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [firstDelivery.delivery.id]
    );
    await expectReject(
      () => db.query(
        `UPDATE operational_alert_deliveries
         SET "providerMessageId" = 'wamid.foundation-test', "updatedAt" = NOW()
         WHERE id = $1::uuid`,
        [secondDelivery.delivery.id]
      ),
      /duplicate key|unique constraint/i
    );

    await expectReject(
      () => db.query(
        `UPDATE operational_alert_events
         SET payload = '{"changed":true}'::jsonb
         WHERE id = $1::uuid`,
        [firstEvent.event.id]
      ),
      /identity and payload are immutable/i
    );
    await expectReject(
      () => db.query(
        `UPDATE operational_alert_instances
         SET snapshot = '{"changed":true}'::jsonb
         WHERE id = $1::uuid`,
        [firstInstance.instance.id]
      ),
      /identity and snapshot are immutable/i
    );
    await expectReject(
      () => db.query(
        `UPDATE operational_alert_deliveries
         SET "recipientSnapshot" = '{"changed":true}'::jsonb
         WHERE id = $1::uuid`,
        [firstDelivery.delivery.id]
      ),
      /identity and snapshots are immutable/i
    );

    await db.query(
      `UPDATE operational_alert_events
       SET status = 'processed', "processedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [firstEvent.event.id]
    );
    await db.query(
      `UPDATE operational_alert_instances
       SET status = 'completed', "completedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [firstInstance.instance.id]
    );
    await db.query(
      `UPDATE operational_alert_deliveries
       SET "messageSnapshot" = '{"kind":"foundation"}'::jsonb,
           status = 'sent',
           "sentAt" = NOW(),
           "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [firstDelivery.delivery.id]
    );
    await expectReject(
      () => db.query(
        `UPDATE operational_alert_deliveries
         SET "messageSnapshot" = '{"kind":"changed"}'::jsonb
         WHERE id = $1::uuid`,
        [firstDelivery.delivery.id]
      ),
      /identity and snapshots are immutable/i
    );
    await db.query(
      `UPDATE operational_alert_deliveries
       SET status = 'delivered', "deliveredAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [firstDelivery.delivery.id]
    );

    assert.strictEqual(
      await scalar(db, `SELECT status FROM operational_alert_events WHERE id = $1::uuid`, [firstEvent.event.id]),
      'processed'
    );
    assert.strictEqual(
      await scalar(db, `SELECT status FROM operational_alert_instances WHERE id = $1::uuid`, [firstInstance.instance.id]),
      'completed'
    );
    assert.strictEqual(
      await scalar(db, `SELECT status FROM operational_alert_deliveries WHERE id = $1::uuid`, [firstDelivery.delivery.id]),
      'delivered'
    );

    assert.strictEqual((await events.listOperationalAlertEvents(ids.clinicA)).length, 2);
    assert.strictEqual((await events.listOperationalAlertEvents(ids.clinicB)).length, 0);
    assert.strictEqual((await instances.listOperationalAlertInstances(ids.clinicA)).length, 2);
    assert.strictEqual((await deliveries.listOperationalAlertDeliveries(ids.clinicA)).length, 2);
    assert.strictEqual(
      await deliveries.findOperationalAlertDeliveryById(firstDelivery.delivery.id, ids.clinicB),
      null
    );

    console.log('operational-alerts-foundation.test.js passed (A-T)');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
