const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const routePath = require.resolve('../../src/routes/mercadopago-webhook.routes');
const controllerPath = require.resolve('../../src/controllers/mercadopago.controller');
const mercadoPagoServicePath = require.resolve('../../src/services/mercado-pago.service');
const billingServicePath = require.resolve('../../src/services/saas-billing.service');
const envPath = require.resolve('../../src/config/env');

const originalNodeEnv = process.env.NODE_ENV;
const originalWebhookSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;

function clearWebhookModules() {
  for (const modulePath of [routePath, controllerPath, mercadoPagoServicePath, billingServicePath, envPath]) {
    delete require.cache[modulePath];
  }
}

function setWebhookEnvironment(secret) {
  process.env.NODE_ENV = 'production';
  if (secret === null) {
    delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    return;
  }
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = secret;
}

function restoreWebhookEnvironment() {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;

  if (originalWebhookSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  else process.env.MERCADO_PAGO_WEBHOOK_SECRET = originalWebhookSecret;
}

function installModuleStub(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue
  };
}

function createEffectTracker() {
  const effects = {
    processorCalls: 0,
    providerFetchCalls: 0,
    repositoryMutationCalls: 0,
    tenantMutationCalls: 0
  };

  effects.processWebhook = async () => {
    effects.processorCalls += 1;
    effects.providerFetchCalls += 1;
    effects.repositoryMutationCalls += 1;
    effects.tenantMutationCalls += 1;
    return { ok: true, duplicate: false, ignored: false, subscription: null };
  };

  return effects;
}

async function createWebhookServer({ secret, processWebhook, verifyWebhookSignature }) {
  clearWebhookModules();
  setWebhookEnvironment(secret);
  installModuleStub(billingServicePath, { processMercadoPagoWebhook: processWebhook });

  if (verifyWebhookSignature) {
    installModuleStub(mercadoPagoServicePath, { verifyWebhookSignature });
  }

  const router = require(routePath);
  const app = express();
  app.use((req, res, next) => {
    req.requestId = String(req.get('x-request-id') || 'test-request-id');
    next();
  });
  app.use('/api/webhooks/mercadopago', router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeWebhookServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  clearWebhookModules();
  restoreWebhookEnvironment();
}

function createSignature({ secret, dataId, requestId, timestamp }) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
}

async function requestWebhook(server, { dataId = 'subscription-123', requestId = 'request-123', signature }) {
  const address = server.address();
  const headers = {
    'content-type': 'application/json',
    'x-request-id': requestId
  };
  if (signature !== undefined) headers['x-signature'] = signature;

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/webhooks/mercadopago?data.id=${encodeURIComponent(dataId)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'notification-123',
        type: 'subscription_preapproval',
        action: 'updated',
        data: { id: dataId }
      })
    }
  );

  return {
    status: response.status,
    body: await response.json()
  };
}

function assertNoBusinessEffects(effects) {
  assert.equal(effects.processorCalls, 0, 'billing processor must not run');
  assert.equal(effects.providerFetchCalls, 0, 'provider fetch must not run');
  assert.equal(effects.repositoryMutationCalls, 0, 'repository mutation must not run');
  assert.equal(effects.tenantMutationCalls, 0, 'tenant mutation must not run');
}

test.after(() => {
  clearWebhookModules();
  restoreWebhookEnvironment();
});

test('Mercado Pago webhook signatures fail closed before billing processing', async (t) => {
  const secret = 'test-only-mercado-pago-webhook-secret';
  const timestamp = '1727300000';
  const dataId = 'subscription-123';

  await t.test('CASE A: valid signature preserves the normal processing flow', async () => {
    const effects = createEffectTracker();
    const requestId = 'request-valid';
    const digest = createSignature({ secret, dataId, requestId, timestamp });
    const server = await createWebhookServer({ secret, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId,
        signature: `ts=${timestamp},v1=${digest}`
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(effects.processorCalls, 1);
      assert.equal(effects.providerFetchCalls, 1);
      assert.equal(effects.repositoryMutationCalls, 1);
      assert.equal(effects.tenantMutationCalls, 1);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('CASE B: invalid signature is rejected without business effects', async () => {
    const effects = createEffectTracker();
    const server = await createWebhookServer({ secret, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'request-invalid',
        signature: `ts=${timestamp},v1=${'0'.repeat(64)}`
      });

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { success: false, error: 'webhook_signature_invalid' });
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('CASE C: missing signature is rejected without business effects', async () => {
    const effects = createEffectTracker();
    const server = await createWebhookServer({ secret, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'request-missing'
      });

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { success: false, error: 'webhook_signature_invalid' });
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('CASE D: malformed signature is rejected without an exception leak', async () => {
    const effects = createEffectTracker();
    const server = await createWebhookServer({ secret, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'request-malformed',
        signature: `ts=${timestamp}`
      });

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { success: false, error: 'webhook_signature_invalid' });
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('CASE E: request ID correlation mismatch is rejected', async () => {
    const effects = createEffectTracker();
    const digest = createSignature({
      secret,
      dataId,
      requestId: 'request-used-to-sign',
      timestamp
    });
    const server = await createWebhookServer({ secret, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'different-request-id',
        signature: `ts=${timestamp},v1=${digest}`
      });

      assert.equal(response.status, 401);
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('CASE F: unavailable secret fails closed in production-like configuration', async () => {
    const effects = createEffectTracker();
    const server = await createWebhookServer({ secret: null, processWebhook: effects.processWebhook });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'request-no-secret',
        signature: `ts=${timestamp},v1=${'a'.repeat(64)}`
      });

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { success: false, error: 'webhook_signature_invalid' });
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });

  await t.test('verification exceptions fail closed without business effects', async () => {
    const effects = createEffectTracker();
    const server = await createWebhookServer({
      secret,
      processWebhook: effects.processWebhook,
      verifyWebhookSignature: () => {
        throw new Error('test-only verification failure');
      }
    });

    try {
      const response = await requestWebhook(server, {
        dataId,
        requestId: 'request-error',
        signature: `ts=${timestamp},v1=${'b'.repeat(64)}`
      });

      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { success: false, error: 'webhook_signature_invalid' });
      assertNoBusinessEffects(effects);
    } finally {
      await closeWebhookServer(server);
    }
  });
});

test('signature rejection remains before payload parsing and billing processing', () => {
  const controllerSource = require('node:fs').readFileSync(
    path.resolve(__dirname, '../../src/controllers/mercadopago.controller.js'),
    'utf8'
  );

  const signatureGuardIndex = controllerSource.indexOf('if (signatureValid !== true)');
  const payloadParseIndex = controllerSource.indexOf('payload = normalizePayload(req)');
  const processWebhookIndex = controllerSource.indexOf('await processMercadoPagoWebhook');

  assert.ok(signatureGuardIndex >= 0);
  assert.ok(signatureGuardIndex < payloadParseIndex);
  assert.ok(signatureGuardIndex < processWebhookIndex);
});
