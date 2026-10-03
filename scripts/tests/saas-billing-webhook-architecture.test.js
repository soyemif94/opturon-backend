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

test('BILL-006BC architecture: claim/CAS, short transactions, abort and normal ACK', async (t) => {
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
    if (kind !== 'search' && request.pathname.split('/').pop() !== endpointId[kind]) return new Response('{}', { status: 404 });
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
  async function deliver(valid = true) {
    const requestId = 'fixture-' + crypto.createHash('sha256').update(JSON.stringify(payload.id ?? null)).digest('hex').slice(0, 16); const ts = '1727300000'; const id = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  function signedKey() { return require('./helpers/billing-v2-fixture').delivery(payload, secret, 'fixture-' + crypto.createHash('sha256').update(JSON.stringify(payload.id ?? null)).digest('hex').slice(0,16)).dedupeKey; }
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
  async function assertRetryable(response, reason) {
    assert.deepEqual(response, { status: 503, body: { success: false, error: 'webhook_processing_failed' } });
    const row = await event();
    assert.equal(row.processingStatus, 'failed'); assert.equal(row.contractOutcome, null);
    assert.match(row.processingError, new RegExp('^billing_contract_v2:claim:[0-9a-f-]{36}:' + reason + '$')); assert.deepEqual(row.raw, payload);
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

    const claims = require('../../src/services/saas-billing-webhook-claims');
    const markerProtocol = require('../../src/services/saas-billing-rollback-marker');
    const activePattern = /^billing_contract_v2:claim:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:claim_active$/;
    function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
    async function stale() { await pool.query(`UPDATE saas_subscription_events SET "updatedAt"=NOW()-interval '1 minute'`); }
    async function noAction(reason) {
      const before = await business(); const result = await deliver();
      assert.equal(result.status, 200); assert.equal(result.body.ignored, true);
      const row = await event(); assert.equal(row.processingStatus, 'ignored');
      assert.equal(row.processingError, reason); assert.equal(row.contractOutcome, null);
      assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), before); await assertMutations(0);
      const reads = calls.length; assert.equal((await deliver()).body.duplicate, true);
      assert.deepEqual(await event(), row); assert.equal(calls.length, reads);
    }
    async function decision(type, reason) {
      const before = await business(); const result = await deliver();
      assert.equal(result.status, 200); assert.equal(result.body.outcome, type.toUpperCase());
      const row = await event(); assert.equal(row.processingStatus, 'ignored');
      assert.equal(row.contractOutcome.type, type); assert.equal(row.contractOutcome.reasonCode, reason);
      assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), before); await assertMutations(0);
    }
    // Load the exact deployed bridge without checkout or file mutation. Its
    // actual guard must reject candidate markers, not a reimplemented fixture.
    const bridgePath = path.join(root, 'src/services/saas-billing.service.js');
    const bridge = new (require('node:module'))(bridgePath, module);
    bridge.filename = bridgePath; bridge.paths = module.paths;
    bridge._compile(require('node:child_process').execFileSync('git',
      ['show', 'd51bf60658a0e34088256ed9c1029d78e3b884d7:src/services/saas-billing.service.js'],
      { cwd: root, encoding: 'utf8' }), bridgePath);
    async function bridgeRefuses() {
      const before = await event(); const beforeBusiness = await business(); const reads = calls.length;
      const rowsBefore = (await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n;
      await assert.rejects(bridge.exports.processMercadoPagoWebhook(payload, { signatureValid: true }), /billing_runtime_generation_disabled/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n, rowsBefore);
      assert.deepEqual(await event(), before); assert.deepEqual(await business(), beforeBusiness);
      assert.equal(calls.length, reads); await assertMutations(0);
    }
    await scenario('CASE A: unique claim is committed and independently visible before every provider GET', async () => {
      paymentTopic(); let first;
      provider.beforeFetch = async () => {
        const row = await event(); assert.equal(row.processingStatus, 'processing');
        assert.match(row.processingError, activePattern);
        first ||= row.processingError; assert.equal(row.processingError, first); await assertMutations(0);
      };
      await assertProcessed(await deliver()); assert.equal(calls.length, 7);
      assert.equal((await event()).processingError, null);
      assert.deepEqual((await business()).subscription.metadata.contract, subscription.metadata.contract);
    });
    await scenario('CASE B: delayed provider has no event lock or open PostgreSQL transaction', async () => {
      const entered = deferred(); const release = deferred();
      provider.beforeFetch = async kind => { if (kind === 'invoice') { entered.resolve(); await release.promise; } };
      const request = deliver(); await entered.promise;
      const independent = await pool.connect();
      try {
        const activity = (await admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE application_name=$1', [schema])).rows;
        assert.ok(activity.length > 0);
        assert.equal(activity.some(row => row.xact_start !== null || row.state === 'idle in transaction'), false);
        await independent.query('BEGIN');
        const locked = await independent.query('SELECT id FROM saas_subscription_events FOR UPDATE NOWAIT');
        assert.equal(locked.rowCount, 1); await independent.query('ROLLBACK');
      } finally { independent.release(); release.resolve(); }
      await assertProcessed(await request);
      t.diagnostic('PROVIDER_IO_DB_TRANSACTION_TEST=PASS; independent pg_stat_activity and FOR UPDATE NOWAIT');
    });
    await scenario('CASE C: active duplicate returns bounded 503 and does zero provider/business work', async () => {
      const entered = deferred(); const release = deferred();
      provider.beforeFetch = async kind => { if (kind === 'invoice') { entered.resolve(); await release.promise; } };
      const first = deliver(); await entered.promise; const before = await event();
      const start = performance.now();
      try {
        assert.equal((await deliver()).status, 503); assert.equal(calls.length, 2);
        assert.deepEqual(await event(), before); await assertMutations(0);
        assert.ok(performance.now() - start < 2000);
      } finally { release.resolve(); }
      await assertProcessed(await first);
    });
    await scenario('CASE D: UUID-B reclaim rejects late UUID-A finalization and every A business write', async () => {
      const entered = deferred(); const release = deferred(); let markerB;
      provider.beforeFetch = async kind => {
        if (kind !== 'invoice') return;
        if (calls.length === 2) { entered.resolve(); await release.promise; }
        else markerB = (await event()).processingError;
      };
      const workerA = deliver(); await entered.promise; const claimedA = await event();
      await stale();
      let finalB;
      try {
        await assertProcessed(await deliver()); finalB = await event();
        assert.match(markerB, activePattern); assert.notEqual(markerB, claimedA.processingError);
        const cas = await pool.query(`SELECT id FROM saas_subscription_events WHERE id=$1 AND "dedupeKey"=$2
          AND "processingStatus"='processing' AND "processingError"=$3`, [claimedA.id, claimedA.dedupeKey, claimedA.processingError]);
        assert.equal(cas.rowCount, 0);
      } finally { release.resolve(); }
      assert.equal((await workerA).status, 503); assert.deepEqual(await event(), finalB); await assertMutations(1);
    });
    await scenario('CASE E: new runtime reclaims failed v2 event with new UUID before provider retry', async () => {
      provider.error = { kind: 'invoice', status: 503 }; await assertRetryable(await deliver(), 'provider_5xx');
      const failed = await event(); assert.match(failed.processingError, /:provider_5xx$/);
      provider.error = null;
      provider.beforeFetch = async () => { const row = await event(); assert.match(row.processingError, activePattern);
        assert.notEqual(row.processingError.split(':')[2], failed.processingError.split(':')[2]); };
      await assertProcessed(await deliver()); assert.equal((await event()).id, failed.id);
    });
    await scenario('CASE F: deployed bridge blocks the exact v2 failed row and preserves its marker', async () => {
      provider.error = { kind: 'invoice', status: 503 }; await assertRetryable(await deliver(), 'provider_5xx');
      await bridgeRefuses();
    });
    await scenario('CASE G: lock and statement timeouts are installed before contended initial INSERT', async () => {
      const independent = await pool.connect(); const queries = [];
      fault.query = async (_client, sql) => { queries.push(sql); };
      const snapshot = service.__internal.buildWebhookEventSnapshot(payload, { signatureValid: true });
      try {
        await independent.query('BEGIN');
        await repository.insertSubscriptionEvent({ ...snapshot, raw: payload,
          dedupeKey: signedKey() }, independent);
        const start = performance.now(); assert.equal((await deliver()).status, 503);
        const elapsed = Math.round(performance.now() - start);
        assert.ok(elapsed >= 800 && elapsed < 2500, `contended INSERT took ${elapsed}ms`);
        const insert = queries.findIndex(sql => sql.includes('INSERT INTO saas_subscription_events'));
        assert.ok(insert >= 2); assert.match(queries[0], /SET LOCAL lock_timeout = '1000ms'/);
        assert.match(queries[1], /SET LOCAL statement_timeout = '2000ms'/);
        assert.equal(calls.length, 0); await assertMutations(0);
        t.diagnostic(`INSERT_CONTENTION_MAX_OBSERVED_MS=${elapsed}`);
      } finally { await independent.query('ROLLBACK'); independent.release(); }
    });
    await scenario('CASE H: shared 15s budget aborts actual HTTP body during third sequential read; cleanup is bounded', async () => {
      paymentTopic(); let active = 0; let aborted = 0; const rejections = [];
      const onUnhandled = error => rejections.push(error); process.on('unhandledRejection', onUnhandled);
      const http = require('node:http');
      const remote = http.createServer((req, res) => {
        const kind = req.url.startsWith('/v1/payments/') ? 'payment'
          : req.url.startsWith('/authorized_payments/search') ? 'search' : 'invoice';
        active++; let done = false;
        const timer = setTimeout(() => { done = true; res.end(JSON.stringify(provider[kind])); }, 6000);
        res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
        res.on('close', () => { clearTimeout(timer); active--; if (!done) aborted++; });
      });
      await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
      provider.httpBase = `http://127.0.0.1:${remote.address().port}`;
      let saved;
      try {
        const start = performance.now(); await assertRetryable(await deliver(), 'provider_timeout');
        const elapsed = Math.round(performance.now() - start); saved = await event();
        assert.match(saved.processingError, /:provider_timeout$/);
        assert.ok(elapsed >= 14500 && elapsed < 18000, `aggregate elapsed=${elapsed}`);
        for (let n = 0; n < 50 && active; n++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(active, 0); assert.equal(aborted, 1); assert.equal(calls.length, 6);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(await event(), saved); await assertMutations(0); assert.deepEqual(rejections, []);
        t.diagnostic(`AGGREGATE_TIMEOUT_TEST=PASS elapsedMs=${elapsed}; bodyAborted=${aborted}; outstanding=${active}; lateMutation=0`);
      } finally {
        remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
    for (const [label, status] of [['I', 'pending'], ['J', 'in_process'], ['K', 'rejected'], ['L', 'cancelled']]) {
      await scenario(`CASE ${label}: ${status} is durable normal no-action, HTTP 200, no repeated provider work`, async () => {
        provider.payment.status = status; await noAction(`payment_${status}`);
      });
    }
    await scenario('CASE M: pending N1=100 then approved N2=101 on the same resource applies business once', async () => {
      paymentTopic(); payload.id = 100; provider.payment.status = 'pending'; await noAction('payment_pending');
      const n1 = await event(); payload.id = 101; provider.payment.status = 'approved';
      await assertProcessed(await deliver()); const n2 = await event();
      assert.notEqual(n1.id, n2.id); assert.notEqual(n1.dedupeKey, n2.dedupeKey);
      assert.equal((await deliver()).body.duplicate, true); await assertMutations(1);
    });
    await scenario('CASE N: successful zero-match search is acknowledged, including weak Opturon metadata', async () => {
      paymentTopic(); provider.search = { results: [], paging: { total: 0, offset: 0, limit: 2 } };
      provider.payment.metadata = { subscription_id: subscription.id }; await noAction('authorized_invoice_not_found');
    });
    for (const [label, reason, error] of [
      ['O', 'provider_timeout', Object.assign(new Error('mock deadline'), { code: 'provider_timeout' })],
      ['P', 'provider_5xx', Object.assign(new Error('mock 5xx'), { status: 503 })],
      ['NETWORK', 'provider_network_error', new TypeError('fetch failed')],
      ['404', 'provider_not_found', Object.assign(new Error('mock 404'), { status: 404 })]
    ]) {
      await scenario(`CASE ${label}: search technical failure persists same claim UUID with ${reason}`, async () => {
        paymentTopic(); let claim;
        provider.beforeFetch = async kind => {
          claim ||= (await event()).processingError;
          if (kind === 'search') throw error;
        };
        await assertRetryable(await deliver(), reason); assert.equal((await event()).processingError, claim.replace('claim_active', reason));
      });
    }
    await scenario('CASE Q: one row total=1 offset=0 is only a candidate; canonical invoice is fetched', async () => {
      paymentTopic(); await assertProcessed(await deliver());
      assert.deepEqual(calls, ['/v1/payments/19951521071', '/authorized_payments/19951521071', '/preapproval/19951521071', '/preapproval_plan/19951521071', '/authorized_payments/search?payment_id=19951521071&offset=0&limit=2',
        '/authorized_payments/6114264375', '/preapproval/mp-1']);
    });
    for (const [label, total, offset, rows] of [
      ['R', 2, 0, 1], ['S', undefined, 0, 1], ['T', 1, 20, 1], ['V', 1, 0, 0],
      ['OFFSET_MISSING', 1, undefined, 1], ['LIMIT_CONTRADICTION', 1, 0, 1]
    ]) {
      await scenario(`CASE ${label}: contradictory/absent pagination never authorizes`, async () => {
        paymentTopic(); provider.search.paging = { total, offset, limit: label === 'LIMIT_CONTRADICTION' ? 0 : 2 };
        if (!rows) provider.search.results = [];
        await decision('manual_review', 'provider_relationship_unproven'); assert.equal(calls.length, 5);
      });
    }
    await scenario('CASE U: exact empty first page is ordinary terminal zero-match', async () => {
      paymentTopic(); provider.search = { results: [], paging: { total: 0, offset: 0 } }; await noAction('authorized_invoice_not_found');
    });
    await scenario('CASE W: search result Payment mismatch cannot authorize canonical chain', async () => {
      paymentTopic(); provider.search.results[0].payment.id = 'wrong';
      await decision('contract_rejected', 'provider_identity_mismatch'); assert.equal(calls.length, 5);
    });
    await scenario('CASE X: full approved canonical chain applies once and preserves immutable contract', async () => {
      await assertProcessed(await deliver()); assert.equal((await deliver()).body.duplicate, true); await assertMutations(1);
      assert.deepEqual((await business()).subscription.metadata.contract, subscription.metadata.contract);
    });
    for (const [label, mutate, reason] of [
      ['Y', () => { provider.payment.transaction_amount = 1; }, 'contract_amount_mismatch'],
      ['Z', () => { provider.payment.currency_id = 'USD'; }, 'contract_currency_mismatch'],
      ['AA', () => { provider.preapproval.auto_recurring.frequency = 2; }, 'contract_interval_mismatch']
    ]) await scenario(`CASE ${label}: proven mismatch is atomically contract_rejected`, async () => {
      mutate(); await decision('contract_rejected', reason);
    });
    await scenario('CASE AB: missing cadence is atomically manual_review', async () => {
      delete provider.preapproval.auto_recurring.frequency; await decision('manual_review', 'provider_relationship_unproven');
    });
    await scenario('CASE AC: cross-tenant external reference is rejected without retargeting', async () => {
      provider.preapproval.external_reference = `opturon:other-tenant:${subscription.id}`;
      await decision('contract_rejected', 'external_reference_mismatch');
    });
    for (const status of ['refunded', 'charged_back', 'future_unknown']) await scenario(`CASE AD: ${status} cannot enter success gate`, async () => {
      provider.payment.status = status; await decision('manual_review', 'unsupported_charge_type');
    });
    await scenario('CASE AE: payload cannot supply a claim UUID or outcome; raw remains unchanged', async () => {
      const forged = `billing_contract_v2:claim:${crypto.randomUUID()}:claim_active`;
      payload.processingError = forged; payload.contractOutcome = { type: 'manual_review' };
      provider.beforeFetch = async () => { assert.notEqual((await event()).processingError, forged); };
      await assertProcessed(await deliver()); assert.deepEqual((await event()).raw, payload);
    });
    await scenario('CASE AF: malformed failed marker has no ownership authority and cannot bypass proof', async () => {
      const snapshot = service.__internal.buildWebhookEventSnapshot(payload);
      const invalid = 'billing_contract_v2:claim:not-a-uuid:claim_active';
      assert.equal(markerProtocol.isBillingContractV2Marker(invalid), false);
      await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: signedKey(),
        raw: payload, processingStatus: 'failed', processingError: invalid });
      delete provider.preapproval.auto_recurring.frequency;
      provider.beforeFetch = async () => { assert.match((await event()).processingError, activePattern); };
      await decision('manual_review', 'provider_relationship_unproven');
    });
    await scenario('CASE AG: invalid signature is rejected before claim, event insert and all GETs', async () => {
      assert.equal((await deliver(false)).status, 401); assert.equal(await event(), undefined);
      assert.equal(calls.length, 0); await assertMutations(0);
    });
    for (const status of ['processed', 'ignored']) await scenario(`CASE AH: ${status} remains terminal even with marked processingError`, async () => {
      const snapshot = service.__internal.buildWebhookEventSnapshot(payload);
      await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: signedKey(),
        raw: payload, processingStatus: status, processingError: `billing_contract_v2:claim:${crypto.randomUUID()}:claim_active` });
      const before = await event(); assert.equal((await deliver()).body.duplicate, true);
      assert.deepEqual(await event(), before); assert.equal(calls.length, 0); await assertMutations(0);
    });
    for (const reason of ['provider_timeout', 'provider_5xx', 'claim_active']) await scenario(`CASE AI: candidate ${reason} is safe under actual deployed bridge`, async () => {
      if (reason === 'claim_active') {
        const snapshot = service.__internal.buildWebhookEventSnapshot(payload);
        await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: signedKey(),
          raw: payload, processingStatus: 'processing', processingError: `billing_contract_v2:claim:${crypto.randomUUID()}:claim_active` });
      } else {
        provider.beforeFetch = () => { throw Object.assign(new Error('mock'), reason === 'provider_timeout' ? { code: reason } : { status: 503 }); };
        await assertRetryable(await deliver(), reason); assert.match((await event()).processingError, new RegExp(`:${reason}$`));
      }
      await bridgeRefuses();
    });
    for (const identity of [undefined, {}, [], '', 'bad:id', 1.5]) await scenario(`Unsigned notification identity ${JSON.stringify(identity)} has no authority`, async () => {
      if (identity === undefined) delete payload.id; else payload.id = identity; await assertProcessed(await deliver()); assert.equal(calls.length, 6);
    });
    await scenario('Historical unmarked fresh processing is bounded; only stale recovery runs 6C', async () => {
      const snapshot = service.__internal.buildWebhookEventSnapshot(payload);
      await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: signedKey(), raw: payload, processingStatus: 'processing' });
      const before = await event(); assert.equal((await deliver()).status, 503); assert.equal(calls.length, 0);
      assert.deepEqual(await event(), before); await stale(); await assertProcessed(await deliver());
    });
    await scenario('Finalization re-reads binding after preliminary proof; changed local authority cannot apply', async () => {
      let cas = 0;
      fault.query = async (_client, sql) => {
        if (sql.includes('AND "processingError" = $3 FOR UPDATE') && ++cas === 1) {
          await repository.updateSaasSubscriptionById(subscription.id, { mercadoPagoPreapprovalId: 'changed-after-prepare' });
          await pool.query('TRUNCATE mutation_audit');
        }
      };
      const response = await deliver(); assert.equal(response.status, 200);
      assert.equal((await event()).contractOutcome.reasonCode, 'provider_identity_mismatch'); await assertMutations(0);
    });
    await scenario('Normal no-action completion SQL failure is atomic and retains a technical retry marker', async () => {
      provider.payment.status = 'pending';
      fault.query = async (client, sql, params) => {
        if (sql.startsWith('UPDATE saas_subscription_events') && params[2] === 'ignored') {
          fault.query = null; await client.query('SELECT 1/0');
        }
      };
      await assertRetryable(await deliver(), 'db_retryable'); assert.match((await event()).processingError, /:db_retryable$/);
      await noAction('payment_pending');
    });
    await scenario('Late failed worker cannot overwrite the replacement worker terminal result', async () => {
      const entered = deferred(); const release = deferred();
      provider.beforeFetch = async kind => {
        if (kind === 'invoice' && calls.length === 2) {
          entered.resolve(); await release.promise; throw new TypeError('late network failure');
        }
      };
      const workerA = deliver(); await entered.promise; await stale();
      let finalB;
      try { await assertProcessed(await deliver()); finalB = await event(); }
      finally { release.resolve(); }
      assert.equal((await workerA).status, 503); assert.deepEqual(await event(), finalB); await assertMutations(1);
    });
    await scenario('An active candidate claim is protected by the deployed bridge during provider delay', async () => {
      const entered = deferred(); const release = deferred();
      provider.beforeFetch = async kind => { if (kind === 'invoice') { entered.resolve(); await release.promise; } };
      const request = deliver(); await entered.promise;
      try { await bridgeRefuses(); } finally { release.resolve(); }
      await assertProcessed(await request);
    });
    assert.equal(claims.CLAIM_STALE_AFTER_MS, 30000); assert.equal(claims.PROVIDER_BUDGET_MS, 15000);
    assert.ok(claims.CLAIM_STALE_AFTER_MS > claims.PROVIDER_BUDGET_MS + 2 * claims.STATEMENT_TIMEOUT_MS);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    global.fetch = originalFetch;
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const [id, previous] of modules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
  }
});