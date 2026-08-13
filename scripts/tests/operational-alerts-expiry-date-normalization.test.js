const assert = require('assert/strict');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const ids = Object.freeze({
  clinic: '8e117b14-7c5c-44fb-a4a4-ac86eb6c5074',
  rule: 'bd59ef4b-a0ca-4256-ba7b-f9f922345835',
  product: '4987198f-0101-4d1a-b0f4-21cb1ca0a427',
  lot: 'f80b4eb6-b406-400b-abc4-c8e271751951'
});
const NOW = '2026-08-13T12:00:00.000Z';

const {
  listInventoryExpiryAlertCandidates
} = require(path.join(root, 'src/repositories/inventory-expiry-alerts.repository.js'));
const {
  createInventoryExpiryAlertProducer
} = require(path.join(root, 'src/services/inventory-expiry-alert-producer.service.js'));
const {
  createOperationalAlertCandidatePreviewService
} = require(path.join(root, 'src/services/operational-alert-candidate-preview.service.js'));

function queryInput() {
  return {
    clinicId: ids.clinic,
    rangeStartDate: '2026-08-20',
    rangeEndDate: '2026-08-20',
    quantityBasis: 'physical',
    minimumAvailableQuantity: 1
  };
}

function candidateRow(expiresAt) {
  return {
    lotId: ids.lot,
    productId: ids.product,
    productName: 'QA Alerts Canary Product',
    productSku: 'QA-ALERTS-CANARY-PRODUCT',
    lotNumber: 'QA-ALERTS-CANARY-20260820',
    expiresAt,
    relevantQuantity: 1,
    supplierName: null,
    locationName: 'QA Alerts Canary Location',
    totalLots: 1,
    totalProducts: 1
  };
}

function clientReturning(rows) {
  return {
    async query(text) {
      assert.match(text, /FROM inventory_lots l/);
      return { rows };
    }
  };
}

async function candidatesFor(expiresAt) {
  return listInventoryExpiryAlertCandidates(
    queryInput(),
    clientReturning([candidateRow(expiresAt)])
  );
}

function canaryRule(overrides = {}) {
  return {
    id: ids.rule,
    clinicId: ids.clinic,
    name: 'Opturon Canary — inventory lot expiry',
    eventType: 'inventory.lot_expiring',
    eventVersion: 1,
    triggerMode: 'scheduled',
    configVersion: 2,
    enabled: false,
    archivedAt: null,
    conditions: {
      daysBefore: 7,
      minimumAvailableQuantity: 1,
      quantityBasis: 'physical',
      repeatPolicy: 'once_per_threshold'
    },
    schedule: { frequency: 'daily', sendAt: '09:00', timezone: 'tenant' },
    deliveryPolicy: { maxAttempts: 1 },
    ...overrides
  };
}

async function main() {
  const stringCandidates = await candidatesFor('2026-08-20');
  assert.equal(stringCandidates.items[0].expiresAt, '2026-08-20');

  // This matches node-postgres's PostgreSQL DATE convention: local midnight.
  const pgDate = new Date(2026, 7, 20);
  const dateCandidates = await candidatesFor(pgDate);
  assert.equal(dateCandidates.items[0].expiresAt, '2026-08-20');

  for (const invalidValue of [null, 'not-a-date', new Date('invalid')]) {
    const invalidCandidates = await candidatesFor(invalidValue);
    assert.equal(invalidCandidates.items[0].expiresAt, null);
  }

  const producer = createInventoryExpiryAlertProducer({
    listCandidates: async () => dateCandidates,
    logInfo: () => {},
    logWarn: () => {}
  });
  const evaluated = await producer({
    rule: canaryRule({ enabled: true }),
    clinic: { id: ids.clinic, timezone: 'America/Argentina/Buenos_Aires' },
    now: NOW
  });
  assert.equal(evaluated.events.length, 1);
  assert.equal(evaluated.metrics.candidateCount, 1);
  assert.equal(evaluated.metrics.digestCount, 1);
  assert.deepEqual(evaluated.events[0].payload.items.map((item) => item.lotId), [ids.lot]);
  assert.equal(evaluated.events[0].payload.items[0].expiresAt, '2026-08-20');

  const storedRule = canaryRule();
  const preview = await createOperationalAlertCandidatePreviewService({
    findClinic: async () => ({ id: ids.clinic, timezone: 'America/Argentina/Buenos_Aires' }),
    findRule: async () => storedRule,
    getEvaluator: () => producer,
    now: () => NOW
  }).previewRuleCandidates('tenant_1772601586508_w1e4fs', ids.rule);
  assert.equal(preview.candidateCount, 1);
  assert.deepEqual(preview.candidateLotIds, [ids.lot]);
  assert.equal(preview.expectedEventCount, 1);
  assert.equal(preview.expectedDigestCount, 1);
  assert.equal(preview.digestItemCount, 1);
  assert.equal(preview.truncated, false);
  assert.equal(preview.evaluable, true);
  assert.equal(preview.reason, null);
  assert.equal(storedRule.enabled, false);

  console.log('operational-alerts-expiry-date-normalization.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
