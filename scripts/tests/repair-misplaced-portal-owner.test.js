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

function buildScriptHarness() {
  const state = {
    user: {
      id: '8652c830-3e16-4ef1-bead-0bc42a3d1671',
      clinic_id: 'admin-clinic',
      email: 'mati_moran95@hotmail.com',
      name: 'Matias Moran',
      role: 'owner',
      active: true,
      account_type: 'client_portal',
      account_root_user_id: '208ddd98-997a-4dda-bd7c-b33f7d8ac78c',
      has_password_hash: true,
      clinic_name: 'Opturon Admin',
      timezone: 'America/Buenos_Aires',
      tenant_id: 'tenant_wrong_admin',
      account_scope: 'opturon_admin'
    },
    invitations: [
      {
        id: 'invite-1',
        clinic_id: 'admin-clinic',
        tenant_id: 'tenant_wrong_admin',
        accepted_at: '2026-07-24T22:59:20.999Z',
        revoked_at: null
      }
    ],
    sameClinicUsers: [
      { id: 'staff-1', email: 'admin@opturon.test', role: 'owner', active: true },
      { id: '8652c830-3e16-4ef1-bead-0bc42a3d1671', email: 'mati_moran95@hotmail.com', role: 'owner', active: true }
    ],
    activity: {
      conversations_assigned: 0,
      orders_seller: 0,
      rooted_users: 0
    },
    targetClinicId: 'client-clinic',
    auditEvents: [],
    invitationUpdates: 0,
    clinicUpdates: 0,
    targetClinicUsers: []
  };

  const fakeQuery = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();

    if (sql.includes('FROM staff_users su INNER JOIN clinics c')) {
      return { rows: [clone(state.user)] };
    }

    if (sql.includes('SELECT (SELECT COUNT(*)::INT FROM conversations')) {
      return { rows: [clone(state.activity)] };
    }

    if (sql.includes('FROM portal_user_invitations')) {
      return { rows: clone(state.invitations) };
    }

    if (sql.includes('FROM staff_users WHERE "clinicId" = $1 ORDER BY "createdAt" ASC')) {
      return { rows: clone(state.sameClinicUsers) };
    }

    if (sql.includes('FROM staff_users WHERE "clinicId" = $1 AND id <> $2 LIMIT 1')) {
      return { rows: clone(state.targetClinicUsers) };
    }

    if (sql.startsWith('UPDATE staff_users SET "clinicId" = $2')) {
      state.user.clinic_id = params[1];
      state.user.account_root_user_id = params[0];
      state.user.tenant_id = 'tenant_matias_moran_8652c830';
      state.user.account_scope = 'client';
      state.clinicUpdates += 1;
      return { rows: [] };
    }

    if (sql.startsWith('UPDATE portal_user_invitations SET "clinicId" = $2')) {
      state.invitations = state.invitations.map((item) => ({
        ...item,
        clinic_id: params[1],
        tenant_id: params[2]
      }));
      state.invitationUpdates += 1;
      return { rows: [] };
    }

    throw new Error(`unexpected sql: ${sql}`);
  };

  mockModule('src/db/client.js', {
    query: fakeQuery,
    closePool: async () => {},
    withTransaction: async (fn) => fn({ query: fakeQuery })
  });

  mockModule('src/repositories/tenant.repository.js', {
    provisionCleanClinicForExternalTenant: async (input) => ({
      id: state.targetClinicId,
      name: input.name,
      timezone: input.timezone,
      externalTenantId: input.externalTenantId
    }),
    updateClinicPortalPrimaryUserIdById: async () => ({ primaryPortalUserId: state.user.id })
  });

  mockModule('src/repositories/portal-user-audit.repository.js', {
    createPortalUserAuditEvent: async (payload) => {
      state.auditEvents.push(clone(payload));
    }
  });

  const scriptPath = modulePath('scripts/repair-misplaced-portal-owner.js');
  delete require.cache[scriptPath];
  return {
    state,
    script: require(scriptPath)
  };
}

async function testDryRunAndApplyAreIdempotent() {
  const { state, script } = buildScriptHarness();

  const dryRun = await script.repairMisplacedPortalOwner({
    email: 'Mati_moran95@hotmail.com',
    dryRun: true
  });
  assert.strictEqual(dryRun.ok, true);
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.preview.hasPasswordHash, true);
  assert.strictEqual(dryRun.preview.currentAccountScope, 'opturon_admin');

  const apply = await script.repairMisplacedPortalOwner({
    email: 'mati_moran95@hotmail.com',
    dryRun: false
  });
  assert.strictEqual(apply.ok, true);
  assert.strictEqual(apply.alreadyRepaired, false);
  assert.strictEqual(state.clinicUpdates, 1);
  assert.strictEqual(state.invitationUpdates, 1);
  assert.strictEqual(state.auditEvents.length, 1);
  assert.strictEqual(state.auditEvents[0].action, 'tenant_portal_user_repaired');
  assert.strictEqual(state.user.account_scope, 'client');

  const secondApply = await script.repairMisplacedPortalOwner({
    email: 'mati_moran95@hotmail.com',
    dryRun: false
  });
  assert.strictEqual(secondApply.ok, true);
  assert.strictEqual(secondApply.alreadyRepaired, true);
  assert.strictEqual(state.clinicUpdates, 1);
  assert.strictEqual(state.invitationUpdates, 1);
}

async function testNonAdminScopedOwnerIsRejected() {
  const { state, script } = buildScriptHarness();
  state.user.account_scope = 'client';
  state.user.tenant_id = 'tenant_other_client';

  const dryRun = await script.repairMisplacedPortalOwner({
    email: 'mati_moran95@hotmail.com',
    dryRun: true
  });
  assert.strictEqual(dryRun.ok, false);
  assert.strictEqual(dryRun.reason, 'unsupported_current_scope');

  const apply = await script.repairMisplacedPortalOwner({
    email: 'mati_moran95@hotmail.com',
    dryRun: false
  });
  assert.strictEqual(apply.ok, false);
  assert.strictEqual(apply.reason, 'unsupported_current_scope');
  assert.strictEqual(state.clinicUpdates, 0);
  assert.strictEqual(state.invitationUpdates, 0);
}

async function run() {
  await testDryRunAndApplyAreIdempotent();
  await testNonAdminScopedOwnerIsRejected();
  console.log('repair-misplaced-portal-owner.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
