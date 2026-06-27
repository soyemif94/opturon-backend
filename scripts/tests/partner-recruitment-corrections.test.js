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

function resetModules() {
  clearModule('src/services/partner-recruitment-applications.service.js');
}

function setup(overrides = {}) {
  resetModules();
  const calls = {
    transitions: [],
    updates: [],
    audit: [],
    createPartnerAccount: 0
  };
  const application = {
    id: 'app-1',
    sponsorPartnerId: 'partner-1',
    status: 'approved',
    invitationId: null,
    createdPartnerId: null,
    firstName: 'Adriel',
    lastName: 'Opturon',
    email: 'correo@example.com',
    normalizedEmail: 'correo@example.com',
    phone: '02915275449',
    normalizedPhone: '02915275449',
    documentId: '38550389',
    normalizedDocumentId: '38550389',
    city: 'Bahia Blanca',
    province: 'Buenos Aires',
    country: 'Argentina',
    notes: 'Referencia controlada',
    ...overrides.application
  };
  let currentApplication = { ...application };

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({})
  });
  mockModule('src/repositories/partners.repository.js', {
    findPartnerById: async (partnerId) => ({
      id: partnerId,
      email: 'sponsor@example.com',
      status: 'active',
      sponsorPartnerId: null,
      profile: { displayName: 'Sponsor Uno', code: '8000' }
    }),
    findPartnerByEmail: async () => null,
    findPartnerByPhone: async () => overrides.existingPartnerByPhone || null,
    findStaffUserByEmail: async () => null,
    createPartnerAccount: async () => {
      calls.createPartnerAccount += 1;
      return { id: 'partner-new', email: currentApplication.email, status: 'invited' };
    },
    createPartnerProfile: async () => ({ partnerId: 'partner-new' }),
    createPartnerRelationship: async () => ({ id: 'rel-1' }),
    createPartnerAuditLog: async (payload) => {
      calls.audit.push(payload);
      return { id: `audit-${calls.audit.length}` };
    }
  });
  mockModule('src/repositories/partner-invitations.repository.js', {
    createPartnerInvitation: async () => ({ id: 'invite-1', partnerId: 'partner-new', email: currentApplication.email, expiresAt: '2099-06-20T12:00:00.000Z' }),
    revokePendingPartnerInvitationsByEmail: async () => [],
    revokePendingPartnerInvitationsByPartnerId: async () => []
  });
  mockModule('src/repositories/partner-recruitment-applications.repository.js', {
    createRecruitmentApplication: async () => currentApplication,
    updateRecruitmentApplication: async (_applicationId, patch) => {
      currentApplication = { ...currentApplication, ...patch };
      calls.updates.push({ applicationId: currentApplication.id, patch });
      return currentApplication;
    },
    transitionRecruitmentApplication: async (_applicationId, input) => {
      currentApplication = {
        ...currentApplication,
        status: input.status,
        adminNotes: input.setAdminNotes ? input.adminNotes || null : currentApplication.adminNotes || null,
        invitationId: input.invitationId || currentApplication.invitationId || null,
        createdPartnerId: input.createdPartnerId || currentApplication.createdPartnerId || null
      };
      calls.transitions.push({ applicationId: currentApplication.id, input });
      return currentApplication;
    },
    markRecruitmentApplicationInvitationSent: async (_applicationId, input) => {
      currentApplication = {
        ...currentApplication,
        status: 'invitation_sent',
        invitationId: input.invitationId,
        createdPartnerId: input.createdPartnerId || null
      };
      return currentApplication;
    },
    markRecruitmentApplicationAccepted: async () => currentApplication,
    markRecruitmentApplicationExpired: async () => ({ ...currentApplication, status: 'expired' }),
    findRecruitmentApplicationById: async () => currentApplication,
    findRecruitmentApplicationByIdForUpdate: async () => currentApplication,
    findRecruitmentApplicationByInvitationId: async () => currentApplication,
    listRecruitmentApplications: async () => ({ applications: [currentApplication], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }),
    findRecruitmentApplicationDuplicates: async () => overrides.duplicateApplications || []
  });
  mockModule('src/services/partner-invitations-email.service.js', {
    buildPartnerInvitationAcceptLink: (token) => `https://asesores.opturon.com/invite?token=${token}`,
    sendPartnerInvitationEmail: async () => ({ provider: 'resend', id: 'email-1' })
  });

  const service = require(modulePath('src/services/partner-recruitment-applications.service.js'));
  return { service, calls, getApplication: () => currentApplication };
}

