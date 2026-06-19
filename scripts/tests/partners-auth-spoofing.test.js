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

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function testAdminMiddlewareRejectsSpoofedRoleHeaderWithoutRealAdminActor() {
  clearModule('src/middlewares/partner-auth.middleware.js');
  mockModule('src/middlewares/portal-internal-auth.middleware.js', {
    requirePortalInternalAuth: (_req, _res, next) => next()
  });
  mockModule('src/services/portal-active-tenant.service.js', {
    findPortalActorContext: async () => ({
      id: 'actor-1',
      accountScope: 'client',
      isAdmin: false
    })
  });
  mockModule('src/repositories/partners.repository.js', {
    findPartnerById: async () => null
  });

  const { requireAdminInternalActor } = require(modulePath('src/middlewares/partner-auth.middleware.js'));
  const req = {
    get(header) {
      if (header === 'x-portal-actor-id') return '11111111-1111-4111-8111-111111111111';
      if (header === 'x-portal-actor-role') return 'superadmin';
      return '';
    }
  };
  const res = createResponseRecorder();
  let nextCalled = false;

  await requireAdminInternalActor(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'partner_admin_forbidden');
}

async function testPartnerMiddlewareRejectsUnknownPartnerHeader() {
  clearModule('src/middlewares/partner-auth.middleware.js');
  mockModule('src/middlewares/portal-internal-auth.middleware.js', {
    requirePortalInternalAuth: (_req, _res, next) => next()
  });
  mockModule('src/services/portal-active-tenant.service.js', {
    findPortalActorContext: async () => null
  });
  mockModule('src/repositories/partners.repository.js', {
    findPartnerById: async () => null
  });

  const { requirePartnerInternalAuth } = require(modulePath('src/middlewares/partner-auth.middleware.js'));
  const req = {
    get(header) {
      if (header === 'x-partner-id') return '11111111-1111-4111-8111-111111111111';
      return '';
    }
  };
  const res = createResponseRecorder();
  let nextCalled = false;

  await requirePartnerInternalAuth(req, res, () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'partner_forbidden');
}

async function testPartnerControllerUsesResolvedAuthContextInsteadOfClientHeader() {
  clearModule('src/controllers/partners.controller.js');
  mockModule('src/services/partners.service.js', {
    getPartnerMe: async (partnerId) => ({
      ok: true,
      partner: { id: partnerId }
    }),
    getPartnerSummary: async () => ({ ok: true, partner: {}, summary: {} }),
    getPartnerClients: async () => ({ ok: true, partner: {}, clients: [] }),
    getPartnerRankProgress: async () => ({ ok: true, partner: {}, rankHistory: [], latestEvaluation: null })
  });

  const { getPartnersMe } = require(modulePath('src/controllers/partners.controller.js'));
  const req = {
    partnerAuth: {
      partnerId: 'partner-authenticated'
    },
    get(header) {
      if (header === 'x-partner-id') return 'partner-spoofed';
      return '';
    }
  };
  const res = createResponseRecorder();

  await getPartnersMe(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.partner.id, 'partner-authenticated');
}

async function run() {
  await testAdminMiddlewareRejectsSpoofedRoleHeaderWithoutRealAdminActor();
  await testPartnerMiddlewareRejectsUnknownPartnerHeader();
  await testPartnerControllerUsesResolvedAuthContextInsteadOfClientHeader();
  console.log('partners-auth-spoofing.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
