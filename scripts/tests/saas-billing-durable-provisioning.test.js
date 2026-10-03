const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const root = path.resolve(__dirname, '../..');
const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), 'utf8');
const originalFetch = global.fetch;
const secret = 'local-test-webhook-secret';
const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const input = { tenantId: 'tenant-a', planCode: 'inicial', payerEmail: 'payer@example.invalid' };
const modules = new Map();

function stub(name, exports) {
  const resolved = require.resolve(file(name));
  if (!modules.has(resolved)) modules.set(resolved, require.cache[resolved]);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

async function openDatabase() {
  const url = process.env.BILLING_TEST_DATABASE_URL;
  if (!url) {
    const { PGlite } = require('@electric-sql/pglite');
    const db = new PGlite();
    return {
      mode: 'PGlite', query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql), close: () => db.close(),
      transaction: (fn, hooks) => db.transaction(async (tx) => {
        const result = await fn(tx);
        await hooks.beforeCommit();
        return result;
      }).then(async (result) => { await hooks.afterCommit(); return result; })
    };
  }
  // Never accept production credentials or an arbitrary DB target for these tests.
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'billing_test');
  assert.equal(parsed.password, '');
  const { Pool } = require('pg');
  const schema = `billing_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
  return {
    mode: 'PostgreSQL (independent connections)',
    query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql),
    transaction: async (fn, hooks) => {
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await hooks.beforeCommit();
        await client.query('COMMIT');
        committed = true;
        await hooks.afterCommit();
        return result;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  };
}

test('durable subscription creation: real SQL, mocked provider, failure injection', async (t) => {
  const db = await openDatabase();
  t.diagnostic(`SQL_ENGINE=${db.mode}`);
  let fault = {};
  let trace = [];
  let provider = {};
  let httpServer;
  const query = async (client, sql, params, tx = {}) => {
    if (sql.includes('INSERT INTO saas_subscriptions')) tx.phase = 'reserve';
    if (sql.includes("SET \"provisioningState\" = 'provider_call_started'")) tx.phase = 'claim';
    if (params && params[16] === 'provider_created') tx.phase = 'provider';
    if (params && params[16] === 'ready') tx.phase = 'finish';
    trace.push({ sql, params, phase: tx.phase });
    if (fault.beforeQuery) await fault.beforeQuery(sql, params, tx);
    return client.query(sql, params);
  };
  stub('src/db/client.js', {
    query: (sql, params) => query(db, sql, params),
    withTransaction: (fn) => {
      const tx = {};
      return db.transaction((client) => fn({ query: (sql, params) => query(client, sql, params, tx) }), {
        beforeCommit: async () => { if (fault.beforeCommit) await fault.beforeCommit(tx.phase); },
        afterCommit: async () => {
          trace.push({ commit: tx.phase });
          if (fault.afterCommit) await fault.afterCommit(tx.phase);
        }
      });
    }
  });
  stub('src/config/env.js', { mercadoPagoWebhookSecret: secret, portalInternalKey: 'local-test-key', nodeEnv: 'production' });
  stub('src/utils/logger.js', { logInfo() {}, logWarn() {}, logError() {} });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail: () => { throw new Error('email_forbidden_in_test'); }
  });
  // Loading the production controller must not load unrelated business modules.
  for (const name of ['portal-active-tenant', 'tenant-policy', 'transfer-payment-validation',
    'ai-assist', 'meta-embedded-readiness', 'partners', 'partner-client-requests', 'partner-recruitment-applications']) {
    stub(`src/services/${name}.service.js`, {});
  }
  const realMp = require(file('src/services/mercado-pago.service.js'));
  stub('src/services/mercado-pago.service.js', require('./helpers/billing-v2-fixture').canonicalReads({
    ...realMp,
    createPreapproval: async (payload) => {
      provider.calls.push(payload);
      // A separate DB connection must see BOTH the reservation and committed claim.
      const row = (await db.query('SELECT * FROM saas_subscriptions WHERE "externalReference" = $1', [payload.externalReference])).rows[0];
      assert.ok(row, 'local identity must be committed BEFORE provider POST');
      assert.equal(row.provisioningState, 'provider_call_started');
      assert.ok(row.providerCallStartedAt);
      assert.equal(payload.amount, Number(row.amount));
      assert.equal(payload.currency, row.currency);
      const result = {
        id: `mp-${provider.calls.length}`, external_reference: payload.externalReference,
        payer_email: payload.payerEmail, status: 'pending', init_point: 'https://checkout.example.invalid/subscription',
        auto_recurring: { transaction_amount: payload.amount, currency_id: payload.currency, frequency: 1, frequency_type: 'months' }
      };
      provider.remote = result;
      if (provider.onCreate) return provider.onCreate(payload, result);
      return result;
    },
    getPreapproval: async () => { provider.gets += 1; return provider.remote; },
    getPayment: async () => provider.payment,
    getAuthorizedPayment: async () => ({ id: 'invoice-1', preapproval_id: provider.remote.id, status: 'processed',
      transaction_amount: 40600, currency_id: 'ARS', payment: { id: provider.payment.id } }),
    searchAuthorizedPaymentsByPaymentId: async () => ({ paging: { total: 1, offset: 0, limit: 2 },
      results: [{ id: 'invoice-1', payment: { id: provider.payment.id } }] })
  }, { getPayment: 'payment-1' }));
  global.fetch = (url, ...args) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'real provider network calls are forbidden');
    return originalFetch(url, ...args);
  };
  const repository = require(file('src/repositories/saas-subscriptions.repository.js'));
  const service = require(file('src/services/saas-billing.service.js'));
  const { postAdminBillingSubscription } = require(file('src/controllers/admin.controller.js'));
  const { postMercadoPagoWebhook } = require(file('src/controllers/mercadopago.controller.js'));
  const { requirePortalInternalAuth } = require(file('src/middlewares/portal-internal-auth.middleware.js'));
  const app = express();
  app.use(express.json());
  app.post('/api/admin/billing/subscriptions', requirePortalInternalAuth, postAdminBillingSubscription);
  app.post('/api/webhooks/mercadopago', postMercadoPagoWebhook);
  httpServer = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  async function request(payload = input) {
    const res = await fetch(`${base}/api/admin/billing/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-key': 'local-test-key' },
      body: JSON.stringify(payload)
    });
    return { status: res.status, body: await res.json() };
  }
  async function reset() {
    fault = {}; trace = []; provider = { calls: [], gets: 0 };
    await db.exec('TRUNCATE saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await db.query(`INSERT INTO clinics (id, "externalTenantId") VALUES ($1,'tenant-a'),($2,'tenant-b')`, [tenantA, tenantB]);
  }
  async function rows() { return (await db.query('SELECT * FROM saas_subscriptions ORDER BY "createdAt", id')).rows; }
  async function seed(overrides = {}) {
    const id = crypto.randomUUID();
    return repository.insertSaasSubscription({
      id, clinicId: tenantA, externalTenantId: 'tenant-a', planCode: 'inicial', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending',
      externalReference: `opturon:tenant-a:${id}`, mercadoPagoPayerEmail: input.payerEmail,
      metadata: { plan: { label: 'Plan Inicial', amount: 40600, currency: 'ARS' } }, ...overrides
    });
  }
  async function webhook({ valid = true, topic = 'subscription_preapproval' } = {}) {
    const dataId = topic === 'payment' ? 'payment-1' : provider.remote.id;
    const requestId = crypto.randomUUID();
    const ts = '1727300000';
    const digest = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    const res = await fetch(`${base}/api/webhooks/mercadopago?data.id=${dataId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` },
      body: JSON.stringify({ id: crypto.randomUUID(), type: topic, action: 'updated', data: { id: dataId } })
    });
    return { status: res.status, body: await res.json() };
  }
  const once = (match) => {
    let fired = false;
    return (...args) => { if (!fired && match(...args)) { fired = true; throw new Error('injected_failure'); } };
  };
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  try {
    await db.exec(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    await db.exec(read('db/migrations/050_saas_subscriptions_phase1.sql'));
    // Historical duplicates, including NULL provider IDs, must survive migration.
    await db.query(`INSERT INTO clinics (id, "externalTenantId") VALUES ($1,'legacy')`, [tenantA]);
    await db.exec(`INSERT INTO saas_subscriptions ("clinicId", "externalTenantId", "planCode", amount, "externalReference")
      SELECT '${tenantA}', 'legacy', 'inicial', 40600, 'legacy-' || n FROM generate_series(1,2) n`);
    await db.exec(read('db/migrations/085_saas_subscription_provisioning.sql'));
    await db.exec(read('db/migrations/085_saas_subscription_provisioning.sql'));
    await db.exec(read('db/migrations/086_saas_subscription_event_contract_outcome.sql'));
    await db.exec(read('db/migrations/087_saas_billing_runtime_state.sql'));
    await db.exec(read('db/migrations/088_saas_billing_effects_reconciliation.sql'));
    await db.exec("WITH activation AS (SELECT clock_timestamp() AS at) UPDATE saas_billing_runtime_state SET generation=2,\"billingContractV2CutoverActive\"=true,\"cutoverAt\"=at,\"autoApplyNotBefore\"=at+interval '24 hours' FROM activation");
    assert.equal((await rows()).length, 2);
    assert.ok((await rows()).every((row) => row.provisioningState === null));
    await assert.rejects(db.exec(`UPDATE saas_subscriptions SET "provisioningState" = 'invalid'`));

    await scenario('CASE A: normal create commits local identity and claim before provider, then ready', async () => {
      const result = await request({ ...input, amount: 1, currency: 'USD' });
      assert.equal(result.status, 201);
      assert.equal(result.body.data.subscription.provisioningState, 'ready');
      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0].amount, 40600);
      assert.equal(provider.calls[0].currency, 'ARS');
      assert.equal((await rows()).length, 1);
      assert.deepEqual(trace.filter((event) => event.commit).map((event) => event.commit), ['reserve', 'claim', 'provider', 'finish']);
    });
    await scenario('CASE B: sequential duplicate reuses the persisted checkout', async () => {
      const first = await request(); const replay = await request();
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.subscription.id, first.body.data.subscription.id);
      assert.equal(replay.body.data.reused, true);
      assert.equal(provider.calls.length, 1); assert.equal((await rows()).length, 1);
    });
    await scenario('CASE C: concurrent HTTP requests serialize with one reservation and one POST', async () => {
      let release;
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      provider.onCreate = async (_payload, result) => { entered(); await gate; return result; };
      const first = request();
      const second = request();
      await started;
      // Additional simultaneous requests must complete while the provider is blocked.
      const others = await Promise.all(Array.from({ length: 4 }, () => request()));
      assert.ok(others.every((r) => r.status === 409));
      release();
      const results = await Promise.all([first, second]);
      assert.ok(results.some((r) => r.status === 201));
      assert.equal(provider.calls.length, 1);
      assert.equal((await rows()).length, 1);
      t.diagnostic('CONCURRENT_REQUEST_COUNT=6 LOCAL_RESERVATIONS_CREATED=1 MP_CREATE_PREAPPROVAL_CALL_COUNT=1 LIVE_SUBSCRIPTIONS_CREATED=1');
    });
    await scenario('CASE D: legacy pending with no provider ID is not safe to resume', async () => {
      await seed(); assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 0);
    });
    await scenario('CASE E: existing active blocks creation', async () => {
      await seed({ localStatus: 'active' }); assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 0);
    });
    await scenario('CASE F: paused, payment_failed and suspended remain non-terminal', async () => {
      for (const localStatus of ['paused', 'payment_failed', 'suspended']) {
        await reset(); await seed({ localStatus });
        assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 0);
      }
    });
    await scenario('CASE G: genuinely canceled permits a new durable subscription', async () => {
      const old = await seed({ localStatus: 'canceled' });
      const result = await request(); assert.equal(result.status, 201);
      assert.notEqual(result.body.data.subscription.id, old.id);
      assert.equal(provider.calls.length, 1); assert.equal((await rows()).filter((r) => r.localStatus !== 'canceled').length, 1);
    });
    await scenario('CASE H: different tenants create independently', async () => {
      let entered;
      let release;
      const started = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      provider.onCreate = async (payload, result) => {
        if (payload.externalReference.includes('tenant-a')) { entered(); await gate; }
        return result;
      };
      const first = request(); await started;
      const second = await request({ ...input, tenantId: 'tenant-b' });
      assert.equal(second.status, 201); release(); assert.equal((await first).status, 201);
      assert.equal(provider.calls.length, 2); assert.equal((await rows()).length, 2);
    });
    await scenario('CASE I: different plan or payer is a conflict, without implicit upgrade', async () => {
      await request();
      assert.equal((await request({ ...input, planCode: 'empresa' })).status, 409);
      assert.equal((await request({ ...input, payerEmail: 'other@example.invalid' })).status, 409);
      assert.equal(provider.calls.length, 1);
    });
    await scenario('CASE J: reservation INSERT or COMMIT failure prevents every provider call', async () => {
      fault.beforeQuery = once((sql) => sql.includes('INSERT INTO saas_subscriptions'));
      assert.equal((await request()).status, 500); assert.equal(provider.calls.length, 0); assert.equal((await rows()).length, 0);
      fault = { beforeCommit: once((phase) => phase === 'reserve') };
      assert.equal((await request()).status, 500); assert.equal(provider.calls.length, 0); assert.equal((await rows()).length, 0);
    });
    await scenario('CASE K: crash after reservation commit resumes the SAME reservation', async () => {
      fault.afterCommit = once((phase) => phase === 'reserve');
      assert.equal((await request()).status, 500);
      const [reserved] = await rows(); assert.equal(reserved.provisioningState, 'reserved');
      assert.equal(provider.calls.length, 0);
      const replay = await request(); assert.equal(replay.status, 201);
      assert.equal(replay.body.data.subscription.id, reserved.id); assert.equal(provider.calls.length, 1);
    });
    await scenario('CASE L: ambiguous provider outcome blocks all replays', async () => {
      provider.onCreate = () => { throw new Error('network_timeout_after_send'); };
      assert.equal((await request()).status, 500);
      assert.equal((await rows())[0].provisioningState, 'reconciliation_required');
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 1);
    });
    await scenario('WINDOW B: crash after committed claim but before POST never retries POST', async () => {
      fault.afterCommit = once((phase) => phase === 'claim');
      assert.equal((await request()).status, 500); assert.equal(provider.calls.length, 0);
      assert.equal((await rows())[0].provisioningState, 'provider_call_started');
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 0);
    });
    await scenario('CASE M: provider success followed by provider-ID DB failure keeps durable correlation', async () => {
      fault.beforeQuery = once((_sql, params) => params && params[16] === 'provider_created');
      assert.equal((await request()).status, 500);
      const [row] = await rows(); assert.equal(row.mercadoPagoPreapprovalId, null);
      assert.equal(row.externalReference, provider.remote.external_reference);
      assert.equal(row.provisioningState, 'provider_call_started');
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 1);
    });
    await scenario('CASE N: only a valid signed webhook recovers the row from CASE M', async () => {
      fault.beforeCommit = once((phase) => phase === 'provider');
      assert.equal((await request()).status, 500);
      const id = (await rows())[0].id;
      const before = trace.length;
      assert.equal((await webhook({ valid: false })).status, 401);
      assert.equal(provider.gets, 0); assert.equal(trace.length, before);
      provider.remote.status = 'authorized';
      const result = await webhook(); assert.equal(result.status, 200); assert.equal(result.body.error, undefined);
      const [recovered] = await rows();
      assert.equal(recovered.id, id); assert.equal(recovered.provisioningState, 'ready');
      assert.equal(recovered.mercadoPagoPreapprovalId, provider.remote.id); assert.equal(recovered.localStatus, 'active');
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 1);
    });
    await scenario('known provider ID survives tenant snapshot failure and resumes locally', async () => {
      fault.beforeQuery = once((sql) => sql.includes('SET settings ='));
      assert.equal((await request()).status, 500);
      const [row] = await rows(); assert.equal(row.provisioningState, 'provider_created'); assert.ok(row.mercadoPagoPreapprovalId);
      assert.equal((await request()).status, 201); assert.equal(provider.calls.length, 1);
      assert.equal((await rows())[0].provisioningState, 'ready');
    });
    await scenario('webhook arriving before create completion must not regress active state', async () => {
      provider.onCreate = async (_payload, result) => {
        provider.remote = { ...result, status: 'authorized' };
        assert.equal((await webhook()).body.error, undefined);
        return result;
      };
      assert.equal((await request()).status, 201);
      assert.equal((await rows())[0].localStatus, 'active'); assert.equal(provider.calls.length, 1);
    });
    await scenario('payment webhook can recover a missing provider ID using the durable external reference', async () => {
      fault.beforeCommit = once((phase) => phase === 'provider');
      await request(); provider.remote.status = 'authorized';
      provider.payment = { date_created: new Date().toISOString(), id: 'payment-1', status: 'approved', preapproval_id: provider.remote.id, external_reference: provider.remote.external_reference,
        transaction_amount: 40600, currency_id: 'ARS' };
      assert.equal((await webhook({ topic: 'payment' })).body.error, undefined);
      const [row] = await rows(); assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, provider.remote.id);
      assert.equal(provider.calls.length, 1);
    });
    await scenario('historical duplicate non-terminal rows fail closed without deletion', async () => {
      await seed(); await seed({ planCode: 'empresa' });
      const result = await request(); assert.equal(result.status, 409);
      assert.equal(result.body.error, 'subscription_multiple_non_terminal'); assert.equal(provider.calls.length, 0);
      assert.equal((await rows()).length, 2);
    });
    await scenario('an older live subscription is not hidden by a newer canceled one', async () => {
      await seed({ localStatus: 'active' }); await seed({ localStatus: 'canceled' });
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 0);
    });
    await scenario('malformed success and reconciliation-write failure remain fail-closed', async () => {
      provider.onCreate = () => ({});
      fault.beforeQuery = once((sql) => sql.includes("SET \"provisioningState\" = 'reconciliation_required'"));
      assert.equal((await request()).status, 500);
      assert.equal((await rows())[0].provisioningState, 'provider_call_started');
      assert.equal((await request()).status, 409); assert.equal(provider.calls.length, 1);
    });
    await scenario('tenant validation and internal authentication precede any reservation', async () => {
      assert.equal((await request({ ...input, tenantId: 'unknown' })).status, 404);
      const res = await fetch(`${base}/api/admin/billing/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(res.status, 401); assert.equal((await rows()).length, 0); assert.equal(provider.calls.length, 0);
    });
    await scenario('static guard: all runtime INSERTs are behind the serialized reservation service', async () => {
      const source = read('src/services/saas-billing.service.js');
      assert.ok(source.indexOf('await insertSaasSubscription(') < source.indexOf('preapproval = await createPreapproval('));
      assert.match(source, /findClinicByExternalTenantId\(tenantId, client, \{ forUpdate: true \}\)/);
      const repoSource = read('src/repositories/saas-subscriptions.repository.js');
      assert.match(repoSource, /WHERE id = \$1::uuid AND "provisioningState" = 'reserved'/);
      assert.match(repoSource, /"mercadoPagoPreapprovalId" IS NULL/);
    });
  } finally {
    global.fetch = originalFetch;
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await db.close();
    for (const [name, previous] of modules) {
      if (previous) require.cache[name] = previous;
      else delete require.cache[name];
    }
  }
});
