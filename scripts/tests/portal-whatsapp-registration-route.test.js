const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const actorId = '11111111-1111-4111-8111-111111111111';
const routePath = '/tenants/:tenantId/whatsapp/register';
const forbiddenCode = 'portal_whatsapp_canary_forbidden';
const secret = 'never-expose-access-token-or-pin-123456';

function load(relativePath, dependencies) {
  const module = { exports: {} };
  const requireMock = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected dependency in isolated route test: ${name}`);
  };
  new Function('require', 'module', 'exports', fs.readFileSync(path.join(root, relativePath), 'utf8'))(
    requireMock, module, module.exports
  );
  return module.exports;
}

function harness(options = {}) {
  const calls = [];
  const env = { nodeEnv: 'production', portalInternalKey: 'test-internal-key' };
  const actor = Object.hasOwn(options, 'actor') ? options.actor : {
    id: actorId, clinicId: 'clinic-a', tenantId: 'tenant-a', role: 'owner', accountScope: 'client'
  };
  const actorService = load('src/services/portal-active-tenant.service.js', {
    '../config/env': env,
    '../db/client': {
      query: async (_sql, params) => ({ rows: actor && params[0] === actor.id ? [actor] : [] })
    },
    '../repositories/staff.repository': {},
    '../repositories/portal-users.repository': {},
    '../repositories/tenant.repository': {
      findClinicByExternalTenantId: async (tenantId) => (
        ['tenant-a', 'tenant-b', 'admin-tenant'].includes(tenantId) ? { id: `clinic-${tenantId}` } : null
      )
    }
  });
  const internalAuth = load('src/middlewares/portal-internal-auth.middleware.js', { '../config/env': env });
  const activeTenant = load('src/middlewares/portal-active-tenant.middleware.js', {
    '../services/portal-active-tenant.service': actorService
  });
  const canaryAuthorization = load('src/middlewares/portal-whatsapp-canary-authorization.middleware.js', {
    '../services/portal-active-tenant.service': actorService
  });
  const registrations = [];
  const router = {};
  for (const method of ['use', 'get', 'post', 'patch', 'put', 'delete']) {
    router[method] = (pattern, ...handlers) => registrations.push({ method, pattern, handlers });
  }
  const noop = (_req, _res, next) => next && next();
  const unusedExports = new Proxy({}, { get: () => () => noop });
  const multer = () => ({ single: () => noop });
  multer.memoryStorage = () => ({});
  multer.MulterError = class extends Error {};
  const dependencies = {
    express: { Router: () => router },
    multer,
    '../middlewares/portal-internal-auth.middleware': internalAuth,
    '../middlewares/portal-active-tenant.middleware': activeTenant,
    '../middlewares/portal-whatsapp-canary-authorization.middleware': canaryAuthorization,
    '../services/portal-whatsapp-embedded-signup.service': {
      registerPortalWhatsAppPhoneNumber: async (...args) => {
        calls.push(args);
        if (options.error) throw options.error;
        return options.result || { ok: true, registered: true };
      }
    }
  };
  const source = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
    if (!Object.hasOwn(dependencies, match[1])) dependencies[match[1]] = unusedExports;
  }
  load('src/routes/portal.routes.js', dependencies);
  const target = registrations.find((entry) => entry.method === 'post' && entry.pattern === routePath);
  assert.ok(target, 'registration endpoint must exist');
  const targetIndex = registrations.indexOf(target);
  const before = registrations.slice(0, targetIndex).filter((entry) => entry.method === 'use'
    && ['/tenants/:tenantId', routePath].includes(entry.pattern));
  const headers = {
    'x-portal-key': 'test-internal-key', 'x-portal-actor-id': actorId,
    'x-request-id': 'registration-route-test', ...options.headers
  };
  const req = {
    params: { tenantId: options.tenantId || 'tenant-a' },
    body: options.body || {},
    get: (name) => headers[name.toLowerCase()] || null
  };
  const res = {
    statusCode: null, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  };
  async function runHandlers(handlers, index = 0) {
    if (index === handlers.length) return;
    let nextTask;
    await handlers[index](req, res, () => { nextTask = runHandlers(handlers, index + 1); });
    if (nextTask) await nextTask;
  }
  return {
    calls, req, res, target, canaryAuthorization,
    async run() {
      await runHandlers([...before.flatMap((entry) => entry.handlers), ...target.handlers]);
      return res;
    },
    async runAfterTenantResolution() {
      await runHandlers(target.handlers);
      return res;
    }
  };
}

test('registration requires the portal internal key before actor resolution or service', async () => {
  for (const key of ['', 'wrong-key']) {
    const scenario = harness({ headers: { 'x-portal-key': key } });
    const res = await scenario.run();
    assert.equal(res.statusCode, 401);
    assert.equal(scenario.calls.length, 0);
    assert.equal(res.headers['cache-control'], 'private, no-store');
  }
});

test('registration requires a persisted actor with owner or manager permissions', async () => {
  for (const role of ['owner', 'manager']) {
    const scenario = harness({ actor: { id: actorId, tenantId: 'tenant-a', role, accountScope: 'client' } });
    assert.equal((await scenario.run()).statusCode, 200);
    assert.equal(scenario.calls.length, 1);
  }
  for (const role of ['seller', 'viewer', 'unknown']) {
    const scenario = harness({ actor: { id: actorId, tenantId: 'tenant-a', role, accountScope: 'client' } });
    assert.equal((await scenario.run()).body.error, forbiddenCode);
    assert.equal(scenario.calls.length, 0);
  }
  for (const headers of [{ 'x-portal-actor-id': '' }, { 'x-portal-actor-id': 'forged-actor' }]) {
    const scenario = harness({ headers });
    assert.equal((await scenario.run()).statusCode, 403);
    assert.equal(scenario.calls.length, 0);
  }
});

test('a client cannot register a different tenant through path, active header or body', async () => {
  const foreignPath = harness({ tenantId: 'tenant-b' });
  assert.equal((await foreignPath.run()).statusCode, 403);
  assert.equal(foreignPath.calls.length, 0);

  const ownPath = harness({
    headers: { 'x-active-tenant-id': 'tenant-b', 'x-portal-actor-role': 'admin' },
    body: { tenantId: 'tenant-b', clinicId: 'clinic-b', channelId: 'channel-b', phoneNumberId: 'phone-b',
      accessToken: secret, pin: '123456', actorUserId: 'forged-actor', requestId: secret }
  });
  assert.equal((await ownPath.run()).statusCode, 200);
  assert.deepEqual(ownPath.calls, [['tenant-a', { actorUserId: actorId, requestId: 'registration-route-test' }]]);
  assert.ok(!JSON.stringify(ownPath.calls).includes(secret));
});

test('Opturon admin registration uses only the server-resolved active tenant', async () => {
  const admin = { id: actorId, tenantId: 'admin-tenant', role: 'owner', accountScope: 'opturon_admin' };
  const scenario = harness({ actor: admin, tenantId: 'admin-tenant', headers: { 'x-active-tenant-id': 'tenant-b' } });
  assert.equal((await scenario.run()).statusCode, 200);
  assert.equal(scenario.calls[0][0], 'tenant-b');

  const foreignPath = harness({ actor: admin, tenantId: 'tenant-b' });
  assert.equal((await foreignPath.run()).statusCode, 403);
  assert.equal(foreignPath.calls.length, 0);

  for (const context of [
    { source: 'active_tenant', actorUserId: 'different-actor', activeTenantId: 'tenant-b' },
    { source: 'active_tenant', actorUserId: actorId, activeTenantId: 'tenant-a' },
    { source: 'requested_tenant', actorUserId: actorId, activeTenantId: 'tenant-b' }
  ]) {
    const forged = harness({ actor: admin, tenantId: 'admin-tenant' });
    forged.req.activeTenantId = 'tenant-b';
    forged.req.activeTenantContext = context;
    assert.equal((await forged.runAfterTenantResolution()).statusCode, 403);
    assert.equal(forged.calls.length, 0);
  }
});

test('registration response includes no PIN, access token or arbitrary service details', async () => {
  const success = harness({ result: { ok: true, registered: true, pin: secret, accessToken: secret, data: secret } });
  assert.deepEqual((await success.run()).body, { success: true, data: { registered: true } });

  const failure = harness({ result: { ok: false, reason: 'meta_phone_registration_failed', detail: secret } });
  assert.equal((await failure.run()).statusCode, 502);
  assert.deepEqual(failure.res.body, { success: false, error: 'meta_phone_registration_failed' });

  const unexpected = harness({ error: new Error(secret) });
  assert.equal((await unexpected.run()).statusCode, 500);
  assert.deepEqual(unexpected.res.body, { success: false, error: 'whatsapp_registration_failed' });
  const arbitraryReason = harness({ result: { ok: false, reason: secret, detail: secret } });
  assert.deepEqual((await arbitraryReason.run()).body, { success: false, error: 'whatsapp_registration_failed' });
});

test('registration fails closed without resolved tenant context and rejects unsafe request IDs', async () => {
  const unresolved = harness();
  assert.equal((await unresolved.runAfterTenantResolution()).statusCode, 403);
  assert.equal(unresolved.calls.length, 0);
  const unsafeRequestId = harness({ headers: { 'x-request-id': 'arbitrary\nlog-content' } });
  assert.equal((await unsafeRequestId.run()).statusCode, 200);
  assert.equal(unsafeRequestId.calls[0][1].requestId, null);
});