async function testPartnerCanReopenApprovedWithoutInvitation() {
  const { service, calls, getApplication } = setup();
  const result = await service.reopenApplicationForEditByPartner('partner-1', 'app-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.application.id, 'app-1');
  assert.strictEqual(getApplication().status, 'changes_requested');
  assert.strictEqual(calls.transitions.length, 1);
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_changes_requested_after_approval'), true);
}

async function testPartnerCannotReopenApprovedWithInvitation() {
  const { service } = setup({
    application: {
      invitationId: 'invite-1'
    }
  });
  const result = await service.reopenApplicationForEditByPartner('partner-1', 'app-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_recruitment_application_not_editable');
}

async function testPartnerCannotReopenAnotherSponsorsApplication() {
  const { service } = setup({
    application: {
      sponsorPartnerId: 'partner-2'
    }
  });
  const result = await service.reopenApplicationForEditByPartner('partner-1', 'app-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_recruitment_application_not_found');
}

async function testPartnerCannotReopenRejectedApplication() {
  const { service } = setup({
    application: {
      status: 'rejected'
    }
  });
  const result = await service.reopenApplicationForEditByPartner('partner-1', 'app-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_recruitment_application_not_editable');
}

async function testAdminCanRequestChangesFromApprovedWithoutInvitation() {
  const { service, calls, getApplication } = setup();
  const result = await service.reviewApplicationAsAdmin('app-1', 'request_changes', { adminNotes: 'El telefono coincide con otra cuenta.' }, 'staff-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(getApplication().status, 'changes_requested');
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_changes_requested_after_approval'), true);
}

async function testCorrectionKeepsSameApplicationIdAndSponsor() {
  const { service, calls, getApplication } = setup({
    application: {
      status: 'changes_requested',
      adminNotes: 'El telefono coincide con otra cuenta.'
    }
  });
  const result = await service.updateApplicationForPartner('partner-1', 'app-1', {
    firstName: 'Adriel Sergio',
    lastName: 'Opturon',
    email: 'correo@example.com',
    phone: '02915550000',
    documentId: '38550389',
    city: 'Bahia Blanca',
    province: 'Buenos Aires',
    country: 'Argentina',
    notes: 'Referencia corregida',
    consentConfirmed: true
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(getApplication().id, 'app-1');
  assert.strictEqual(getApplication().sponsorPartnerId, 'partner-1');
  assert.strictEqual(calls.updates.length, 1);
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_application_updated'), true);
  assert.deepStrictEqual(calls.audit.find((entry) => entry.action === 'partner_recruitment_application_updated').metadata.modifiedFields.includes('phone'), true);
}

async function testResubmittedCorrectionReturnsToPendingReview() {
  const { service, calls, getApplication } = setup({
    application: {
      status: 'changes_requested'
    }
  });
  const result = await service.submitApplicationForPartner('partner-1', 'app-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(getApplication().status, 'pending_review');
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_application_resubmitted'), true);
}

async function testReapprovedUsesDedicatedAuditAction() {
  const { service, calls, getApplication } = setup({
    application: {
      status: 'pending_review',
      approvedAt: '2026-06-27T00:00:00.000Z'
    }
  });
  const result = await service.reviewApplicationAsAdmin('app-1', 'approve', {}, 'staff-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(getApplication().status, 'approved');
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_application_reapproved'), true);
}

async function testDuplicatePhoneBlocksInvitationWithSpecificCode() {
  const { service, calls } = setup({
    existingPartnerByPhone: {
      id: 'partner-existing',
      email: 'emi@example.com',
      status: 'active',
      profile: { displayName: 'Emi' }
    }
  });
  const result = await service.sendRecruitmentInvitationAsAdmin('app-1', 'staff-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'recruitment_duplicate_phone');
  assert.strictEqual(calls.createPartnerAccount, 0);
  assert.strictEqual(calls.audit.some((entry) => entry.action === 'partner_recruitment_invitation_send_failed'), true);
}

async function run() {
  await testPartnerCanReopenApprovedWithoutInvitation();
  await testPartnerCannotReopenApprovedWithInvitation();
  await testPartnerCannotReopenAnotherSponsorsApplication();
  await testPartnerCannotReopenRejectedApplication();
  await testAdminCanRequestChangesFromApprovedWithoutInvitation();
  await testCorrectionKeepsSameApplicationIdAndSponsor();
  await testResubmittedCorrectionReturnsToPendingReview();
  await testReapprovedUsesDedicatedAuditAction();
  await testDuplicatePhoneBlocksInvitationWithSpecificCode();
  console.log('partner-recruitment-corrections.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
