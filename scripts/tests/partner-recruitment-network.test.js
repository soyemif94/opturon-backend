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

function resetRecruitmentModules() {
  clearModule('src/services/partner-recruitment-applications.service.js');
}

function resetPartnerModules() {
  clearModule('src/services/partners.service.js');
}

function setupRecruitmentAcceptance(overrides = {}) {
  resetRecruitmentModules();

  const calls = {
    relationships: [],
    accepted: [],
    audit: []
  };

  const partnersById = {
    sponsor: { id: 'sponsor', status: 'active', sponsorPartnerId: null, profile: { displayName: 'Sponsor Uno' } },
    child: { id: 'child', status: 'invited', sponsorPartnerId: null, profile: { displayName: 'Child Uno' } },
    ancestor: { id: 'ancestor', status: 'active', sponsorPartnerId: null, profile: { displayName: 'Ancestor' } },
    ...overrides.partnersById
  };

  const application = {
    id: 'app-1',
    sponsorPartnerId: 'sponsor',
    status: 'invitation_sent',
    email: 'child@test.com',
    phone: '+54 9 11 5555 1111',
    invitationId: 'invite-1',
    createdPartnerId: 'child',
    ...overrides.application
  };

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({})
  });

  mockModule('src/repositories/partners.repository.js', {
    findPartnerById: async (partnerId) => partnersById[partnerId] || null,
    findPartnerByEmail: async () => null,
    findPartnerByPhone: async () => null,
    findStaffUserByEmail: async () => null,
    createPartnerAccount: async () => ({ id: 'child', email: application.email, status: 'invited' }),
    createPartnerProfile: async () => ({ partnerId: 'child' }),
    createPartnerRelationship: async (payload) => {
      calls.relationships.push(payload);
      return { id: 'rel-1', ...payload };
    },
    createPartnerAuditLog: async (payload) => {
      calls.audit.push(payload);
      return { id: `audit-${calls.audit.length}` };
    }
  });

  mockModule('src/repositories/partner-invitations.repository.js', {
    createPartnerInvitation: async () => ({ id: 'invite-1', partnerId: 'child', email: application.email, expiresAt: '2099-06-20T12:00:00.000Z' }),
    revokePendingPartnerInvitationsByEmail: async () => [],
    revokePendingPartnerInvitationsByPartnerId: async () => []
  });

  mockModule('src/repositories/partner-recruitment-applications.repository.js', {
    createRecruitmentApplication: async () => application,
    updateRecruitmentApplication: async () => application,
    transitionRecruitmentApplication: async () => application,
    markRecruitmentApplicationInvitationSent: async () => application,
    markRecruitmentApplicationAccepted: async (_applicationId, payload) => {
      calls.accepted.push(payload);
      return { ...application, status: 'invitation_accepted', acceptedAt: payload.acceptedAt, createdPartnerId: payload.createdPartnerId };
    },
    markRecruitmentApplicationExpired: async () => ({ ...application, status: 'expired' }),
    findRecruitmentApplicationById: async () => application,
    findRecruitmentApplicationByIdForUpdate: async () => application,
    findRecruitmentApplicationByInvitationId: async () => application,
    listRecruitmentApplications: async () => ({ applications: [application], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }),
    findRecruitmentApplicationDuplicates: async () => []
  });

  mockModule('src/services/partner-invitations-email.service.js', {
    buildPartnerInvitationAcceptLink: (token) => `https://asesores.opturon.com/invite?token=${token}`,
    sendPartnerInvitationEmail: async () => ({ provider: 'resend', id: 'email-1' })
  });

  const service = require(modulePath('src/services/partner-recruitment-applications.service.js'));
  return { service, calls, application, partnersById };
}

