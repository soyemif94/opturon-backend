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

  const partnerMap = {
    'partner-1': {
      id: 'partner-1',
      email: 'partner1@test.com',
      status: 'active',
      sponsorPartnerId: 'partner-2',
      currentRankCode: 'lider',
      profile: { displayName: 'Partner Uno' }
    },
    'partner-2': {
      id: 'partner-2',
      email: 'partner2@test.com',
      status: 'active',
      sponsorPartnerId: null,
      currentRankCode: 'emperador',
      profile: { displayName: 'Partner Dos' }
    },
    'partner-3': {
      id: 'partner-3',
      email: 'partner3@test.com',
      status: 'active',
      sponsorPartnerId: null,
      currentRankCode: 'coordinador',
      profile: { displayName: 'Partner Tres' }
    }
  };

  const planRules = {
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
      },
      {
        code: 'emperador',
        ownSignupRatePercent: '32.50',
        ownRecurringRatePercent: '12.00',
        lineRecurringRatePercentByDepth: ['4.00', '2.00', '1.00']
      }
    ],
    rankThresholds: [
      { code: 'asesor', minActiveClients: 0, minGeneratedCommission: '0.00' },
      { code: 'lider', minActiveClients: 3, minGeneratedCommission: '50000.00' },
      { code: 'emperador', minActiveClients: 8, minGeneratedCommission: '150000.00' }
    ]
  };

  const repo = {
    listPartners: async () => [],
    findPartnerById: async (partnerId) => partnerMap[partnerId] || null,
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
      planName: 'Default',
      currency: 'ARS',
      versionNumber: 1,
      rules: planRules,
      maxPayoutPercent: '15.00'
    }),
    findPublishedCommissionPlanVersion: async () => ({
      id: 'version-1',
      planId: 'plan-1',
      planCode: 'default',
      planName: 'Default',
      currency: 'ARS',
      versionNumber: 1,
      rules: planRules,
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
        eventType: 'subscription_recurring_accredited',
        eventAt: new Date().toISOString(),
        periodKey: '2026-06',
        currency: 'ARS',
        planCodeSnapshot: 'default',
        planVersionNumberSnapshot: 1,
        payoutKind: 'own_recurring',
        paymentStatus: 'accredited',
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
    findLatestRankEvaluationByPartnerId: async () => null,
    listPartnerNetworkNodes: async () => [],
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
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00',
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: false });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation.length, 2);
  assert.strictEqual(result.simulation[0].commissionAmount, '110.00');
  assert.strictEqual(result.simulation[1].commissionAmount, '40.00');
  assert.strictEqual(result.simulation[0].currency, 'ARS');
  assert.strictEqual(result.simulation[1].payoutKind, 'line_recurring_rebate');
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
  assert.strictEqual(result.evaluation.currentRankCode, 'lider');
  assert.strictEqual(result.evaluation.nextRankCode, 'emperador');
}

async function testAuthenticatePartnerUserReturnsPartnerIdentity() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.authenticatePartnerUser('partner1@test.com', 'password123');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.user.globalRole, 'partner');
  assert.strictEqual(result.user.accountScope, 'partner');
}

async function testCreateCommissionPlanRejectsMissingExplicitRules() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.createCommissionPlanWithVersion({
    code: 'plan-missing-rules',
    name: 'Plan Missing Rules',
    maxPayoutPercent: '15.00'
  }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_partner_commission_rules');
}

async function testCreateCommissionPlanRejectsRecurringCapAbove15() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.createCommissionPlanWithVersion({
    code: 'plan-cap-over',
    name: 'Plan Cap Over',
    maxPayoutPercent: '15.00',
    rules: {
      recurringCapPercent: '16.00',
      rankConfigs: [
        {
          code: 'asesor',
          ownSignupRatePercent: '25.00',
          ownRecurringRatePercent: '10.00',
          lineRecurringRatePercentByDepth: ['0.00']
        }
      ]
    }
  }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_partner_commission_rules');
}

async function testRecurringCapExact15Allowed() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.simulateCommissionEntries({
    tenantId: 'tenant-a',
    sourceType: 'subscription',
    sourceRef: 'sub-cap-ok',
    sourceEventId: 'evt-cap-ok',
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00',
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: false });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.simulation.map((item) => item.commissionRate).join(','), '11.00,4.00');
}

