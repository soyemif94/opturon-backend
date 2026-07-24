const assert = require('assert');
const path = require('path');
const { compareSync } = require('bcryptjs');

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

function buildService(initialUser) {
  const state = {
    user: initialUser ? { ...initialUser } : null,
    tokens: [],
    auditEvents: [],
    updatedCredentials: []
  };

  mockModule('src/db/client.js', {
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) })
  });

  mockModule('src/repositories/portal-password-reset.repository.js', {
    findResettablePortalUserByEmail: async (email) => {
      if (!state.user) return null;
      return String(state.user.email).toLowerCase() === String(email).toLowerCase() ? { ...state.user } : null;
    },
    createPortalPasswordResetToken: async (payload) => {
      const row = {
        id: `reset-${state.tokens.length + 1}`,
        userId: payload.userId,
        tokenHash: payload.tokenHash,
        expiresAt: payload.expiresAt,
        consumedAt: null,
        metadata: payload.metadata || {},
        createdAt: '2026-07-24T23:40:00.000Z'
      };
      state.tokens.push(row);
      return { ...row };
    },
    revokePendingPortalPasswordResetTokensByUserId: async (userId) => {
      const revoked = [];
      for (const token of state.tokens) {
        if (token.userId === userId && !token.consumedAt && new Date(token.expiresAt).getTime() > Date.now()) {
          token.consumedAt = '2026-07-24T23:41:00.000Z';
          revoked.push({ id: token.id });
        }
      }
      return revoked;
    },
    findPortalPasswordResetTokenByHash: async (tokenHash) => {
      const token = state.tokens.find((item) => item.tokenHash === tokenHash);
      if (!token || !state.user) return null;
      return {
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        consumedAt: token.consumedAt,
        metadata: token.metadata,
        createdAt: token.createdAt,
        clinicId: state.user.clinicId,
        email: state.user.email,
        name: state.user.name,
        role: state.user.role,
        active: state.user.active,
        tenantId: state.user.tenantId,
        accountScope: state.user.accountScope
      };
    },
    consumePortalPasswordResetTokenById: async (tokenId) => {
      const token = state.tokens.find((item) => item.id === tokenId && !item.consumedAt);
      if (!token) return null;
      token.consumedAt = '2026-07-24T23:42:00.000Z';
      return { ...token };
    },
    revokePortalPasswordResetTokenByHash: async (tokenHash) => {
      const token = state.tokens.find((item) => item.tokenHash === tokenHash && !item.consumedAt);
      if (!token) return null;
      token.consumedAt = '2026-07-24T23:43:00.000Z';
      return { ...token };
    }
  });

  mockModule('src/repositories/portal-users.repository.js', {
    updatePortalUserCredentialsById: async (payload) => {
      state.updatedCredentials.push({ ...payload });
      if (!state.user) return null;
      state.user.passwordHash = payload.passwordHash;
      state.user.active = payload.active;
      return {
        id: state.user.id,
        clinicId: state.user.clinicId,
        name: state.user.name,
        email: state.user.email,
        accountRootUserId: state.user.accountRootUserId,
        role: state.user.role,
        active: state.user.active,
        passwordHash: state.user.passwordHash
      };
    }
  });

  mockModule('src/repositories/portal-user-audit.repository.js', {
    createPortalUserAuditEvent: async (payload) => {
      state.auditEvents.push(payload);
    }
  });

  const servicePath = modulePath('src/services/portal-password-reset.service.js');
  delete require.cache[servicePath];
  return {
    state,
    service: require(servicePath)
  };
}

