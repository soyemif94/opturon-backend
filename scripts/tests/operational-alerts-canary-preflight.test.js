const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const ids = Object.freeze({
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  rule: '20000000-0000-4000-8000-000000000001',
  lot: '30000000-0000-4000-8000-000000000001'
});

// The repository tests pass an in-memory client explicitly.  Stub the default
// client before loading modules so this focused test never opens or contacts a
// configured database.
const dbClientPath = path.join(root, 'src/db/client.js');
require.cache[dbClientPath] = {
  id: dbClientPath,
  filename: dbClientPath,
  loaded: true,
  exports: {
    query: async () => {
      throw new Error('unexpected_default_database_query');
    }
  }
};

const observabilityRepository = require(path.join(
  root,
  'src/repositories/operational-alert-observability.repository.js'
));
const {
  createOperationalAlertCanaryPreflightService
} = require(path.join(root, 'src/services/operational-alert-canary-preflight.service.js'));

function createReadyReadiness(overrides = {}) {
  return {
    ready: true,
    blockers: [],
    checks: {
      recipientCount: 1,
      recipientsReady: true,
      channelReady: true,
      templateReady: true
    },
    ...overrides
  };
}

function createSingleCandidatePreview(overrides = {}) {
  return {
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    evaluable: true,
    candidateCount: 1,
    candidateLotIds: [ids.lot],
    expectedEventCount: 1,
    expectedDigestCount: 1,
    digestItemCount: 1,
    truncated: false,
    localDate: '2026-08-13',
    evaluatedAt: '2026-08-13T12:00:00.000Z',
    rule: {
      id: ids.rule,
      enabled: true,
      deliveryPolicy: { maxAttempts: 1 }
    },
    ...overrides
  };
}

function createHealthyWorker(overrides = {}) {
  return {
    workerId: 'operational-alerts-worker',
    lastPollStartedAt: '2026-08-13T11:59:59.000Z',
    lastPollCompletedAt: '2026-08-13T12:00:00.000Z',
    lastSuccessfulPollAt: '2026-08-13T12:00:00.000Z',
    lastError: null,
    updatedAt: '2026-08-13T12:00:00.000Z',
    health: 'healthy',
    ...overrides
  };
}

function createService(overrides = {}) {
  const calls = [];
  const service = createOperationalAlertCanaryPreflightService({
    findClinic: async (tenantId) => {
      calls.push(['findClinic', tenantId]);
      if (tenantId === 'tenant-a') {
        return { id: ids.clinicA, settings: { operationalAlertsEnabled: true } };
      }
      if (tenantId === 'tenant-b') {
        return { id: ids.clinicB, settings: { operationalAlertsEnabled: false } };
      }
      return null;
    },
    countEnabledRules: async (clinicId) => {
      calls.push(['countEnabledRules', clinicId]);
      return 1;
    },
    getDeliveryBacklog: async (clinicId) => {
      calls.push(['getDeliveryBacklog', clinicId]);
      return { pending: 0, processing: 0, retryable: 0, unknownDelivery: 0 };
    },
    getRuleReadiness: async (tenantId, ruleId) => {
      calls.push(['getRuleReadiness', tenantId, ruleId]);
      return createReadyReadiness();
    },
    previewRuleCandidates: async (tenantId, ruleId) => {
      calls.push(['previewRuleCandidates', tenantId, ruleId]);
      return createSingleCandidatePreview();
    },
    getWorkerHealth: async () => {
      calls.push(['getWorkerHealth']);
      return createHealthyWorker();
    },
    now: () => '2026-08-13T12:00:00.000Z',
    ...overrides
  });
  return { service, calls };
}

