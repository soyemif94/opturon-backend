const assert = require('assert');
const path = require('path');
const { hashSync } = require('bcryptjs');

const rootDir = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

function clearModule(relativePath) {
  delete require.cache[modulePath(relativePath)];
}

function setup(overrides = {}) {
  clearModule('src/services/partners.service.js');

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({})
  });

  const repo = {
    listPartners: async () => [],
    findPartnerById: async (partnerId) => {
      if (partnerId === 'partner-1') {
        return {
          id: 'partner-1',
          email: 'partner1@test.com',
          status: 'active',
          sponsorPartnerId: 'partner-2',
          profile: { displayName: 'Partner Uno' }
        };
      }
      if (partnerId === 'partner-2') {
        return {
          id: 'partner-2',
          email: 'partner2@test.com',
          status: 'active',
          sponsorPartnerId: null,
          profile: { displayName: 'Partner Dos' }
        };
      }
      return null;
    },
    findPartnerByEmail: async (email) => (email === 'existing@test.com' ? { id: 'existing-1', status: 'active', profile: { displayName: 'Existing' } } : null),
    findRawPartnerAuthByEmail: async (email) => (email === 'partner1@test.com'
      ? { id: 'partner-1', email, status: 'active', passwordHash: hashSync('password123', 10) }
      : null),
    createPartnerAccount: async () => ({ id: 'partner-new', email: 'new@test.com', status: 'active' }),
    createPartnerProfile: async () => ({ partnerId: 'partner-new' }),
    createPartnerRelationship: async () => ({ id: 'rel-1' }),
    endActivePartnerRelationship: async () => 1,
    updatePartnerStatus: async () => true,
    touchPartnerLogin: async () => true,
    findClinicTenantByExternalTenantId: async (tenantId) => (tenantId === 'tenant-a' || tenantId === 'tenant-taken'
      ? { id: 'clinic-1', name: 'Clinic Uno', externalTenantId: tenantId }
      : null),
    findActiveAttributionByTenantId: async (tenantId) => {
      if (tenantId === 'tenant-a') {
        return {
          id: 'attr-1',
          partnerId: 'partner-1',
          clinicId: 'clinic-1',
          tenantId: 'tenant-a',
          status: 'active'
        };
      }
      if (tenantId === 'tenant-taken') {
        return {
          id: 'attr-2',
          partnerId: 'other-partner',
          clinicId: 'clinic-2',
          tenantId: 'tenant-taken',
          status: 'active'
        };
      }
      return null;
    },
    findAttributionById: async () => null,
    listPartnerAttributions: async () => [],
    createPartnerAttribution: async () => ({ id: 'attr-created', partnerId: 'partner-1', clinicId: 'clinic-1', tenantId: 'tenant-a', status: 'active' }),
    cancelActiveAttribution: async () => true,
    listCommissionPlans: async () => [],
    findCommissionPlanByCode: async () => null,
    createCommissionPlan: async () => ({ id: 'plan-1', code: 'default', name: 'Default' }),
    countPlanVersions: async () => 1,
    createCommissionPlanVersion: async () => ({ id: 'version-1', versionNumber: 1 }),
    findCommissionPlanVersionById: async () => ({
      id: 'version-1',
      planId: 'plan-1',
      planCode: 'default',
      versionNumber: 1,
      rules: { directRatePercent: '10.00', indirectRatePercent: '2.50' },
      maxPayoutPercent: '15.00'
    }),
    findPublishedCommissionPlanVersion: async () => ({
      id: 'version-1',
      planId: 'plan-1',
      planCode: 'default',
      versionNumber: 1,
      rules: { directRatePercent: '10.00', indirectRatePercent: '2.50' },
      maxPayoutPercent: '15.00'
    }),
    listPartnerCommissionEntries: async () => [],
    findCommissionEntriesBySource: async () => [],
    findCommissionEntryById: async (entryId) => (entryId === 'entry-1'
      ? {
        id: 'entry-1',
        partnerId: 'partner-1',
        attributionId: 'attr-1',
        planVersionId: 'version-1',
        clinicId: 'clinic-1',
        tenantId: 'tenant-a',
        sourceType: 'subscription',
        sourceRef: 'sub-1',
        sourceEventId: 'evt-1',
        eventType: 'subscription_payment',
        eventAt: new Date().toISOString(),
        periodKey: '2026-06',
        status: 'generated',
        basisAmount: '1000.00',
        commissionRate: '10.00',
        commissionAmount: '100.00',
        depthLevel: 0,
        idempotencyKey: 'subscription:sub-1:evt-1:partner-1:0:generated'
      }
      : null),
    createCommissionEntry: async (payload) => ({ id: payload.reversalOfEntryId ? 'entry-reversal' : `entry-${payload.partnerId}-${payload.depthLevel}`, ...payload }),
    markCommissionEntryReversed: async () => true,
    sumGeneratedCommissionsForPartner: async () => '60000.00',
    countActivePartnerAttributions: async () => 4,
    createRankEvaluation: async (payload) => ({ id: 'eval-1', evaluatedAt: new Date().toISOString(), ...payload }),
    closeActiveRankHistory: async () => 1,
    createRankHistory: async () => ({ id: 'rank-1' }),
    listRankHistory: async () => [],
    createPartnerAuditLog: async () => ({ id: 'audit-1' }),
    listPartnerAuditLog: async () => [],
    ...overrides
  };

  mockModule('src/repositories/partners.repository.js', repo);
}

async function testCreatePartnerRejectsDuplicateEmail() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.createPartner({ email: 'existing@test.com', password: 'password123', displayName: 'Existing' }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_email_already_exists');
}

async function testAttributeTenantBlocksOtherPartner() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.attributeTenantToPartner('partner-1', { tenantId: 'tenant-taken' }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'tenant_already_attributed');
}

async function testSimulateCommissionEntriesBuildsDirectAndIndirectPayouts() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.simulateCommissionEntries({
    tenantId: 'tenant-a',
    sourceType: 'subscription',
    sourceRef: 'sub-1',
    sourceEventId: 'evt-1',
    eventType: 'subscription_payment',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00'
  }, { persist: false });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation.length, 2);
  assert.strictEqual(result.simulation[0].commissionAmount, '100.00');
  assert.strictEqual(result.simulation[1].commissionAmount, '25.00');
}

async function testReverseCommissionEntryCreatesNegativeReversal() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.reverseCommissionEntries({ entryId: 'entry-1', reason: 'manual_fix' }, {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reversedEntry.reversalOfEntryId, 'entry-1');
  assert.strictEqual(result.reversedEntry.commissionAmount, '-100.00');
}

async function testEvaluateRankUsesThresholds() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.evaluatePartnerRank('partner-1', {}, {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.evaluation.currentRankCode, 'builder');
  assert.strictEqual(result.evaluation.nextRankCode, 'elite');
}

async function testAuthenticatePartnerUserReturnsPartnerIdentity() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.authenticatePartnerUser('partner1@test.com', 'password123');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.user.globalRole, 'partner');
  assert.strictEqual(result.user.accountScope, 'partner');
}

async function run() {
  await testCreatePartnerRejectsDuplicateEmail();
  await testAttributeTenantBlocksOtherPartner();
  await testSimulateCommissionEntriesBuildsDirectAndIndirectPayouts();
  await testReverseCommissionEntryCreatesNegativeReversal();
  await testEvaluateRankUsesThresholds();
  await testAuthenticatePartnerUserReturnsPartnerIdentity();
  console.log('partners-foundation.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