function setupPartnerInvitationAcceptance() {
  resetPartnerModules();

  const calls = {
    updatedCredentials: 0,
    invitationAccepted: 0,
    recruitmentAccepted: 0
  };

  const invitation = {
    id: 'invite-1',
    partnerId: 'child',
    email: 'child@test.com',
    expiresAt: '2099-06-20T12:00:00.000Z',
    acceptedAt: null,
    revokedAt: null
  };

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({})
  });
  mockModule('src/services/saas-billing-plans.service.js', {
    resolveSaasPlanDefinition: () => null
  });
  mockModule('src/services/partner-invitations-email.service.js', {
    buildPartnerInvitationAcceptLink: () => 'https://asesores.opturon.com/invite?token=abc',
    sendPartnerInvitationEmail: async () => ({ provider: 'resend', id: 'email-1' })
  });
  mockModule('src/repositories/partners.repository.js', {
    listPartners: async () => [],
    findPartnerById: async (partnerId) => ({ id: partnerId, email: 'child@test.com', status: 'active', sponsorPartnerId: 'sponsor', profile: { displayName: 'Child Uno' } }),
    findPartnerByEmail: async () => null,
    findPartnerByCode: async () => null,
    findRawPartnerAuthByEmail: async () => null,
    createPartnerAccount: async () => null,
    createPartnerProfile: async () => null,
    createPartnerRelationship: async () => null,
    endActivePartnerRelationship: async () => null,
    updatePartnerStatus: async () => null,
    updatePartnerCredentialsById: async () => {
      calls.updatedCredentials += 1;
      return { id: 'child', email: 'child@test.com', status: 'active' };
    },
    touchPartnerLogin: async () => true,
    findClinicTenantByExternalTenantId: async () => null,
    findActiveAttributionByTenantId: async () => null,
    findAttributionById: async () => null,
    listPartnerAttributions: async () => [],
    createPartnerAttribution: async () => null,
    cancelActiveAttribution: async () => null,
    listCommissionPlans: async () => [],
    findCommissionPlanByCode: async () => null,
    createCommissionPlan: async () => null,
    countPlanVersions: async () => 0,
    createCommissionPlanVersion: async () => null,
    findCommissionPlanVersionById: async () => null,
    findPublishedCommissionPlanVersion: async () => null,
    listPartnerCommissionEntries: async () => [],
    listPartnerCommissionLedger: async () => ({ summary: {}, rows: [], page: 1, pageSize: 20 }),
    findCommissionEntriesBySource: async () => [],
    findCommissionEntryById: async () => null,
    findReversalEntryByOriginalEntryId: async () => null,
    createCommissionEntry: async () => {
      throw new Error('recruitment_should_not_generate_commission');
    },
    markCommissionEntryReversed: async () => null,
    sumGeneratedCommissionsForPartner: async () => '0.00',
    countActivePartnerAttributions: async () => 0,
    createRankEvaluation: async () => null,
    findLatestRankEvaluationByPartnerId: async () => null,
    listPartnerNetworkNodes: async () => [],
    closeActiveRankHistory: async () => null,
    createRankHistory: async () => null,
    listRankHistory: async () => [],
    getPartnerLifecycleSummary: async () => ({}),
    createPartnerAuditLog: async () => ({ id: 'audit-1' }),
    listPartnerAuditLog: async () => []
  });
  mockModule('src/repositories/partner-invitations.repository.js', {
    createPartnerInvitation: async () => null,
    revokePendingPartnerInvitationsByPartnerId: async () => [],
    revokePendingPartnerInvitationsByEmail: async () => [],
    listLatestPartnerInvitationsByPartnerIds: async () => [],
    findPartnerInvitationByTokenHash: async () => invitation,
    markPartnerInvitationAccepted: async () => {
      calls.invitationAccepted += 1;
      invitation.acceptedAt = '2099-06-20T12:10:00.000Z';
      return invitation;
    }
  });
  mockModule('src/services/partner-recruitment-applications.service.js', {
    acceptRecruitmentInvitation: async () => {
      calls.recruitmentAccepted += 1;
      return {
        ok: true,
        application: { id: 'app-1', status: 'invitation_accepted' },
        relationship: { id: 'rel-1' }
      };
    }
  });

  const service = require(modulePath('src/services/partners.service.js'));
  return { service, calls };
}

async function testAcceptanceCreatesDepthOneRelationship() {
  const { service, calls } = setupRecruitmentAcceptance();
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'child', sourceType: 'partner_recruitment_application', sourceId: 'app-1', createdByStaffUserId: 'staff-1' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.relationships.length, 1);
  assert.deepStrictEqual(calls.relationships[0], {
    partnerId: 'child',
    sponsorPartnerId: 'sponsor',
    createdByStaffUserId: 'staff-1'
  });
  assert.strictEqual(calls.accepted.length, 1);
  assert.strictEqual(result.relationship.id, 'rel-1');
  assert.ok(calls.audit.some((entry) => entry.action === 'partner_relationship_created_from_recruitment'));
  assert.ok(calls.audit.some((entry) => entry.metadata && entry.metadata.depth === 1));
}