async function testBacklogRepository() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE operational_alert_deliveries (
        "clinicId" UUID NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE operational_alert_rules (
        "clinicId" UUID NOT NULL,
        enabled BOOLEAN NOT NULL,
        "archivedAt" TIMESTAMPTZ NULL
      );
    `);
    await db.query(
      `INSERT INTO operational_alert_deliveries ("clinicId", status) VALUES
        ($1::uuid, 'pending'),
        ($1::uuid, 'sending'),
        ($1::uuid, 'failed_retryable'),
        ($1::uuid, 'unknown_delivery'),
        ($1::uuid, 'sent'),
        ($2::uuid, 'pending'),
        ($2::uuid, 'unknown_delivery')`,
      [ids.clinicA, ids.clinicB]
    );
    await db.query(
      `INSERT INTO operational_alert_rules ("clinicId", enabled, "archivedAt") VALUES
        ($1::uuid, TRUE, NULL),
        ($1::uuid, TRUE, NOW()),
        ($1::uuid, FALSE, NULL),
        ($2::uuid, TRUE, NULL)`,
      [ids.clinicA, ids.clinicB]
    );
    const client = { query: (text, params) => db.query(text, params) };
    assert.deepEqual(
      await observabilityRepository.getOperationalAlertDeliveryBacklog(ids.clinicA, client),
      { pending: 1, processing: 1, retryable: 1, unknownDelivery: 1 },
      'backlog aggregates only the requested tenant'
    );
    assert.deepEqual(
      await observabilityRepository.getOperationalAlertDeliveryBacklog(ids.clinicB, client),
      { pending: 1, processing: 0, retryable: 0, unknownDelivery: 1 }
    );
    assert.equal(
      await observabilityRepository.countEnabledOperationalAlertRules(ids.clinicA, client),
      1,
      'archived and disabled rules are excluded'
    );
  } finally {
    await db.close();
  }
}

async function testCanaryPreflight() {
  const { service, calls } = createService();
  const safe = await service.getCanaryPreflight('tenant-a', ids.rule);
  assert.equal(safe.canarySafe, true);
  assert.deepEqual(safe.reasons, []);
  assert.equal(safe.operationalAlertsEnabled, true);
  assert.deepEqual(safe.enabledRules, { count: 1 });
  assert.deepEqual(safe.recipients, { count: 1, ready: true });
  assert.deepEqual(safe.deliveryPolicy, { maxAttempts: 1 });
  assert.equal(safe.worker.health, 'healthy');
  assert.deepEqual(safe.backlog, { pending: 0, processing: 0, retryable: 0, unknownDelivery: 0 });
  assert.ok(calls.some((call) => call[0] === 'countEnabledRules' && call[1] === ids.clinicA));
  assert.ok(calls.some((call) => call[0] === 'getDeliveryBacklog' && call[1] === ids.clinicA));
  assert.ok(calls.some((call) => call[0] === 'getRuleReadiness' && call[1] === 'tenant-a'));
  assert.ok(calls.some((call) => call[0] === 'previewRuleCandidates' && call[1] === 'tenant-a'));

  const stale = createService({
    getWorkerHealth: async () => createHealthyWorker({ health: 'stale' })
  });
  const staleResult = await stale.service.getCanaryPreflight('tenant-a', ids.rule);
  assert.equal(staleResult.canarySafe, false);
  assert.ok(staleResult.reasons.some((item) => item.code === 'WORKER_NOT_HEALTHY' && item.detail === 'stale'));

  const featureDisabled = createService();
  const featureDisabledResult = await featureDisabled.service.getCanaryPreflight('tenant-b', ids.rule);
  assert.equal(featureDisabledResult.canarySafe, false);
  assert.ok(featureDisabledResult.reasons.some((item) => item.code === 'OPERATIONAL_ALERTS_DISABLED'));

  const backlog = createService({
    getDeliveryBacklog: async () => ({ pending: 1, processing: 0, retryable: 2, unknownDelivery: 1 })
  });
  const backlogResult = await backlog.service.getCanaryPreflight('tenant-a', ids.rule);
  assert.equal(backlogResult.canarySafe, false);
  assert.ok(backlogResult.reasons.some((item) => item.code === 'DELIVERY_BACKLOG_PENDING'));
  assert.ok(backlogResult.reasons.some((item) => item.code === 'DELIVERY_BACKLOG_RETRYABLE'));
  assert.ok(backlogResult.reasons.some((item) => item.code === 'DELIVERY_BACKLOG_UNKNOWN_DELIVERY'));

  const unsafeRule = createService({
    countEnabledRules: async () => 2,
    getRuleReadiness: async () => createReadyReadiness({
      ready: false,
      blockers: [{ code: 'TEMPLATE_NOT_APPROVED', detail: 'template status is not approved' }],
      checks: {
        recipientCount: 2,
        recipientsReady: false,
        channelReady: false,
        templateReady: false
      }
    }),
    previewRuleCandidates: async () => createSingleCandidatePreview({
      candidateCount: 2,
      expectedDigestCount: 2,
      digestItemCount: 2,
      rule: { id: ids.rule, enabled: false, deliveryPolicy: { maxAttempts: 3 } }
    })
  });
  const unsafeResult = await unsafeRule.service.getCanaryPreflight('tenant-a', ids.rule);
  assert.equal(unsafeResult.canarySafe, false);
  for (const code of [
    'ENABLED_RULE_COUNT_NOT_ONE',
    'CANARY_RULE_DISABLED',
    'RECIPIENT_COUNT_NOT_ONE',
    'RECIPIENTS_NOT_READY',
    'CHANNEL_NOT_READY',
    'TEMPLATE_NOT_READY',
    'RULE_BLOCKER_TEMPLATE_NOT_APPROVED',
    'CANDIDATE_COUNT_NOT_ONE',
    'CANDIDATE_DIGEST_NOT_SINGLE',
    'DELIVERY_POLICY_MAX_ATTEMPTS_NOT_ONE'
  ]) {
    assert.ok(unsafeResult.reasons.some((item) => item.code === code), code);
  }

  const observability = await service.getTenantObservability('tenant-a');
  assert.deepEqual(observability, {
    tenantId: 'tenant-a',
    clinicId: ids.clinicA,
    worker: createHealthyWorker(),
    backlog: { pending: 0, processing: 0, retryable: 0, unknownDelivery: 0 }
  });
}

async function main() {
  await testBacklogRepository();
  await testCanaryPreflight();

  const repositorySource = fs.readFileSync(
    path.join(root, 'src/repositories/operational-alert-observability.repository.js'),
    'utf8'
  );
  assert.match(repositorySource, /WHERE "clinicId" = \$1::uuid/);
  assert.match(repositorySource, /status = 'pending'/);
  assert.match(repositorySource, /status = 'sending'/);
  assert.match(repositorySource, /status = 'failed_retryable'/);
  assert.match(repositorySource, /status = 'unknown_delivery'/);
  assert.doesNotMatch(repositorySource, /\b(?:INSERT|UPDATE|DELETE)\b/i);

  const preflightSource = fs.readFileSync(
    path.join(root, 'src/services/operational-alert-canary-preflight.service.js'),
    'utf8'
  );
  assert.match(preflightSource, /getRuleReadiness/);
  assert.match(preflightSource, /previewRuleCandidates/);
  assert.doesNotMatch(preflightSource, /sendChannelScopedMessage|insertOperationalAlertEvent|insertOperationalAlertInstance|insertOperationalAlertDelivery/);
  console.log('operational-alerts-canary-preflight.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
