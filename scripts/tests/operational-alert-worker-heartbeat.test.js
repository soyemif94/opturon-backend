const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const migrationPath = path.join(root, 'db/migrations/076_operational_alert_worker_heartbeats.sql');
const T0 = '2026-08-13T12:00:00.000Z';

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
    query: (text, params) => db.query(text, params)
  });
}

function isoAt(offsetMs) {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

async function testRepositoryAndMigration(db) {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS operational_alert_worker_heartbeats/);
  assert.match(migration, /"workerId" TEXT PRIMARY KEY/);
  assert.match(migration, /"lastError" TEXT NULL/);
  await db.exec(migration);

  installDbClientStub(db);
  clearModule('src/repositories/operational-alert-worker-heartbeats.repository.js');
  const repository = require(path.join(root, 'src/repositories/operational-alert-worker-heartbeats.repository.js'));

  const created = await repository.upsertOperationalAlertWorkerHeartbeat({
    workerId: 'worker-a',
    startedAt: T0,
    updatedAt: T0,
    lastError: null
  });
  assert.equal(created.workerId, 'worker-a');
  assert.equal(new Date(created.startedAt).toISOString(), T0);
  assert.equal(created.lastPollStartedAt, null);

  const updated = await repository.upsertOperationalAlertWorkerHeartbeat({
    workerId: 'worker-a',
    lastPollStartedAt: isoAt(1_000),
    lastPollCompletedAt: isoAt(2_000),
    lastSuccessfulPollAt: isoAt(2_000),
    lastError: null,
    updatedAt: isoAt(2_000)
  });
  assert.equal(new Date(updated.startedAt).toISOString(), T0);
  assert.equal(new Date(updated.lastPollStartedAt).toISOString(), isoAt(1_000));
  assert.equal(new Date(updated.lastSuccessfulPollAt).toISOString(), isoAt(2_000));
  assert.equal(updated.lastError, null);

  const errored = await repository.upsertOperationalAlertWorkerHeartbeat({
    workerId: 'worker-a',
    lastPollCompletedAt: isoAt(3_000),
    lastError: 'database failure access_token=do-not-store-this-value',
    updatedAt: isoAt(3_000)
  });
  assert.match(errored.lastError, /access_token=\[REDACTED\]/);
  assert.doesNotMatch(errored.lastError, /do-not-store-this-value/);
  assert.ok(errored.lastError.length <= 240);

  await repository.upsertOperationalAlertWorkerHeartbeat({
    workerId: 'worker-b',
    startedAt: isoAt(4_000),
    updatedAt: isoAt(4_000)
  });
  const latest = await repository.findLatestOperationalAlertWorkerHeartbeat();
  assert.equal(latest.workerId, 'worker-b');
}

async function testHealthService() {
  clearModule('src/services/operational-alert-worker-heartbeat.service.js');
  const service = require(path.join(root, 'src/services/operational-alert-worker-heartbeat.service.js'));
  const healthyHeartbeat = {
    workerId: 'worker-a',
    lastPollStartedAt: isoAt(1_000),
    lastPollCompletedAt: isoAt(2_000),
    lastSuccessfulPollAt: isoAt(2_000),
    lastError: null,
    updatedAt: isoAt(2_000)
  };
  assert.equal(service.deriveOperationalAlertWorkerHealth(null, { now: isoAt(2_000) }), 'unknown');
  assert.equal(service.deriveOperationalAlertWorkerHealth(healthyHeartbeat, { now: isoAt(10_000) }), 'healthy');
  assert.equal(service.deriveOperationalAlertWorkerHealth({
    ...healthyHeartbeat,
    lastError: 'poll_failed',
    updatedAt: isoAt(10_000)
  }, { now: isoAt(10_001) }), 'error');
  assert.equal(service.deriveOperationalAlertWorkerHealth(healthyHeartbeat, {
    now: isoAt(100_000),
    staleAfterMs: 30_000
  }), 'stale');
  assert.equal(service.deriveOperationalAlertWorkerHealth({
    workerId: 'worker-starting',
    lastPollStartedAt: isoAt(1_000),
    lastPollCompletedAt: null,
    lastSuccessfulPollAt: null,
    lastError: null,
    updatedAt: isoAt(1_000)
  }, { now: isoAt(2_000) }), 'unknown');

  const serialized = await service.getOperationalAlertWorkerHealth(
    { now: isoAt(10_000) },
    { findLatestHeartbeat: async () => healthyHeartbeat }
  );
  assert.deepEqual(serialized, {
    workerId: 'worker-a',
    lastPollStartedAt: isoAt(1_000),
    lastPollCompletedAt: isoAt(2_000),
    lastSuccessfulPollAt: isoAt(2_000),
    lastError: null,
    updatedAt: isoAt(2_000),
    health: 'healthy'
  });
}

