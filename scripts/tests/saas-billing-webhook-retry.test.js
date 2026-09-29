const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '../..');
const secret = 'local-only-webhook-secret';
const originalFetch = global.fetch;
const modules = new Map();
function stub(name, exports) {
  const id = require.resolve(path.join(root, name));
  modules.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

test('BILL-005: signed HTTP deliveries, real PostgreSQL locks and atomic completion', async (t) => {
  // Fail rather than silently substituting a single-connection concurrency mock.
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `webhook_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  let fault = {};
  let provider = {};
  let logs = [];
  let server;
  let subscription;
  let payload;
  const sensitiveError = 'SELECT secret_sql token=DO_NOT_LEAK provider_body=private';
  async function query(client, sql, params) {
    if (fault.beforeQuery) await fault.beforeQuery(client, sql, params);
    return client.query(sql, params);
  }
  stub('src/db/client.js', {
    query: (sql, params) => query(pool, sql, params),
    withTransaction: async (fn) => {
      const client = await pool.connect();
      let committed = false;
      try {
        if (fault.beforeBegin) await fault.beforeBegin();
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => query(client, sql, params) });
        if (fault.beforeCommit) await fault.beforeCommit(client);
        await client.query('COMMIT');
        committed = true;
        if (fault.afterCommit) await fault.afterCommit();
        return result;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  });
  stub('src/config/env.js', { mercadoPagoWebhookSecret: secret, nodeEnv: 'production' });
  const log = (event, fields) => {
    logs.push({ event, fields });
    if (fault.logEvent === event) throw new Error(sensitiveError);
  };
  stub('src/utils/logger.js', { logInfo: log, logWarn: log, logError: log });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  const realProvider = require(path.join(root, 'src/services/mercado-pago.service.js'));
  stub('src/services/mercado-pago.service.js', {
    ...realProvider,
    createPreapproval() { throw new Error('provider_write_forbidden'); },
    getPreapproval: async () => {
      provider.gets += 1;
      if (provider.onGet) return provider.onGet();
      return provider.remote;
    },
    getPayment: async () => {
      provider.paymentGets += 1;
      if (provider.onPayment) return provider.onPayment();
      return provider.payment;
    }
  });
  global.fetch = (value, ...args) => {
    assert.equal(new URL(value).hostname, '127.0.0.1', 'external requests forbidden');
    return originalFetch(value, ...args);
  };
  const repository = require(path.join(root, 'src/repositories/saas-subscriptions.repository.js'));
  const service = require(path.join(root, 'src/services/saas-billing.service.js'));
  const app = express();
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (fault.response && body.success === true) {
        fault.response = false;
        throw new Error(sensitiveError);
      }
      return json(body);
    };
    next();
  });
  app.use('/api/webhooks/mercadopago', require(path.join(root, 'src/routes/mercadopago-webhook.routes.js')));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const clinicId = '00000000-0000-4000-8000-000000000001';
  async function deliver({ valid = true, body = JSON.stringify(payload) } = {}) {
    const requestId = crypto.randomUUID();
    const dataId = payload.data.id;
    const ts = '1727300000';
    const digest = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${dataId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    fault = {}; provider = { gets: 0, paymentGets: 0 }; logs = [];
    await pool.query('TRUNCATE mutation_audit, saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query(`INSERT INTO clinics (id,"externalTenantId") VALUES ($1,'tenant-test')`, [clinicId]);
    const id = crypto.randomUUID();
    subscription = await repository.insertSaasSubscription({
      id, clinicId, externalTenantId: 'tenant-test', planCode: 'inicial', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: 'mp-1',
      externalReference: `opturon:tenant-test:${id}`
    });
    provider.remote = { id: 'mp-1', status: 'authorized', external_reference: subscription.externalReference,
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS' } };
    provider.payment = { id: 'pay-1', status: 'approved', preapproval_id: 'mp-1', external_reference: subscription.externalReference };
    payload = { id: 'notice-1', type: 'subscription_preapproval', action: 'updated', data: { id: 'mp-1' } };
  }
  async function event() { return (await pool.query('SELECT * FROM saas_subscription_events')).rows[0]; }
  async function mutationCounts() {
    const rows = (await pool.query('SELECT kind,count(*)::int AS n FROM mutation_audit GROUP BY kind')).rows;
    return Object.fromEntries(['subscription', 'tenant'].map(kind => [kind, rows.find(row => row.kind === kind)?.n || 0]));
  }
  async function assertMutations(n) { assert.deepEqual(await mutationCounts(), { subscription: n, tenant: n }); }
  function retryable(response) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false, error: 'webhook_processing_failed' });
  }
  const scenario = (name, run) => t.test(name, async () => { await reset(); await run(); });
  const once = (fn) => {
    let fired = false;
    return async (...args) => { if (!fired) { fired = true; return fn(...args); } };
  };
  function failSqlWhen(match) {
    let fired = false;
    fault.beforeQuery = async (client, sql, params) => {
      if (!fired && match(sql, params)) { fired = true; await client.query('SELECT 1/0'); }
    };
  }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
    }
    // Transactional trigger counters prove committed effects, including rollback windows.
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_webhook_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW
        EXECUTE FUNCTION count_webhook_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW
        EXECUTE FUNCTION count_webhook_mutation('tenant');`);
    t.diagnostic('SQL_ENGINE=PostgreSQL independent connections; provider mocked; production inaccessible');

    await scenario('A: full success commits billing, tenant and processed together', async () => {
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).processingStatus, 'processed');
      await assertMutations(1);
      assert.equal((await repository.findSaasSubscriptionById(subscription.id)).localStatus, 'active');
    });
    await scenario('B: invalid signature has no event, provider or business effect', async () => {
      assert.equal((await deliver({ valid: false })).status, 401);
      assert.equal(provider.gets, 0); assert.equal(await event(), undefined); await assertMutations(0);
    });
    await scenario('C/E/H: provider fails after event insert, identical retry processes once', async () => {
      provider.onGet = () => { throw new Error(sensitiveError); };
      retryable(await deliver()); const failed = await event();
      assert.equal(failed.processingStatus, 'failed');
      assert.equal(failed.processingError, 'webhook_processing_failed'); await assertMutations(0);
      provider.onGet = null;
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).id, failed.id); await assertMutations(1);
      assert.equal(JSON.stringify(logs).includes(sensitiveError), false);
    });
    await scenario('D: real aborted SQL transaction recovers with same dedupe identity', async () => {
      failSqlWhen(sql => sql.startsWith('UPDATE saas_subscriptions'));
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'failed'); await assertMutations(0);
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('F: completed duplicate does not fetch provider or mutate billing again', async () => {
      assert.equal((await deliver()).status, 200); const gets = provider.gets;
      const replay = await deliver(); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
      assert.equal(provider.gets, gets); await assertMutations(1);
    });
    for (const firstFails of [false, true]) {
      await scenario(`G: simultaneous identical delivery, first ${firstFails ? 'fails' : 'succeeds'}`, async () => {
        let release; let started; let secondAtInsert;
        const gate = new Promise(r => { release = r; });
        const entered = new Promise(r => { started = r; });
        const contender = new Promise(r => { secondAtInsert = r; });
        let inserts = 0;
        // PostgreSQL may already serialize the second delivery's unique-index
        // conflict before it reaches FOR UPDATE. Release only after both arrive.
        fault.beforeQuery = async (_c, sql) => { if (sql.includes('INSERT INTO saas_subscription_events') && ++inserts === 2) secondAtInsert(); };
        provider.onGet = async () => {
          if (provider.gets === 1) { started(); await gate; if (firstFails) throw new Error(sensitiveError); }
          return provider.remote;
        };
        const first = deliver(); await entered;
        const second = deliver();
        try { await contender; } finally { release(); }
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, firstFails ? 503 : 200); assert.equal(b.status, 200);
        assert.equal(b.body.duplicate, !firstFails); await assertMutations(1);
        assert.equal((await event()).processingStatus, 'processed');
      });
    }
    await scenario('I: event insertion DB failure stays retryable and does not call provider', async () => {
      failSqlWhen(sql => sql.includes('INSERT INTO saas_subscription_events'));
      retryable(await deliver()); assert.equal(await event(), undefined); assert.equal(provider.gets, 0);
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('I/H: failure before processing leaves received event reprocessable', async () => {
      fault.beforeBegin = once(() => { throw new Error(sensitiveError); });
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'received');
      assert.equal(provider.gets, 0); assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('J: unsupported event ignored durably without provider or business effects', async () => {
      payload.type = 'unsupported';
      const result = await deliver(); assert.equal(result.status, 200); assert.equal(result.body.ignored, true);
      assert.equal((await event()).processingStatus, 'ignored');
      assert.equal((await deliver()).body.duplicate, true); assert.equal(provider.gets, 0); await assertMutations(0);
    });
    await scenario('K: valid webhook recovers BILL-004 durable reservation', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1 WHERE id=$2', ['provider_call_started', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      assert.equal((await deliver({ valid: false })).status, 401); assert.equal(provider.gets, 0);
      assert.equal((await deliver()).status, 200);
      const row = await repository.findSaasSubscriptionById(subscription.id);
      assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, 'mp-1');
      await assertMutations(1);
    });
    for (const payment of [false, true]) {
      await scenario(`partial mutation: tenant failure rolls back ${payment ? 'payment' : 'preapproval'} update`, async () => {
        if (payment) { payload.type = 'payment'; payload.data.id = 'pay-1'; }
        failSqlWhen(sql => sql.includes('SET settings ='));
        retryable(await deliver()); await assertMutations(0);
        assert.equal((await repository.findSaasSubscriptionById(subscription.id)).localStatus, 'pending');
        assert.equal((await event()).processingStatus, 'failed');
        assert.equal((await deliver()).status, 200); await assertMutations(1);
      });
    }
    await scenario('completion marker SQL failure rolls back already executed business SQL', async () => {
      failSqlWhen((sql, params) => sql.startsWith('UPDATE saas_subscription_events') && params[2] === 'processed');
      retryable(await deliver()); await assertMutations(0); assert.equal((await event()).processingStatus, 'failed');
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('failed marker write failure cannot leave a false success marker', async () => {
      provider.onGet = () => { throw new Error(sensitiveError); };
      failSqlWhen((sql, params) => sql.startsWith('UPDATE saas_subscription_events') && params[2] === 'failed');
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'received'); await assertMutations(0);
      provider.onGet = null;
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('business COMMIT failure leaves received event and no committed billing effects', async () => {
      fault.beforeCommit = once(async client => { await client.query('SELECT 1/0'); });
      retryable(await deliver()); await assertMutations(0); assert.equal((await event()).processingStatus, 'received');
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('lost COMMIT acknowledgement remains durably deduplicated', async () => {
      fault.afterCommit = once(() => { throw new Error(sensitiveError); });
      retryable(await deliver()); await assertMutations(1); assert.equal((await event()).processingStatus, 'processed');
      const replay = await deliver(); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true); await assertMutations(1);
    });
    await scenario('response generation failure after commit does not reapply business changes', async () => {
      fault.response = true;
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'processed');
      assert.equal((await deliver()).body.duplicate, true); await assertMutations(1);
    });
    await scenario('success logging failure cannot turn a committed result into a failed event', async () => {
      fault.logEvent = 'mercado_pago_webhook_processed';
      assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'processed');
      assert.equal((await deliver()).body.duplicate, true); await assertMutations(1);
    });
    await scenario('provider payment GET failure is retryable without business SQL', async () => {
      payload.type = 'payment'; payload.data.id = 'pay-1';
      provider.onPayment = () => { throw new Error(sensitiveError); };
      retryable(await deliver()); await assertMutations(0);
      provider.onPayment = null; assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('incomplete provider response never mutates billing and can be retried', async () => {
      provider.onGet = () => ({}); retryable(await deliver()); await assertMutations(0);
      provider.onGet = null; assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('provider timeout releases ownership; late GET result cannot mutate billing', async () => {
      let release;
      provider.onGet = () => new Promise(resolve => { release = resolve; });
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'failed'); await assertMutations(0);
      release(provider.remote); provider.onGet = null;
      assert.equal((await deliver()).status, 200); await assertMutations(1);
    });
    await scenario('existing invalid JSON ignore contract remains permanent and non-mutating', async () => {
      const result = await deliver({ body: '{' });
      assert.equal(result.status, 200); assert.equal(result.body.error, 'invalid_json');
      assert.equal(await event(), undefined); assert.equal(provider.gets, 0); await assertMutations(0);
    });
    await scenario('processor exposes distinct result classes', async () => {
      const first = await service.processMercadoPagoWebhook(payload, { signatureValid: true });
      assert.equal(first.outcome, 'PROCESSED_SUCCESSFULLY');
      assert.equal((await service.processMercadoPagoWebhook(payload)).outcome, 'ALREADY_PROCESSED');
      payload.id = 'unsupported'; payload.type = 'unsupported';
      assert.equal((await service.processMercadoPagoWebhook(payload)).outcome, 'IGNORED_UNSUPPORTED_EVENT');
      payload.id = 'failed'; payload.type = 'preapproval'; provider.onGet = () => { throw new Error(sensitiveError); };
      assert.equal((await service.processMercadoPagoWebhook(payload)).outcome, 'RETRYABLE_PROCESSING_FAILURE');
    });
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    for (const [id, previous] of modules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
  }
});
