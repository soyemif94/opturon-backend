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

test('BILL-007: paid entitlement lifecycle with canonical proofs and atomic PostgreSQL effects', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `lifecycle_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8, application_name: schema });
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
    mercadoPagoEnvironment: 'test', nodeEnv: 'production', portalInternalKey: 'admin-test-key',
    getWhatsAppGraphVersion: () => 'v25.0' });
  const log = (event, fields) => logs.push({ event, fields });
  stub('src/utils/logger.js', { logInfo: log, logWarn: log, logError: log });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  // Exercise the real provider service, including auth, URL encoding and error
  // taxonomy. MP responses are intercepted BEFORE any network; only explicitly
  // enabled cancellation writes are allowed by these isolated scenarios.
  global.fetch = async (value, init = {}) => {
    const request = new URL(value);
    if (request.hostname === '127.0.0.1') return originalFetch(value, init);
    assert.equal(request.origin, 'https://api.mercadopago.com', 'external network forbidden');
    if (init.method === 'POST' && request.pathname === '/preapproval' && provider.allowCreate) {
      const body = JSON.parse(init.body); calls.push('mock_create');
      return new Response(JSON.stringify({ ...provider.preapproval, status: 'pending',
        external_reference: body.external_reference, init_point: 'https://example.invalid/authorize' }), { status: 201 });
    }
    if (init.method === 'PUT' && request.pathname === `/preapproval/${encodeURIComponent(provider.preapproval.id)}`
      && provider.allowCancel) {
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.headers['X-scope'], 'stage');
      assert.deepEqual(JSON.parse(init.body), { status: 'canceled' });
      calls.push('mock_cancel');
      provider.cancelCalls = (provider.cancelCalls || 0) + 1;
      if (provider.cancelError) {
        return new Response(JSON.stringify(provider.cancelError.body || { message: 'mock cancellation rejected' }),
          { status: provider.cancelError.status || 400, headers: provider.cancelError.headers });
      }
      provider.preapproval.status = provider.cancelStatusAfterPut || 'cancelled';
      if (provider.cancelNetworkAfterMutation) throw new Error('mock_response_lost_after_provider_cancel');
      return new Response(JSON.stringify(structuredClone(provider.preapproval)), { status: 200 });
    }
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
    assert.equal(request.search, kind === 'search' ? `?payment_id=${provider.payment.id}&offset=0&limit=2` : '');
    const endpointId = { payment: String(provider.payment.id).trim(), invoice: String(provider.invoice.id), preapproval: provider.preapproval.id, plan: 'plan-1' };
    if (kind !== 'search' && request.pathname.split('/').pop() !== (provider.endpointId?.[kind] || endpointId[kind])) return new Response('{}', { status: 404 });
    if (provider.beforeFetch) await provider.beforeFetch(kind, init.signal);
    if (provider.httpBase) return originalFetch(provider.httpBase + request.pathname + request.search, init);
    if (kind === 'preapproval' && provider.cancelCalls && Array.isArray(provider.cancelReadbackStatuses)) {
      const index = provider.cancelReadbackCount || 0;
      const observation = provider.cancelReadbackStatuses[Math.min(index, provider.cancelReadbackStatuses.length - 1)];
      provider.cancelReadbackCount = index + 1;
      if (observation && typeof observation === 'object') {
        return new Response(JSON.stringify(observation.body || {}), { status: observation.httpStatus || 200 });
      }
      provider.preapproval.status = observation;
      return new Response(JSON.stringify(structuredClone(provider.preapproval)), { status: 200 });
    }
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
  app.use('/api/admin', require('../../src/routes/admin.routes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const clinicId = '00000000-0000-4000-8000-000000000001';
  async function deliver(valid = true, { requestId = 'fixture-request', id = payload.data.id } = {}) {
    const ts = '1727300000';
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function adminCancel({ authorized = true } = {}) {
    const response = await fetch(`${base}/api/admin/billing/subscriptions/${subscription.id}/cancel`, {
      method: 'POST', headers: authorized ? { 'x-portal-key': 'admin-test-key' } : {}
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    fault = {}; provider = {}; calls = []; logs = [];
    await pool.query('TRUNCATE mutation_audit, saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query('INSERT INTO clinics (id,"externalTenantId") VALUES ($1,$2)', [clinicId, 'tenant-routing']);
    await pool.query(`UPDATE clinics SET settings='{"portal":{"policy":{"planCode":"basic"},"lifecycle":{"status":"trial"}}}'::jsonb`);
    const id = crypto.randomUUID();
    const input = { id, clinicId, externalTenantId: 'tenant-routing', planCode: 'crecimiento', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: 'mp-1',
      externalReference: `opturon:tenant-routing:${id}` };
    const contract = captureLocalBillingContract({ ...input, subscriptionId: id,
      plan: { code: 'crecimiento', amount: 40600, currency: 'ARS' }, capturedAt: new Date().toISOString() });
    subscription = await repository.insertSaasSubscription({ ...input, metadata: { contract } });
    provider.preapproval = { id: 'mp-1', status: 'authorized', external_reference: input.externalReference,
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS', frequency: 1, frequency_type: 'months' } };
    provider.payment = { date_created: new Date().toISOString(), id: 19951521071, status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference,
      transaction_amount: 40600, currency_id: 'ARS' };
    provider.search = { paging: { offset: 0, limit: 2, total: 1 }, results: [{ id: 6114264375, payment: { id: 19951521071 } }] };
    provider.invoice = { id: 6114264375, preapproval_id: 'mp-1', transaction_amount: '40600.00', currency_id: 'ARS',
      status: 'processed', summarized: 'done', payment: { id: 19951521071, status: 'approved' }, external_reference: input.externalReference };
    await pool.query('TRUNCATE mutation_audit');
    payload = { id: 'notice-6b', type: 'subscription_authorized_payment', action: 'updated', data: { id: '6114264375' } };
  }
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  const event = async () => (await pool.query('SELECT * FROM saas_subscription_events WHERE "notificationId" IS NOT DISTINCT FROM $1', [service.__internal.extractMercadoPagoWebhookNotificationId(payload)])).rows[0];
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
        EXECUTE FUNCTION count_routing_mutation('tenant');
      CREATE FUNCTION count_plan_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.settings #> '{portal,policy,planCode}' IS DISTINCT FROM OLD.settings #> '{portal,policy,planCode}'
        THEN INSERT INTO mutation_audit(kind) VALUES ('plan'); END IF; RETURN NEW; END $$;
      CREATE TRIGGER plan_effect AFTER UPDATE ON clinics FOR EACH ROW EXECUTE FUNCTION count_plan_mutation();`);
    t.diagnostic('Real loopback PostgreSQL + signed local HTTP; MP fetch intercepted; no external network');

    const reconciliation = require('../../src/services/saas-billing-reconciliation.service');
    const effects = async () => (await pool.query('SELECT * FROM saas_billing_effects')).rows;
    const job = async () => (await pool.query('SELECT * FROM saas_billing_reconciliations')).rows[0];
    const due = () => pool.query(`UPDATE saas_billing_reconciliations SET "nextAttemptAt"=clock_timestamp()-interval '1 second'`);
    const clearAudit = () => pool.query('TRUNCATE mutation_audit');
    function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
    const lifecycle = async () => (await pool.query('SELECT data FROM saas_billing_lifecycles WHERE "subscriptionId"=$1', [subscription.id])).rows[0]?.data;
    const plan = async () => (await business()).tenant.settings.portal.policy.planCode;
    const planWrites = async () => (await pool.query("SELECT count(*)::int n FROM mutation_audit WHERE kind='plan'")).rows[0].n;
    const reversals = async () => (await pool.query('SELECT * FROM saas_billing_reversals')).rows;
    const fresh = () => deliver(true, { requestId: crypto.randomUUID() });
    const cancel = async () => {
      provider.preapproval.status = 'cancelled';
      return deliver(true, { id: 'mp-1', requestId: crypto.randomUUID() });
    };
    const refund = () => { provider.payment.status = 'refunded'; provider.payment.transaction_amount_refunded = 40600; };
    const renewal = () => {
      provider.payment.id += 1;
      provider.payment.date_created = new Date(Date.parse(provider.payment.date_created) + 60000).toISOString();
      provider.invoice.payment.id = provider.payment.id;
      provider.search.results[0].payment.id = provider.payment.id;
    };
    const collection = status => {
      provider.payment.status = 'rejected';
      provider.invoice.type = 'scheduled'; provider.invoice.status = status;
      provider.invoice.payment.status = 'rejected';
      provider.invoice.last_modified = provider.payment.date_created;
    };
    async function anotherContract(planCode = 'empresa') {
      const id = crypto.randomUUID(), preapprovalId = `mp-${id}`;
      const input = { id, clinicId, externalTenantId: 'tenant-routing', planCode, amount: 40600,
        currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: preapprovalId,
        externalReference: `opturon:tenant-routing:${id}` };
      const contract = captureLocalBillingContract({ ...input, subscriptionId: id,
        plan: { code: planCode, amount: 40600, currency: 'ARS' }, capturedAt: new Date().toISOString() });
      subscription = await repository.insertSaasSubscription({ ...input, metadata: { contract } });
      provider.preapproval.id = preapprovalId; provider.preapproval.external_reference = input.externalReference;
      provider.invoice.preapproval_id = preapprovalId; provider.invoice.external_reference = input.externalReference;
      provider.payment.preapproval_id = preapprovalId; provider.payment.external_reference = input.externalReference;
      renewal();
    }
    await scenario('A ORIGINAL BILL-007 DEFECT: created pending preapproval must not assign requested paid plan', async () => {
      await pool.query('TRUNCATE saas_subscriptions CASCADE');
      provider.allowCreate = true;
      const result = await service.createSaasSubscriptionForTenant({ tenantId: 'tenant-routing',
        planCode: 'growth', payerEmail: 'fixture@example.invalid' });
      assert.equal(result.ok, true); subscription = result.subscription;
      assert.equal(subscription.localStatus, 'pending');
      assert.equal(subscription.metadata.contract.planCode, 'growth');
      assert.equal(subscription.metadata.contract.entitlementProfileVersion, 1);
      assert.equal(await plan(), 'basic'); assert.equal(await planWrites(), 0);
      assert.equal((await lifecycle()).billingState, 'awaiting_payment');
      assert.equal((await effects()).length, 0); assert.equal(calls.filter(x => x === 'mock_create').length, 1);
    });
    for (const [name, status] of [['B', 'pending'], ['C', 'in_process']]) await scenario(`${name} ${status}: no entitlement change, durable no-action`, async () => {
      provider.payment.status = status;
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).processingError, `payment_${status}`);
      assert.equal(await plan(), 'basic'); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 0);
    });
    await scenario('D first approved canonical Payment activates immutable contracted plan once', async () => {
      await assertProcessed(await deliver()); assert.equal(await plan(), 'growth');
      const state = await lifecycle(); assert.ok(state.activatedAt); assert.equal(state.previousEntitlement.planCode, 'basic');
      assert.equal(state.activationPaymentId, String(provider.payment.id)); assert.equal(state.paidThrough, null);
      assert.equal(await planWrites(), 1); assert.equal((await effects()).length, 1);
      assert.equal((await service.getSaasSubscriptionDetails(subscription.id)).subscription.lifecycle.activatedAt, state.activatedAt);
    });
    await scenario('E same Payment through distinct signed deliveries: zero extra activation', async () => {
      await deliver(); const before = await lifecycle(); await clearAudit();
      assert.equal((await fresh()).status, 200); assert.deepEqual(await lifecycle(), before);
      assert.equal(await planWrites(), 0); await assertMutations(0); assert.equal((await effects()).length, 1);
    });
    await scenario('F later approved renewal preserves plan and original activation timestamp', async () => {
      await deliver(); const before = await lifecycle(); await clearAudit(); renewal();
      assert.equal((await fresh()).status, 200); assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
      assert.equal((await lifecycle()).activatedAt, before.activatedAt);
      assert.equal((await lifecycle()).lastSuccessfulPaymentId, String(provider.payment.id)); assert.equal((await effects()).length, 2);
    });
    await scenario('G first rejected Payment: failure state with no activation', async () => {
      provider.payment.status = 'rejected'; assert.equal((await deliver()).status, 200);
      assert.equal((await lifecycle()).billingState, 'payment_failed'); assert.equal(await plan(), 'basic');
      assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 0);
    });
    await scenario('H rejected renewal in provider recovery temporarily retains paid entitlement', async () => {
      await deliver(); renewal(); collection('recycling'); await clearAudit();
      assert.equal((await fresh()).status, 200); assert.equal((await lifecycle()).billingState, 'payment_retrying');
      assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 1);
    });
    await scenario('I cancellation before first success never activates', async () => {
      assert.equal((await cancel()).status, 200); assert.equal(await plan(), 'basic'); assert.equal(await planWrites(), 0);
      assert.equal((await lifecycle()).billingState, 'subscription_cancelled');
      assert.equal((await lifecycle()).activatedAt, undefined);
    });
    await scenario('J cancellation after success preserves access and requires explicit expiry review', async () => {
      await deliver(); await clearAudit(); assert.equal((await cancel()).status, 200);
      const state = await lifecycle(); assert.equal(state.billingState, 'subscription_cancelled');
      assert.equal(state.reviewReason, 'cancellation_expiry_unproven'); assert.equal(state.paidThrough, null);
      assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
    });
    await scenario('K partial refund: durable review observation, no positive reapplication or downgrade', async () => {
      await deliver(); await clearAudit(); provider.payment.transaction_amount_refunded = 100;
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal(await plan(), 'growth');
      assert.equal((await reversals())[0].kind, 'partial_refund'); assert.equal(await planWrites(), 0);
      assert.equal((await effects()).length, 1); assert.equal((await lifecycle()).reviewReason, 'reversal_requires_review');
    });
    await scenario('L full refund missing original financial effect: review only', async () => {
      refund(); assert.equal((await deliver()).body.outcome, 'MANUAL_REVIEW');
      assert.equal((await reversals())[0].decision, 'manual_review'); assert.equal(await plan(), 'basic');
      assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 0);
    });
    await scenario('M proven full refund atomically restores durable previous entitlement', async () => {
      await deliver(); await clearAudit(); refund(); assert.equal((await fresh()).status, 200);
      assert.equal(await plan(), 'basic'); assert.equal((await business()).tenant.settings.portal.lifecycle.status, 'trial');
      assert.equal((await lifecycle()).entitlementState, 'reversed'); assert.equal(await planWrites(), 1);
      assert.equal((await reversals())[0].decision, 'reversed'); assert.equal((await effects()).length, 1);
    });
    await scenario('N chargeback: durable negative review, zero positive activation', async () => {
      provider.payment.status = 'charged_back'; assert.equal((await deliver()).body.outcome, 'MANUAL_REVIEW');
      assert.equal((await reversals())[0].kind, 'chargeback'); assert.equal(await plan(), 'basic');
      assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 0);
    });
    await scenario('O older refund after later renewal cannot erase the later entitlement', async () => {
      await deliver(); const first = structuredClone(provider.payment); renewal(); await fresh(); await clearAudit();
      provider.payment = first; provider.invoice.payment.id = first.id; provider.search.results[0].payment.id = first.id;
      refund(); assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW');
      assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 2);
      assert.notEqual((await lifecycle()).lastSuccessfulPaymentId, String(first.id));
    });
    for (const [name, status] of [['P', 'refunded'], ['Q', 'charged_back']]) await scenario(`${name} duplicate ${status}: one durable negative observation`, async () => {
      await deliver(); refund(); provider.payment.status = status; await fresh();
      const before = await business(), state = await lifecycle(); await clearAudit();
      await fresh(); assert.deepEqual(await business(), before); assert.deepEqual(await lifecycle(), state);
      assert.equal((await reversals()).length, 1); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 1);
    });
    await scenario('R webhook/reconciler race applies one financial and one entitlement effect', async () => {
      provider.payment.status = 'pending'; await deliver(); provider.payment.status = 'approved'; await due();
      const entered = deferred(), release = deferred(); let visits = 0;
      provider.beforeFetch = async kind => { if (kind === 'invoice' && ++visits <= 2) { if (visits === 2) entered.resolve(); await release.promise; } };
      const worker = reconciliation.runBillingReconciliationOnce(), webhook = fresh();
      await entered.promise; release.resolve(); assert.equal((await webhook).status, 200); assert.equal((await worker).completed, true);
      assert.equal((await effects()).length, 1); assert.equal(await planWrites(), 1); assert.equal(await plan(), 'growth');
    });
    for (const failAt of ['INSERT INTO saas_billing_effects', 'UPDATE clinics', 'INSERT INTO saas_billing_lifecycles', 'UPDATE saas_subscription_events']) {
      await scenario(`S atomic activation rolls back on ${failAt}`, async () => {
        fault.query = async (_c, sql, params) => { if (sql.includes(failAt) && (failAt !== 'UPDATE saas_subscription_events' || params.includes('processed'))) throw new Error('injected_db_failure'); };
        assert.equal((await deliver()).status, 503); assert.equal(await plan(), 'basic'); assert.equal(await planWrites(), 0);
        assert.equal((await effects()).length, 0); assert.equal(await lifecycle(), undefined);
        assert.notEqual((await event()).processingStatus, 'processed');
        fault = {}; assert.equal((await fresh()).status, 200); assert.equal(await plan(), 'growth');
      });
    }
    await scenario('T reclaimed lease: stale worker has zero entitlement mutations', async () => {
      provider.payment.status = 'pending'; await deliver(); provider.payment.status = 'approved'; await due();
      const entered = deferred(), release = deferred(); let first = true;
      provider.beforeFetch = async kind => { if (kind === 'invoice' && first) { first = false; entered.resolve(); await release.promise; } };
      const old = reconciliation.runBillingReconciliationOnce(); await entered.promise;
      await pool.query(`UPDATE saas_billing_reconciliations SET "leaseExpiresAt"=clock_timestamp()-interval '1 second'`);
      assert.equal((await reconciliation.runBillingReconciliationOnce()).completed, true);
      const before = await lifecycle(); await clearAudit(); release.resolve(); assert.equal((await old).stale, true);
      assert.deepEqual(await lifecycle(), before); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 1);
    });
    await scenario('Admin entitlement ABA change cannot be undone by an older full refund', async () => {
      await deliver();
      await pool.query(`UPDATE clinics SET settings=jsonb_set(settings,'{portal,policy,planCode}','"enterprise"')`);
      await pool.query(`UPDATE clinics SET settings=jsonb_set(settings,'{portal,policy,planCode}','"growth"')`);
      await clearAudit(); refund(); assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW');
      assert.equal(await planWrites(), 0); assert.equal(await plan(), 'growth');
    });
    await scenario('Absent previous plan never causes an invented fallback on refund', async () => {
      await pool.query(`UPDATE clinics SET settings='{}'::jsonb`); await deliver(); await clearAudit(); refund();
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
    });
    await scenario('Refund before approved delivery blocks stale positive replay', async () => {
      refund(); await deliver(); provider.payment.status = 'approved'; provider.payment.transaction_amount_refunded = 0;
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal(await plan(), 'basic'); assert.equal((await effects()).length, 0);
    });
    await scenario('Older unique approved payment cannot overwrite a later successful payment', async () => {
      const earlier = structuredClone(provider.payment); renewal(); await deliver();
      provider.payment = earlier; provider.invoice.payment.id = earlier.id; provider.search.results[0].payment.id = earlier.id;
      await clearAudit(); assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal((await effects()).length, 1);
      assert.equal(await planWrites(), 0); assert.notEqual((await lifecycle()).lastSuccessfulPaymentId, String(earlier.id));
    });
    await scenario('Cancelled individual payment after prior success retains paid access', async () => {
      await deliver(); renewal(); provider.payment.status = 'cancelled'; await clearAudit(); await fresh();
      assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 1);
    });
    await scenario('Preapproval authorized without Payment cannot activate', async () => {
      assert.equal((await deliver(true, { id: 'mp-1' })).status, 200);
      assert.equal(await plan(), 'basic'); assert.equal((await business()).subscription.localStatus, 'pending'); assert.equal((await effects()).length, 0);
    });
    await scenario('Full refund failure before terminal completion rolls back reversal and plan together', async () => {
      await deliver(); refund(); await clearAudit();
      fault.query = async (_c, sql, params) => { if (sql.includes('UPDATE saas_subscription_events') && params.includes('processed')) throw new Error('injected_completion'); };
      assert.equal((await fresh()).status, 503); assert.equal(await plan(), 'growth'); assert.equal((await reversals()).length, 0); assert.equal(await planWrites(), 0);
      fault = {}; await fresh(); assert.equal(await plan(), 'basic'); assert.equal((await reversals()).length, 1);
    });
    await scenario('A pending/rejected provider object with wrong money cannot alter lifecycle', async () => {
      provider.payment.status = 'rejected'; provider.payment.transaction_amount = 1;
      assert.equal((await deliver()).body.outcome, 'CONTRACT_REJECTED'); assert.equal(await lifecycle(), undefined); assert.equal(await plan(), 'basic');
    });
    await scenario('Reconciler observes chargeback with same durable negative policy', async () => {
      provider.payment.status = 'pending'; await deliver(); await due(); provider.payment.status = 'charged_back';
      assert.equal((await reconciliation.runBillingReconciliationOnce()).completed, true);
      assert.equal((await reversals()).length, 1); assert.equal((await job()).status, 'manual_review'); assert.equal(await planWrites(), 0);
    });
    await scenario('Cancellation seen with the first paid invoice records expiry review without requiring another webhook', async () => {
      provider.preapproval.status = 'cancelled'; await deliver();
      const state = await lifecycle(); assert.ok(state.activatedAt); assert.ok(state.cancellationAt);
      assert.equal(state.billingState, 'subscription_cancelled'); assert.equal(state.reviewReason, 'cancellation_expiry_unproven');
      assert.equal((await business()).subscription.localStatus, 'canceled'); assert.equal(await plan(), 'growth');
    });
    await scenario('Canonical status normalization is identical for proof, activation and chargeback', async () => {
      provider.payment.status = ' APPROVED '; await deliver(); assert.equal(await plan(), 'growth');
      await clearAudit(); provider.payment.status = ' CHARGED_BACK ';
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal((await reversals())[0].kind, 'chargeback');
      assert.equal((await lifecycle()).billingState, 'payment_chargeback'); assert.equal(await planWrites(), 0);
    });
    await scenario('Equivalent canonical Payment IDs cannot duplicate a negative observation', async () => {
      await deliver(); refund(); await fresh(); await clearAudit();
      provider.payment.id = ` ${provider.payment.id} `;
      assert.equal((await fresh()).status, 200); assert.equal((await reversals()).length, 1);
      assert.equal(await planWrites(), 0); assert.equal(await plan(), 'basic');
    });
    for (const mismatch of ['collector_conflict', 'original_binding_conflict']) {
      await scenario(`Negative evidence with ${mismatch} cannot change entitlement or attach to a different financial effect`, async () => {
        await deliver(); refund(); await clearAudit();
        if (mismatch === 'collector_conflict') { provider.payment.collector_id = 1; provider.preapproval.collector_id = 2; }
        else { provider.payment.collector_id = 1; provider.preapproval.collector_id = 1; }
        assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal((await reversals()).length, 0);
        assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
      });
    }
    await scenario('Additional historical positive ledger evidence prevents an unproven full reversal', async () => {
      await deliver(); const { effectKey } = require('../../src/services/saas-billing-effects');
      await pool.query(`INSERT INTO saas_billing_effects
        (provider,"effectType","canonicalPaymentId","effectKey","providerPreapprovalId","providerAccountId",
        "subscriptionId","clinicId","externalTenantId","sourceEventId",status)
        SELECT provider,"effectType",$1,$2,"providerPreapprovalId","providerAccountId",
        "subscriptionId","clinicId","externalTenantId","sourceEventId",status FROM saas_billing_effects`,
      ['19951521099', effectKey('19951521099')]);
      refund(); await clearAudit(); assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW');
      assert.equal((await effects()).length, 2); assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
    });
    await scenario('Later activation from another subscription is protected from an older refund', async () => {
      await deliver(); const oldProvider = structuredClone(provider), oldSubscription = subscription;
      await anotherContract(); await fresh(); assert.equal(await plan(), 'enterprise');
      provider = oldProvider; subscription = oldSubscription; refund(); await clearAudit();
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal(await plan(), 'enterprise');
      assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 2);
    });
    await scenario('Delayed first payment cannot overwrite a newer activation from another subscription', async () => {
      const oldProvider = structuredClone(provider), oldSubscription = subscription;
      await anotherContract(); await deliver(); assert.equal(await plan(), 'enterprise');
      provider = oldProvider; subscription = oldSubscription; await clearAudit();
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal(await plan(), 'enterprise');
      assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 1); assert.equal(await lifecycle(), undefined);
    });
    await scenario('Manual-review completion failure rolls back durable negative evidence and lifecycle', async () => {
      await deliver(); const before = await lifecycle(); provider.payment.status = 'charged_back';
      fault.query = async (_c, sql) => { if (sql.includes('"contractOutcome" = $4::jsonb')) throw new Error('review_completion_failed'); };
      assert.equal((await fresh()).status, 503); assert.equal((await reversals()).length, 0);
      assert.deepEqual(await lifecycle(), before); assert.equal(await plan(), 'growth');
      fault = {}; assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); assert.equal((await reversals()).length, 1);
    });
    await scenario('RENEWAL A: recycling retains access temporarily and records canonical collection history', async () => {
      await deliver(); const activation = (await lifecycle()).activatedAt; renewal(); collection('recycling');
      await fresh(); const state = await lifecycle();
      assert.equal(state.billingState, 'payment_retrying'); assert.equal(state.entitlementState, 'active');
      assert.equal(state.collectionHistory[0].phase, 'retrying'); assert.equal(state.activatedAt, activation);
      assert.equal((await business()).tenant.settings.portal.billing.entitlement.paidAccessAllowed, true);
      assert.equal((await job()).resourceId, String(provider.invoice.id));
    });
    await scenario('RENEWAL B: a new approved retry resolves the collection without a second initial activation', async () => {
      await deliver(); const activation = (await lifecycle()).activatedAt; renewal(); collection('recycling'); await fresh();
      renewal(); provider.payment.status = 'approved'; provider.invoice.status = 'processed'; provider.invoice.payment.status = 'approved';
      await clearAudit(); await fresh(); const state = await lifecycle();
      assert.equal(state.billingState, 'active'); assert.equal(state.activatedAt, activation); assert.equal(state.nonpayment, null);
      assert.equal(state.collectionHistory[0].resolvedByPaymentId, String(provider.payment.id)); assert.equal(await planWrites(), 0);
      assert.equal((await effects()).length, 2);
    });
    await scenario('RENEWAL C: processed canonical rejected installment suspends paid entitlement, not the contract plan', async () => {
      await deliver(); renewal(); collection('processed'); await clearAudit(); await fresh();
      const state = await lifecycle(), current = await business();
      assert.equal(state.billingState, 'suspended_for_nonpayment'); assert.equal(state.entitlementState, 'suspended_for_nonpayment');
      assert.equal(current.subscription.localStatus, 'suspended'); assert.equal(current.tenant.settings.portal.lifecycle.status, 'suspended');
      assert.equal(current.tenant.settings.portal.billing.entitlement.paidAccessAllowed, false);
      assert.equal(state.collectionHistory[0].phase, 'final_unpaid'); assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0);
    });
    await scenario('RENEWAL D: valid unique new payment reactivates the same plan once and retains unpaid history', async () => {
      await deliver(); const activation = (await lifecycle()).activatedAt; renewal(); collection('processed'); await fresh();
      renewal(); provider.payment.status = 'approved'; provider.invoice.payment.status = 'approved';
      await clearAudit(); await fresh(); const state = await lifecycle();
      assert.equal(state.entitlementState, 'active'); assert.equal(state.billingState, 'active'); assert.equal(state.activatedAt, activation);
      assert.ok(state.collectionHistory[0].failedAt); assert.ok(state.collectionHistory[0].resolvedAt);
      assert.equal(state.nonpayment, null); assert.equal((await business()).tenant.settings.portal.billing.entitlement.paidAccessAllowed, true);
      assert.equal((await business()).tenant.settings.portal.lifecycle.status, 'active');
      assert.equal(await plan(), 'growth'); assert.equal(await planWrites(), 0); await assertMutations(1);
      await clearAudit(); await fresh(); await assertMutations(0); assert.deepEqual(await lifecycle(), state);
      assert.equal((await effects()).length, 2);
    });
    await scenario('RENEWAL E: duplicate rejected webhooks cannot repeat a suspension', async () => {
      await deliver(); renewal(); collection('processed'); await fresh(); const state = await lifecycle();
      await clearAudit(); await fresh(); await assertMutations(0); assert.deepEqual(await lifecycle(), state);
      assert.equal(state.collectionHistory.length, 1); assert.equal((await effects()).length, 1);
    });
    await scenario('RENEWAL F: old rejected event after newer regularization cannot suspend again', async () => {
      await deliver(); renewal(); collection('processed'); await fresh(); const oldProvider = structuredClone(provider);
      renewal(); provider.payment.status = 'approved'; provider.invoice.payment.status = 'approved'; await fresh();
      const regularized = await lifecycle(); provider = oldProvider; await clearAudit(); await fresh();
      assert.deepEqual(await lifecycle(), regularized); await assertMutations(0);
      assert.equal((await business()).tenant.settings.portal.billing.entitlement.paidAccessAllowed, true);
    });
    await scenario('RENEWAL G: definitive unpaid first installment never acquires a paid entitlement or grace period', async () => {
      collection('processed'); await deliver(); const state = await lifecycle();
      assert.equal(state.activatedAt, undefined); assert.equal(state.entitlementState, 'unactivated'); assert.equal(state.billingState, 'payment_failed');
      assert.equal(await plan(), 'basic'); assert.equal(await planWrites(), 0); assert.equal((await effects()).length, 0);
      assert.equal((await business()).tenant.settings.portal.billing, undefined);
    });
    await scenario('RENEWAL H: suspension preserves immutable contract, plan, client settings and integration configuration', async () => {
      await pool.query(`UPDATE clinics SET settings=settings || '{"clientData":{"keep":"customer-data"},"integrations":{"fixture":"preserved"}}'::jsonb`);
      await deliver(); const before = await business(); renewal(); collection('processed'); await fresh(); const after = await business();
      assert.deepEqual(after.subscription.metadata.contract, before.subscription.metadata.contract);
      assert.equal(after.subscription.id, before.subscription.id); assert.equal(after.subscription.planCode, before.subscription.planCode);
      assert.deepEqual(after.tenant.settings.portal.policy, before.tenant.settings.portal.policy);
      assert.deepEqual(after.tenant.settings.clientData, before.tenant.settings.clientData);
      assert.deepEqual(after.tenant.settings.integrations, before.tenant.settings.integrations);
    });
    for (const retryAttempt of [undefined, 0, 1, 2, 99]) await scenario(`No local retry threshold: recycling remains temporary with provider retry_attempt=${retryAttempt}`, async () => {
      await deliver(); renewal(); collection('recycling'); provider.invoice.retry_attempt = retryAttempt; await fresh();
      assert.equal((await lifecycle()).entitlementState, 'active'); assert.equal((await lifecycle()).billingState, 'payment_retrying');
    });
    await scenario('Unknown or contradictory collection evidence never authorizes suspension', async () => {
      await deliver(); renewal(); collection('processed'); provider.invoice.payment.status = 'approved'; await fresh();
      assert.equal((await lifecycle()).billingState, 'past_due'); assert.equal((await lifecycle()).reviewReason, 'collection_state_unproven');
      assert.equal((await lifecycle()).entitlementState, 'active');
    });
    await scenario('Provider recycling to processed rejection is observed through the same reconciliation policy', async () => {
      await deliver(); renewal(); collection('recycling'); await fresh(); collection('processed'); await due();
      assert.equal((await reconciliation.runBillingReconciliationOnce()).completed, true);
      assert.equal((await lifecycle()).entitlementState, 'suspended_for_nonpayment');
      assert.equal((await job()).status, 'terminal');
    });
    await scenario('Local reconciliation exhaustion cannot masquerade as provider collection exhaustion', async () => {
      await deliver(); renewal(); collection('recycling'); await fresh();
      await pool.query(`UPDATE saas_billing_reconciliations SET attempts=12,"nextAttemptAt"=clock_timestamp()-interval '1 second'`);
      await reconciliation.runBillingReconciliationOnce();
      assert.equal((await lifecycle()).entitlementState, 'active'); assert.equal((await job()).status, 'manual_review');
    });
    await scenario('Cancellation and reversible nonpayment remain separate after regularization', async () => {
      await deliver(); renewal(); collection('processed'); await fresh(); await cancel();
      renewal(); provider.payment.status = 'approved'; provider.invoice.payment.status = 'approved'; await fresh();
      const state = await lifecycle(); assert.equal(state.entitlementState, 'active'); assert.equal(state.billingState, 'subscription_cancelled');
      assert.ok(state.cancellationAt); assert.equal((await business()).subscription.localStatus, 'canceled');
    });
    await scenario('Suspension completion failure rolls back entitlement, projection and rejection history together', async () => {
      await deliver(); const state = await lifecycle(); renewal(); collection('processed');
      fault.query = async (_c, sql, params) => { if (sql.includes('UPDATE saas_subscription_events') && params.includes('ignored')) throw new Error('suspend_completion_failed'); };
      assert.equal((await fresh()).status, 503); assert.deepEqual(await lifecycle(), state);
      assert.equal((await business()).tenant.settings.portal.billing.entitlement.paidAccessAllowed, true);
      fault = {}; await fresh(); assert.equal((await lifecycle()).entitlementState, 'suspended_for_nonpayment');
    });
    await scenario('Refund of a later contract restores an earlier nonpayment access restriction exactly', async () => {
      await deliver(); renewal(); collection('processed'); await fresh();
      const previousAccess = (await business()).tenant.settings.portal.billing.entitlement;
      await anotherContract(); provider.payment.status = 'approved'; provider.invoice.payment.status = 'approved'; await fresh();
      assert.equal(await plan(), 'enterprise'); refund(); await fresh();
      const portal = (await business()).tenant.settings.portal;
      assert.equal(await plan(), 'growth'); assert.equal(portal.lifecycle.status, 'suspended');
      assert.deepEqual(portal.billing.entitlement, previousAccess);
      assert.equal(portal.billing.entitlement.paidAccessAllowed, false);
    });
    await scenario('BILL-008 AC/AD/AE/AF/AG: canonical plan activation, dedupe, suspension and restoration', async () => {
      const { resolveEffectiveEntitlements, canCapability } = require('../../src/services/effective-entitlements');
      const contract = captureLocalBillingContract({ subscriptionId: subscription.id, clinicId,
        externalTenantId: subscription.externalTenantId, externalReference: subscription.externalReference,
        plan: { code: 'distribution', amount: 40600, currency: 'ARS', entitlementProfileVersion: 1 },
        capturedAt: new Date().toISOString() });
      // Fixture setup only: production contracts are never rewritten.
      await pool.query(`UPDATE saas_subscriptions SET "planCode"='distribution',metadata=$2::jsonb WHERE id=$1`,
        [subscription.id, JSON.stringify({ contract })]);
      const effective = async () => resolveEffectiveEntitlements((await business()).tenant.settings);
      assert.equal(canCapability(await effective(), 'inventory'), false);
      await fresh(); const activated = await effective();
      assert.equal(activated.planKey, 'distribution'); assert.equal(activated.entitlementProfileVersion, 1);
      assert.equal(canCapability(activated, 'inventory'), true);
      await clearAudit(); await fresh(); await assertMutations(0);
      assert.deepEqual(await effective(), activated);
      renewal(); collection('processed'); await fresh();
      assert.equal(canCapability(await effective(), 'inventory'), false);
      assert.deepEqual((await business()).subscription.metadata.contract, contract);
      renewal(); provider.payment.status = 'approved'; provider.invoice.payment.status = 'approved'; await fresh();
      assert.equal(canCapability(await effective(), 'inventory'), true);
      assert.equal((await effective()).planKey, 'distribution');
      await clearAudit(); await fresh(); await assertMutations(0);
    });
    await scenario('BILL-008 AH: older reversal cannot replace a later canonical profile', async () => {
      await deliver(); const oldProvider = structuredClone(provider), oldSubscription = subscription;
      await anotherContract();
      const contract = captureLocalBillingContract({ subscriptionId: subscription.id, clinicId,
        externalTenantId: subscription.externalTenantId, externalReference: subscription.externalReference,
        plan: { code: 'distribution', amount: 40600, currency: 'ARS', entitlementProfileVersion: 1 },
        capturedAt: new Date().toISOString() });
      await pool.query(`UPDATE saas_subscriptions SET "planCode"='distribution',metadata=$2::jsonb WHERE id=$1`, [subscription.id, JSON.stringify({ contract })]);
      await fresh(); const before = (await business()).tenant.settings.portal.entitlements;
      provider = oldProvider; subscription = oldSubscription; refund(); await clearAudit();
      assert.equal((await fresh()).body.outcome, 'MANUAL_REVIEW'); await assertMutations(0);
      assert.deepEqual((await business()).tenant.settings.portal.entitlements, before);
    });
    await scenario('BILL-010A.1 A-D: Admin cancels a pending preapproval without payment or entitlement effects', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      const response = await adminCancel();
      assert.equal(response.status, 200); assert.equal(response.body.success, true);
      assert.equal(provider.cancelCalls, 1); assert.equal(provider.preapproval.status, 'cancelled');
      const after = await business(); const state = await lifecycle();
      assert.equal(after.subscription.localStatus, 'canceled');
      assert.equal(after.subscription.mercadoPagoStatus, 'cancelled');
      assert.deepEqual(after.subscription.metadata.contract, subscription.metadata.contract);
      assert.equal(state.billingState, 'subscription_cancelled');
      assert.equal(state.activatedAt, undefined); assert.equal(state.entitlementState, 'unactivated');
      assert.equal(after.tenant.settings.portal.policy.planCode, 'basic');
      assert.equal(after.subscription.lastPaymentId, null); assert.equal(after.subscription.lastPaymentStatus, null);
      assert.equal((await effects()).length, 0);
      assert.deepEqual(calls.filter(call => call === 'mock_cancel'), ['mock_cancel']);
    });
    await scenario('BILL-010A.1 E: retry observes provider cancellation and avoids a duplicate provider mutation', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      assert.equal((await adminCancel()).status, 200);
      const firstCancellationAt = (await lifecycle()).cancellationAt;
      assert.equal((await adminCancel()).status, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await lifecycle()).cancellationAt, firstCancellationAt);
      assert.equal((await effects()).length, 0);
      assert.equal((await business()).tenant.settings.portal.policy.planCode, 'basic');
    });
    await scenario('BILL-010A.1 F: request without the protected Admin credential cannot reach cancellation', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      const response = await adminCancel({ authorized: false });
      assert.equal(response.status, 401);
      assert.equal(provider.cancelCalls || 0, 0);
      assert.equal(calls.length, 0);
      assert.equal(provider.preapproval.status, 'pending');
      assert.equal((await business()).subscription.localStatus, 'pending');
    });
    await scenario('BILL-010A.1 G: unknown provider state fails closed before any provider mutation', async () => {
      provider.preapproval.status = 'review_required'; provider.allowCancel = true;
      const response = await adminCancel();
      assert.equal(response.status, 409);
      assert.equal(response.body.error, 'subscription_cancellation_state_unsupported');
      assert.equal(provider.cancelCalls || 0, 0);
      assert.equal((await business()).subscription.localStatus, 'pending');
      assert.deepEqual(calls.filter(call => call === 'mock_cancel'), []);
    });
    for (const existingStatus of ['authorized', 'paused']) await scenario(`BILL-010A.1 H: existing ${existingStatus} subscriptions remain cancellable`, async () => {
      provider.preapproval.status = existingStatus; provider.allowCancel = true;
      const response = await adminCancel();
      assert.equal(response.status, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'canceled');
      assert.equal((await lifecycle()).billingState, 'subscription_cancelled');
    });
    await scenario('BILL-010A.1: lost provider response reconciles only after canonical GET confirms cancellation', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true; provider.cancelNetworkAfterMutation = true;
      const response = await adminCancel();
      assert.equal(response.status, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'canceled');
      assert.equal((await lifecycle()).billingState, 'subscription_cancelled');
      assert.equal((await effects()).length, 0);
    });
    await scenario('BILL-010A.1: unconfirmed provider result leaves local subscription pending', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true; provider.cancelStatusAfterPut = 'pending';
      const response = await adminCancel();
      assert.equal(response.status, 502);
      assert.equal(response.body.error, 'subscription_cancellation_unconfirmed');
      assert.equal(response.body.details.providerHttpStatus, 200);
      assert.equal(response.body.details.providerResponseStatus, 'pending');
      assert.equal(response.body.details.providerReadbackStatus, 'pending');
      assert.equal(response.body.details.providerReadbackHttpStatus, 200);
      assert.equal(response.body.details.providerReadbackAttempts, 5);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'pending');
      assert.equal(await lifecycle(), undefined);
      assert.equal((await effects()).length, 0);
    });
    await scenario('BILL-010A.3 A: accepted cancellation is applied only after provider readback confirms cancelled', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      const response = await adminCancel();
      assert.equal(response.status, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal(calls.filter(call => call === '/preapproval/mp-1').length, 2);
      assert.equal((await business()).subscription.localStatus, 'canceled');
      assert.equal((await business()).subscription.mercadoPagoStatus, 'cancelled');
      assert.equal((await lifecycle()).billingState, 'subscription_cancelled');
      assert.equal((await effects()).length, 0);
    });
    await scenario('BILL-010A.3 B: provider already cancelled reconciles locally without another PUT', async () => {
      provider.preapproval.status = 'cancelled';
      const response = await adminCancel();
      assert.equal(response.status, 200);
      assert.equal(provider.cancelCalls || 0, 0);
      const after = await business();
      assert.equal(after.subscription.localStatus, 'canceled');
      assert.equal(after.subscription.mercadoPagoStatus, 'cancelled');
      assert.deepEqual(after.subscription.metadata.contract, subscription.metadata.contract);
      assert.equal((await lifecycle()).billingState, 'subscription_cancelled');
      assert.equal((await effects()).length, 0);
    });
    await scenario('BILL-010A.3 C: canceled PUT response cannot override a pending canonical readback', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      provider.cancelStatusAfterPut = 'cancelled';
      provider.cancelReadbackStatuses = ['pending', 'pending', 'pending', 'pending', 'pending'];
      const response = await adminCancel();
      assert.equal(response.status, 502);
      assert.equal(response.body.error, 'subscription_cancellation_unconfirmed');
      assert.equal(response.body.details.providerHttpStatus, 200);
      assert.equal(response.body.details.providerResponseStatus, 'cancelled');
      assert.equal(response.body.details.providerReadbackStatus, 'pending');
      assert.equal(response.body.details.providerReadbackHttpStatus, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'pending');
      assert.equal(await lifecycle(), undefined);
      assert.equal((await effects()).length, 0);
    });
    await scenario('BILL-010A.3 D: lagging readback eventually confirms cancellation without a second provider write', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      provider.cancelStatusAfterPut = 'pending';
      provider.cancelReadbackStatuses = ['pending', 'pending', 'cancelled'];
      const response = await adminCancel();
      assert.equal(response.status, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal(provider.cancelReadbackCount, 3);
      const after = await business();
      const state = await lifecycle();
      assert.equal(after.subscription.localStatus, 'canceled');
      assert.equal(after.subscription.mercadoPagoStatus, 'cancelled');
      assert.equal(state.billingState, 'subscription_cancelled');
      assert.equal(state.activatedAt, undefined);
      assert.equal(state.entitlementState, 'unactivated');
      assert.equal((await effects()).length, 0);
      await assertMutations(1);
    });
    await scenario('BILL-010A.3 F: provider rejection is diagnosed and local billing remains unchanged', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      provider.cancelError = { status: 400, body: {
        message: 'provider rejected cancellation', error: 'bad_request', code: 'PA_INVALID_STATE', status: 400,
        cause: [{ code: 2034, description: 'do not persist this provider detail' }],
        causes: [{ code: 'secondary_reason', description: 'secondary provider detail' }],
        details: { reason: 'provider detail', payer_email: 'person@example.com', access_token: 'secret-token' }
      }, headers: {
        'x-request-id': 'mp-request-010a6'
      } };
      const response = await adminCancel();
      assert.equal(response.status, 502);
      assert.equal(response.body.error, 'subscription_cancellation_unconfirmed');
      assert.equal(response.body.details.providerHttpStatus, 400);
      assert.equal(response.body.details.providerResponseStatus, null);
      assert.deepEqual(response.body.details.providerResponseErrorCodes, ['bad_request', '2034']);
      assert.equal(response.body.details.providerReadbackStatus, 'pending');
      assert.equal(response.body.details.providerReadbackHttpStatus, 200);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'pending');
      assert.equal(await lifecycle(), undefined);
      assert.equal((await effects()).length, 0);
      const failure = logs.find(item => item.event === 'billing_subscription_cancellation_unconfirmed');
      assert.ok(failure);
      assert.equal(failure.fields.providerHttpStatus, 400);
      assert.equal(failure.fields.providerError, 'bad_request');
      assert.equal(failure.fields.providerErrorCode, 'PA_INVALID_STATE');
      assert.equal(failure.fields.providerErrorMessage, 'provider rejected cancellation');
      assert.equal(failure.fields.providerErrorStatus, '400');
      assert.equal(failure.fields.providerRequestId, 'mp-request-010a6');
      assert.equal(failure.fields.providerCause[0].code, 2034);
      assert.equal(failure.fields.providerCauses[0].code, 'secondary_reason');
      assert.equal(failure.fields.providerDetails.payer_email, '[REDACTED]');
      assert.equal(failure.fields.providerDetails.access_token, '[REDACTED]');
      const serializedFailure = JSON.stringify(failure);
      assert.equal(serializedFailure.includes('secret-token'), false);
      assert.equal(serializedFailure.includes('person@example.com'), false);
    });
    await scenario('BILL-010A.4: failed readback captures HTTP status and safe error code without provider body', async () => {
      provider.preapproval.status = 'pending'; provider.allowCancel = true;
      provider.cancelStatusAfterPut = 'pending';
      provider.cancelReadbackStatuses = Array.from({ length: 5 }, () => ({
        httpStatus: 503, body: { error: 'service_unavailable', cause: [{ code: 'readback_down', description: 'private detail' }] }
      }));
      const response = await adminCancel();
      assert.equal(response.status, 502);
      assert.equal(response.body.details.providerReadbackHttpStatus, 503);
      assert.deepEqual(response.body.details.providerReadbackErrorCode, 'mercadopago_preapproval_failed');
      assert.equal(response.body.details.providerReadbackStatus, null);
      assert.equal(JSON.stringify(response.body.details).includes('private detail'), false);
      assert.equal(provider.cancelCalls, 1);
      assert.equal((await business()).subscription.localStatus, 'pending');
      assert.equal((await effects()).length, 0);
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
