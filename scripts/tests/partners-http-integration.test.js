const assert = require('assert');
const express = require('express');
const http = require('http');
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

async function withServer(testFn) {
  const modulesToClear = [
    'src/config/env.js',
    'src/middlewares/partner-auth.middleware.js',
    'src/middlewares/portal-internal-auth.middleware.js',
    'src/services/portal-active-tenant.service.js',
    'src/repositories/partners.repository.js'
  ];
  modulesToClear.forEach(clearModule);

  mockModule('src/config/env.js', {
    nodeEnv: 'test',
    portalInternalKey: 'internal-test-key'
  });
  mockModule('src/services/portal-active-tenant.service.js', {
    findPortalActorContext: async (actorId) => {
      if (actorId === '11111111-1111-4111-8111-111111111111') {
        return { id: actorId, accountScope: 'client', isAdmin: false };
      }
      if (actorId === '22222222-2222-4222-8222-222222222222') {
        return { id: actorId, accountScope: 'opturon_admin', isAdmin: true };
      }
      return null;
    }
  });
  mockModule('src/repositories/partners.repository.js', {
    findPartnerById: async (partnerId) => {
      if (partnerId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
        return { id: partnerId, email: 'a@test.com', status: 'active', profile: { displayName: 'Partner A' } };
      }
      if (partnerId === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') {
        return { id: partnerId, email: 'b@test.com', status: 'suspended', profile: { displayName: 'Partner B' } };
      }
      return null;
    }
  });

  const { requirePortalInternalAuth } = require(modulePath('src/middlewares/portal-internal-auth.middleware.js'));
  const {
    requirePartnerInternalAuth,
    requireAdminInternalActor
  } = require(modulePath('src/middlewares/partner-auth.middleware.js'));

  const app = express();
  app.get('/api/partners/me', requirePartnerInternalAuth, (req, res) => {
    res.status(200).json({ success: true, partnerId: req.partnerAuth.partnerId });
  });
  app.get('/api/partners/me/summary', requirePartnerInternalAuth, (req, res) => {
    res.status(200).json({ success: true, partnerId: req.partnerAuth.partnerId });
  });
  app.get('/api/admin/partners', requireAdminInternalActor, (req, res) => {
    res.status(200).json({ success: true, actorId: req.adminActor.id });
  });
  app.get('/api/internal-check', requirePortalInternalAuth, (_req, res) => {
    res.status(200).json({ success: true });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testFn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testPartnerInactiveRejected() {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/partners/me`, {
      headers: {
        'x-portal-key': 'internal-test-key',
        'x-partner-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      }
    });
    const body = await response.json();
    assert.strictEqual(response.status, 403);
    assert.strictEqual(body.error, 'partner_forbidden');
  });
}

async function testPartnerUnknownRejectedEvenWithHeaderSpoof() {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/partners/me/summary`, {
      headers: {
        'x-portal-key': 'internal-test-key',
        'x-partner-id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      }
    });
    const body = await response.json();
    assert.strictEqual(response.status, 403);
    assert.strictEqual(body.error, 'partner_forbidden');
  });
}

async function testAdminSpoofedRoleIgnored() {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/partners`, {
      headers: {
        'x-portal-key': 'internal-test-key',
        'x-portal-actor-id': '11111111-1111-4111-8111-111111111111',
        'x-portal-actor-role': 'superadmin'
      }
    });
    const body = await response.json();
    assert.strictEqual(response.status, 403);
    assert.strictEqual(body.error, 'partner_admin_forbidden');
  });
}

async function testAdminMissingActorRejected() {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/partners`, {
      headers: {
        'x-portal-key': 'internal-test-key'
      }
    });
    const body = await response.json();
    assert.strictEqual(response.status, 401);
    assert.strictEqual(body.error, 'partner_admin_unauthorized');
  });
}

async function testAdminValidActorAccepted() {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/partners`, {
      headers: {
        'x-portal-key': 'internal-test-key',
        'x-portal-actor-id': '22222222-2222-4222-8222-222222222222'
      }
    });
    const body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.actorId, '22222222-2222-4222-8222-222222222222');
  });
}

async function run() {
  await testPartnerInactiveRejected();
  await testPartnerUnknownRejectedEvenWithHeaderSpoof();
  await testAdminSpoofedRoleIgnored();
  await testAdminMissingActorRejected();
  await testAdminValidActorAccepted();
  console.log('partners-http-integration.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
