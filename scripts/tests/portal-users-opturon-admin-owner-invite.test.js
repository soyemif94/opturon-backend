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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildService(overrides = {}) {
  const state = {
    createdUsers: [],
    invitations: [],
    auditEvents: [],
    provisionCalls: [],
    movedUsers: [],
    roleUpdates: [],
    credentialUpdates: [],
    existingAnyByEmail: overrides.existingAnyByEmail || null
  };

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) })
  });

  mockModule('src/services/portal-context.service.js', {
    resolvePortalTenantContext: async (tenantId) => ({
      ok: true,
      tenantId,
      clinic: {
        id: 'admin-clinic',
        timezone: 'America/Buenos_Aires'
      }
    })
  });

  mockModule('src/repositories/tenant.repository.js', {
    getClinicPortalAccountConfigById: async (clinicId) => {
      if (clinicId === 'admin-clinic') {
        return {
          primaryPortalUserId: null,
          subaccountLimit: null,
          unlimitedSubaccounts: true,
          accountScope: 'opturon_admin',
          limitSource: 'clinic_settings'
        };
      }

      return {
        primaryPortalUserId: 'owner-user-1',
        subaccountLimit: 3,
        unlimitedSubaccounts: false,
        accountScope: 'client',
        limitSource: 'clinic_settings'
      };
    },
    updateClinicPortalPrimaryUserIdById: async (_clinicId, primaryPortalUserId) => ({ primaryPortalUserId }),
    provisionCleanClinicForExternalTenant: async (input) => {
      state.provisionCalls.push(clone(input));
      return {
        id: overrides.provisionedClinicId || 'provisioned-clinic',
        name: input.name,
        timezone: input.timezone,
        externalTenantId: input.externalTenantId
      };
    }
  });

  mockModule('src/repositories/portal-users.repository.js', {
    listPortalUsersByClinicId: async () => [],
    listPortalUsersForManagementByClinicId: async () => [],
    listPortalUsersForOpturonAdmin: async () => [],
    createPortalUser: async (payload) => {
      state.createdUsers.push(clone(payload));
      return {
        id: 'owner-user-1',
        clinicId: payload.clinicId,
        name: payload.name,
        email: payload.email,
        accountRootUserId: payload.accountRootUserId || 'owner-user-1',
        role: payload.role,
        active: payload.active !== false,
        createdAt: '2026-07-24T23:30:00.000Z',
        updatedAt: '2026-07-24T23:30:00.000Z'
      };
    },
    updatePortalUserClinicById: async (payload) => {
      state.movedUsers.push(clone(payload));
      return {
        id: payload.userId,
        clinicId: payload.nextClinicId,
        name: 'Mati Moran',
        email: 'mati_moran95@hotmail.com',
        accountRootUserId: payload.accountRootUserId,
        role: 'owner',
        active: false,
        createdAt: '2026-07-24T23:30:00.000Z',
        updatedAt: '2026-07-24T23:31:00.000Z'
      };
    },
    updatePortalUserAccountRootById: async (payload) => ({
      id: payload.userId,
      clinicId: payload.clinicId,
      name: 'Mati Moran',
      email: 'mati_moran95@hotmail.com',
      accountRootUserId: payload.accountRootUserId,
      role: 'owner',
      active: false,
      createdAt: '2026-07-24T23:30:00.000Z',
      updatedAt: '2026-07-24T23:31:00.000Z'
    }),
    updatePortalUserCredentialsById: async (payload) => {
      state.credentialUpdates.push(clone(payload));
      return null;
    },
    updatePortalUserProfileById: async () => null,
    updatePortalUserRole: async (payload) => {
      state.roleUpdates.push(clone(payload));
      return null;
    },
    deletePortalUserById: async () => null,
    findAnyPortalUserByEmail: async () => clone(state.existingAnyByEmail),
    findAnyPortalUserByEmailAndClinicId: async () => null,
    findPortalUserByEmail: async () => null,
    findPortalUserByEmailAndTenantId: async () => null,
    findPortalUserById: async () => null
  });

  mockModule('src/repositories/portal-user-invitations.repository.js', {
    createPortalUserInvitation: async (payload) => {
      state.invitations.push(clone(payload));
      return {
        id: 'invite-1',
        clinicId: payload.clinicId,
        tenantId: payload.tenantId,
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
        expiresAt: payload.expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: '2026-07-24T23:32:00.000Z'
      };
    },
    revokePendingPortalUserInvitationsByUserId: async () => [],
    listLatestPortalUserInvitationsByClinicId: async () => [],
    findPortalInvitationByTokenHash: async () => null,
    markPortalInvitationAccepted: async () => null
  });

  mockModule('src/repositories/portal-user-audit.repository.js', {
    createPortalUserAuditEvent: async (payload) => {
      state.auditEvents.push(clone(payload));
    },
    listPortalUserAuditEventsByClinicId: async () => []
  });

  mockModule('src/utils/portal-users.js', {
    normalizePortalUserRole: (value) => String(value || '').trim().toLowerCase(),
    isOperationalPortalAssigneeRole: (role) => ['seller', 'manager', 'owner'].includes(String(role || '').trim().toLowerCase())
  });

  const servicePath = modulePath('src/services/portal-users.service.js');
  delete require.cache[servicePath];
  return {
    state,
    service: require(servicePath)
  };
}

