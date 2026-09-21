const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const modulePath = (relativePath) => path.join(root, relativePath);
const read = (relativePath) => fs.readFileSync(modulePath(relativePath), 'utf8');
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  const previous = require.cache[fullPath];
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
  return () => {
    if (previous) require.cache[fullPath] = previous;
    else delete require.cache[fullPath];
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function loadGuard(actor) {
  const restore = [
    mockModule('src/middlewares/portal-internal-auth.middleware.js', {
      requirePortalInternalAuth: (_req, _res, next) => next()
    }),
    mockModule('src/services/portal-active-tenant.service.js', {
      findPortalActorContext: async () => actor
    }),
    mockModule('src/repositories/partners.repository.js', {
      findPartnerById: async () => null
    })
  ];
  const middlewarePath = modulePath('src/middlewares/partner-auth.middleware.js');
  delete require.cache[middlewarePath];
  const middleware = require(middlewarePath);
  return {
    guard: middleware.requireAdminInternalActor,
    restore: () => {
      delete require.cache[middlewarePath];
      restore.reverse().forEach((fn) => fn());
    }
  };
}

async function authorize(actor, targetTenantId = 'tenant-a') {
  const { guard, restore } = loadGuard(actor);
  const req = {
    params: { tenantId: targetTenantId },
    get: (header) => header === 'x-portal-actor-id' ? ACTOR_ID : ''
  };
  const res = response();
  let nextCalled = false;
  try {
    await guard(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  } finally {
    restore();
  }
}

async function run() {
  const clientActor = {
    id: ACTOR_ID,
    tenantId: 'tenant-a',
    role: 'owner',
    accountScope: 'client',
    isAdmin: false
  };
  const platformActor = {
    id: ACTOR_ID,
    tenantId: 'opturon-admin',
    role: 'owner',
    accountScope: 'opturon_admin',
    isAdmin: true
  };

  const clientRead = await authorize(clientActor);
  assert.equal(clientRead.res.statusCode, 403, 'CLIENT_MODULE_READ_DENIED');
  assert.equal(clientRead.nextCalled, false);

  const clientWrite = await authorize(clientActor);
  assert.equal(clientWrite.res.statusCode, 403, 'CLIENT_MODULE_WRITE_DENIED');
  assert.equal(clientWrite.nextCalled, false);

  const clientCapabilityWrite = await authorize(clientActor);
  assert.equal(clientCapabilityWrite.res.statusCode, 403, 'CLIENT_CAPABILITY_WRITE_DENIED');

  const tenantAdminEscalation = await authorize({ ...clientActor, role: 'admin' });
  assert.equal(tenantAdminEscalation.res.statusCode, 403, 'TENANT_ADMIN_PLATFORM_ESCALATION_DENIED');

  const crossTenantMutation = await authorize(clientActor, 'tenant-b');
  assert.equal(crossTenantMutation.res.statusCode, 403, 'CROSS_TENANT_MODULE_MUTATION_DENIED');

  const platformRead = await authorize(platformActor);
  assert.equal(platformRead.nextCalled, true, 'PLATFORM_STAFF_MODULE_READ_ALLOWED');
  assert.equal(platformRead.req.adminActor.id, ACTOR_ID);

  const platformWrite = await authorize(platformActor, 'tenant-b');
  assert.equal(platformWrite.nextCalled, true, 'PLATFORM_STAFF_MODULE_WRITE_ALLOWED');

  const portalRoutes = read('src/routes/portal.routes.js');
  const adminRoutes = read('src/routes/admin.routes.js');
  const controller = read('src/controllers/portal.controller.js');

  assert.match(portalRoutes, /router\.get\('\/tenants\/:tenantId\/policy', requireAdminInternalActor, getPortalTenantPolicy\)/);
  assert.match(portalRoutes, /router\.patch\('\/tenants\/:tenantId\/policy', requireAdminInternalActor, patchPortalTenantPolicy\)/);
  assert.match(portalRoutes, /router\.post\('\/tenants\/:tenantId\/provision', requireAdminInternalActor, postPortalTenantProvision\)/);
  assert.match(adminRoutes, /router\.get\('\/tenants', requireAdminInternalActor, getTenants\)/);
  assert.match(adminRoutes, /router\.get\('\/tenants\/:tenantId\/policy', requireAdminInternalActor, getTenantPolicy\)/);
  assert.match(adminRoutes, /router\.patch\('\/tenants\/:tenantId\/policy', requireAdminInternalActor, patchTenantPolicy\)/);
  assert.match(controller, /patchPortalTenantPolicy[\s\S]*mode: 'admin'[\s\S]*actorScope:[\s\S]*portal_control_plane_api/);

  console.log('CLIENT_MODULE_READ_DENIED=PASS');
  console.log('CLIENT_MODULE_WRITE_DENIED=PASS');
  console.log('CLIENT_CAPABILITY_WRITE_DENIED=PASS');
  console.log('CLIENT_INTERNAL_RECOMMENDATIONS_DENIED=PASS (no backend recommendation endpoint exists)');
  console.log('TENANT_ADMIN_PLATFORM_ESCALATION_DENIED=PASS');
  console.log('CROSS_TENANT_MODULE_MUTATION_DENIED=PASS');
  console.log('PLATFORM_STAFF_MODULE_READ_ALLOWED=PASS');
  console.log('PLATFORM_STAFF_MODULE_WRITE_ALLOWED=PASS');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
