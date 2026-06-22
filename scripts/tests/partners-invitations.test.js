const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');

const rootDir = path.resolve(__dirname, '..', '..');
const dbName = 'opturon_partner_invites_scratch';
const dbUrl = `postgresql://postgres:postgres@127.0.0.1:5434/${dbName}`;
const adminDbUrl = 'postgresql://postgres:postgres@127.0.0.1:5434/postgres';
const scratchKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function clearModules() {
  [
    'src/config/env.js',
    'src/db/client.js',
    'src/repositories/partners.repository.js',
    'src/repositories/partner-invitations.repository.js',
    'src/services/partner-invitations-email.service.js',
    'src/services/partners.service.js'
  ].forEach((relativePath) => {
    delete require.cache[modulePath(relativePath)];
  });
}

function setScratchEnv() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.TOKENS_ENCRYPTION_KEY = scratchKey;
  process.env.PORTAL_INTERNAL_KEY = 'scratch-internal-key';
  process.env.OPTURON_PUBLIC_APP_URL = 'https://www.opturon.com';
}

async function recreateScratchDatabase() {
  const client = new Client({ connectionString: adminDbUrl });
  await client.connect();
  await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName]);
  await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();
}

function runMigrations() {
  execFileSync('node', ['src/db/migrate.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      TOKENS_ENCRYPTION_KEY: scratchKey,
      PORTAL_INTERNAL_KEY: 'scratch-internal-key'
    },
    stdio: 'pipe'
  });
}

async function inspect052Schema() {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const passwordHash = await client.query(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'partner_accounts'
       AND column_name = 'passwordHash'`
  );
  assert.strictEqual(passwordHash.rows[0].is_nullable, 'YES');

  const invitationTable = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'partner_invitations'`
  );
  assert.strictEqual(invitationTable.rowCount, 1);

  const invitationIndexes = await client.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'partner_invitations'
     ORDER BY indexname ASC`
  );
  assert.ok(invitationIndexes.rows.some((row) => row.indexname === 'partner_invitations_token_hash_unique_idx'));
  assert.ok(invitationIndexes.rows.some((row) => /UNIQUE INDEX .*tokenHash/.test(row.indexdef)));

  const foreignKeys = await client.query(
    `SELECT conname
     FROM pg_constraint
     WHERE conrelid = 'partner_invitations'::regclass
       AND contype = 'f'`
  );
  assert.ok(foreignKeys.rowCount >= 2);

  const statusConstraint = await client.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'partner_accounts'::regclass
       AND conname = 'partner_accounts_status_check'`
  );
  assert.match(statusConstraint.rows[0].definition, /invitation_canceled/);

  await client.end();
}

async function insertAdminActor(client) {
  const clinicId = '10000000-0000-4000-8000-000000000001';
  const adminActorId = '10000000-0000-4000-8000-000000000010';

  await client.query(
    `INSERT INTO clinics (id, name, timezone, settings, "externalTenantId")
     VALUES ($1, 'Opturon Admin', 'UTC', '{"portal":{"accountScope":"opturon_admin"}}'::jsonb, 'tenant_admin')`,
    [clinicId]
  );

  await client.query(
    `INSERT INTO staff_users (id, "clinicId", name, role, active, email, "passwordHash", "accountType", "accountRootUserId")
     VALUES ($1, $2, 'Admin Actor', 'owner', TRUE, 'admin@opturon.test', '$2b$10$abcdefghijklmnopqrstuv', 'internal_staff', $1)`,
    [adminActorId, clinicId]
  );

  return { clinicId, adminActorId };
}

function installEmailMock(options = {}) {
  let lastLink = null;
  const emailModulePath = modulePath('src/services/partner-invitations-email.service.js');
  require.cache[emailModulePath] = {
    id: emailModulePath,
    filename: emailModulePath,
    loaded: true,
    exports: {
      buildPartnerInvitationAcceptLink: (token) => {
        lastLink = `https://www.opturon.com/partners/invite?token=${encodeURIComponent(token)}`;
        return lastLink;
      },
      sendPartnerInvitationEmail: async (input) => {
        if (options.failSend) {
          const error = new Error('partner_invitation_email_send_failed');
          error.code = 'partner_invitation_email_send_failed';
          throw error;
        }
        lastLink = input.acceptLink;
        return { provider: 'resend', id: 'mock-email-1', to: input.email };
      }
    }
  };
  return {
    getToken() {
      if (!lastLink) return null;
      return new URL(lastLink).searchParams.get('token');
    }
  };
}

function installInvitationAcceptFailureWrapper() {
  const repoPath = modulePath('src/repositories/partner-invitations.repository.js');
  const actual = require(repoPath);
  require.cache[repoPath] = {
    id: repoPath,
    filename: repoPath,
    loaded: true,
    exports: {
      ...actual,
      markPartnerInvitationAccepted: async () => {
        throw new Error('forced_accept_failure');
      }
    }
  };
}

