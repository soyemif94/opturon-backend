const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const covered = new Set();
const NOW = '2026-08-11T12:00:00.000Z';

const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  rule: '20000000-0000-4000-8000-000000000001',
  channel: '30000000-0000-4000-8000-000000000001',
  recipient: '40000000-0000-4000-8000-000000000001',
  productA: '50000000-0000-4000-8000-000000000001',
  productB: '50000000-0000-4000-8000-000000000002',
  productInactive: '50000000-0000-4000-8000-000000000003',
  productDeleted: '50000000-0000-4000-8000-000000000004',
  location: '60000000-0000-4000-8000-000000000001'
});

function mark(...labels) {
  labels.forEach((label) => covered.add(label));
}

function uuid(index) {
  return `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
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

function inventoryRule(overrides = {}) {
  return {
    id: ids.rule,
    clinicId: ids.clinicA,
    name: 'Inventory expiry fixture',
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerMode: 'scheduled',
    configVersion: 3,
    enabled: true,
    archivedAt: null,
    conditions: {
      daysBefore: 30,
      minimumAvailableQuantity: 1,
      quantityBasis: 'physical',
      repeatPolicy: 'once_per_threshold'
    },
    schedule: { frequency: 'daily', sendAt: '08:00', timezone: 'tenant' },
    deliveryPolicy: { maxAttempts: 3 },
    channelId: ids.channel,
    templateKey: 'inventory_lot_expiring_v1',
    templateLanguage: 'es_AR',
    formatterKey: 'inventory_lot_expiring',
    formatterVersion: 1,
    nextEvaluationAt: '2026-08-11T10:59:00.000Z',
    schedulerLockedBy: 'worker-a',
    schedulerLeaseExpiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides
  };
}

async function createInventorySchema(db) {
  await db.exec(`
    CREATE TABLE clinics (id UUID PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      name TEXT NOT NULL,
      sku TEXT NULL,
      status TEXT NOT NULL,
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
      "availableQuantity" NUMERIC(14,3) NOT NULL,
      "warehouseName" TEXT NULL,
      "locationName" TEXT NULL,
      status TEXT NOT NULL,
      "operationalStatus" TEXT NULL
    );
    CREATE TABLE inventory_lot_allocations (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "lotId" UUID NOT NULL,
      quantity NUMERIC(14,3) NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX idx_inventory_lots_tenant_expires_at
      ON inventory_lots ("tenantId", "expiresAt") WHERE "expiresAt" IS NOT NULL;
    CREATE INDEX idx_inventory_lot_allocations_lot
      ON inventory_lot_allocations ("tenantId", "lotId", status);
  `);
}

async function seedInventory(db) {
  await db.query(
    `INSERT INTO clinics (id, name) VALUES ($1::uuid, 'Tenant A'), ($2::uuid, 'Tenant B')`,
    [ids.clinicA, ids.clinicB]
  );
  await db.query(
    `INSERT INTO products (id, "clinicId", name, sku, status, "deletedAt") VALUES
      ($1::uuid, $5::uuid, 'Alpha', 'A-1', 'active', NULL),
      ($2::uuid, $5::uuid, 'Beta', 'B-1', 'active', NULL),
      ($3::uuid, $5::uuid, 'Inactive', 'I-1', 'archived', NULL),
      ($4::uuid, $5::uuid, 'Deleted', 'D-1', 'active', NOW())`,
    [ids.productA, ids.productB, ids.productInactive, ids.productDeleted, ids.clinicA]
  );
  await db.query(
    `INSERT INTO inventory_locations (id, "tenantId", name) VALUES ($1::uuid, $2::uuid, 'Deposito')`,
    [ids.location, ids.clinicA]
  );

  const lots = [
    [uuid(1), ids.productA, null, 5, 'active', null, 'NULL'],
    [uuid(2), ids.productA, '2026-08-10', 5, 'active', null, 'EXPIRED'],
    [uuid(3), ids.productA, '2026-09-10', 5, 'active', null, 'EXACT'],
    [uuid(4), ids.productA, '2026-09-09', 2, 'active', null, 'BEFORE'],
    [uuid(5), ids.productA, '2026-09-11', 3, 'active', null, 'AFTER'],
    [uuid(6), ids.productA, '2026-09-10', 0, 'active', null, 'ZERO'],
    [uuid(7), ids.productA, '2026-09-10', 0.5, 'active', null, 'BELOW'],
    [uuid(8), ids.productA, '2026-09-10', 7, 'active', 'blocked', 'BLOCKED'],
    [uuid(9), ids.productA, '2026-09-10', 8, 'cancelled', null, 'CANCELLED'],
    [uuid(10), ids.productA, '2026-09-10', 9, 'active', 'written_off', 'WRITTEN'],
    [uuid(11), ids.productB, '2026-09-10', 10, 'active', null, 'ALLOCATED'],
    [uuid(12), ids.productInactive, '2026-09-10', 4, 'active', null, 'INACTIVE'],
    [uuid(13), ids.productDeleted, '2026-09-10', 4, 'active', null, 'DELETED']
  ];
  for (const [id, productId, expiresAt, quantity, status, operationalStatus, code] of lots) {
    await db.query(
      `INSERT INTO inventory_lots (
         id, "tenantId", "productId", "locationId", "lotNumber", "supplierName",
         "expiresAt", "availableQuantity", status, "operationalStatus"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Proveedor Fixture', $6::date, $7, $8, $9)`,
      [id, ids.clinicA, productId, ids.location, code, expiresAt, quantity, status, operationalStatus]
    );
  }
  await db.query(
    `INSERT INTO inventory_lot_allocations (id, "tenantId", "lotId", quantity, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 8, 'allocated')`,
    [uuid(90), ids.clinicA, uuid(11)]
  );
}