async function testReporterCoalescingAndFailOpen() {
  clearModule('src/services/operational-alert-worker-heartbeat.service.js');
  const service = require(path.join(root, 'src/services/operational-alert-worker-heartbeat.service.js'));
  let clockMs = Date.parse(T0);
  const writes = [];
  const reporter = service.createOperationalAlertWorkerHeartbeatReporter({
    workerId: 'worker-a',
    now: () => new Date(clockMs),
    writeIntervalMs: 30_000,
    upsertHeartbeat: async (input) => {
      writes.push({ ...input });
      return input;
    },
    logWarn: () => {}
  });

  assert.deepEqual(reporter.markWorkerStarted(), { queued: true, coalesced: false });
  await reporter.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].startedAt, T0);

  assert.deepEqual(reporter.markPollStarted(), { queued: true, coalesced: false });
  await reporter.flush();
  assert.deepEqual(reporter.markPollSucceeded(), { queued: true, coalesced: false });
  await reporter.flush();
  assert.equal(writes.length, 3);
  assert.equal(writes[2].lastSuccessfulPollAt, T0);
  assert.equal(writes[2].lastError, null);

  clockMs += 1_000;
  assert.deepEqual(reporter.markPollStarted(), { queued: false, coalesced: true });
  assert.deepEqual(reporter.markPollSucceeded(), { queued: false, coalesced: true });
  await reporter.flush();
  assert.equal(writes.length, 3);

  clockMs += 30_000;
  assert.deepEqual(reporter.markPollStarted(), { queued: false, coalesced: true });
  assert.deepEqual(reporter.markPollSucceeded(), { queued: true, coalesced: false });
  await reporter.flush();
  assert.equal(writes.length, 4);
  assert.equal(writes[3].lastPollStartedAt, isoAt(31_000));
  assert.equal(writes[3].lastSuccessfulPollAt, isoAt(31_000));

  clockMs += 1;
  assert.deepEqual(reporter.markPollFailed(new Error('poll failed token=do-not-store-this-value')), {
    queued: true,
    coalesced: false
  });
  await reporter.flush();
  assert.equal(writes.length, 5);
  assert.match(writes[4].lastError, /token=\[REDACTED\]/);
  assert.doesNotMatch(writes[4].lastError, /do-not-store-this-value/);

  const warnings = [];
  const brokenReporter = service.createOperationalAlertWorkerHeartbeatReporter({
    workerId: 'worker-failing-heartbeat',
    now: () => new Date(clockMs),
    upsertHeartbeat: async () => {
      throw new Error('database unavailable token=do-not-store-this-value');
    },
    logWarn: (event, payload) => warnings.push({ event, payload })
  });
  assert.doesNotThrow(() => brokenReporter.markWorkerStarted());
  await brokenReporter.flush();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'operational_alert_worker_heartbeat_write_failed');
  assert.doesNotMatch(warnings[0].payload.error, /do-not-store-this-value/);
}

function testWorkerIntegrationContract() {
  const workerSource = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  assert.match(workerSource, /createOperationalAlertWorkerHeartbeatReporter/);
  assert.match(workerSource, /operationalAlertHeartbeat\.markWorkerStarted\(\)/);
  assert.match(workerSource, /operationalAlertHeartbeat\.markPollStarted\(\)/);
  assert.match(workerSource, /operationalAlertHeartbeat\.markPollSucceeded\(\)/);
  assert.match(workerSource, /operationalAlertHeartbeat\.markPollFailed\(error\)/);
  assert.match(workerSource, /reportOperationalAlertHeartbeat/);
}

async function run() {
  const db = new PGlite();
  try {
    await testRepositoryAndMigration(db);
    await testHealthService();
    await testReporterCoalescingAndFailOpen();
    testWorkerIntegrationContract();
    console.log('operational-alert-worker-heartbeat.test.js passed');
  } finally {
    await db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
