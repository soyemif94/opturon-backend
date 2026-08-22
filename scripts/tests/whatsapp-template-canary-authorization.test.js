const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppCanaryAuthorization } = require('../../src/middlewares/portal-whatsapp-canary-authorization.middleware');

function response() {
  return { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(tenantId = 'tenant-a') {
  return { params: { tenantId }, get(name) { return name === 'x-portal-actor-id' ? 'actor-a' : null; } };
}

async function run(actor, write, tenantId = 'tenant-a') {
  const middleware = createWhatsAppCanaryAuthorization({ hasPortalInternalAuth: () => true, findPortalActorContext: async () => actor });
  const req = request(tenantId); const res = response(); let next = 0;
  await middleware(req, res, () => { next += 1; }, write);
  return { req, res, next };
}

test('owner and manager can send only inside their tenant', async () => {
  for (const role of ['owner', 'manager']) assert.equal((await run({ id: 'actor-a', tenantId: 'tenant-a', role, isAdmin: false }, true)).next, 1);
  assert.equal((await run({ id: 'actor-a', tenantId: 'tenant-a', role: 'owner', isAdmin: false }, true, 'tenant-b')).res.code, 403);
});
test('seller and viewer are read-only at backend authority', async () => {
  for (const role of ['seller', 'viewer']) {
    assert.equal((await run({ id: 'actor-a', tenantId: 'tenant-a', role, isAdmin: false }, false)).next, 1);
    assert.equal((await run({ id: 'actor-a', tenantId: 'tenant-a', role, isAdmin: false }, true)).res.code, 403);
  }
});