function loadRuntime(db) {
  [
    'src/db/client.js',
    'src/repositories/inventory-expiry-alerts.repository.js',
    'src/services/inventory-expiry-alert-producer.service.js',
    'src/services/operational-alert-scheduled-evaluator.service.js',
    'src/services/portal-operational-alerts.service.js',
    'src/services/operational-alert-event-processor.service.js'
  ].forEach(clearModule);
  installDbClientStub(db);
  return {
    candidates: require(path.join(root, 'src/repositories/inventory-expiry-alerts.repository.js')),
    producer: require(path.join(root, 'src/services/inventory-expiry-alert-producer.service.js')),
    scheduler: require(path.join(root, 'src/services/operational-alert-scheduled-evaluator.service.js')),
    portal: require(path.join(root, 'src/services/portal-operational-alerts.service.js')),
    eventProcessor: require(path.join(root, 'src/services/operational-alert-event-processor.service.js')),
    registry: require(path.join(root, 'src/operational-alerts/operational-alert-registry.js')),
    formatter: require(path.join(root, 'src/operational-alerts/operational-alert-formatter.js')),
    domain: require(path.join(root, 'src/operational-alerts/inventory-lot-expiry-alert.js'))
  };
}

function basicCandidate(index = 30, overrides = {}) {
  return {
    lotId: uuid(index),
    productId: ids.productA,
    productName: 'Alpha',
    productSku: 'A-1',
    lotNumber: `LOT-${index}`,
    expiresAt: '2026-09-10',
    relevantQuantity: 5,
    supplierName: 'Proveedor Fixture',
    locationName: 'Deposito',
    ...overrides
  };
}

