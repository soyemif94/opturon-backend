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

test('BILL-006BC final: authenticated delivery, canonical effects, cutover and reconciliation', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `architecture_test_${crypto.randomUUID().replaceAll('-', '')}`;
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
    if (provider.beforeFetch) await provider.beforeFetch(kind, init.signal);
    if (provider.httpBase) return originalFetch(provider.httpBase + request.pathname + request.search, init);
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
  async function deliver(valid = true, { requestId = 'fixture-request', id = payload.data.id } = {}) {
    const ts = '1727300000';
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
    provider.payment = { date_created: new Date().toISOString(), id: 19951521071, status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference,
      transaction_amount: 40600, currency_id: 'ARS' };
    provider.search = { paging: { offset: 0, limit: 2, total: 1 }, results: [{ id: 6114264375, payment: { id: 19951521071 } }] };
    provider.invoice = { id: 6114264375, preapproval_id: 'mp-1', transaction_amount: '40600.00', currency_id: 'ARS',
      status: 'processed', summarized: 'done', payment: { id: 19951521071, status: 'approved' }, external_reference: input.externalReference };
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

    const reconciliation = require('../../src/services/saas-billing-reconciliation.service');
    const claims = require('../../src/services/saas-billing-webhook-claims');
    const jobs = require('../../src/repositories/saas-billing-reconciliation.repository');
    const effects = async () => (await pool.query('SELECT * FROM saas_billing_effects')).rows;
    const job = async () => (await pool.query('SELECT * FROM saas_billing_reconciliations')).rows[0];
    const due = () => pool.query(`UPDATE saas_billing_reconciliations SET "nextAttemptAt"=clock_timestamp()-interval '1 second'`);
    const clearAudit = () => pool.query('TRUNCATE mutation_audit');
    function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
    async function reviewed(reason) {
      assert.equal((await deliver()).body.outcome, 'MANUAL_REVIEW');
      assert.equal((await event()).contractOutcome.reasonCode, reason);
      await assertMutations(0); assert.equal((await effects()).length, 0);
    }
    for (const field of ['id', 'action', 'type']) await scenario(`Same signature + changed unsigned ${field}: same delivery/effect`, async () => {
      await assertProcessed(await deliver()); const before = await event(); const reads = calls.length;
      payload[field] = field === 'type' ? 'preapproval' : 'tampered-preapproval.updated';
      const response = await deliver(); assert.equal(response.body.duplicate, true);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n, 1);
      assert.deepEqual((await pool.query('SELECT * FROM saas_subscription_events')).rows[0], before);
      assert.equal(calls.length, reads); assert.equal((await effects()).length, 1); await assertMutations(1);
    });
    await scenario('Tampered body arrives first: signed invoice still requires Payment proof', async () => {
      provider.payment.status = 'pending';
      payload.type = 'preapproval'; payload.action = 'preapproval.updated'; payload.data.id = 'mp-1';
      const response = await deliver(true, { id: '6114264375' });
      assert.equal(response.status, 200); assert.equal((await event()).processingError, 'payment_pending');
      await assertMutations(0); assert.equal((await effects()).length, 0); assert.ok(await job());
    });
    await scenario('Same Payment through invoice then Payment: one canonical effect', async () => {
      await assertProcessed(await deliver()); payload.id = 'different-topic'; paymentTopic();
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).processingError, 'canonical_effect_already_applied');
      await assertMutations(1); assert.equal((await effects()).length, 1);
    });
    await scenario('Distinct authenticated deliveries of same Payment: one effect', async () => {
      await assertProcessed(await deliver()); payload.id = 'new-authenticated-delivery';
      assert.equal((await deliver(true, { requestId: 'second-signed-request' })).status, 200);
      await assertMutations(1); assert.equal((await effects()).length, 1);
    });
    await scenario('Concurrent authenticated deliveries: authoritative unique ledger', async () => {
      const responses = await Promise.all([deliver(true, { requestId: 'a' }), deliver(true, { requestId: 'b' })]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]); await assertMutations(1);
      assert.equal((await effects()).length, 1);
    });
    await scenario('Effect/business/completion rollback is atomic, retry applies once', async () => {
      fault.query = async (_client, sql) => { if (sql.includes('UPDATE clinics')) throw new Error('synthetic_db_failure'); };
      assert.equal((await deliver()).status, 503); assert.equal((await effects()).length, 0); await assertMutations(0);
      fault = {}; await assertProcessed(await deliver()); assert.equal((await effects()).length, 1);
    });
    await scenario('Conflicting collector binding is manual review without another mutation', async () => {
      provider.payment.collector_id = 'collector-a'; await assertProcessed(await deliver());
      provider.payment.collector_id = 'collector-b'; payload.id = 'conflicting-binding';
      assert.equal((await deliver(true, { requestId: 'conflict' })).body.outcome, 'MANUAL_REVIEW');
      assert.equal((await event()).contractOutcome.reasonCode, 'provider_relationship_unproven');
      await assertMutations(1); assert.equal((await effects()).length, 1);
    });
    await scenario('Pre-cutover subscription and old Payment are quarantined', async () => {
      await pool.query(`UPDATE saas_subscriptions SET "createdAt"=clock_timestamp()-interval '2 days'`); await clearAudit();
      await reviewed('legacy_effect_unreconciled'); assert.equal(await job(), undefined);
    });
    await scenario('Pre-cutover subscription, Payment at exact +24h boundary is eligible', async () => {
      await pool.query(`UPDATE saas_subscriptions SET "createdAt"=clock_timestamp()-interval '2 days'`); await clearAudit();
      provider.payment.date_created = (await pool.query('SELECT "autoApplyNotBefore" FROM saas_billing_runtime_state')).rows[0].autoApplyNotBefore.toISOString();
      // DB microseconds are preserved by requesting a textual ISO value.
      provider.payment.date_created = (await pool.query(`SELECT to_char("autoApplyNotBefore" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM saas_billing_runtime_state`)).rows[0].at;
      await assertProcessed(await deliver());
    });
    await scenario('New local v2 subscription is eligible immediately', async () => { await assertProcessed(await deliver()); });
    for (const date of [undefined, '2026-02-30T00:00:00Z', '2026-10-02T00:00:00', 'invalid']) {
      await scenario(`Invalid Payment date ${date} never falls back to NOW`, async () => {
        provider.payment.date_created = date; await reviewed('legacy_effect_unreconciled');
      });
    }
    for (const status of ['pending', 'in_process']) await scenario(`${status}: durable job, original event stays terminal, worker applies shared effect`, async () => {
      provider.payment.status = status; assert.equal((await deliver()).status, 200);
      const original = await event(); assert.equal((await job()).status, 'pending');
      provider.payment.status = 'approved'; await due();
      assert.equal((await reconciliation.runBillingReconciliationOnce()).completed, true);
      assert.equal((await job()).status, 'completed'); assert.equal((await effects()).length, 1);
      await assertMutations(1); assert.deepEqual(await event(), original);
      assert.equal((await effects())[0].sourceEventId, null); assert.ok((await effects())[0].sourceReconciliationRunId);
    });
    await scenario('Zero search match enqueues durable progression', async () => {
      paymentTopic(); provider.search = { paging: { offset: 0, limit: 2, total: 0 }, results: [] };
      assert.equal((await deliver()).status, 200); assert.equal((await job()).reason, 'authorized_invoice_not_found'); await assertMutations(0);
    });
    for (const status of ['rejected', 'cancelled']) await scenario(`${status}: terminal without reconciliation`, async () => {
      provider.payment.status = status; assert.equal((await deliver()).status, 200);
      assert.equal(await job(), undefined); await assertMutations(0);
    });
    await scenario('Manual review never enqueues automatic retry', async () => {
      provider.invoice.preapproval_id = null; await reviewed('provider_relationship_unproven'); assert.equal(await job(), undefined);
    });
    await scenario('Webhook and reconciliation race: one business application', async () => {
      provider.payment.status = 'pending'; await deliver(); provider.payment.status = 'approved'; await due();
      const entered = deferred(); const release = deferred(); let visits = 0;
      provider.beforeFetch = async kind => { if (kind === 'invoice' && ++visits <= 2) { if (visits === 2) entered.resolve(); await release.promise; } };
      const worker = reconciliation.runBillingReconciliationOnce(); const webhook = deliver(true, { requestId: 'race' });
      await entered.promise; release.resolve();
      assert.equal((await webhook).status, 200); assert.equal((await worker).completed, true);
      assert.equal((await effects()).length, 1); await assertMutations(1);
    });
    await scenario('Expired lease safely reclaimed; stale worker has zero finalization writes', async () => {
      provider.payment.status = 'pending'; await deliver(); provider.payment.status = 'approved'; await due();
      const entered = deferred(); const release = deferred(); let first = true;
      provider.beforeFetch = async kind => { if (kind === 'invoice' && first) { first = false; entered.resolve(); await release.promise; } };
      const old = reconciliation.runBillingReconciliationOnce(); await entered.promise;
      await pool.query(`UPDATE saas_billing_reconciliations SET "leaseExpiresAt"=clock_timestamp()-interval '1 second'`);
      assert.equal((await reconciliation.runBillingReconciliationOnce()).completed, true);
      const before = await job(); release.resolve(); assert.equal((await old).stale, true);
      assert.deepEqual(await job(), before); assert.equal((await effects()).length, 1); await assertMutations(1);
      const statuses = (await pool.query('SELECT status FROM saas_billing_reconciliation_runs ORDER BY "createdAt"')).rows.map(r => r.status);
      assert.deepEqual(statuses, ['stale', 'completed']);
    });
    await scenario('Attempts exhausted: manual review, zero provider calls', async () => {
      provider.payment.status = 'pending'; await deliver(); await due();
      await pool.query('UPDATE saas_billing_reconciliations SET attempts=12'); const reads = calls.length;
      await reconciliation.runBillingReconciliationOnce(); assert.equal(calls.length, reads);
      assert.equal((await job()).status, 'manual_review'); assert.equal((await job()).reason, 'reconciliation_exhausted');
    });
    await scenario('Historical tool: insufficient evidence makes no ledger or business writes', async () => {
      const tool = require('../billing/reconcile-historical-billing-effect');
      assert.deepEqual(await tool.reconcileHistoricalEffect({ paymentId: '19951521071', eventId: crypto.randomUUID(), apply: true }),
        { classification: 'insufficient', applied: false });
      assert.equal((await effects()).length, 0); await assertMutations(0);
    });
    await scenario('Historical tool: correlated atomic snapshot, dry-run, ledger-only apply and replay', async () => {
      await assertProcessed(await deliver());
      const original = await event();
      // Local fixture reconstructs a retained legacy atomic completion. Never production SQL.
      await pool.query('TRUNCATE saas_billing_effects CASCADE');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE saas_subscription_events SET "updatedAt"=NOW()-interval '2 days'`);
        await client.query(`UPDATE saas_subscriptions SET "updatedAt"=NOW()-interval '2 days',"createdAt"=NOW()-interval '3 days'`);
        await client.query(`UPDATE clinics SET "updatedAt"=NOW()-interval '2 days'`);
        await client.query('COMMIT');
      } finally { client.release(); }
      await clearAudit();
      const tool = require('../billing/reconcile-historical-billing-effect');
      const options = { paymentId: '19951521071', eventId: original.id };
      const dry = await tool.reconcileHistoricalEffect(options);
      assert.equal(dry.classification, 'proven_applied'); assert.equal(dry.dryRun, true);
      assert.equal((await effects()).length, 0); await assertMutations(0);
      const applied = await tool.reconcileHistoricalEffect({ ...options, apply: true });
      assert.equal(applied.applied, true); assert.equal((await effects()).length, 1); await assertMutations(0);
      const replay = await deliver(true, { requestId: 'historical-replay' });
      assert.equal(replay.status, 200);
      const row = (await pool.query('SELECT * FROM saas_subscription_events WHERE "requestId"=$1', ['historical-replay'])).rows[0];
      assert.equal(row.processingError, 'canonical_effect_already_applied'); await assertMutations(0);
    });
    await scenario('Historical tool: lastPaymentId and processed status without atomic snapshot are insufficient', async () => {
      await assertProcessed(await deliver()); const original = await event();
      await pool.query('TRUNCATE saas_billing_effects CASCADE');
      await pool.query(`UPDATE saas_subscriptions SET metadata=metadata-'mercadoPagoPaymentSnapshot'`); await clearAudit();
      const result = await require('../billing/reconcile-historical-billing-effect').reconcileHistoricalEffect({
        paymentId: '19951521071', eventId: original.id, apply: true });
      assert.equal(result.classification, 'insufficient'); assert.equal((await effects()).length, 0); await assertMutations(0);
    });
    await scenario('Reconciliation age exhausted and repeated pending use bounded backoff', async () => {
      provider.payment.status = 'pending'; await deliver(); await due();
      await reconciliation.runBillingReconciliationOnce();
      const pending = await job(); assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 1);
      const retryDelay = new Date(pending.nextAttemptAt) - Date.now();
      assert.ok(retryDelay > 590000 && retryDelay <= 600000);
      await pool.query(`UPDATE saas_billing_reconciliations SET "createdAt"=clock_timestamp()-interval '49 hours',"nextAttemptAt"=clock_timestamp()`);
      const reads = calls.length; await reconciliation.runBillingReconciliationOnce();
      assert.equal(calls.length, reads); assert.equal((await job()).reason, 'reconciliation_exhausted');
    });
    await scenario('Forged delivery context is rejected before event INSERT or provider', async () => {
      await assert.rejects(service.processMercadoPagoWebhook(payload, { signatureValid: true, verifiedDelivery: {
        manifest: 'forged', resourceId: 'mp-1' } }), /verified_delivery_context_required/);
      assert.equal(await event(), undefined); assert.equal(calls.length, 0); await assertMutations(0);
    });
    await scenario('Two canonical classes for signed ID: review after all four probes', async () => {
      provider.endpointId = { preapproval: '6114264375' };
      provider.preapproval.id = '6114264375';
      await reviewed('provider_relationship_unproven'); assert.equal(calls.length, 4);
    });
    await scenario('Other root class technical uncertainty cannot be ignored after first success', async () => {
      provider.endpointId = { plan: '6114264375' }; provider.error = { kind: 'plan', status: 503 };
      assert.equal((await deliver()).status, 503);
      assert.match((await event()).processingError, /:provider_5xx$/); await assertMutations(0);
    });
    const precursorPath = path.join(root, 'src/services/saas-billing.service.js');
    const precursorModule = new (require('node:module'))(precursorPath, module);
    precursorModule.filename = precursorPath; precursorModule.paths = module.paths;
    precursorModule._compile(require('node:child_process').execFileSync('git',
      ['show', 'd51bf60658a0e34088256ed9c1029d78e3b884d7:src/services/saas-billing.service.js'],
      { cwd: root, encoding: 'utf8' }), precursorPath);
    // Only this disposable local schema is changed to construct cutover fixtures.
    async function legacyFixture(fn) {
      await pool.query('TRUNCATE saas_billing_runtime_state');
      await pool.query(`INSERT INTO saas_billing_runtime_state(id,"schemaVersion",generation,"billingContractV2CutoverActive") VALUES(1,1,1,false)`);
      try { await fn(); }
      finally {
        const state = (await pool.query('SELECT generation FROM saas_billing_runtime_state')).rows[0];
        if (state.generation === 1) await require('./helpers/billing-v2-fixture').activateFixture(pool);
      }
    }
    await scenario('Final v2 runtime under generation 1: 503 before event/provider/business', async () => {
      await legacyFixture(async () => {
        assert.equal((await deliver()).status, 503); assert.equal(await event(), undefined);
        assert.equal(calls.length, 0); await assertMutations(0);
      });
    });
    await scenario('Missing M0: both runtimes fail closed, signature rejection still precedes DB read', async () => {
      await pool.query('ALTER TABLE saas_billing_runtime_state RENAME TO hidden_runtime_state');
      try {
        assert.equal((await deliver()).status, 503); assert.equal((await deliver(false)).status, 401);
        await assert.rejects(precursorModule.exports.processMercadoPagoWebhook(payload, { signatureValid: true }), /does not exist/);
        assert.equal(await event(), undefined); assert.equal(calls.length, 0); await assertMutations(0);
      } finally { await pool.query('ALTER TABLE hidden_runtime_state RENAME TO saas_billing_runtime_state'); }
    });
    await scenario('Exact precursor after cutover: zero INSERT/provider/business for any unsigned topic', async () => {
      for (const type of ['payment', 'preapproval', 'authorized_payment', 'unsupported']) {
        payload.type = type;
        await assert.rejects(precursorModule.exports.processMercadoPagoWebhook(payload, { signatureValid: true }), /generation_disabled/);
      }
      assert.equal(await event(), undefined); assert.equal(calls.length, 0); await assertMutations(0);
    });
    await scenario('Exact precursor before cutover preserves legacy billing application', async () => {
      await legacyFixture(async () => {
        payload.type = 'payment'; payload.data.id = '19951521071';
        const result = await precursorModule.exports.processMercadoPagoWebhook(payload, { signatureValid: true });
        assert.equal(result.ok, true); assert.equal((await event()).processingStatus, 'processed'); await assertMutations(1);
        assert.equal((await effects()).length, 0);
      });
    });
    await scenario('Exact precursor: provider in flight at activation cannot mutate afterwards', async () => {
      await legacyFixture(async () => {
        payload.type = 'payment'; payload.data.id = '19951521071';
        const entered = deferred(); const release = deferred();
        provider.beforeFetch = async kind => { if (kind === 'payment') { entered.resolve(); await release.promise; } };
        const pending = precursorModule.exports.processMercadoPagoWebhook(payload, { signatureValid: true });
        await entered.promise;
        try { await require('./helpers/billing-v2-fixture').activateFixture(pool); } finally { release.resolve(); }
        assert.equal((await pending).ok, false); await assertMutations(0); assert.equal((await effects()).length, 0);
      });
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
