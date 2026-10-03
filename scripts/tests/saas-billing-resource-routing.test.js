const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');
const { captureLocalBillingContract } = require('../../src/services/saas-billing-contract');
const outcomes = require('../../src/services/saas-billing-webhook-outcomes');

const root = path.resolve(__dirname, '../..');
const secret = 'local-only-6b-signature';
const token = 'TEST-local-only-6b-token';
const originalFetch = global.fetch;
const modules = new Map();
function stub(name, exports) {
  const id = require.resolve(path.join(root, name));
  modules.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

test('BILL-006B: resource routing, signed HTTP and isolated PostgreSQL', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `routing_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  let server; let provider; let calls; let logs; let payload; let subscription;
  stub('src/db/client.js', {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  });
  stub('src/config/env.js', { mercadoPagoWebhookSecret: secret, mercadoPagoAccessToken: token,
    mercadoPagoEnvironment: 'test', nodeEnv: 'production' });
  const log = (event, fields) => logs.push({ event, fields });
  stub('src/utils/logger.js', { logInfo: log, logWarn: log, logError: log });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  // Exercise the real provider service, including auth, URL encoding and error
  // taxonomy. MP responses are intercepted BEFORE any network; writes are banned.
  global.fetch = async (value, init = {}) => {
    const request = new URL(value);
    if (request.hostname === '127.0.0.1') return originalFetch(value, init);
    assert.equal(request.origin, 'https://api.mercadopago.com', 'external network forbidden');
    assert.equal(init.method, 'GET', 'provider writes forbidden');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['X-scope'], 'stage');
    calls.push(request.pathname + request.search);
    const kind = request.pathname === '/authorized_payments/search' ? 'search'
      : request.pathname.startsWith('/authorized_payments/') ? 'invoice'
      : request.pathname.startsWith('/v1/payments/') ? 'payment'
      : request.pathname.startsWith('/preapproval/') ? 'preapproval'
      : request.pathname.startsWith('/preapproval_plan/') ? 'plan' : null;
    assert.ok(kind, 'unexpected provider endpoint');
    assert.equal(request.search, kind === 'search' ? '?payment_id=19951521071&offset=0&limit=2' : '');
    const endpointId = { payment: '19951521071', invoice: '6114264375', preapproval: 'mp-1', plan: 'plan-1' };
    if (kind !== 'search' && request.pathname.split('/').pop() !== (provider.endpointId?.[kind] || endpointId[kind])) return new Response('{}', { status: 404 });
    if (provider.error?.kind === kind) {
      if (provider.error.network) throw new Error(provider.error.message);
      return new Response(JSON.stringify(provider.error.body || { message: 'mock provider error' }),
        { status: provider.error.status });
    }
    return new Response(JSON.stringify(provider[kind]), { status: 200 });
  };
  const repository = require('../../src/repositories/saas-subscriptions.repository');
  const service = require('../../src/services/saas-billing.service');
  const mp = require('../../src/services/mercado-pago.service');
  const app = express();
  app.use('/api/webhooks/mercadopago', require('../../src/routes/mercadopago-webhook.routes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const clinicId = '00000000-0000-4000-8000-000000000001';
  async function deliver(valid = true) {
    const requestId = 'fixture-' + (payload.id || 'without-notification'); const ts = '1727300000'; const id = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    provider = {}; calls = []; logs = [];
    await pool.query('TRUNCATE mutation_audit, saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query('INSERT INTO clinics (id,"externalTenantId") VALUES ($1,$2)', [clinicId, 'tenant-routing']);
    const id = crypto.randomUUID();
    const input = { id, clinicId, externalTenantId: 'tenant-routing', planCode: 'inicial', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: 'mp-1',
      externalReference: `opturon:tenant-routing:${id}` };
    const contract = captureLocalBillingContract({ ...input, subscriptionId: id,
      plan: { code: 'inicial', amount: 40600, currency: 'ARS' }, capturedAt: new Date().toISOString() });
    subscription = await repository.insertSaasSubscription({ ...input, metadata: { contract } });
    provider.preapproval = { id: 'mp-1', status: 'authorized', external_reference: input.externalReference,
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS', frequency: 1, frequency_type: 'months' } };
    provider.payment = { date_created: new Date().toISOString(), id: 19951521071, status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference,
      transaction_amount: 40600, currency_id: 'ARS' };
    provider.search = { paging: { offset: 0, limit: 2, total: 1 }, results: [{ id: 6114264375, payment: { id: 19951521071 } }] };
    provider.invoice = { id: 6114264375, preapproval_id: 'mp-1', transaction_amount: '40600.00', currency_id: 'ARS',
      status: 'processed', summarized: 'done', payment: { id: 19951521071, status: 'approved' }, external_reference: input.externalReference };
    payload = { id: 'notice-6b', type: 'subscription_authorized_payment', action: 'updated', data: { id: '6114264375' } };
  }
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  const event = async () => (await pool.query('SELECT * FROM saas_subscription_events')).rows[0];
  const business = async () => ({ subscription: (await pool.query('SELECT * FROM saas_subscriptions')).rows[0],
    tenant: (await pool.query('SELECT * FROM clinics')).rows[0] });
  async function assertMutations(n) {
    const rows = (await pool.query('SELECT kind,count(*)::int AS n FROM mutation_audit GROUP BY kind')).rows;
    assert.deepEqual(Object.fromEntries(['subscription', 'tenant'].map(kind => [kind, rows.find(row => row.kind === kind)?.n || 0])),
      { subscription: n, tenant: n });
  }
  async function assertProcessed(response) {
    assert.equal(response.status, 200); assert.equal(response.body.duplicate, false);
    const row = await event();
    assert.equal(row.processingStatus, 'processed'); assert.equal(row.contractOutcome, null);
    assert.equal(row.subscriptionId, subscription.id); assert.deepEqual(row.raw, payload); await assertMutations(1);
  }
  async function assertRetryable(response, reason) {
    assert.deepEqual(response, { status: 503, body: { success: false, error: 'webhook_processing_failed' } });
    const row = await event();
    assert.equal(row.processingStatus, 'failed'); assert.equal(row.contractOutcome, null);
    assert.equal(require('../../src/services/saas-billing-rollback-marker').isBillingContractV2Marker(row.processingError), true); assert.deepEqual(row.raw, payload);
    assert.equal(row.processingError.split(':').at(-1), reason);
    await assertMutations(0);
  }
  function paymentTopic() { payload.type = 'payment'; payload.data.id = '19951521071'; }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql', '086_saas_subscription_event_contract_outcome.sql', '087_saas_billing_runtime_state.sql', '088_saas_billing_effects_reconciliation.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
      if (name.startsWith('088_')) await require('./helpers/billing-v2-fixture').activateFixture(pool);
    }
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_routing_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW
        EXECUTE FUNCTION count_routing_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW
        EXECUTE FUNCTION count_routing_mutation('tenant');`);
    t.diagnostic('Real loopback PostgreSQL + signed local HTTP; MP fetch intercepted; no external network');

    await scenario('A/P: invoice ID goes to authorized_payments, Payment ID goes to v1/payments after 6C proof', async () => {
      await assertProcessed(await deliver());
      assert.deepEqual(calls, ['/v1/payments/6114264375', '/authorized_payments/6114264375', '/preapproval/6114264375', '/preapproval_plan/6114264375', '/preapproval/mp-1', '/v1/payments/19951521071']);
    });
    await scenario('B/P: Payment ID goes to v1/payments, preserving existing preapproval read and effects', async () => {
      paymentTopic();
      assert.equal((await deliver()).status, 200);
      assert.deepEqual(calls, ['/v1/payments/19951521071', '/authorized_payments/19951521071', '/preapproval/19951521071', '/preapproval_plan/19951521071', '/authorized_payments/search?payment_id=19951521071&offset=0&limit=2',
        '/authorized_payments/6114264375', '/preapproval/mp-1']);
      assert.equal((await event()).processingStatus, 'processed'); await assertMutations(1);
      assert.equal((await business()).subscription.lastPaymentId, '19951521071');
    });
    await scenario('C/D: normalized invoice preserves all original fields and three separate identities', async () => {
      const resource = await service.__internal.fetchMercadoPagoChargeResource('authorized_payment', '6114264375');
      assert.deepEqual(resource, { kind: 'authorized_payment', id: '6114264375', invoiceId: '6114264375',
        paymentId: '19951521071', preapprovalId: 'mp-1', data: provider.invoice });
      assert.equal(await event(), undefined); await assertMutations(0);
    });
    await scenario('Payment normalized resource cannot be mistaken for an invoice', async () => {
      const result = await service.__internal.fetchMercadoPagoChargeResource('payment', '19951521071');
      assert.deepEqual(result, { kind: 'payment', id: '19951521071', invoiceId: null,
        paymentId: '19951521071', preapprovalId: 'mp-1', data: provider.payment });
      assert.deepEqual(calls, ['/v1/payments/19951521071']);
    });
    for (const [label, kind] of [['E', 'invoice'], ['F', 'payment']]) {
      await scenario(`${label}: transient ${kind} failure is retryable; same event later succeeds`, async () => {
        if (kind === 'payment') paymentTopic();
        provider.error = { kind, status: 503 };
        await assertRetryable(await deliver(), 'provider_5xx'); const failed = await event();
        provider.error = null;
        assert.equal((await deliver()).status, 200); assert.equal((await event()).id, failed.id);
        assert.equal((await event()).processingStatus, 'processed'); await assertMutations(1);
      });
      await scenario(`404 ${kind} remains retryable, never a financial rejection`, async () => {
        if (kind === 'payment') paymentTopic();
        provider.error = { kind, status: 404 };
        await assertRetryable(await deliver(), 'provider_not_found');
      });
    }
    for (const status of ['pending', 'rejected', 'in_process', 'approved']) {
      await scenario(`G: nested payment ${status} does not override canonical approved Payment`, async () => {
        provider.invoice.payment.status = status;
        await assertProcessed(await deliver());
      });
    }
    for (const summarized of ['pending', 'done', 'semaphore', null, { charged_amount: 500 }]) {
      await scenario(`H: summarized ${JSON.stringify(summarized)} is opaque`, async () => {
        provider.invoice.summarized = summarized;
        const result = await service.processMercadoPagoWebhook(payload, require('./helpers/billing-v2-fixture').delivery(payload, secret, 'fixture-' + (payload.id || 'without-notification')));
        assert.equal(result.outcome, 'PROCESSED_SUCCESSFULLY');
        await assertMutations(1);
      });
    }
    await scenario('I: malformed invoice shapes remain retryable without subscription/tenant writes', async () => {
      const valid = provider.invoice;
      for (const [i, malformed] of [null, {}, [], { ...valid, id: {} },
        { ...valid, payment: 'not-an-object' }, { ...valid, payment: { id: {} } }].entries()) {
        payload.id = `malformed-${i}`; provider.invoice = malformed;
        const response = await deliver(); assert.equal(response.status, 503);
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events WHERE "processingStatus"=$1 AND "contractOutcome" IS NULL', ['failed'])).rows[0].n, 6);
      await assertMutations(0);
    });
    await scenario('Optional nested payment and external reference may be absent', async () => {
      delete provider.invoice.payment; delete provider.invoice.external_reference;
      const result = await service.processMercadoPagoWebhook(payload, require('./helpers/billing-v2-fixture').delivery(payload, secret, 'fixture-' + (payload.id || 'without-notification')));
      assert.equal(result.outcome, 'IGNORED_NO_ACTION');
      assert.equal((await event()).processingError, 'invoice_payment_pending'); await assertMutations(0);
    });
    await scenario('J: duplicate invoice is durable; raw and timestamps unchanged; no refetch', async () => {
      await assertProcessed(await deliver()); const before = await event();
      const duplicate = await deliver(); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
      assert.deepEqual(await event(), before); assert.equal(calls.length, 6); await assertMutations(1);
    });
    await scenario('J: simultaneous invoice deliveries share one durable event and provider fetch', async () => {
      const results = await Promise.all([deliver(), deliver()]);
      assert.ok(results.every(result => [200, 503].includes(result.status)));
      assert.equal(results.filter(result => result.status === 200 && !result.body.duplicate).length, 1);
      assert.equal(calls.length, 6); await assertMutations(1);
    });
    await scenario('K: invalid signature rejects before event insertion and provider fetch', async () => {
      assert.equal((await deliver(false)).status, 401);
      assert.equal(await event(), undefined); assert.equal(calls.length, 0); await assertMutations(0);
    });
    for (const type of ['contract_rejected', 'manual_review']) {
      await scenario(`L: existing ${type} prevents invoice fetch and preserves terminal outcome`, async () => {
        const snapshot = service.__internal.buildWebhookEventSnapshot(payload, { signatureValid: true });
        const input = { ...snapshot, provider: 'mercado_pago', raw: payload,
          dedupeKey: require('./helpers/billing-v2-fixture').delivery(payload, secret, 'fixture-' + (payload.id || 'without-notification')).dedupeKey, processingStatus: 'received' };
        await service.__internal.processSubscriptionWebhookEvent(input, () => type === 'contract_rejected'
          ? outcomes.contractRejected({ reasonCode: 'contract_amount_mismatch' })
          : outcomes.manualReview({ reasonCode: 'legacy_contract_unknown' }));
        const before = await event(); const response = await deliver();
        assert.equal(response.status, 200); assert.equal(response.body.outcome, type.toUpperCase());
        assert.equal(response.body.duplicate, true); assert.deepEqual(await event(), before);
        assert.equal(calls.length, 0); await assertMutations(0);
      });
    }
    await scenario('M: invoice and Payment paths preserve immutable metadata.contract', async () => {
      const contract = subscription.metadata.contract;
      provider.invoice.metadata = { contract: null };
      await assertProcessed(await deliver());
      assert.deepEqual((await business()).subscription.metadata.contract, contract);
      paymentTopic(); payload.id = 'notice-payment'; provider.payment.metadata = { contract: { amount: '1.00' } };
      assert.equal((await deliver()).status, 200);
      assert.deepEqual((await business()).subscription.metadata.contract, contract);
    });
    await scenario('N: preapproval webhook still recovers BILL-004 provider_call_started', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1,"providerCallStartedAt"=NOW() WHERE id=$2', ['provider_call_started', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      payload.type = 'subscription_preapproval'; payload.data.id = 'mp-1';
      assert.equal((await deliver()).status, 200);
      const row = (await business()).subscription;
      assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, 'mp-1');
      assert.deepEqual(row.metadata.contract, subscription.metadata.contract); await assertMutations(1);
    });
    await scenario('O: unrelated generic Payment cannot mutate an existing subscription', async () => {
      paymentTopic(); provider.payment = { id: 19951521071, status: 'approved', preapproval_id: 'unrelated', external_reference: 'unmapped' };
      provider.search = { paging: { offset: 0, limit: 2, total: 0 }, results: [] };
      const before = await business(); assert.equal((await deliver()).status, 200); assert.deepEqual(await business(), before);
      assert.equal((await event()).processingError, 'authorized_invoice_not_found');
      assert.deepEqual(calls, ['/v1/payments/19951521071', '/authorized_payments/19951521071', '/preapproval/19951521071', '/preapproval_plan/19951521071', '/authorized_payments/search?payment_id=19951521071&offset=0&limit=2']);
    });
    await scenario('Legacy authorized_payment alias is retained but follows the invoice gate', async () => {
      payload.type = 'authorized_payment'; payload.action = 'preapproval.updated';
      await assertProcessed(await deliver());
      assert.deepEqual(calls, ['/v1/payments/6114264375', '/authorized_payments/6114264375', '/preapproval/6114264375', '/preapproval_plan/6114264375', '/preapproval/mp-1', '/v1/payments/19951521071']);
    });
    await scenario('Q: errors and success never expose provider credentials, body, or invoice in HTTP/logs/raw', async () => {
      const privateValue = 'provider-private-body';
      provider.error = { kind: 'invoice', status: 500, body: { message: privateValue, access_token: token } };
      const failed = await deliver(); await assertRetryable(failed, 'provider_5xx');
      provider.error = { kind: 'invoice', network: true, message: `${token} ${secret} ${privateValue}` };
      const network = await deliver(); await assertRetryable(network, 'provider_network_error');
      provider.error = null; provider.invoice.private = privateValue;
      const success = await deliver(); await assertProcessed(success);
      const outputs = JSON.stringify({ logs, failed, network, success, event: await event() });
      for (const value of [token, secret, privateValue, 'transaction_amount']) assert.equal(outputs.includes(value), false);
    });
    await scenario('Dedicated service encodes invoice ID and shares configured auth', async () => {
      provider.endpointId = { invoice: 'invoice%2Fwith%3Fcharacters' };
      await mp.getAuthorizedPayment('invoice/with?characters');
      assert.deepEqual(calls, ['/authorized_payments/invoice%2Fwith%3Fcharacters']);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    global.fetch = originalFetch;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const [id, previous] of modules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
  }
});
