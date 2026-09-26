const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const FAKE_ACCESS_TOKEN = 'APP_USR_FAKE_DIAGNOSTICS_TOKEN';
const FAKE_PUBLIC_KEY = 'APP_USR_FAKE_PUBLIC_KEY';

process.env.MERCADO_PAGO_ACCESS_TOKEN = FAKE_ACCESS_TOKEN;
process.env.MERCADO_PAGO_PUBLIC_KEY = FAKE_PUBLIC_KEY;
process.env.MERCADO_PAGO_ENVIRONMENT = 'production';

const env = require('../../src/config/env');
const diagnosticsRouter = require('../../src/routes/mercadopago-diagnostics.routes');

function requestJson(server, requestPath) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: address.port,
        path: requestPath
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: body ? JSON.parse(body) : null
          });
        });
      }
    );
    request.on('error', reject);
  });
}

test('Mercado Pago diagnostics remain read-only for every GET variant', async (t) => {
  const originalFetch = global.fetch;
  const providerCalls = [];

  global.fetch = async (url, options = {}) => {
    providerCalls.push({ url: String(url), method: String(options.method || 'GET').toUpperCase() });
    return new Response(JSON.stringify({ id: 123, nickname: 'diagnostics-user' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const app = express();
  app.use(diagnosticsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  t.after(() => {
    global.fetch = originalFetch;
    server.close();
  });

  await t.test('normal diagnostics use only the provider GET endpoint and do not expose configured values', async () => {
    providerCalls.length = 0;
    const response = await requestJson(server, '/__mercadopago/diagnostics');

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.diagnostics.mode, 'read_only');
    assert.deepEqual(providerCalls, [
      { url: 'https://api.mercadopago.com/users/me', method: 'GET' }
    ]);

    const serialized = JSON.stringify(response.body);
    assert.doesNotMatch(serialized, new RegExp(FAKE_ACCESS_TOKEN));
    assert.doesNotMatch(serialized, new RegExp(FAKE_PUBLIC_KEY));
    assert.equal(response.body.diagnostics.env.token.present, true);
    assert.equal(response.body.diagnostics.env.publicKey.present, true);
  });

  await t.test('legacy mutation parameters return a controlled 400 without provider calls', async () => {
    const legacyQueries = [
      'preapproval=1',
      'payerEmail=test%40example.com',
      'tenantId=tenant-test',
      'planCode=crecimiento',
      'currency=ARS',
      'amount=68600',
      'preapproval=1&payerEmail=test%40example.com'
    ];

    for (const query of legacyQueries) {
      providerCalls.length = 0;
      const response = await requestJson(server, `/__mercadopago/diagnostics?${query}`);
      assert.equal(response.status, 400, query);
      assert.deepEqual(response.body, {
        ok: false,
        error: 'mutating_diagnostics_disabled',
        message: 'Mutating diagnostics are disabled.'
      });
      assert.equal(providerCalls.length, 0, query);
    }
  });

  await t.test('unknown parameters cannot enable a mutation', async () => {
    providerCalls.length = 0;
    const response = await requestJson(server, '/__mercadopago/diagnostics?unknown=1');

    assert.equal(response.status, 200);
    assert.deepEqual(providerCalls, [
      { url: 'https://api.mercadopago.com/users/me', method: 'GET' }
    ]);
  });

  await t.test('missing Mercado Pago configuration fails safely before any provider request', async () => {
    providerCalls.length = 0;
    const previousToken = env.mercadoPagoAccessToken;
    env.mercadoPagoAccessToken = '';
    try {
      const response = await requestJson(server, '/__mercadopago/diagnostics');
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.diagnostics.mode, 'read_only');
      assert.equal(response.body.diagnostics.usersMe.ok, false);
      assert.equal(providerCalls.length, 0);
    } finally {
      env.mercadoPagoAccessToken = previousToken;
    }
  });

  await t.test('the diagnostics execution path contains no provider or database mutation', () => {
    const serviceSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/mercado-pago.service.js'),
      'utf8'
    );
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/routes/mercadopago-diagnostics.routes.js'),
      'utf8'
    );
    const diagnosticsBody = serviceSource.slice(
      serviceSource.indexOf('async function runMercadoPagoAuthDiagnostics'),
      serviceSource.indexOf('async function getPreapproval')
    );

    assert.doesNotMatch(diagnosticsBody, /POST|PUT|PATCH|DELETE|createPreapproval|updatePreapproval|cancelPreapproval|pausePreapproval|reactivatePreapproval/);
    assert.doesNotMatch(routeSource, /repository|database|withTransaction|sendEmail|createPreapproval|updatePreapproval|cancelPreapproval|pausePreapproval|reactivatePreapproval/);
  });
});