async function testOwnerInviteProvisionsClientTenant() {
  const { state, service } = buildService();
  const result = await service.invitePortalUser('tenant-admin', {
    name: 'Mati Moran',
    email: 'Mati_moran95@hotmail.com',
    role: 'owner'
  }, {
    actorUserId: 'admin-user-1'
  });

  assert.strictEqual(result.ok, true);
  assert.match(result.tenantId, /^tenant_mati_moran_/);
  assert.strictEqual(state.provisionCalls.length, 1);
  assert.strictEqual(state.createdUsers.length, 1);
  assert.strictEqual(state.createdUsers[0].clinicId, 'provisioned-clinic');
  assert.strictEqual(state.createdUsers[0].active, false);
  assert.strictEqual(state.createdUsers[0].passwordHash, null);
  assert.strictEqual(state.invitations.length, 1);
  assert.strictEqual(state.invitations[0].clinicId, 'provisioned-clinic');
  assert.strictEqual(state.invitations[0].tenantId, result.tenantId);
  assert.strictEqual(result.user.invitationStatus, 'pending');
  assert.strictEqual(result.meta.accountScope, 'client');
  assert.strictEqual(state.auditEvents.length, 1);
  assert.strictEqual(state.auditEvents[0].action, 'tenant_portal_user_invited');
  assert.strictEqual(state.auditEvents[0].payload.reusedClientTenant, false);
}

async function testManagerInviteDoesNotProvisionTenant() {
  const { state, service } = buildService();
  const result = await service.invitePortalUser('tenant-admin', {
    name: 'Admin Seller',
    email: 'admin.seller@example.com',
    role: 'manager'
  }, {
    actorUserId: 'admin-user-1'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tenantId, 'tenant-admin');
  assert.strictEqual(state.provisionCalls.length, 0);
  assert.strictEqual(state.createdUsers.length, 1);
  assert.strictEqual(state.createdUsers[0].clinicId, 'admin-clinic');
}

async function testOwnerInviteRetryReusesExistingClientTenant() {
  const { state, service } = buildService({
    existingAnyByEmail: {
      id: 'owner-user-1',
      clinicId: 'client-clinic-1',
      name: 'Mati Moran',
      email: 'mati_moran95@hotmail.com',
      accountRootUserId: 'owner-user-1',
      role: 'owner',
      active: true,
      passwordHash: '$2a$10$existing',
      createdAt: '2026-07-24T22:00:00.000Z',
      updatedAt: '2026-07-24T22:00:00.000Z',
      tenantId: 'tenant_existing_client',
      accountScope: 'client'
    },
    provisionedClinicId: 'client-clinic-1'
  });

  const result = await service.invitePortalUser('tenant-admin', {
    name: 'Mati Moran',
    email: 'mati_moran95@hotmail.com',
    role: 'owner'
  }, {
    actorUserId: 'admin-user-1'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tenantId, 'tenant_existing_client');
  assert.strictEqual(state.createdUsers.length, 0);
  assert.strictEqual(state.provisionCalls.length, 1);
  assert.strictEqual(state.provisionCalls[0].externalTenantId, 'tenant_existing_client');
  assert.strictEqual(state.movedUsers.length, 0);
  assert.strictEqual(state.invitations.length, 1);
  assert.strictEqual(state.invitations[0].tenantId, 'tenant_existing_client');
  assert.strictEqual(state.auditEvents[0].payload.reusedClientTenant, true);
}

async function run() {
  const originalDateNow = Date.now;
  Date.now = () => 1784935800000;

  try {
    await testOwnerInviteProvisionsClientTenant();
    await testManagerInviteDoesNotProvisionTenant();
    await testOwnerInviteRetryReusesExistingClientTenant();
    console.log('portal-users-opturon-admin-owner-invite.test.js: ok');
  } finally {
    Date.now = originalDateNow;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