async function testInactiveSponsorBlocked() {
  const { service } = setupRecruitmentAcceptance({
    partnersById: {
      sponsor: { id: 'sponsor', status: 'suspended', sponsorPartnerId: null, profile: { displayName: 'Sponsor Uno' } }
    }
  });
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'child', sourceType: 'partner_recruitment_application', sourceId: 'app-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_sponsor_inactive');
}

async function testSelfInvitationBlocked() {
  const { service } = setupRecruitmentAcceptance();
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'sponsor', sourceType: 'partner_recruitment_application', sourceId: 'app-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_recruitment_self_invitation');
}

async function testCycleBlocked() {
  const { service } = setupRecruitmentAcceptance({
    partnersById: {
      sponsor: { id: 'sponsor', status: 'active', sponsorPartnerId: 'ancestor', profile: { displayName: 'Sponsor Uno' } },
      ancestor: { id: 'ancestor', status: 'active', sponsorPartnerId: 'child', profile: { displayName: 'Ancestor' } },
      child: { id: 'child', status: 'invited', sponsorPartnerId: null, profile: { displayName: 'Child Uno' } }
    }
  });
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'child', sourceType: 'partner_recruitment_application', sourceId: 'app-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_hierarchy_cycle_detected');
}

async function testSecondSponsorBlocked() {
  const { service } = setupRecruitmentAcceptance({
    partnersById: {
      child: { id: 'child', status: 'active', sponsorPartnerId: 'other-sponsor', profile: { displayName: 'Child Uno' } }
    }
  });
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'child', sourceType: 'partner_recruitment_application', sourceId: 'app-1' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_relationship_already_exists');
}

async function testIdempotentWhenRelationshipAlreadyExistsWithSameSponsor() {
  const { service, calls } = setupRecruitmentAcceptance({
    partnersById: {
      child: { id: 'child', status: 'active', sponsorPartnerId: 'sponsor', profile: { displayName: 'Child Uno' } }
    }
  });
  const result = await service.acceptRecruitmentInvitation({ id: 'invite-1', partnerId: 'child', sourceType: 'partner_recruitment_application', sourceId: 'app-1' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.relationship, null);
  assert.strictEqual(calls.relationships.length, 0);
  assert.strictEqual(calls.accepted.length, 1);
}

async function testPartnerInvitationConsumptionBlocksRetryWithoutDuplicates() {
  const { service, calls } = setupPartnerInvitationAcceptance();
  const first = await service.acceptPartnerInvitation('abcdefghijklmnopqrstuvwxyz123456', 'password123');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(calls.updatedCredentials, 1);
  assert.strictEqual(calls.invitationAccepted, 1);
  assert.strictEqual(calls.recruitmentAccepted, 1);

  const second = await service.acceptPartnerInvitation('abcdefghijklmnopqrstuvwxyz123456', 'password123');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'invalid_or_expired_invitation');
  assert.strictEqual(calls.updatedCredentials, 1);
  assert.strictEqual(calls.invitationAccepted, 1);
}

function testSourceHasNoRecruitmentCommissionOrLedgerCalls() {
  const source = require('fs').readFileSync(modulePath('src/services/partner-recruitment-applications.service.js'), 'utf8');
  assert.doesNotMatch(source, /createCommissionEntry/);
  assert.doesNotMatch(source, /ledger/i);
}

async function run() {
  await testAcceptanceCreatesDepthOneRelationship();
  await testInactiveSponsorBlocked();
  await testSelfInvitationBlocked();
  await testCycleBlocked();
  await testSecondSponsorBlocked();
  await testIdempotentWhenRelationshipAlreadyExistsWithSameSponsor();
  await testPartnerInvitationConsumptionBlocksRetryWithoutDuplicates();
  testSourceHasNoRecruitmentCommissionOrLedgerCalls();
  console.log('partner-recruitment-network.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
