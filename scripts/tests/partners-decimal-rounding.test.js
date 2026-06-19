const assert = require('assert');
const path = require('path');

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

function setup() {
  clearModule('src/services/partners.service.js');

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({})
  });

  const partners = {
    'partner-root': {
      id: 'partner-root',
      email: 'root@test.com',
      status: 'active',
      sponsorPartnerId: 'partner-sponsor',
      currentRankCode: 'lider',
      profile: { displayName: 'Root' }
    },
    'partner-sponsor': {
      id: 'partner-sponsor',
      email: 'sponsor@test.com',
      status: 'active',
      sponsorPartnerId: null,
      currentRankCode: 'coordinador',
      profile: { displayName: 'Sponsor' }
    }
  };

  const explicitRules = {
    recurringCapPercent: '15.00',
    rankConfigs: [
      {
        code: 'asesor',
        ownSignupRatePercent: '25.00',
        ownRecurringRatePercent: '10.00',
        lineRecurringRatePercentByDepth: ['0.00', '0.00', '0.00']
      },
      {
        code: 'lider',
        ownSignupRatePercent: '27.50',
        ownRecurringRatePercent: '11.00',
        lineRecurringRatePercentByDepth: ['2.00', '0.00', '0.00']
      },
      {
        code: 'coordinador',
        ownSignupRatePercent: '30.00',
        ownRecurringRatePercent: '12.00',
        lineRecurringRatePercentByDepth: ['3.00', '1.50', '0.00']
      }
    ],
    rankThresholds: [
      { code: 'asesor', minActiveClients: 0, minGeneratedCommission: '0.00' },
      { code: 'lider', minActiveClients: 1, minGeneratedCommission: '0.01' },
      { code: 'coordinador', minActiveClients: 2, minGeneratedCommission: '1.00' }
    ]
  };

  mockModule('src/repositories/partners.repository.js', {
    listPartners: async () => [],
    findPartnerById: async (partnerId) => partners[partnerId] || null,
    findPartnerByEmail: async () => null,
    findRawPartnerAuthByEmail: async () => null,
    createPartnerAccount: async () => null,
    createPartnerProfile: async () => null,
    createPartnerRelationship: async () => null,
    endActivePartnerRelationship: async () => 0,
    updatePartnerStatus: async () => false,
    touchPartnerLogin: async () => false,
    findClinicTenantByExternalTenantId: async (tenantId) => ({ id: 'clinic-1', externalTenantId: tenantId, name: 'Clinic' }),
    findActiveAttributionByTenantId: async (tenantId) => ({
      id: 'attr-1',
      partnerId: 'partner-root',
      clinicId: 'clinic-1',
      tenantId,
      status: 'active'
    }),
    findAttributionById: async () => null,
    listPartnerAttributions: async () => [],
    createPartnerAttribution: async () => null,
    cancelActiveAttribution: async () => false,
    listCommissionPlans: async () => [],
    findCommissionPlanByCode: async () => null,
    createCommissionPlan: async () => null,
    countPlanVersions: async () => 0,
    createCommissionPlanVersion: async () => null,
    findCommissionPlanVersionById: async () => ({
      id: 'version-1',
      planId: 'plan-1',
      planCode: 'exact-decimals',
      planName: 'Exact decimals',
      versionNumber: 1,
      currency: 'ARS',
      rules: explicitRules,
      maxPayoutPercent: '15.00'
    }),
    findPublishedCommissionPlanVersion: async () => ({
      id: 'version-1',
      planId: 'plan-1',
      planCode: 'exact-decimals',
      planName: 'Exact decimals',
      versionNumber: 1,
      currency: 'ARS',
      rules: explicitRules,
      maxPayoutPercent: '15.00'
    }),
    listPartnerCommissionEntries: async () => [],
    findCommissionEntriesBySource: async () => [],
    findCommissionEntryById: async () => null,
    findReversalEntryByOriginalEntryId: async () => null,
    createCommissionEntry: async (payload) => payload,
    markCommissionEntryReversed: async () => false,
    sumGeneratedCommissionsForPartner: async () => '0.00',
    countActivePartnerAttributions: async () => 1,
    createRankEvaluation: async () => null,
    closeActiveRankHistory: async () => 0,
    createRankHistory: async () => null,
    listRankHistory: async () => [],
    createPartnerAuditLog: async () => null,
    listPartnerAuditLog: async () => []
  });
}

async function simulateRecurring(basisAmount) {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  return service.simulateCommissionEntries({
    tenantId: 'tenant-decimal',
    sourceType: 'subscription',
    sourceRef: `sub-${basisAmount}`,
    sourceEventId: `evt-${basisAmount}`,
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-19T00:00:00.000Z',
    basisAmount,
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: false });
}

async function simulateSignup(basisAmount) {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  return service.simulateCommissionEntries({
    tenantId: 'tenant-signup',
    sourceType: 'subscription',
    sourceRef: `signup-${basisAmount}`,
    sourceEventId: `signup-evt-${basisAmount}`,
    eventType: 'subscription_signup_accredited',
    eventAt: '2026-06-19T00:00:00.000Z',
    basisAmount,
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: false });
}

async function testBase010Recurring() {
  const result = await simulateRecurring('0.10');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation[0].commissionAmount, '0.01');
}

async function testBase029Recurring() {
  const result = await simulateRecurring('0.29');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation[0].commissionAmount, '0.03');
}

async function testBase10005Signup275() {
  const result = await simulateSignup('100.05');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation[0].commissionRate, '27.50');
  assert.strictEqual(result.simulation[0].commissionAmount, '27.51');
}

async function testLineDepth15Percent() {
  const result = await simulateRecurring('100.05');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation[0].commissionRate, '11.00');
  assert.strictEqual(result.simulation[1].commissionRate, '3.00');
  assert.strictEqual(result.simulation[0].commissionAmount, '11.01');
  assert.strictEqual(result.simulation[1].commissionAmount, '3.00');
}

async function testTooManyInputDecimalsRejected() {
  const result = await simulateRecurring('100.005');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_partner_commission_basis_amount');
}

async function run() {
  await testBase010Recurring();
  await testBase029Recurring();
  await testBase10005Signup275();
  await testLineDepth15Percent();
  await testTooManyInputDecimalsRejected();
  console.log('partners-decimal-rounding.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
