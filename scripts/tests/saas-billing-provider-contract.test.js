const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');
const { captureLocalBillingContract } = require('../../src/services/saas-billing-contract');

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

test('BILL-006C: canonical contract gate, signed HTTP and isolated PostgreSQL', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `routing_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  let fault = {}; let server; let provider; let calls; let logs; let payload; let subscription;
  stub('src/db/client.js', {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (sql, params) => {
          if (fault.query) await fault.query(client, sql, params);
          return client.query(sql, params);
        } });
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
      : request.pathname.startsWith('/preapproval/') ? 'preapproval' : null;
    assert.ok(kind, 'unexpected provider endpoint');
    assert.equal(request.search, kind === 'search' ? '?payment_id=19951521071' : '');
    if (provider.beforeFetch) await provider.beforeFetch(kind);
    if (provider.error?.kind === kind) {
      if (provider.error.network) throw new Error(provider.error.message);
      return new Response(JSON.stringify(provider.error.body || { message: 'mock provider error' }),
        { status: provider.error.status });
    }
    return new Response(JSON.stringify(provider[kind]), { status: 200 });
  };
  const repository = require('../../src/repositories/saas-subscriptions.repository');
  const service = require('../../src/services/saas-billing.service');
  const app = express();
  app.use('/api/webhooks/mercadopago', require('../../src/routes/mercadopago-webhook.routes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const clinicId = '00000000-0000-4000-8000-000000000001';
  async function deliver(valid = true) {
    const requestId = crypto.randomUUID(); const ts = '1727300000'; const id = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    fault = {}; provider = {}; calls = []; logs = [];
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
    provider.payment = { id: 19951521071, status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference,
      transaction_amount: 40600, currency_id: 'ARS' };
    provider.search = { paging: { total: 1 }, results: [{ id: 6114264375, payment: { id: 19951521071 } }] };
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
  async function assertRetryable(response) {
    assert.deepEqual(response, { status: 503, body: { success: false, error: 'webhook_processing_failed' } });
    const row = await event();
    assert.equal(row.processingStatus, 'failed'); assert.equal(row.contractOutcome, null);
    assert.equal(row.processingError, 'webhook_processing_failed'); assert.deepEqual(row.raw, payload);
    await assertMutations(0);
  }
  function paymentTopic() { payload.type = 'payment'; payload.data.id = '19951521071'; }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql', '086_saas_subscription_event_contract_outcome.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
    }
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_routing_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW
        EXECUTE FUNCTION count_routing_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW
        EXECUTE FUNCTION count_routing_mutation('tenant');`);
    t.diagnostic('Real loopback PostgreSQL + signed local HTTP; MP fetch intercepted; no external network');


    function preapprovalTopic() { payload.type = 'subscription_preapproval'; payload.data.id = 'mp-1'; }
    async function assertDecision(type, reason, response = null) {
      const before = await business();
      response ||= await deliver();
      assert.equal(response.status, 200);
      assert.equal(response.body.outcome, type.toUpperCase());
      const row = await event();
      assert.equal(row.processingStatus, 'ignored'); assert.equal(row.contractOutcome.type, type);
      assert.equal(row.contractOutcome.reasonCode, reason);
      assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), before);
      await assertMutations(0);
      return row;
    }
    async function assertNoAction(reason) {
      const before = await business();
      assert.equal((await deliver()).status, 503);
      const row = await event();
      assert.equal(row.processingStatus, 'failed'); assert.equal(row.contractOutcome, null);
      assert.equal(row.processingError, reason); assert.deepEqual(row.raw, payload);
      assert.deepEqual(await business(), before); await assertMutations(0);
    }
    async function contractPatch(patch) {
      await pool.query('UPDATE saas_subscriptions SET metadata=$1::jsonb WHERE id=$2',
        [JSON.stringify(patch), subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
    }
    await scenario('CASE A/J/P/AA: native contract and exact canonical resources process real billing once', async () => {
      provider.invoice.transaction_amount = '040600.0';
      provider.payment.transaction_amount = '40600.00';
      provider.payment.currency_id = ' ars ';
      await assertProcessed(await deliver());
      const row = (await business()).subscription;
      assert.equal(row.localStatus, 'active'); assert.equal(row.lastPaymentId, '19951521071');
      assert.deepEqual(row.metadata.contract, subscription.metadata.contract);
      assert.deepEqual(calls, ['/authorized_payments/6114264375', '/preapproval/mp-1', '/v1/payments/19951521071']);
    });
    await scenario('CASE B: unknown legacy contract requires durable manual review, never mutable row authority', async () => {
      await contractPatch({});
      await assertDecision('manual_review', 'legacy_contract_unknown');
    });
    await scenario('Legacy KNOWN observation is readable but not native immutable financial authority', async () => {
      await contractPatch({ billingModel: 'pending_link', plan: { code: 'inicial', label: 'Plan Inicial', amount: 40600, currency: 'ARS' } });
      await assertDecision('manual_review', 'legacy_contract_unknown');
    });
    await scenario('CASE C: contract tenant conflict requires manual review', async () => {
      await contractPatch({ contract: { ...subscription.metadata.contract, externalTenantId: 'another' } });
      await assertDecision('manual_review', 'local_contract_conflict');
    });
    for (const [label, mutate, reason] of [
      ['D', () => { provider.preapproval.auto_recurring.transaction_amount = '40599.99'; }, 'contract_amount_mismatch'],
      ['E', () => { provider.preapproval.auto_recurring.currency_id = 'USD'; }, 'contract_currency_mismatch'],
      ['F', () => { provider.preapproval.auto_recurring.frequency = 2; }, 'contract_interval_mismatch'],
      ['G', () => { provider.preapproval.auto_recurring.frequency_type = 'days'; }, 'contract_interval_mismatch'],
      ['H', () => { provider.preapproval.external_reference = 'not-an-opturon-reference'; }, 'external_reference_mismatch'],
      ['I', () => { provider.preapproval.id = 'different-preapproval'; }, 'provider_identity_mismatch'],
      ['K', () => { provider.invoice.transaction_amount = '40599.99'; }, 'contract_amount_mismatch'],
      ['L', () => { provider.invoice.currency_id = 'USD'; }, 'contract_currency_mismatch'],
      ['N', () => { provider.invoice.id = 'different-invoice'; }, 'provider_identity_mismatch'],
      ['Q', () => { provider.payment.id = 'different-payment'; }, 'provider_identity_mismatch'],
      ['R', () => { provider.payment.transaction_amount = '40599.99'; }, 'contract_amount_mismatch'],
      ['S', () => { provider.payment.currency_id = 'USD'; }, 'contract_currency_mismatch']
    ]) {
      await scenario('CASE ' + label + ': proven mismatch is durable and has zero business effects', async () => {
        mutate(); await assertDecision('contract_rejected', reason);
      });
    }
    await scenario('CASE M: missing invoice preapproval is insufficient proof, not a mismatch', async () => {
      delete provider.invoice.preapproval_id;
      await assertDecision('manual_review', 'provider_relationship_unproven');
      assert.deepEqual(calls, ['/authorized_payments/6114264375']);
    });
    await scenario('CASE O: missing Payment remains retryable and later complete invoice succeeds', async () => {
      delete provider.invoice.payment;
      await assertNoAction('invoice_payment_pending'); const before = await event();
      provider.invoice.payment = { id: 19951521071 };
      await assertProcessed(await deliver()); assert.equal((await event()).id, before.id);
    });
    for (const status of ['pending', 'in_process', 'rejected', 'cancelled', 'authorized', 'in_mediation']) {
      await scenario('CASE T/U/AE: ' + status + ' is nonterminal; same notification can later be approved', async () => {
        provider.payment.status = status;
        await assertNoAction('payment_not_approved'); const before = await event();
        provider.payment.status = 'approved';
        await assertProcessed(await deliver()); assert.equal((await event()).id, before.id);
      });
    }
    for (const status of ['refunded', 'charged_back', 'unexpected_status']) {
      await scenario('CASE V: canonical ' + status + ' is visible durable manual review, not successful billing', async () => {
        provider.payment.status = status;
        await assertDecision('manual_review', 'unsupported_charge_type');
      });
    }
    for (const status of ['refunded', 'charged_back']) {
      await scenario('Post-approval update ' + status + ' surfaces review without a second successful application', async () => {
        await assertProcessed(await deliver());
        const before = await business();
        provider.payment.status = status; payload.id = 'notice-post-approval';
        const response = await deliver();
        assert.equal(response.status, 200); assert.equal(response.body.outcome, 'MANUAL_REVIEW');
        const row = (await pool.query('SELECT * FROM saas_subscription_events WHERE "notificationId"=$1', [payload.id])).rows[0];
        assert.equal(row.contractOutcome.reasonCode, 'unsupported_charge_type');
        assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), before);
        await assertMutations(1);
      });
    }
    for (const refunded of [1, '100.01']) {
      await scenario('CASE V: approved Payment with partial refund ' + refunded + ' needs review', async () => {
        provider.payment.transaction_amount_refunded = refunded;
        await assertDecision('manual_review', 'unsupported_charge_type');
      });
    }
    await scenario('Explicit zero refunded amount preserves an ordinary approved Payment', async () => {
      provider.payment.transaction_amount_refunded = '0.00';
      await assertProcessed(await deliver());
    });
    await scenario('Malformed refunded amount is insufficient proof rather than an assumed zero', async () => {
      provider.payment.transaction_amount_refunded = 'not-a-number';
      await assertDecision('manual_review', 'provider_relationship_unproven');
    });
    await scenario('CASE W: weak matching payment fields plus zero invoices cannot authorize or reject billing', async () => {
      paymentTopic();
      provider.payment.metadata = { preapproval_id: 'mp-1', external_reference: subscription.externalReference };
      provider.payment.subscription_id = 'mp-1';
      provider.search = { paging: { total: 0 }, results: [] };
      await assertNoAction('authorized_invoice_not_found');
      assert.deepEqual(calls, ['/v1/payments/19951521071', '/authorized_payments/search?payment_id=19951521071']);
    });
    await scenario('CASE X: one invoice proves generic Payment despite absent weak metadata', async () => {
      paymentTopic(); delete provider.payment.preapproval_id; delete provider.payment.external_reference;
      await assertProcessed(await deliver());
      assert.deepEqual(calls, ['/v1/payments/19951521071', '/authorized_payments/search?payment_id=19951521071',
        '/authorized_payments/6114264375', '/preapproval/mp-1']);
    });
    await scenario('CASE Y: multiple invoices require review; never choose first', async () => {
      paymentTopic(); provider.search.paging.total = 2;
      provider.search.results.push({ id: 999, payment: { id: 19951521071 } });
      await assertDecision('manual_review', 'provider_relationship_unproven');
      assert.equal(calls.length, 2);
    });
    await scenario('CASE Z/AD: search transient failure is retryable with same event', async () => {
      paymentTopic(); provider.error = { kind: 'search', status: 503 };
      await assertRetryable(await deliver()); const failed = await event();
      provider.error = null; await assertProcessed(await deliver()); assert.equal((await event()).id, failed.id);
    });
    for (const [type, reason] of [['contract_rejected', 'contract_amount_mismatch'], ['manual_review', 'legacy_contract_unknown']]) {
      await scenario('CASE AB/AC/AI/AJ/AN: ' + type + ' redelivery preserves outcome, raw, contract and no provider work', async () => {
        payload._opturonBillingOutcome = { untrusted: ['original', { nested: true }] };
        payload.contractOutcome = { type: 'VALID' };
        if (type === 'contract_rejected') provider.invoice.transaction_amount = 1;
        else await contractPatch({});
        await assertDecision(type, reason);
        const before = await event(); const count = calls.length; const beforeBusiness = await business();
        const response = await deliver();
        assert.equal(response.status, 200); assert.equal(response.body.duplicate, true);
        assert.deepEqual(await event(), before); assert.equal(calls.length, count);
        assert.deepEqual(await business(), beforeBusiness); await assertMutations(0);
      });
    }
    for (const topic of ['subscription_authorized_payment', 'payment']) {
    for (const withNotification of [true, false]) {
      await scenario('CASE AE: future same-resource ' + topic + ' update, notification identity present=' + withNotification, async () => {
        if (topic === 'payment') paymentTopic();
        if (!withNotification) delete payload.id;
        provider.payment.status = 'pending';
        await assertNoAction('payment_not_approved');
        if (withNotification) payload.id = 'notice-future-approved';
        provider.payment.status = 'approved';
        assert.equal((await deliver()).status, 200);
        assert.equal((await business()).subscription.localStatus, 'active');
        const rows = (await pool.query('SELECT * FROM saas_subscription_events')).rows;
        assert.equal(rows.length, withNotification ? 2 : 1);
        assert.equal(rows.filter(row => row.processingStatus === 'processed').length, 1);
        await assertMutations(1);
      });
    }
    }
    await scenario('CASE AF: invalid signature makes zero provider calls and zero event writes', async () => {
      assert.equal((await deliver(false)).status, 401);
      assert.equal(await event(), undefined); assert.equal(calls.length, 0); await assertMutations(0);
    });
    await scenario('CASE AG: provider timeout cannot acknowledge or perform late business writes', async () => {
      let release; provider.beforeFetch = kind => kind === 'invoice' ? new Promise(resolve => { release = resolve; }) : undefined;
      await assertRetryable(await deliver());
      release(); provider.beforeFetch = null;
      await assertProcessed(await deliver());
    });
    await scenario('CASE AH: real SQL error during outcome persistence rolls back and returns 503', async () => {
      provider.invoice.transaction_amount = 1;
      fault.query = async (client, sql) => {
        if (sql.startsWith('UPDATE saas_subscription_events') && sql.includes('"contractOutcome" =')) {
          fault.query = null; await client.query('SELECT 1/0');
        }
      };
      await assertRetryable(await deliver());
      await assertDecision('contract_rejected', 'contract_amount_mismatch');
    });
    await scenario('CASE AK: valid second tenant external reference never retargets bound subscription', async () => {
      const otherId = crypto.randomUUID(); const otherClinic = crypto.randomUUID();
      await pool.query('INSERT INTO clinics (id,"externalTenantId") VALUES ($1,$2)', [otherClinic, 'other-tenant']);
      const input = { id: otherId, clinicId: otherClinic, externalTenantId: 'other-tenant', planCode: 'inicial',
        amount: 40600, currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending',
        mercadoPagoPreapprovalId: 'other-preapproval', externalReference: 'opturon:other-tenant:' + otherId };
      const other = await repository.insertSaasSubscription({ ...input, metadata: { contract: captureLocalBillingContract({
        ...input, subscriptionId: otherId, plan: { code: 'inicial', amount: 40600, currency: 'ARS' },
        capturedAt: new Date().toISOString()
      }) } });
      provider.preapproval.external_reference = other.externalReference;
      const before = await repository.findSaasSubscriptionById(other.id);
      await assertDecision('contract_rejected', 'external_reference_mismatch');
      assert.deepEqual(await repository.findSaasSubscriptionById(other.id), before);
    });
    await scenario('CASE AL: durable uncertain claim recovers via canonical preapproval with UUID casing normalized', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1,"providerCallStartedAt"=NOW() WHERE id=$2',
        ['reconciliation_required', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      provider.preapproval.external_reference = 'opturon:tenant-routing:' + subscription.id.toUpperCase();
      preapprovalTopic(); await assertProcessed(await deliver());
      assert.equal((await business()).subscription.provisioningState, 'ready');
    });
    await scenario('Unclaimed reserved local row cannot be linked by external reference alone', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1 WHERE id=$2', ['reserved', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      preapprovalTopic(); await assertDecision('manual_review', 'provider_relationship_unproven');
    });
    await scenario('Unbound provider_call_started without a durable claim timestamp cannot recover', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1 WHERE id=$2', ['provider_call_started', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      preapprovalTopic(); await assertDecision('manual_review', 'provider_relationship_unproven');
    });
    await scenario('CASE AM: concurrent identical invoices mutate once under database ownership', async () => {
      const responses = await Promise.all([deliver(), deliver(), deliver()]);
      assert.ok(responses.every(r => r.status === 200));
      assert.equal(responses.filter(r => r.body.duplicate).length, 2);
      assert.equal(calls.length, 3); await assertMutations(1);
    });
    await scenario('CASE AO: plan topic cannot fall through via preapproval.updated action', async () => {
      payload.type = 'subscription_preapproval_plan'; payload.action = 'preapproval.updated';
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).processingStatus, 'ignored');
      assert.equal(calls.length, 0); await assertMutations(0);
    });
    await scenario('CASE AP: compatibility alias enforces full financial validation', async () => {
      payload.type = 'authorized_payment'; provider.payment.transaction_amount = 2;
      await assertDecision('contract_rejected', 'contract_amount_mismatch');
    });
    for (const [field, value, reason] of [
      ['transaction_amount', '40600.001', 'provider_relationship_unproven'],
      ['currency_id', undefined, 'provider_relationship_unproven'],
      ['frequency', undefined, 'provider_relationship_unproven'],
      ['frequency_type', undefined, 'provider_relationship_unproven'],
      ['transaction_amount', '40599.99', 'contract_amount_mismatch']
    ]) {
      await scenario('Preapproval-only webhook validates ' + field + '=' + value, async () => {
        preapprovalTopic(); provider.preapproval.auto_recurring[field] = value;
        await assertDecision(reason.startsWith('contract_') ? 'contract_rejected' : 'manual_review', reason);
      });
    }
    await scenario('Preapproval remote tenant case is significant, UUID case alone is equivalent', async () => {
      preapprovalTopic(); provider.preapproval.external_reference = 'opturon:TENANT-routing:' + subscription.id;
      await assertDecision('contract_rejected', 'external_reference_mismatch');
    });
    await scenario('Mutable row money cannot override native contract', async () => {
      await pool.query('UPDATE saas_subscriptions SET amount=1,currency=$1 WHERE id=$2', ['USD', subscription.id]);
      await pool.query('TRUNCATE mutation_audit'); await assertProcessed(await deliver());
      assert.equal((await business()).subscription.amount, '40600.00');
    });
    await scenario('TOCTOU: re-resolve local row after provider IO and reject changed binding', async () => {
      provider.beforeFetch = async kind => {
        if (kind !== 'payment') return;
        provider.beforeFetch = null;
        await repository.updateSaasSubscriptionById(subscription.id, { mercadoPagoPreapprovalId: 'changed-binding' });
        await pool.query('TRUNCATE mutation_audit');
      };
      const response = await deliver();
      await assertDecision('contract_rejected', 'provider_identity_mismatch', response);
    });
    await scenario('TOCTOU: contract is protected atomically against a concurrent metadata replacement', async () => {
      provider.beforeFetch = async kind => {
        if (kind !== 'payment') return;
        provider.beforeFetch = null;
        await repository.updateSaasSubscriptionById(subscription.id, { metadata: { contract: null, concurrentNote: 'kept' } });
        await pool.query('TRUNCATE mutation_audit');
      };
      await assertProcessed(await deliver());
      assert.deepEqual((await business()).subscription.metadata.contract, subscription.metadata.contract);
      assert.equal((await business()).subscription.metadata.concurrentNote, 'kept');
    });
    await scenario('TOCTOU: independent writer waits on the subscription lock through validation and commit', async () => {
      const writer = await pool.connect(); let pending;
      try {
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        fault.query = async (_client, sql) => {
          if (!sql.startsWith('UPDATE saas_subscriptions')) return;
          fault.query = null;
          pending = repository.updateSaasSubscriptionById(subscription.id,
            { metadata: { contract: null, afterGate: true } }, writer);
          let waiting = false;
          for (let n = 0; n < 50 && !waiting; n++) {
            const activity = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
            waiting = activity?.wait_event_type === 'Lock';
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true, 'second writer must block until the validated transaction completes');
        };
        assert.equal((await deliver()).status, 200); await pending;
        const row = (await business()).subscription;
        assert.equal(row.localStatus, 'active'); assert.equal(row.metadata.afterGate, true);
        assert.deepEqual(row.metadata.contract, subscription.metadata.contract);
      } finally { if (pending) await pending; writer.release(); }
    });
    for (const target of ['invoice', 'payment']) {
      await scenario('Missing ' + target + ' currency cannot silently default to ARS', async () => {
        delete provider[target].currency_id;
        await assertDecision('manual_review', 'provider_relationship_unproven');
      });
    }
    await scenario('Unsupported invoice charge type cannot apply ordinary recurring billing', async () => {
      provider.invoice.type = 'prorated';
      await assertDecision('manual_review', 'unsupported_charge_type');
    });
    await scenario('Mismatch diagnostics retain only allowlisted facts, never provider payload or payer PII', async () => {
      provider.payment.payer = { email: 'private-payer@example.invalid' };
      provider.payment.access_token = 'private-provider-token'; provider.payment.transaction_amount = 1;
      const response = await deliver();
      await assertDecision('contract_rejected', 'contract_amount_mismatch', response);
      const output = JSON.stringify({ response, logs, event: await event() });
      for (const secret of ['private-payer@example.invalid', 'private-provider-token']) assert.equal(output.includes(secret), false);
      assert.deepEqual((await event()).contractOutcome.details, {
        expectedField: 'amount', observedField: 'transaction_amount', observedValue: '1.00', contractVersion: 1, contractSource: 'contract'
      });
    });
    await scenario('Generic search candidate must match Payment identity and canonical invoice linkage', async () => {
      paymentTopic(); provider.search.results[0].payment.id = 'wrong-payment';
      await assertDecision('contract_rejected', 'provider_identity_mismatch');
      assert.equal(calls.length, 2);
    });
    await scenario('Canonical invoice cannot switch Payment after search', async () => {
      paymentTopic(); provider.invoice.payment.id = 'wrong-payment';
      await assertDecision('contract_rejected', 'provider_identity_mismatch');
      assert.equal(calls.length, 3);
    });
    for (const search of [{}, { results: [], paging: { total: 1 } },
      { results: [{ id: 1 }], paging: { total: 2 } }, { results: [], paging: { total: -1 } }]) {
      await scenario('Incomplete or paginated search never chooses an arbitrary invoice: ' + JSON.stringify(search), async () => {
        paymentTopic(); provider.search = search;
        await assertDecision('manual_review', 'provider_relationship_unproven');
      });
    }
    for (const kind of ['invoice', 'preapproval', 'payment', 'search']) {
      await scenario('Provider 404 ' + kind + ' is retryable, never a contract mismatch', async () => {
        if (kind === 'search') paymentTopic();
        provider.error = { kind, status: 404 };
        await assertRetryable(await deliver());
      });
    }

  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    global.fetch = originalFetch;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const [id, previous] of modules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
  }
});