async function fetchPartnerAuthState(client, partnerId) {
  const result = await client.query(
    `SELECT status, "passwordHash"
     FROM partner_accounts
     WHERE id = $1`,
    [partnerId]
  );
  return result.rows[0] || null;
}

async function fetchInvitationRows(client, partnerId) {
  const result = await client.query(
    `SELECT id, "acceptedAt", "revokedAt", "expiresAt"
     FROM partner_invitations
     WHERE "partnerId" = $1
     ORDER BY "createdAt" ASC`,
    [partnerId]
  );
  return result.rows;
}

async function runDomainAssertions() {
  setScratchEnv();
  clearModules();
  const emailMock = installEmailMock();
  const service = require(modulePath('src/services/partners.service.js'));

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const seed = await insertAdminActor(client);
  await client.end();

  const inviteResult = await service.invitePartner(
    {
      email: 'invited@partner.test',
      displayName: 'Invited Partner',
      code: 'INVITED-001'
    },
    { actorStaffUserId: seed.adminActorId }
  );
  assert.strictEqual(inviteResult.ok, true);
  assert.strictEqual(inviteResult.partner.status, 'invited');
  assert.strictEqual(inviteResult.invitation.status, 'pending');

  const firstToken = emailMock.getToken();
  assert.ok(firstToken);

  const lookup1 = await service.resolvePartnerInvitation(firstToken);
  assert.strictEqual(lookup1.ok, true);
  assert.strictEqual(lookup1.invitation.email, 'invited@partner.test');

  const loginPending = await service.authenticatePartnerUser('invited@partner.test', 'password123');
  assert.strictEqual(loginPending.ok, false);
  assert.strictEqual(loginPending.reason, 'invalid_credentials');

  const resendResult = await service.resendPartnerInvitation(inviteResult.partner.id, {
    actorStaffUserId: seed.adminActorId
  });
  assert.strictEqual(resendResult.ok, true);

  const secondToken = emailMock.getToken();
  assert.ok(secondToken);
  assert.notStrictEqual(secondToken, firstToken);

  const oldLookup = await service.resolvePartnerInvitation(firstToken);
  assert.strictEqual(oldLookup.ok, false);
  assert.strictEqual(oldLookup.reason, 'invalid_or_expired_invitation');

  const secondLookup = await service.resolvePartnerInvitation(secondToken);
  assert.strictEqual(secondLookup.ok, true);

  const dbClient = new Client({ connectionString: dbUrl });
  await dbClient.connect();
  const invitationRowsAfterResend = await fetchInvitationRows(dbClient, inviteResult.partner.id);
  assert.strictEqual(invitationRowsAfterResend.length, 2);
  assert.strictEqual(Boolean(invitationRowsAfterResend[0].revokedAt), true);
  assert.strictEqual(invitationRowsAfterResend[1].revokedAt, null);
  await dbClient.end();

  const acceptResult = await service.acceptPartnerInvitation(secondToken, 'password123');
  assert.strictEqual(acceptResult.ok, true);
  assert.strictEqual(acceptResult.partner.status, 'active');

  const loginActive = await service.authenticatePartnerUser('invited@partner.test', 'password123');
  assert.strictEqual(loginActive.ok, true);
  assert.strictEqual(loginActive.user.globalRole, 'partner');

  const usedLookup = await service.resolvePartnerInvitation(secondToken);
  assert.strictEqual(usedLookup.ok, false);
  assert.strictEqual(usedLookup.reason, 'invalid_or_expired_invitation');

  const verifyClient = new Client({ connectionString: dbUrl });
  await verifyClient.connect();
  const acceptedState = await fetchPartnerAuthState(verifyClient, inviteResult.partner.id);
  assert.strictEqual(acceptedState.status, 'active');
  assert.ok(acceptedState.passwordHash);
  assert.notStrictEqual(acceptedState.passwordHash, 'password123');
  const acceptedInvitations = await fetchInvitationRows(verifyClient, inviteResult.partner.id);
  assert.strictEqual(Boolean(acceptedInvitations[1].acceptedAt), true);
  await verifyClient.end();

  const suspendedPartner = await service.createPartner(
    {
      email: 'suspended@partner.test',
      password: 'password123',
      displayName: 'Suspended Partner',
      status: 'suspended'
    },
    { actorStaffUserId: seed.adminActorId }
  );
  assert.strictEqual(suspendedPartner.ok, true);
  const loginSuspended = await service.authenticatePartnerUser('suspended@partner.test', 'password123');
  assert.strictEqual(loginSuspended.ok, false);
  assert.strictEqual(loginSuspended.reason, 'invalid_credentials');

  const canceled = await service.cancelPartnerInvitation(inviteResult.partner.id, {
    actorStaffUserId: seed.adminActorId,
    reason: 'admin_cleanup'
  });
  assert.strictEqual(canceled.ok, false);
  assert.strictEqual(canceled.reason, 'partner_invitation_not_pending');

  const secondInvite = await service.invitePartner(
    {
      email: 'cancelme@partner.test',
      displayName: 'Cancel Me',
      code: 'CANCEL-001'
    },
    { actorStaffUserId: seed.adminActorId }
  );
  assert.strictEqual(secondInvite.ok, true);
  const cancelToken = emailMock.getToken();
  assert.ok(cancelToken);
  const canceledPending = await service.cancelPartnerInvitation(secondInvite.partner.id, {
    actorStaffUserId: seed.adminActorId,
    reason: 'admin_cleanup'
  });
  assert.strictEqual(canceledPending.ok, true);
  assert.strictEqual(canceledPending.partner.status, 'invitation_canceled');
  const canceledLookup = await service.resolvePartnerInvitation(cancelToken);
  assert.strictEqual(canceledLookup.ok, false);
  assert.strictEqual(canceledLookup.reason, 'invalid_or_expired_invitation');
}