async function testExistingEmailGeneratesPersistentTokenCaseInsensitive() {
  const { state, service } = buildService({
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'mati_moran95@hotmail.com',
    name: 'Matias Moran',
    role: 'owner',
    active: true,
    tenantId: 'tenant_client_1',
    accountScope: 'client',
    passwordHash: '$2a$10$oldhash'
  });

  const result = await service.requestPortalPasswordReset('Mati_Moran95@Hotmail.com', { includeDelivery: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(typeof result.delivery.token, 'string');
  assert.strictEqual(result.delivery.email, 'mati_moran95@hotmail.com');
  assert.strictEqual(state.tokens.length, 1);
  assert.notStrictEqual(state.tokens[0].tokenHash, result.delivery.token);
  assert.strictEqual(state.auditEvents[0].action, 'tenant_portal_password_reset_requested');
}

async function testUnknownEmailReturnsGenericWithoutToken() {
  const { state, service } = buildService(null);
  const result = await service.requestPortalPasswordReset('nobody@example.com', { includeDelivery: true });
  assert.deepStrictEqual(result, { ok: true, delivery: null });
  assert.strictEqual(state.tokens.length, 0);
}

async function testOpturonAdminUserCannotUsePortalReset() {
  const { state, service } = buildService({
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'admin-owner@example.com',
    name: 'Admin Owner',
    role: 'owner',
    active: true,
    tenantId: 'tenant_admin_1',
    accountScope: 'opturon_admin',
    passwordHash: '$2a$10$oldhash'
  });
  const result = await service.requestPortalPasswordReset('admin-owner@example.com', { includeDelivery: true });
  assert.deepStrictEqual(result, { ok: true, delivery: null });
  assert.strictEqual(state.tokens.length, 0);
}

async function testValidTokenChangesPasswordAndInvalidatesReuse() {
  const oldPassword = 'ViejaClave123';
  const { state, service } = buildService({
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'mati_moran95@hotmail.com',
    name: 'Matias Moran',
    role: 'owner',
    active: true,
    tenantId: 'tenant_client_1',
    accountScope: 'client',
    passwordHash: '$2a$10$oldhash'
  });

  const request = await service.requestPortalPasswordReset('mati_moran95@hotmail.com', { includeDelivery: true });
  assert.strictEqual((await service.validatePortalPasswordResetToken(request.delivery.token)).valid, true);

  const reset = await service.resetPortalPassword(request.delivery.token, 'NuevaClave123');
  assert.strictEqual(reset.ok, true);
  assert.strictEqual(state.updatedCredentials.length, 1);
  const newHash = state.updatedCredentials[0].passwordHash;
  assert.strictEqual(compareSync('NuevaClave123', newHash), true);
  assert.strictEqual(compareSync(oldPassword, newHash), false);
  assert.strictEqual((await service.validatePortalPasswordResetToken(request.delivery.token)).valid, false);

  const reuse = await service.resetPortalPassword(request.delivery.token, 'OtraClave123');
  assert.strictEqual(reuse.ok, false);
  assert.strictEqual(reuse.reason, 'invalid_or_expired_reset_token');
}

async function testExpiredAndInvalidTokensFail() {
  const { state, service } = buildService({
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'mati_moran95@hotmail.com',
    name: 'Matias Moran',
    role: 'owner',
    active: true,
    tenantId: 'tenant_client_1',
    accountScope: 'client',
    passwordHash: '$2a$10$oldhash'
  });

  const request = await service.requestPortalPasswordReset('mati_moran95@hotmail.com', { includeDelivery: true });
  state.tokens[0].expiresAt = '2026-07-24T00:00:00.000Z';

  const expiredValidation = await service.validatePortalPasswordResetToken(request.delivery.token);
  assert.strictEqual(expiredValidation.valid, false);

  const expiredReset = await service.resetPortalPassword(request.delivery.token, 'NuevaClave123');
  assert.strictEqual(expiredReset.ok, false);
  assert.strictEqual(expiredReset.reason, 'invalid_or_expired_reset_token');

  const invalidReset = await service.resetPortalPassword('totally-invalid-token-value', 'NuevaClave123');
  assert.strictEqual(invalidReset.ok, false);
  assert.strictEqual(invalidReset.reason, 'invalid_or_expired_reset_token');
}

async function testInvalidatePendingDeliveryTokenConsumesIt() {
  const { state, service } = buildService({
    id: 'user-1',
    clinicId: 'clinic-1',
    email: 'mati_moran95@hotmail.com',
    name: 'Matias Moran',
    role: 'owner',
    active: true,
    tenantId: 'tenant_client_1',
    accountScope: 'client',
    passwordHash: '$2a$10$oldhash'
  });

  const request = await service.requestPortalPasswordReset('mati_moran95@hotmail.com', { includeDelivery: true });
  assert.strictEqual((await service.validatePortalPasswordResetToken(request.delivery.token)).valid, true);

  const invalidation = await service.invalidatePortalPasswordResetToken(request.delivery.token);
  assert.deepStrictEqual(invalidation, { ok: true, invalidated: true });
  assert.strictEqual((await service.validatePortalPasswordResetToken(request.delivery.token)).valid, false);
}

async function run() {
  await testExistingEmailGeneratesPersistentTokenCaseInsensitive();
  await testUnknownEmailReturnsGenericWithoutToken();
  await testOpturonAdminUserCannotUsePortalReset();
  await testValidTokenChangesPasswordAndInvalidatesReuse();
  await testExpiredAndInvalidTokensFail();
  await testInvalidatePendingDeliveryTokenConsumesIt();
  console.log('portal-password-reset.service.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
