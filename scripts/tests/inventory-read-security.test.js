const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const authorizationPath = path.join(root, 'src/middlewares/portal-inventory-authorization.middleware.js');
const actorServicePath = path.join(root, 'src/services/portal-active-tenant.service.js');

function mockResponse() {
  return {
    statusCode: null,
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

async function runGate(actor, options = {}) {
  delete require.cache[require.resolve(authorizationPath)];
  require.cache[require.resolve(actorServicePath)] = {
    id: actorServicePath,
    filename: actorServicePath,
    loaded: true,
    exports: {
      hasPortalInternalAuth: () => options.internalAuth !== false,
      findPortalActorContext: async () => actor
    }
  };
  const authorization = require(authorizationPath);
  const middleware = authorization[options.gate || 'requireInventoryReadRole']();
  const req = {
    params: { tenantId: options.targetTenantId || 'tenant-a' },
    activeTenantId: options.activeTenantId,
    activeTenantContext: options.activeTenantContext,
    get(name) {
      if (String(name).toLowerCase() === 'x-portal-actor-id') return options.actorId === undefined ? 'actor-1' : options.actorId;
      if (String(name).toLowerCase() === 'x-portal-actor-global-role') return options.globalRole || null;
      return null;
    }
  };
  const res = mockResponse();
  let nextCalls = 0;
  await middleware(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

async function testReadRoleMatrix() {
  for (const role of ['owner', 'manager', 'seller', 'viewer', 'editor']) {
    const result = await runGate({ role, tenantId: 'tenant-a', isAdmin: false });
    assert.equal(result.nextCalls, 1, `${role} must read its own inventory`);
    assert.equal(result.res.statusCode, null);
    assert.ok(result.req.inventoryActor, 'authorized actor context must be attached');
  }

  for (const actor of [
    null,
    { role: 'unknown', tenantId: 'tenant-a', isAdmin: false },
    { role: 'viewer', tenantId: 'tenant-b', isAdmin: false },
    { role: 'owner', tenantId: '', isAdmin: false },
    { role: 'owner', tenantId: 'tenant-a', isAdmin: true, accountScope: 'tenant' }
  ]) {
    const result = await runGate(actor);
    assert.equal(result.nextCalls, 0);
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.res.body.error, 'portal_inventory_role_forbidden');
  }

  const anonymous = await runGate({ role: 'owner', tenantId: 'tenant-a', isAdmin: false }, { actorId: '' });
  assert.equal(anonymous.res.statusCode, 403, 'missing actor identity must be forbidden');
  const noInternalKey = await runGate({ role: 'owner', tenantId: 'tenant-a', isAdmin: false }, { internalAuth: false });
  assert.equal(noInternalKey.res.statusCode, 403, 'missing server-to-server auth must be forbidden');

  const adminActor = { id: 'actor-1', role: 'owner', tenantId: 'admin-tenant', isAdmin: true, accountScope: 'opturon_admin' };
  for (const globalRole of ['superadmin', 'ops_admin']) {
    const ownTenant = await runGate(adminActor, { targetTenantId: 'admin-tenant', globalRole });
    assert.equal(ownTenant.nextCalls, 1, `${globalRole} may read its canonical tenant`);
    const selectedTenant = await runGate(adminActor, {
      targetTenantId: 'admin-tenant',
      activeTenantId: 'tenant-a',
      activeTenantContext: { source: 'active_tenant', actorUserId: 'actor-1', activeTenantId: 'tenant-a' },
      globalRole
    });
    assert.equal(selectedTenant.nextCalls, 1, `${globalRole} may read a server-resolved active tenant`);
  }

  for (const globalRole of ['', 'sales_rep', 'support_agent']) {
    const denied = await runGate(adminActor, { targetTenantId: 'admin-tenant', globalRole });
    assert.equal(denied.res.statusCode, 403, `${globalRole || 'missing role'} must not gain admin inventory access`);
  }
  const forgedSelection = await runGate(adminActor, {
    targetTenantId: 'admin-tenant',
    activeTenantId: 'tenant-b',
    activeTenantContext: { source: 'active_tenant', actorUserId: 'different-actor', activeTenantId: 'tenant-b' },
    globalRole: 'superadmin'
  });
  assert.equal(forgedSelection.res.statusCode, 403, 'admin cross-tenant scope must come from the canonical selection middleware');

  for (const gate of ['requireCatalogWriteRole', 'requireInventoryReceiptRole']) {
    const allowedAdmin = await runGate(adminActor, { targetTenantId: 'admin-tenant', globalRole: 'ops_admin', gate });
    assert.equal(allowedAdmin.nextCalls, 1, `${gate} must allow a canonical Opturon admin`);
    const deniedSupport = await runGate(adminActor, { targetTenantId: 'admin-tenant', globalRole: 'support_agent', gate });
    assert.equal(deniedSupport.res.statusCode, 403, `${gate} must reject support staff`);
  }

  const sensitiveAdmin = await runGate(adminActor, {
    targetTenantId: 'admin-tenant', globalRole: 'superadmin', gate: 'requireSensitiveInventoryRole'
  });
  assert.equal(sensitiveAdmin.res.statusCode, 403, 'generic sensitive inventory mutations remain tenant owner/manager only');
}

function testInventoryRouteDefenseInDepth() {
  const source = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  const inventoryRoutes = source.split(/\r?\n/).filter((line) => /router\.(get|post|put|patch|delete)\('\/tenants\/:tenantId\/inventory\//.test(line));
  assert.ok(inventoryRoutes.length >= 20, 'expected complete inventory route surface');
  for (const line of inventoryRoutes) {
    assert.match(line, /requirePortalInternalAuth/, `inventory route lacks internal auth: ${line}`);
    if (/router\.get\(/.test(line)) {
      assert.match(line, /inventoryReadRole/, `inventory GET lacks actor membership gate: ${line}`);
      assert.match(line, /inventoryCapability/, `inventory GET lacks capability gate: ${line}`);
    }
  }
  assert.match(
    source,
    /router\.post\('\/tenants\/:tenantId\/products\/:productId\/inventory-mode', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, catalogModule, postPortalProductInventoryMode\)/,
    'inventory mode mutation must not remain an unauthenticated inventory backdoor'
  );
}

async function main() {
  try {
    await testReadRoleMatrix();
    testInventoryRouteDefenseInDepth();
    console.log('inventory-read-security.test.js passed');
  } finally {
    delete require.cache[require.resolve(authorizationPath)];
    delete require.cache[require.resolve(actorServicePath)];
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
