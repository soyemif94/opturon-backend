const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const activePath = require.resolve(path.join(root, 'src/services/portal-active-tenant.service.js'));
const middlewarePath = require.resolve(path.join(root, 'src/middlewares/portal-inbox-authorization.middleware.js'));

async function runGate(actor, {
  internal = true,
  tenantId = 'tenant-a',
  activeTenantId,
  activeTenantContext,
  globalRole = ''
} = {}) {
  delete require.cache[middlewarePath];
  require.cache[activePath] = {
    id: activePath, filename: activePath, loaded: true,
    exports: {
      hasPortalInternalAuth: () => internal,
      findPortalActorContext: async () => actor
    }
  };
  const { requireConversationDeleteRole } = require(middlewarePath);
  let nextCalled = false;
  let responseStatus = null;
  const req = {
    params: { tenantId },
    activeTenantId,
    activeTenantContext,
    get(name) {
      if (name === 'x-portal-actor-id') return 'actor-id';
      if (name === 'x-portal-actor-global-role') return globalRole;
      return '';
    }
  };
  const res = { status(code) { responseStatus = code; return this; }, json(body) { return body; } };
  await requireConversationDeleteRole()(req, res, () => { nextCalled = true; });
  return { nextCalled, responseStatus };
}

async function main() {
  assert.equal((await runGate({ tenantId: 'tenant-a', role: 'owner', isAdmin: false })).nextCalled, true);
  assert.equal((await runGate({ tenantId: 'tenant-a', role: 'manager', isAdmin: false })).nextCalled, true);
  for (const globalRole of ['superadmin', 'ops_admin']) {
    assert.equal((await runGate({
      id: 'actor-id', tenantId: 'admin-tenant', role: 'owner', isAdmin: true, accountScope: 'opturon_admin'
    }, {
      tenantId: 'admin-tenant', globalRole
    })).nextCalled, true);
    assert.equal((await runGate({
      id: 'actor-id', tenantId: 'admin-tenant', role: 'owner', isAdmin: true, accountScope: 'opturon_admin'
    }, {
      tenantId: 'admin-tenant',
      activeTenantId: 'tenant-a',
      activeTenantContext: { source: 'active_tenant', actorUserId: 'actor-id', activeTenantId: 'tenant-a' },
      globalRole
    })).nextCalled, true);
  }
  for (const actor of [
    { tenantId: 'tenant-a', role: 'seller', isAdmin: false },
    { tenantId: 'tenant-a', role: 'viewer', isAdmin: false },
    { tenantId: 'tenant-b', role: 'owner', isAdmin: false },
    null
  ]) {
    assert.equal((await runGate(actor)).responseStatus, 403);
  }
  const admin = { id: 'actor-id', tenantId: 'admin-tenant', role: 'owner', isAdmin: true, accountScope: 'opturon_admin' };
  for (const globalRole of ['', 'sales_rep', 'support_agent']) {
    assert.equal((await runGate(admin, { tenantId: 'admin-tenant', globalRole })).responseStatus, 403);
  }
  assert.equal((await runGate(admin, {
    tenantId: 'admin-tenant',
    activeTenantId: 'tenant-b',
    activeTenantContext: { source: 'active_tenant', actorUserId: 'different-actor', activeTenantId: 'tenant-b' },
    globalRole: 'superadmin'
  })).responseStatus, 403);
  assert.equal((await runGate({ tenantId: 'tenant-a', role: 'owner' }, { internal: false })).responseStatus, 403);
  console.log('inbox-conversation-delete-authorization.test.js passed');
}

main().finally(() => {
  delete require.cache[activePath];
  delete require.cache[middlewarePath];
}).catch((error) => { console.error(error); process.exitCode = 1; });
