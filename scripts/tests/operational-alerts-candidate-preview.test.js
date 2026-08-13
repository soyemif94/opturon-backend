const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const NOW = '2026-08-12T12:00:00.000Z';
const ids = Object.freeze({
  clinic: '10000000-0000-4000-8000-000000000001',
  rule: '20000000-0000-4000-8000-000000000001',
  product: '30000000-0000-4000-8000-000000000001',
  lot: '40000000-0000-4000-8000-000000000001'
});

const {
  createOperationalAlertCandidatePreviewService
} = require(path.join(root, 'src/services/operational-alert-candidate-preview.service.js'));
const {
  createInventoryExpiryAlertProducer
} = require(path.join(root, 'src/services/inventory-expiry-alert-producer.service.js'));

function inventoryRule(overrides = {}) {
  return {
    id: ids.rule,
    clinicId: ids.clinic,
    name: 'Canary candidate preview',
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerMode: 'scheduled',
    configVersion: 4,
    enabled: false,
    archivedAt: null,
    conditions: {
      daysBefore: 30,
      minimumAvailableQuantity: 1,
      quantityBasis: 'physical',
      repeatPolicy: 'once_per_threshold'
    },
    schedule: { frequency: 'daily', sendAt: '08:00', timezone: 'tenant' },
    deliveryPolicy: { maxAttempts: 1 },
    ...overrides
  };
}

async function main() {
  const rule = inventoryRule();
  const clinic = {
    id: ids.clinic,
    timezone: 'America/Argentina/Buenos_Aires',
    settings: { operationalAlertsEnabled: false }
  };
  let candidateQueryCalls = 0;
  let evaluatorCalls = 0;
  const realEvaluator = createInventoryExpiryAlertProducer({
    listCandidates: async (input) => {
      candidateQueryCalls += 1;
      assert.deepEqual(input, {
        clinicId: ids.clinic,
        rangeStartDate: '2026-09-11',
        rangeEndDate: '2026-09-11',
        quantityBasis: 'physical',
        minimumAvailableQuantity: 1
      });
      return {
        totalLots: 1,
        totalProducts: 1,
        items: [{
          lotId: ids.lot,
          productId: ids.product,
          productName: 'Producto Canary',
          productSku: 'CANARY-1',
          lotNumber: 'LOTE-CANARY',
          expiresAt: '2026-09-11',
          relevantQuantity: 2,
          supplierName: 'Proveedor',
          locationName: 'Deposito'
        }]
      };
    },
    logInfo: () => {},
    logWarn: () => {}
  });
  const service = createOperationalAlertCandidatePreviewService({
    findClinic: async (tenantId) => {
      assert.equal(tenantId, 'tenant-canary');
      return clinic;
    },
    findRule: async (ruleId, clinicId) => {
      assert.equal(ruleId, ids.rule);
      assert.equal(clinicId, ids.clinic);
      return rule;
    },
    getEvaluator: (eventType, eventVersion) => {
      assert.equal(eventType, 'inventory.lot_expiring');
      assert.equal(eventVersion, 1);
      return async (input) => {
        evaluatorCalls += 1;
        assert.equal(input.rule.enabled, true, 'preview enables only its in-memory evaluator copy');
        assert.equal(rule.enabled, false, 'stored rule remains disabled');
        return realEvaluator(input);
      };
    },
    now: () => NOW
  });

  const preview = await service.previewRuleCandidates('tenant-canary', ids.rule);
  assert.equal(candidateQueryCalls, 1);
  assert.equal(evaluatorCalls, 1);
  assert.equal(rule.enabled, false);
  assert.deepEqual(preview, {
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    tenantId: 'tenant-canary',
    ruleId: ids.rule,
    rule: {
      id: ids.rule,
      configVersion: 4,
      enabled: false,
      triggerMode: 'scheduled',
      conditions: rule.conditions,
      schedule: rule.schedule,
      deliveryPolicy: rule.deliveryPolicy
    },
    evaluatedRuleEnabled: true,
    evaluatedAt: NOW,
    localDate: '2026-08-12',
    candidateCount: 1,
    candidateLotIds: [ids.lot],
    expectedEventCount: 1,
    expectedDigestCount: 1,
    digestItemCount: 1,
    truncated: false,
    evaluable: true,
    reason: null
  });

  const noCandidateService = createOperationalAlertCandidatePreviewService({
    findClinic: async () => clinic,
    findRule: async () => rule,
    getEvaluator: () => async () => ({
      events: [],
      outcome: 'no_match',
      metrics: { candidateCount: 0, digestCount: 0 }
    }),
    now: () => NOW
  });
  const noCandidates = await noCandidateService.previewRuleCandidates('tenant-canary', ids.rule);
  assert.equal(noCandidates.candidateCount, 0);
  assert.deepEqual(noCandidates.candidateLotIds, []);
  assert.equal(noCandidates.expectedEventCount, 0);
  assert.equal(noCandidates.digestItemCount, 0);
  assert.equal(noCandidates.evaluable, true);

  const truncatedService = createOperationalAlertCandidatePreviewService({
    findClinic: async () => clinic,
    findRule: async () => rule,
    getEvaluator: () => async () => ({
      events: [{
        payload: {
          totalLots: 2,
          items: [{ lotId: ids.lot }],
          truncation: { omittedLots: 1 }
        }
      }],
      metrics: { candidateCount: 2, digestCount: 1 }
    }),
    now: () => NOW
  });
  const truncated = await truncatedService.previewRuleCandidates('tenant-canary', ids.rule);
  assert.equal(truncated.candidateCount, 2);
  assert.deepEqual(truncated.candidateLotIds, [ids.lot]);
  assert.equal(truncated.truncated, true);

  const archived = await createOperationalAlertCandidatePreviewService({
    findClinic: async () => clinic,
    findRule: async () => inventoryRule({ archivedAt: NOW }),
    getEvaluator: () => {
      throw new Error('archived rules must not run an evaluator');
    },
    now: () => NOW
  }).previewRuleCandidates('tenant-canary', ids.rule);
  assert.equal(archived.evaluable, false);
  assert.equal(archived.reason, 'operational_alert_rule_archived');

  const source = fs.readFileSync(
    path.join(root, 'src/services/operational-alert-candidate-preview.service.js'),
    'utf8'
  );
  assert.match(source, /getScheduledOperationalAlertEvaluator/);
  assert.match(source, /await evaluator\(/);
  assert.match(source, /candidateCount > candidateLotIds\.length/);
  assert.doesNotMatch(source, /insertOperationalAlertEvent|insertOperationalAlertInstance|insertOperationalAlertDelivery/);
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /operational-alerts\/rules\/:ruleId\/candidate-preview/);
  assert.match(routes, /operationalAlertsAdminPermission, getOperationalAlertRuleCandidatePreview/);
  console.log('operational-alerts-candidate-preview.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