async function testCandidateQuery(runtime, db) {
  const exactPhysical = await runtime.candidates.listInventoryExpiryAlertCandidates({
    clinicId: ids.clinicA,
    rangeStartDate: '2026-09-10',
    rangeEndDate: '2026-09-10',
    quantityBasis: 'physical',
    minimumAvailableQuantity: 1
  });
  assert.deepEqual(exactPhysical.items.map((item) => item.lotNumber), ['EXACT', 'BLOCKED', 'ALLOCATED']);
  assert.equal(exactPhysical.items.find((item) => item.lotNumber === 'BLOCKED').relevantQuantity, 7);
  assert.equal(exactPhysical.items.find((item) => item.lotNumber === 'ALLOCATED').relevantQuantity, 10);
  mark('C', 'D', 'E', 'G', 'H', 'I', 'K');

  const exactCommercial = await runtime.candidates.listInventoryExpiryAlertCandidates({
    clinicId: ids.clinicA,
    rangeStartDate: '2026-09-10',
    rangeEndDate: '2026-09-10',
    quantityBasis: 'commercial',
    minimumAvailableQuantity: 1
  });
  assert.deepEqual(exactCommercial.items.map((item) => item.lotNumber), ['EXACT', 'ALLOCATED']);
  assert.equal(exactCommercial.items.find((item) => item.lotNumber === 'ALLOCATED').relevantQuantity, 2);
  mark('J');

  const window = await runtime.candidates.listInventoryExpiryAlertCandidates({
    clinicId: ids.clinicA,
    rangeStartDate: '2026-08-11',
    rangeEndDate: '2026-09-10',
    quantityBasis: 'physical',
    minimumAvailableQuantity: 1
  });
  assert.ok(window.items.some((item) => item.lotNumber === 'BEFORE'));
  assert.ok(!window.items.some((item) => item.lotNumber === 'AFTER'));
  assert.ok(!window.items.some((item) => item.lotNumber === 'EXPIRED'));
  mark('F');

  const plan = await db.query(
    `EXPLAIN ${runtime.candidates.INVENTORY_EXPIRY_CANDIDATE_QUERY}`,
    [ids.clinicA, '2026-09-10', '2026-09-10', 'physical', 1, 250]
  );
  assert.ok(plan.rows.length > 0);
  const migration = fs.readFileSync(path.join(root, 'db/migrations/059_inventory_lots_phase1.sql'), 'utf8');
  assert.match(migration, /idx_inventory_lots_tenant_expires_at/);
}