async function runEmailFailureAssertion() {
  setScratchEnv();
  clearModules();
  installEmailMock({ failSend: true });
  const service = require(modulePath('src/services/partners.service.js'));

  const result = await service.invitePartner({
    email: 'emailfail@partner.test',
    displayName: 'Email Fail Partner',
    code: 'EMAIL-FAIL-001'
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'partner_invitation_email_send_failed');
  assert.doesNotMatch(JSON.stringify(result), /token/i);

  const lookup = await service.getPartnerAuthUserByEmail('emailfail@partner.test');
  assert.strictEqual(lookup.ok, true);
  assert.strictEqual(lookup.user, null);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const persisted = await client.query(
    `SELECT pa.status, pa."passwordHash", COUNT(pi.id)::INT AS invitations
     FROM partner_accounts pa
     LEFT JOIN partner_invitations pi ON pi."partnerId" = pa.id
     WHERE LOWER(pa.email) = LOWER('emailfail@partner.test')
     GROUP BY pa.id`,
  );
  assert.strictEqual(persisted.rowCount, 1);
  assert.strictEqual(persisted.rows[0].status, 'invited');
  assert.strictEqual(persisted.rows[0].passwordHash, null);
  assert.strictEqual(persisted.rows[0].invitations, 1);
  await client.end();
}

async function runRollbackAssertion() {
  setScratchEnv();
  clearModules();
  const emailMock = installEmailMock();
  const baselineService = require(modulePath('src/services/partners.service.js'));
  const inviteResult = await baselineService.invitePartner({
    email: 'rollback@partner.test',
    displayName: 'Rollback Partner',
    code: 'ROLLBACK-001'
  });
  assert.strictEqual(inviteResult.ok, true);
  const token = emailMock.getToken();
  assert.ok(token);

  clearModules();
  installEmailMock();
  installInvitationAcceptFailureWrapper();
  const service = require(modulePath('src/services/partners.service.js'));

  await assert.rejects(
    service.acceptPartnerInvitation(token, 'password123'),
    /forced_accept_failure/
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const authState = await fetchPartnerAuthState(client, inviteResult.partner.id);
  assert.strictEqual(authState.status, 'invited');
  assert.strictEqual(authState.passwordHash, null);
  const invitations = await fetchInvitationRows(client, inviteResult.partner.id);
  assert.strictEqual(invitations.length, 1);
  assert.strictEqual(invitations[0].acceptedAt, null);
  assert.strictEqual(invitations[0].revokedAt, null);
  await client.end();
}

async function runExpiredAndRevokedAssertions() {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const expired = await client.query(
    `SELECT pi."tokenHash"
     FROM partner_invitations pi
     INNER JOIN partner_accounts pa ON pa.id = pi."partnerId"
     WHERE LOWER(pa.email) = LOWER('emailfail@partner.test')
     LIMIT 1`
  );
  assert.strictEqual(expired.rowCount, 1);
  await client.query(
    `UPDATE partner_invitations
     SET "expiresAt" = NOW() - INTERVAL '1 hour'
     WHERE "tokenHash" = $1`,
    [expired.rows[0].tokenHash]
  );
  await client.end();

  setScratchEnv();
  clearModules();
  installEmailMock();
  const service = require(modulePath('src/services/partners.service.js'));
  const expiredLookup = await service.resolvePartnerInvitation('definitely-not-valid');
  assert.strictEqual(expiredLookup.ok, false);
  assert.strictEqual(expiredLookup.reason, 'invalid_or_expired_invitation');
}

async function main() {
  setScratchEnv();
  await recreateScratchDatabase();
  runMigrations();
  runMigrations();
  await inspect052Schema();
  await runDomainAssertions();
  await runEmailFailureAssertion();
  await runRollbackAssertion();
  await runExpiredAndRevokedAssertions();
  console.log('partners-invitations.test.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