async function testRecurringCapOver15Rejected() {
  setup({
    findPartnerById: async (partnerId) => ({
      'partner-1': { id: 'partner-1', email: 'partner1@test.com', status: 'active', sponsorPartnerId: 'partner-2', currentRankCode: 'lider', profile: { displayName: 'One' } },
      'partner-2': { id: 'partner-2', email: 'partner2@test.com', status: 'active', sponsorPartnerId: 'partner-3', currentRankCode: 'emperador', profile: { displayName: 'Two' } },
      'partner-3': { id: 'partner-3', email: 'partner3@test.com', status: 'active', sponsorPartnerId: null, currentRankCode: 'emperador', profile: { displayName: 'Three' } }
    }[partnerId] || null)
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.simulateCommissionEntries({
    tenantId: 'tenant-a',
    sourceType: 'subscription',
    sourceRef: 'sub-cap-bad',
    sourceEventId: 'evt-cap-bad',
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00',
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: false });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_commission_cap_exceeded');
}

async function testRecurringPaymentMustBeAccredited() {
  setup();
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.simulateCommissionEntries({
    tenantId: 'tenant-a',
    sourceType: 'subscription',
    sourceRef: 'sub-unpaid',
    sourceEventId: 'evt-unpaid',
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00',
    paymentStatus: 'pending',
    reversed: false
  }, { persist: false });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_commission_payment_not_eligible');
}

async function testSponsorCycleTwoNodesRejected() {
  setup({
    findPartnerById: async (partnerId) => ({
      'partner-1': { id: 'partner-1', email: 'p1@test.com', status: 'active', sponsorPartnerId: 'partner-2', currentRankCode: 'asesor', profile: { displayName: 'One' } },
      'partner-2': { id: 'partner-2', email: 'p2@test.com', status: 'active', sponsorPartnerId: 'partner-1', currentRankCode: 'asesor', profile: { displayName: 'Two' } }
    }[partnerId] || null)
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.assignPartnerSponsor('partner-1', 'partner-2', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_sponsor_cycle_detected');
}

async function testSponsorCycleThreeNodesRejected() {
  setup({
    findPartnerById: async (partnerId) => ({
      'partner-1': { id: 'partner-1', email: 'p1@test.com', status: 'active', sponsorPartnerId: null, currentRankCode: 'asesor', profile: { displayName: 'One' } },
      'partner-2': { id: 'partner-2', email: 'p2@test.com', status: 'active', sponsorPartnerId: 'partner-3', currentRankCode: 'asesor', profile: { displayName: 'Two' } },
      'partner-3': { id: 'partner-3', email: 'p3@test.com', status: 'active', sponsorPartnerId: 'partner-1', currentRankCode: 'asesor', profile: { displayName: 'Three' } }
    }[partnerId] || null)
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.assignPartnerSponsor('partner-1', 'partner-2', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_sponsor_cycle_detected');
}

async function testAttributionUniqueViolationReturnsBusinessError() {
  setup({
    findActiveAttributionByTenantId: async (tenantId) => {
      if (tenantId === 'tenant-race') {
        return { id: 'attr-race', partnerId: 'partner-2', clinicId: 'clinic-2', tenantId, status: 'active' };
      }
      return null;
    },
    findClinicTenantByExternalTenantId: async (tenantId) => (tenantId === 'tenant-race' ? { id: 'clinic-race', name: 'Clinic Race', externalTenantId: tenantId } : null),
    createPartnerAttribution: async () => {
      const error = new Error('duplicate');
      error.code = '23505';
      throw error;
    }
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.attributeTenantToPartner('partner-1', { tenantId: 'tenant-race' }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'tenant_already_attributed');
}

async function testGenerateIsIdempotentForSameEvent() {
  setup({
    findCommissionEntriesBySource: async () => ([{ id: 'entry-existing', partnerId: 'partner-1' }])
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.simulateCommissionEntries({
    tenantId: 'tenant-a',
    sourceType: 'subscription',
    sourceRef: 'sub-existing',
    sourceEventId: 'evt-existing',
    eventType: 'subscription_recurring_accredited',
    eventAt: '2026-06-18T12:00:00.000Z',
    basisAmount: '1000.00',
    paymentStatus: 'accredited',
    reversed: false
  }, { persist: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reusedExisting, true);
}

async function testDoubleReversalRejected() {
  setup({
    findCommissionEntryById: async () => ({
      id: 'entry-1',
      status: 'reversed'
    })
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.reverseCommissionEntries({ entryId: 'entry-1', reason: 'manual_fix' }, {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_commission_entry_already_reversed');
}

async function testGetPartnerClientsAddsTrustedBillingSummary() {
  setup({
    listPartnerAttributions: async () => ([
      {
        id: 'attr-1',
        partnerId: 'partner-1',
        clinicId: 'clinic-1',
        tenantId: 'tenant-a',
        status: 'active',
        attributionSource: 'manual_admin',
        notes: 'Cliente con SaaS al dia',
        attributedAt: '2026-06-18T12:00:00.000Z',
        endedAt: null,
        clinicName: 'Clinic Uno',
        billingPlanCode: 'crecimiento',
        billingSubscriptionStatus: 'active',
        billingLastPaymentStatus: 'approved',
        billingNextPaymentAt: '2026-07-18T12:00:00.000Z',
        billingLastAccreditedPaymentAt: '2026-06-18T10:00:00.000Z',
        createdAt: '2026-06-18T12:00:00.000Z',
        updatedAt: '2026-06-18T12:00:00.000Z'
      }
    ])
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.getPartnerClients('partner-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.clients.length, 1);
  assert.deepStrictEqual(result.clients[0].billing, {
    subscriptionStatus: 'active',
    paymentStatus: 'current',
    planName: 'Plan Crecimiento',
    lastAccreditedPaymentAt: '2026-06-18T10:00:00.000Z',
    nextPaymentAt: '2026-07-18T12:00:00.000Z'
  });
  assert.strictEqual('billingPlanCode' in result.clients[0], false);
  assert.strictEqual('billingLastPaymentStatus' in result.clients[0], false);
}

async function testGetPartnerClientsKeepsBillingUndefinedWithoutTrustedData() {
  setup({
    listPartnerAttributions: async () => ([
      {
        id: 'attr-2',
        partnerId: 'partner-1',
        clinicId: 'clinic-2',
        tenantId: 'tenant-b',
        status: 'active',
        attributionSource: 'referral',
        notes: null,
        attributedAt: '2026-06-17T12:00:00.000Z',
        endedAt: null,
        clinicName: 'Clinic Dos',
        billingPlanCode: null,
        billingSubscriptionStatus: null,
        billingLastPaymentStatus: null,
        billingNextPaymentAt: null,
        billingLastAccreditedPaymentAt: null,
        createdAt: '2026-06-17T12:00:00.000Z',
        updatedAt: '2026-06-17T12:00:00.000Z'
      }
    ])
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.getPartnerClients('partner-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.clients[0].billing, undefined);
}

async function testGetPartnerRankProgressExposesTrustedRequirements() {
  setup({
    findLatestRankEvaluationByPartnerId: async () => ({
      id: 'eval-2',
      partnerId: 'partner-1',
      planVersionId: 'version-1',
      status: 'completed',
      currentRankCode: 'lider',
      nextRankCode: 'emperador',
      metrics: {
        activeClients: 4,
        generatedCommission: '60000.00',
        thresholdMatched: {
          code: 'lider',
          minActiveClients: 3,
          minGeneratedCommission: '50000.00'
        }
      },
      windowStart: '2026-05-01T00:00:00.000Z',
      windowEnd: '2026-05-31T23:59:59.000Z',
      evaluatedAt: '2026-06-01T12:00:00.000Z',
      createdAt: '2026-06-01T12:00:00.000Z'
    }),
    listRankHistory: async () => ([
      {
        id: 'rank-1',
        partnerId: 'partner-1',
        rankCode: 'lider',
        effectiveFrom: '2026-06-01T12:00:00.000Z',
        effectiveTo: null,
        evaluationId: 'eval-2',
        notes: 'partner_rank_evaluated',
        createdAt: '2026-06-01T12:00:00.000Z'
      }
    ])
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.getPartnerRankProgress('partner-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.currentRank, 'lider');
  assert.strictEqual(result.nextRank, 'emperador');
  assert.strictEqual(result.evaluationStatus, 'complete');
  assert.strictEqual(result.progressPercent, 40);
  assert.strictEqual(result.requirements.length, 2);
  assert.deepStrictEqual(result.requirements[0], {
    code: 'active_clients',
    label: 'Clientes activos',
    currentValue: 4,
    targetValue: 8,
    remainingValue: 4,
    completed: false,
    valueType: 'count',
    currency: null
  });
  assert.deepStrictEqual(result.requirements[1], {
    code: 'generated_commission',
    label: 'Objetivo comercial acreditado',
    currentValue: '60000.00',
    targetValue: '150000.00',
    remainingValue: '90000.00',
    completed: false,
    valueType: 'currency',
    currency: 'ARS'
  });
}

async function testGetPartnerNetworkBuildsTrustedThreeLevelView() {
  setup({
    listPartnerNetworkNodes: async () => ([
      {
        id: 'network-1',
        status: 'active',
        depth: 1,
        createdAt: '2026-01-10T10:00:00.000Z',
        displayName: 'Lucia Sponsor',
        relationshipStartsAt: '2026-02-01T10:00:00.000Z',
        currentRankCode: 'lider',
        activeClientCount: 5
      },
      {
        id: 'network-2',
        status: 'suspended',
        depth: 2,
        createdAt: '2026-02-10T10:00:00.000Z',
        displayName: 'Marco Expansion',
        relationshipStartsAt: '2026-03-01T10:00:00.000Z',
        currentRankCode: null,
        activeClientCount: 2
      },
      {
        id: 'network-3',
        status: 'active',
        depth: 3,
        createdAt: '2026-03-10T10:00:00.000Z',
        displayName: '',
        relationshipStartsAt: null,
        currentRankCode: 'asesor',
        activeClientCount: 0
      },
      {
        id: 'network-2',
        status: 'active',
        depth: 3,
        createdAt: '2026-03-11T10:00:00.000Z',
        displayName: 'Duplicado corrupto',
        relationshipStartsAt: '2026-03-11T10:00:00.000Z',
        currentRankCode: 'coordinador',
        activeClientCount: 9
      },
      {
        id: 'network-4',
        status: 'active',
        depth: 4,
        createdAt: '2026-04-10T10:00:00.000Z',
        displayName: 'Fuera de alcance',
        relationshipStartsAt: '2026-04-11T10:00:00.000Z',
        currentRankCode: 'emperador',
        activeClientCount: 9
      }
    ])
  });
  const service = require(modulePath('src/services/partners.service.js'));
  const result = await service.getPartnerNetwork('partner-1');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.summary, {
    firstLineCount: 1,
    secondLineCount: 1,
    thirdLineCount: 1,
    activeNetworkCount: 2
  });
  assert.strictEqual(result.levels.length, 3);
  assert.deepStrictEqual(result.levels[0], {
    depth: 1,
    partners: [
      {
        displayName: 'Lucia Sponsor',
        status: 'active',
        rankCode: 'lider',
        activeClientCount: 5,
        joinedAt: '2026-02-01T10:00:00.000Z'
      }
    ]
  });
  assert.deepStrictEqual(result.levels[1], {
    depth: 2,
    partners: [
      {
        displayName: 'Marco Expansion',
        status: 'suspended',
        rankCode: null,
        activeClientCount: 2,
        joinedAt: '2026-03-01T10:00:00.000Z'
      }
    ]
  });
  assert.deepStrictEqual(result.levels[2], {
    depth: 3,
    partners: [
      {
        displayName: 'Asesor de red 3',
        status: 'active',
        rankCode: 'asesor',
        activeClientCount: 0,
        joinedAt: '2026-03-10T10:00:00.000Z'
      }
    ]
  });
}

async function run() {
  await testCreatePartnerRejectsDuplicateEmail();
  await testAttributeTenantBlocksOtherPartner();
  await testSimulateCommissionEntriesBuildsDirectAndIndirectPayouts();
  await testReverseCommissionEntryCreatesNegativeReversal();
  await testEvaluateRankUsesThresholds();
  await testAuthenticatePartnerUserReturnsPartnerIdentity();
  await testCreateCommissionPlanRejectsMissingExplicitRules();
  await testCreateCommissionPlanRejectsRecurringCapAbove15();
  await testRecurringCapExact15Allowed();
  await testRecurringCapOver15Rejected();
  await testRecurringPaymentMustBeAccredited();
  await testSponsorCycleTwoNodesRejected();
  await testSponsorCycleThreeNodesRejected();
  await testAttributionUniqueViolationReturnsBusinessError();
  await testGenerateIsIdempotentForSameEvent();
  await testDoubleReversalRejected();
  await testGetPartnerClientsAddsTrustedBillingSummary();
  await testGetPartnerClientsKeepsBillingUndefinedWithoutTrustedData();
  await testGetPartnerRankProgressExposesTrustedRequirements();
  await testGetPartnerNetworkBuildsTrustedThreeLevelView();
  console.log('partners-foundation.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