async function testProducerAndDigest(runtime) {
  let queryCalls = 0;
  const disabledProducer = runtime.producer.createInventoryExpiryAlertProducer({
    listCandidates: async () => { queryCalls += 1; return { items: [], totalLots: 0, totalProducts: 0 }; },
    logInfo: () => {},
    logWarn: () => {}
  });
  const disabled = await disabledProducer({
    rule: inventoryRule({ enabled: false }),
    clinic: { id: ids.clinicA, timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  assert.equal(disabled.events.length, 0);
  assert.equal(queryCalls, 0);
  mark('A');

  await assert.rejects(
    () => disabledProducer({
      rule: inventoryRule(),
      clinic: { id: ids.clinicB, timezone: 'America/Argentina/Buenos_Aires' },
      now: NOW
    }),
    (error) => error.code === 'inventory_expiry_evaluation_tenant_mismatch'
  );
  mark('B');

  const rows = [
    basicCandidate(33, { productName: 'Zulu' }),
    basicCandidate(31, { productName: 'Alpha' }),
    basicCandidate(32, { productName: 'Alpha' })
  ];
  const producer = runtime.producer.createInventoryExpiryAlertProducer({
    listCandidates: async (input) => {
      assert.equal(input.rangeStartDate, '2026-09-10');
      assert.equal(input.rangeEndDate, '2026-09-10');
      return { items: rows, totalLots: 3, totalProducts: 1 };
    },
    logInfo: () => {},
    logWarn: () => {},
    clock: () => 100
  });
  const result = await producer({
    rule: inventoryRule(),
    clinic: { id: ids.clinicA, timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].payload.items.map((item) => item.lotId), [uuid(31), uuid(32), uuid(33)]);
  assert.equal(result.events[0].payload.totalLots, 3);
  assert.equal(result.events[0].payload.items[0].daysRemaining, 30);
  const evaluation = runtime.registry.evaluateOperationalAlertCondition(inventoryRule(), result.events[0]);
  assert.equal(evaluation.outcome, 'MATCH');
  mark('L', 'M');

  const dailyRule = inventoryRule({
    conditions: { ...inventoryRule().conditions, repeatPolicy: 'daily' }
  });
  const dailyContextA = runtime.domain.buildInventoryExpiryEvaluationContext({
    rule: dailyRule,
    clinic: { timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  const dailyContextB = runtime.domain.buildInventoryExpiryEvaluationContext({
    rule: dailyRule,
    clinic: { timezone: 'America/Argentina/Buenos_Aires' },
    now: '2026-08-12T12:00:00.000Z'
  });
  const dailyA = runtime.domain.buildInventoryExpiryDigest({
    rule: dailyRule,
    context: dailyContextA,
    candidates: { items: [basicCandidate()], totalLots: 1, totalProducts: 1 }
  });
  const dailyB = runtime.domain.buildInventoryExpiryDigest({
    rule: dailyRule,
    context: dailyContextB,
    candidates: {
      items: [basicCandidate(30, { expiresAt: '2026-09-10' })],
      totalLots: 1,
      totalProducts: 1
    }
  });
  assert.notEqual(dailyA.deduplicationKey, dailyB.deduplicationKey);
  assert.equal(dailyContextA.rangeStartDate, '2026-08-11');
  assert.equal(dailyContextB.evaluationWindowKey, '2026-08-12');
  mark('Q');

  const onceContext = runtime.domain.buildInventoryExpiryEvaluationContext({
    rule: inventoryRule(),
    clinic: { timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  const mutableSource = basicCandidate();
  const onceA = runtime.domain.buildInventoryExpiryDigest({
    rule: inventoryRule(),
    context: onceContext,
    candidates: { items: [mutableSource], totalLots: 1, totalProducts: 1 }
  });
  const onceB = runtime.domain.buildInventoryExpiryDigest({
    rule: inventoryRule(),
    context: onceContext,
    candidates: { items: [basicCandidate()], totalLots: 1, totalProducts: 1 }
  });
  assert.equal(onceA.deduplicationKey, onceB.deduplicationKey);
  assert.equal(onceContext.rangeStartDate, onceContext.targetDate);
  mark('R');

  const manyCandidates = Array.from({ length: 300 }, (_, index) => basicCandidate(index + 1000));
  const capped = runtime.domain.buildInventoryExpiryDigest({
    rule: inventoryRule(),
    context: onceContext,
    candidates: { items: manyCandidates, totalLots: 300, totalProducts: 1 }
  });
  assert.equal(capped.payload.items.length, 250);
  assert.equal(capped.payload.totalLots, 300);
  assert.deepEqual(capped.payload.truncation, { itemLimit: 250, omittedLots: 50 });

  const originalSnapshot = JSON.parse(JSON.stringify(onceA.payload));
  mutableSource.relevantQuantity = 999;
  assert.deepEqual(onceA.payload, originalSnapshot);
  mark('W');

  return result.events[0].payload;
}

function testTimezone(runtime) {
  const argentina = runtime.domain.buildInventoryExpiryEvaluationContext({
    rule: inventoryRule(),
    clinic: { timezone: 'America/Argentina/Buenos_Aires' },
    now: '2026-08-12T02:30:00.000Z'
  });
  assert.equal(argentina.localDate, '2026-08-11');
  assert.equal(argentina.targetDate, '2026-09-10');
  assert.equal(runtime.domain.calculateNextDailyScheduleAt({
    now: '2026-08-11T11:00:00.000Z',
    timezone: 'America/Argentina/Buenos_Aires',
    sendAt: '08:00'
  }), '2026-08-11T11:00:00.000Z');
  mark('S');

  const springForward = runtime.domain.calculateNextDailyScheduleAt({
    now: '2026-03-08T05:00:00.000Z',
    timezone: 'America/New_York',
    sendAt: '02:30'
  });
  const springLocal = DateTime.fromISO(springForward).setZone('America/New_York');
  assert.equal(springLocal.toISODate(), '2026-03-08');
  assert.equal(springLocal.hour, 3);
  const nextAfterGap = runtime.domain.calculateNextDailyScheduleAt({
    now: new Date(new Date(springForward).getTime() + 1).toISOString(),
    timezone: 'America/New_York',
    sendAt: '02:30'
  });
  assert.equal(DateTime.fromISO(nextAfterGap).setZone('America/New_York').toISODate(), '2026-03-09');
  mark('T');
}

async function testNoMatchAndLogs(runtime) {
  const logs = [];
  const noMatchProducer = runtime.producer.createInventoryExpiryAlertProducer({
    listCandidates: async () => ({ items: [], totalLots: 0, totalProducts: 0 }),
    logInfo: (message, meta) => logs.push({ message, meta }),
    logWarn: (message, meta) => logs.push({ message, meta }),
    clock: () => 50
  });
  const result = await noMatchProducer({
    rule: inventoryRule(),
    clinic: { id: ids.clinicA, timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  assert.equal(result.events.length, 0);
  assert.ok(new Date(result.nextEvaluationAt).getTime() > new Date(NOW).getTime());
  assert.ok(logs.some((entry) => entry.message === 'inventory_expiry_evaluation_no_match'));
  mark('U');

  const sensitiveProducer = runtime.producer.createInventoryExpiryAlertProducer({
    listCandidates: async () => ({
      items: [basicCandidate(40, {
        productName: 'SECRET_PRODUCT',
        productSku: 'SECRET_SKU',
        lotNumber: 'SECRET_LOT'
      })],
      totalLots: 1,
      totalProducts: 1
    }),
    logInfo: (message, meta) => logs.push({ message, meta }),
    logWarn: (message, meta) => logs.push({ message, meta }),
    clock: () => 50
  });
  await sensitiveProducer({
    rule: inventoryRule(),
    clinic: { id: ids.clinicA, timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /SECRET_PRODUCT|SECRET_SKU|SECRET_LOT/);
  assert.match(serialized, /candidateCount/);
  mark('AC');
}

function testFormatter(runtime, payload) {
  const items = Array.from({ length: 15 }, (_, index) => basicCandidate(index + 100, {
    productName: `Producto ${String(index + 1).padStart(2, '0')}`
  })).map((row) => ({
    lotId: row.lotId,
    productId: row.productId,
    productName: row.productName,
    sku: row.productSku,
    lotCode: row.lotNumber,
    expiresAt: row.expiresAt,
    daysRemaining: 30,
    relevantQuantity: row.relevantQuantity,
    supplierName: row.supplierName,
    locationName: row.locationName
  }));
  const material = {
    ...payload,
    totalLots: 20,
    totalProducts: 15,
    items,
    truncation: { itemLimit: 250, omittedLots: 5 }
  };
  const snapshot = {
    rule: inventoryRule(),
    event: { material }
  };
  const first = runtime.formatter.formatOperationalAlertMessage(snapshot);
  const second = runtime.formatter.formatOperationalAlertMessage(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.value.metadata.visibleLots, 12);
  assert.match(first.value.components[0].parameters[3].text, /\.\.\.y 8 lotes mas/);
  assert.doesNotMatch(first.value.auditText, /descartar|esta vencido/);
  mark('N', 'AB');
}

async function testAtomicCompletion(runtime, eventPayload) {
  const rule = inventoryRule();
  const event = {
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    entityType: 'operational_alert_rule',
    entityId: rule.id,
    occurredAt: eventPayload.evaluatedAt,
    payload: eventPayload,
    deduplicationKey: 'inventory.lot_expiring:atomic:v1'
  };
  const committed = { event: null, finished: false, leaseOwner: 'worker-a' };
  let failFinish = true;
  const dependencies = {
    withTransaction: async (work) => {
      const tx = JSON.parse(JSON.stringify(committed));
      const client = { state: tx };
      const result = await work(client);
      Object.assign(committed, tx);
      return result;
    },
    findClaimedRule: async (ruleId, clinicId, workerId, client) => (
      client.state.leaseOwner === workerId ? { ...rule, schedulerLockedBy: workerId } : null
    ),
    insertEvent: async (input, client) => {
      if (client.state.event) return { event: client.state.event, inserted: false };
      client.state.event = JSON.parse(JSON.stringify(input));
      return { event: client.state.event, inserted: true };
    },
    finishRule: async (ruleId, clinicId, options, client) => {
      if (failFinish) throw new Error('simulated_finish_failure');
      client.state.finished = true;
      client.state.leaseOwner = null;
      return { ...rule, nextEvaluationAt: options.nextEvaluationAt };
    }
  };
  const result = { events: [event], nextEvaluationAt: '2026-08-12T11:00:00.000Z' };
  await assert.rejects(
    () => runtime.scheduler.completeScheduledEvaluation({
      rule,
      workerId: 'worker-a',
      now: new Date(NOW),
      result,
      dependencies
    }),
    /simulated_finish_failure/
  );
  assert.equal(committed.event, null);
  assert.equal(committed.finished, false);
  failFinish = false;
  const completed = await runtime.scheduler.completeScheduledEvaluation({
    rule,
    workerId: 'worker-a',
    now: new Date(NOW),
    result,
    dependencies
  });
  assert.equal(completed.inserted, 1);
  assert.equal(committed.finished, true);
  mark('V');

  committed.leaseOwner = 'worker-b';
  const secondWorker = await runtime.scheduler.completeScheduledEvaluation({
    rule,
    workerId: 'worker-a',
    now: new Date(NOW),
    result,
    dependencies
  });
  assert.equal(secondWorker.outcome, 'lease_lost');
  assert.ok(committed.event);
  mark('P');

  committed.leaseOwner = 'worker-a';
  const duplicate = await runtime.scheduler.completeScheduledEvaluation({
    rule,
    workerId: 'worker-a',
    now: new Date(NOW),
    result,
    dependencies
  });
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.deduplicated, 1);
  mark('O');
}

async function testRegistryAndReadiness(runtime) {
  const definitions = runtime.registry.listOperationalAlertDefinitions();
  const inventory = definitions.find((item) => item.eventType === 'inventory.lot_expiring');
  const cash = definitions.find((item) => item.eventType === 'cash.session_closed');
  assert.equal(inventory.producer.status, 'PRODUCER_AVAILABLE');
  assert.equal(inventory.templateContract.templateKey, 'inventory_lot_expiring_v1');
  assert.equal(cash.producer.status, 'CONFIGURABLE_BUT_PRODUCER_NOT_ACTIVE');
  mark('Y', 'Z');

  const readiness = runtime.portal.__private__.buildRuleReadiness({
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
      id: ids.channel,
      clinicId: ids.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'fixture-phone',
      wabaId: 'fixture-waba',
      accessToken: 'fixture-token'
    },
    template: null
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((item) => item.code === 'TEMPLATE_MISSING'));
  assert.ok(!readiness.blockers.some((item) => item.code === 'PRODUCER_NOT_AVAILABLE'));
  mark('X');

  let enableOptions = null;
  const recipient = {
    id: ids.recipient,
    clinicId: ids.clinicA,
    active: true,
    consentStatus: 'granted',
    consentSource: 'fixture',
    consentedAt: NOW,
    revokedAt: null,
    staffUserId: null
  };
  const channel = {
    id: ids.channel,
    clinicId: ids.clinicA,
    provider: 'whatsapp_cloud',
    status: 'active',
    phoneNumberId: 'fixture-phone',
    wabaId: 'fixture-waba',
    accessToken: 'fixture-token'
  };
  const template = {
    clinicId: ids.clinicA,
    channelId: ids.channel,
    wabaId: 'fixture-waba',
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1_fixture',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'approved',
    definition: {
      components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}} {{4}} {{5}}' }]
    },
    metadata: { operationalAlertContract: 'operational_alert_body_parameters_v1' }
  };
  const service = runtime.portal.createPortalOperationalAlertsService({
    withTransaction: (work) => work({}),
    findClinic: async () => ({
      id: ids.clinicA,
      timezone: 'America/Argentina/Buenos_Aires',
      settings: { operationalAlertsEnabled: true }
    }),
    findRule: async () => inventoryRule(),
    listRuleRecipients: async () => [{ recipientId: ids.recipient }],
    findRecipient: async () => recipient,
    listStaff: async () => [],
    findChannel: async () => channel,
    findTemplate: async () => template,
    enableRule: async (ruleId, clinicId, client, options) => {
      enableOptions = options;
      return { ...inventoryRule(), enabled: true, nextEvaluationAt: options.nextEvaluationAt };
    },
    createAudit: async () => null,
    now: () => NOW
  });
  const enabled = await service.enableRule(
    'tenant-a',
    ids.rule,
    { expectedConfigVersion: 3 },
    { id: uuid(9999), role: 'owner' }
  );
  assert.equal(enableOptions.nextEvaluationAt, '2026-08-12T11:00:00.000Z');
  assert.equal(enabled.nextEvaluationAt, '2026-08-12T11:00:00.000Z');
}

async function testFeatureDisabledNoDelivery(runtime) {
  let listRulesCalled = false;
  let graphCalled = false;
  const event = {
    id: '80000000-0000-4000-8000-000000000001',
    clinicId: ids.clinicA,
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    entityType: 'operational_alert_rule',
    entityId: ids.rule,
    occurredAt: NOW,
    payload: {},
    deduplicationKey: 'inventory.lot_expiring:feature-disabled:v1',
    lockedBy: 'event-worker',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z'
  };
  const result = await runtime.eventProcessor.processClaimedOperationalAlertEvent(event, {
    workerId: 'event-worker',
    dependencies: {
      withTransaction: (work) => work({}),
      findClaimedEvent: async () => event,
      getClinicById: async () => ({ id: ids.clinicA, settings: { operationalAlertsEnabled: false } }),
      updateEventStatus: async (eventId, clinicId, patch) => ({ ...event, status: patch.status }),
      listRulesForEvent: async () => { listRulesCalled = true; return []; },
      listRuleRecipients: async () => [],
      findRecipient: async () => null,
      insertInstance: async () => { graphCalled = true; },
      aggregateInstance: async () => null,
      insertDelivery: async () => { graphCalled = true; }
    }
  });
  assert.equal(result.outcome, 'feature_disabled');
  assert.equal(listRulesCalled, false);
  assert.equal(graphCalled, false);
  mark('AA');
}

async function main() {
  const db = new PGlite();
  try {
    await createInventorySchema(db);
    await seedInventory(db);
    const runtime = loadRuntime(db);
    await testCandidateQuery(runtime, db);
    const payload = await testProducerAndDigest(runtime);
    testTimezone(runtime);
    await testNoMatchAndLogs(runtime);
    testFormatter(runtime, payload);
    await testAtomicCompletion(runtime, payload);
    await testRegistryAndReadiness(runtime);
    await testFeatureDisabledNoDelivery(runtime);

    const expected = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      'AA', 'AB', 'AC'
    ];
    assert.deepEqual(Array.from(covered).sort(), expected.sort());
    console.log('operational-alerts-inventory-expiry.test.js passed (A-AC)');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
