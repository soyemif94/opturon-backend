const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const outcomes = require('../../src/services/saas-billing-webhook-outcomes');
const { captureLocalBillingContract } = require('../../src/services/saas-billing-contract');
const secret = 'local-only-6d-webhook-secret';
const originalFetch = global.fetch;
const modules = new Map();
function stub(name, exports) {
  const id = require.resolve(path.join(root, name));
  modules.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

test('V/W: BILL-006D safe, allowlisted outcome model', () => {
  for (const reasonCode of outcomes.CONTRACT_REJECT_REASON_CODES) {
    assert.equal(outcomes.contractRejected({ reasonCode }).type, 'contract_rejected');
  }
  for (const reasonCode of outcomes.MANUAL_REVIEW_REASON_CODES) {
    assert.equal(outcomes.manualReview({ reasonCode }).type, 'manual_review');
  }
  for (const input of [
    { reasonCode: 'raw secret exception' },
    { reasonCode: 'legacy_contract_unknown' },
    { reasonCode: 'contract_amount_mismatch', token: 'secret' },
    { reasonCode: 'contract_amount_mismatch', details: { payer: { email: 'private@example.test' } } },
    { reasonCode: 'contract_amount_mismatch', details: { observedField: 'id', observedValue: 'secret' } },
    { reasonCode: 'contract_amount_mismatch', details: { observedField: 'currency_id', observedValue: 'Bearer secret' } },
    { reasonCode: 'contract_amount_mismatch', details: { observedField: 'transaction_amount', observedValue: {} } },
    { reasonCode: 'contract_amount_mismatch', details: { contractSource: 'arbitrary_text' } },
    { reasonCode: 'contract_amount_mismatch', resource: { type: 'payment', id: 'https://secret' } },
    { reasonCode: 'contract_amount_mismatch', resource: { type: 'payment', id: 'pay-1', headers: {} } },
    { reasonCode: 'contract_amount_mismatch', subscriptionId: 'invalid' }
  ]) assert.throws(() => outcomes.contractRejected(input), /webhook_contract_outcome_invalid/);
  const result = outcomes.contractRejected({ reasonCode: 'contract_amount_mismatch',
    details: { expectedField: 'amount', observedField: 'transaction_amount', observedValue: '123.45',
      contractVersion: 1, contractSource: 'contract' }, resource: { type: 'payment', id: 'pay-1' } });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.details));
  assert.deepEqual(outcomes.validateContractOutcome(result), result);
  assert.throws(() => outcomes.manualReview({ reasonCode: 'arbitrary_reason' }), /webhook_contract_outcome_invalid/);
  assert.throws(() => outcomes.validateContractOutcome({ type: 'ignored', reasonCode: 'legacy_contract_unknown' }), /webhook_contract_outcome_invalid/);
  for (const details of [{ token: 'synthetic' }, { Authorization: 'synthetic' }, { stack: 'synthetic' },
    { provider: { payload: {} } }, { observedValue: { nested: { secret: 'synthetic' } } }]) {
    assert.throws(() => outcomes.manualReview({ reasonCode: 'legacy_contract_unknown', details }), /webhook_contract_outcome_invalid/);
  }
  assert.throws(() => outcomes.manualReview({ reasonCode: 'legacy_contract_unknown',
    resource: { type: 'payment', id: 'x'.repeat(129) } }), /webhook_contract_outcome_invalid/);
});

test('BILL-006D: signed HTTP, real PostgreSQL terminal outcomes and retries', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'billing_test'); assert.equal(url.password, '');
  const schema = `outcome_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  let fault = {}; let provider = {}; let logs = []; let decision; let decisions = 0;
  let subscription; let payload; let server;
  const clinicId = '00000000-0000-4000-8000-000000000001';
  const sensitiveError = 'secret_sql provider_body=private token=DO_NOT_LEAK';
  async function query(client, sql, params) {
    if (fault.beforeQuery) await fault.beforeQuery(client, sql, params);
    return client.query(sql, params);
  }
  stub('src/db/client.js', {
    query: (sql, params) => query(pool, sql, params),
    withTransaction: async fn => {
      const client = await pool.connect(); let committed = false;
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => query(client, sql, params) });
        if (fault.beforeCommit) await fault.beforeCommit(client);
        await client.query('COMMIT'); committed = true;
        if (fault.afterCommit) await fault.afterCommit();
        return result;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  });
  stub('src/config/env.js', { mercadoPagoWebhookSecret: secret, nodeEnv: 'production' });
  const log = (event, fields) => { logs.push({ event, fields }); };
  stub('src/utils/logger.js', { logInfo: log, logWarn: log, logError: log });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  const realProvider = require('../../src/services/mercado-pago.service');
  stub('src/services/mercado-pago.service.js', {
    ...realProvider,
    createPreapproval() { throw new Error('provider_write_forbidden'); },
    getPayment() { throw new Error('unexpected_payment_fetch'); },
    getPreapproval: async () => {
      provider.gets += 1;
      if (provider.fail) throw new Error(sensitiveError);
      return provider.remote;
    }
  });
  global.fetch = (value, ...args) => {
    assert.equal(new URL(value).hostname, '127.0.0.1', 'external requests forbidden');
    return originalFetch(value, ...args);
  };
  const repository = require('../../src/repositories/saas-subscriptions.repository');
  const service = require('../../src/services/saas-billing.service');
  // Test-only executor supplies a future decision. HTTP data never chooses an
  // outcome in production; the real controller, event runner and SQL are used.
  stub('src/services/saas-billing.service.js', {
    ...service,
    processMercadoPagoWebhook: (body, meta) => {
      if (!decision) return service.processMercadoPagoWebhook(body, meta);
      const snapshot = service.__internal.buildWebhookEventSnapshot(body, meta);
      return service.__internal.processSubscriptionWebhookEvent({
        ...snapshot, dedupeKey: service.__internal.deriveWebhookDedupeKey(snapshot), raw: body,
        provider: 'mercado_pago', processingStatus: 'received'
      }, async (client, event) => { decisions += 1; return decision(client, event); });
    }
  });
  const app = express();
  app.use('/api/webhooks/mercadopago', require('../../src/routes/mercadopago-webhook.routes'));
  // Load the exact old service, repository and controller from Git in memory.
  // Shared dependencies are unchanged by 6D; DB/provider boundaries remain the
  // same local PG and provider stubs. No copied source files or mock status gate.
  const previousSha = '8928f5ad79d85c4cb162914f5079e302b42b3344';
  const previousModules = new Map();
  const previousPaths = ['src/services/saas-billing.service.js',
    'src/repositories/saas-subscriptions.repository.js', 'src/controllers/mercadopago.controller.js'];
  function loadPrevious(relative) {
    if (previousModules.has(relative)) return previousModules.get(relative).exports;
    const filename = path.join(root, relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    previousModules.set(relative, module);
    const source = execFileSync('git', ['show', `${previousSha}:${relative}`], { cwd: root, encoding: 'utf8' });
    const run = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${source}\n})`, { filename });
    run(request => {
      const resolved = localRequire.resolve(request);
      const previous = previousPaths.find(name => path.join(root, name) === resolved);
      return previous ? loadPrevious(previous) : localRequire(request);
    }, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  const previousController = loadPrevious('src/controllers/mercadopago.controller.js');
  app.post('/audit/previous-runtime', express.raw({ type: '*/*', limit: '2mb' }),
    (req, _res, next) => { req.rawBody = req.body; next(); }, previousController.postMercadoPagoWebhook);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function deliver({ valid = true, previous = false } = {}) {
    const requestId = crypto.randomUUID(); const ts = '1727300000'; const dataId = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    const endpoint = previous ? '/audit/previous-runtime' : '/api/webhooks/mercadopago';
    const response = await fetch(`${base}${endpoint}?data.id=${dataId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId,
        'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    fault = {}; provider = { gets: 0 }; logs = []; decision = null; decisions = 0;
    await pool.query('TRUNCATE mutation_audit, saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query('INSERT INTO clinics (id,"externalTenantId") VALUES ($1,$2)', [clinicId, 'tenant-test']);
    const id = crypto.randomUUID();
    const input = { id, clinicId, externalTenantId: 'tenant-test', planCode: 'inicial', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: 'mp-1',
      externalReference: `opturon:tenant-test:${id}` };
    const contract = captureLocalBillingContract({ ...input, subscriptionId: id,
      plan: { code: 'inicial', amount: 40600, currency: 'ARS' }, capturedAt: new Date().toISOString() });
    subscription = await repository.insertSaasSubscription({ ...input, metadata: { contract } });
    provider.remote = { id: 'mp-1', status: 'authorized', external_reference: subscription.externalReference,
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS' } };
    payload = { id: 'notice-6d', type: 'subscription_preapproval', action: 'updated', data: { id: 'mp-1' } };
  }
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  const event = async () => (await pool.query('SELECT * FROM saas_subscription_events')).rows[0];
  const business = async () => ({
    subscription: (await pool.query('SELECT * FROM saas_subscriptions')).rows[0],
    tenant: (await pool.query('SELECT * FROM clinics')).rows[0]
  });
  async function assertMutations(n) {
    const rows = (await pool.query('SELECT kind,count(*)::int AS n FROM mutation_audit GROUP BY kind')).rows;
    assert.deepEqual(Object.fromEntries(['subscription', 'tenant'].map(kind => [kind, rows.find(r => r.kind === kind)?.n || 0])),
      { subscription: n, tenant: n });
  }
  function synthetic(status, eventId) {
    return (status === 'contract_rejected' ? outcomes.contractRejected : outcomes.manualReview)({
      eventId, subscriptionId: subscription.id,
      reasonCode: status === 'contract_rejected' ? 'contract_amount_mismatch' : 'legacy_contract_unknown',
      details: { expectedField: 'amount', contractVersion: 1, contractSource: 'contract' },
      resource: { type: 'preapproval', id: 'mp-1' }
    });
  }
  function retryable(response) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { success: false, error: 'webhook_processing_failed' });
    assert.equal(JSON.stringify(logs).includes(sensitiveError), false);
  }
  function failSqlWhen(match) {
    let fired = false;
    fault.beforeQuery = async (client, sql, params) => {
      if (!fired && match(sql, params)) { fired = true; await client.query('SELECT 1/0'); }
    };
  }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql', '086_saas_subscription_event_contract_outcome.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
    }
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_outcome_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW
        EXECUTE FUNCTION count_outcome_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW
        EXECUTE FUNCTION count_outcome_mutation('tenant');`);
    t.diagnostic('SQL_ENGINE=PostgreSQL; independent connections; synthetic decisions; real signed HTTP; no provider network');

    for (const [status, cases] of [['contract_rejected', ['A', 'C', 'E', 'G']], ['manual_review', ['B', 'D', 'F', 'H']]]) {
      await scenario(`${cases[0]}/M: ${status} is atomic, visible, HTTP 200 and leaves contract/business untouched`, async () => {
        const before = await business();
        decision = (_client, row) => synthetic(status, row.id);
        const response = await deliver(); const row = await event();
        assert.equal(response.status, 200); assert.equal(response.body.outcome, status.toUpperCase());
        assert.equal(row.processingStatus, 'ignored'); assert.equal(response.body.ignored, true);
        assert.equal(row.subscriptionId, subscription.id);
        const saved = row.contractOutcome;
        assert.equal(saved.eventId, row.id); assert.equal(saved.subscriptionId, subscription.id);
        assert.equal(saved.reasonCode, row.processingError); assert.equal(row.resourceId, 'mp-1');
        assert.equal(row.topic, payload.type); assert.equal(saved.type, status);
        assert.equal(new Date(saved.recordedAt).getTime(), row.updatedAt.getTime());
        assert.deepEqual(saved.details, synthetic(status).details);
        assert.deepEqual(saved.resource, { type: 'preapproval', id: 'mp-1' });
        assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), before); await assertMutations(0);
        assert.equal(provider.gets, 0); assert.equal(logs.at(-1).fields.outcome, status.toUpperCase());
      });
      await scenario(`${cases[1]}: ${status} SQL failure returns 503, then failed can retry to terminal`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        failSqlWhen(sql => sql.startsWith('UPDATE saas_subscription_events') && sql.includes('"contractOutcome" ='));
        retryable(await deliver()); const failed = await event();
        assert.equal(failed.processingStatus, 'failed'); assert.equal(failed.contractOutcome, null);
        await assertMutations(0);
        assert.equal((await deliver()).status, 200);
        assert.equal((await event()).id, failed.id); assert.equal((await event()).processingStatus, 'ignored');
        assert.equal((await event()).contractOutcome.type, status);
        await assertMutations(0);
      });
      await scenario(`${cases[2]}/O: duplicate ${status} retains original result without executor/provider/business work`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        await deliver(); const first = await event();
        decision = () => { throw new Error('must_not_reprocess'); };
        const replay = await deliver();
        assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
        assert.equal(replay.body.outcome, status.toUpperCase()); assert.equal(decisions, 1);
        assert.deepEqual(await event(), first);
        // Ordinary production route, without a test decision, also short-circuits.
        decision = null;
        const result = await service.processMercadoPagoWebhook(payload, { signatureValid: true });
        assert.equal(result.duplicate, true); assert.deepEqual(result.contractOutcome, first.contractOutcome);
        assert.equal(provider.gets, 0); await assertMutations(0);
      });
      await scenario(`${cases[3]}: concurrent ${status} commits one terminal result`, async () => {
        let release; let started; let secondAtInsert; let inserts = 0;
        const gate = new Promise(r => { release = r; });
        const entered = new Promise(r => { started = r; });
        const contender = new Promise(r => { secondAtInsert = r; });
        fault.beforeQuery = async (_c, sql) => {
          if (sql.includes('INSERT INTO saas_subscription_events') && ++inserts === 2) secondAtInsert();
        };
        decision = async (_client, row) => { started(); await gate; return synthetic(status, row.id); };
        const first = deliver(); await entered; const second = deliver();
        try { await contender; } finally { release(); }
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(b.body.duplicate, true);
        assert.equal(decisions, 1); assert.equal((await event()).processingStatus, 'ignored');
        assert.equal((await event()).contractOutcome.type, status);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n, 1);
        await assertMutations(0); assert.equal(provider.gets, 0);
      });
      await scenario(`${status}: COMMIT failure never acknowledges an uncommitted terminal result`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        fault.beforeCommit = client => client.query('SELECT 1/0');
        retryable(await deliver());
        assert.equal((await event()).processingStatus, 'received');
        assert.equal((await event()).contractOutcome, null); await assertMutations(0);
        fault = {}; assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'ignored');
        assert.equal((await event()).contractOutcome.type, status);
      });
      await scenario(`${status}: lost commit acknowledgement retains durable result on retry`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        fault.afterCommit = () => { throw new Error(sensitiveError); };
        retryable(await deliver()); const first = await event(); assert.equal(first.processingStatus, 'ignored');
        assert.equal(first.contractOutcome.type, status);
        fault = {}; const replay = await deliver();
        assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
        assert.equal(decisions, 1); assert.deepEqual(await event(), first); await assertMutations(0);
      });
      await scenario(`N: processed cannot downgrade to ${status} through redelivery`, async () => {
        assert.equal((await deliver()).status, 200); const first = await event();
        decision = (_client, row) => synthetic(status, row.id);
        const replay = await deliver(); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
        assert.equal(decisions, 0); assert.equal(provider.gets, 1); assert.deepEqual(await event(), first);
        await assertMutations(1);
      });
      await scenario(`${status}: speculative business SQL is rolled back before terminal persistence`, async () => {
        const before = await business();
        decision = async (client, row) => {
          await client.query('UPDATE saas_subscriptions SET "localStatus"=$1 WHERE id=$2', ['active', subscription.id]);
          await client.query('UPDATE clinics SET settings=$1 WHERE id=$2', ['{"unintended":true}', clinicId]);
          return synthetic(status, row.id);
        };
        assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'ignored');
        assert.equal((await event()).contractOutcome.type, status);
        assert.deepEqual(await business(), before); await assertMutations(0);
      });
      await scenario(`P: ${status} preserves a provider _opturonBillingOutcome collision exactly`, async () => {
        payload._opturonBillingOutcome = { provider: 'original', details: { nested: ['unchanged', null, 42] } };
        const before = structuredClone(payload);
        decision = (_client, row) => synthetic(status, row.id);
        assert.equal((await deliver()).status, 200);
        const row = await event();
        assert.deepEqual(row.raw, before); assert.equal(row.contractOutcome.type, status);
        assert.equal(row.processingStatus, 'ignored'); await assertMutations(0);
        assert.equal((await deliver()).body.duplicate, true); assert.deepEqual((await event()).raw, before);
      });
      await scenario(`Q: ${status} preserves arbitrary raw keys, nested data and database JSONB representation`, async () => {
        payload._opturonInternal = { provider: ['own', { a: false, b: null }] };
        payload.contractOutcome = { type: 'provider-owned', details: { deeply: { nested: ['kept'] } } };
        payload.nested = { list: [1, 'ñ', { unicode: '✓', empty: {} }], other: [] };
        let before;
        decision = async (client, row) => {
          before = (await client.query('SELECT raw, raw::text AS serialized FROM saas_subscription_events WHERE id=$1', [row.id])).rows[0];
          return synthetic(status, row.id);
        };
        assert.equal((await deliver()).status, 200);
        const after = (await pool.query('SELECT raw, raw::text AS serialized FROM saas_subscription_events')).rows[0];
        assert.deepEqual(after, before); assert.deepEqual(after.raw, payload); await assertMutations(0);
      });
      await scenario(`${status === 'contract_rejected' ? 'S' : 'T'}: exact 8928f5a runtime safely deduplicates corrected ${status}`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        assert.equal((await deliver()).status, 200);
        const first = await event(); const before = await business();
        assert.equal(first.processingStatus, 'ignored'); assert.equal(first.contractOutcome.type, status);
        const oldResponse = await deliver({ previous: true });
        assert.equal(oldResponse.status, 200);
        assert.deepEqual(oldResponse.body, { success: true, duplicate: true, ignored: true });
        assert.equal(provider.gets, 0); assert.equal(decisions, 1);
        assert.deepEqual(await event(), first); assert.deepEqual(await business(), before); await assertMutations(0);
      });
    }
    await scenario('R: legacy ignored with NULL outcome remains terminal and distinct from contract decisions', async () => {
      payload.type = 'unsupported';
      const first = await deliver(); assert.equal(first.status, 200);
      assert.deepEqual(first.body, { success: true, duplicate: false, ignored: true });
      const original = await event();
      assert.equal(original.processingStatus, 'ignored'); assert.equal(original.contractOutcome, null);
      decision = () => { throw new Error('legacy_ignored_must_not_reprocess'); };
      const replay = await deliver();
      assert.deepEqual(replay.body, { success: true, duplicate: true, ignored: true });
      assert.equal(replay.status, 200); assert.equal(decisions, 0); assert.equal(provider.gets, 0);
      assert.deepEqual(await event(), original); await assertMutations(0);
    });
    await scenario('U: additive nullable migration is idempotent and old runtime can insert/process on new schema', async () => {
      const column = (await pool.query(`SELECT data_type,is_nullable,column_default FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='saas_subscription_events' AND column_name='contractOutcome'`, [schema])).rows[0];
      assert.deepEqual(column, { data_type: 'jsonb', is_nullable: 'YES', column_default: null });
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations/086_saas_subscription_event_contract_outcome.sql'), 'utf8'));
      assert.equal((await deliver({ previous: true })).status, 200);
      const processed = await event();
      assert.equal(processed.processingStatus, 'processed'); assert.equal(processed.contractOutcome, null);
      assert.equal(provider.gets, 1); await assertMutations(1);
      assert.equal((await deliver()).body.duplicate, true); assert.equal(provider.gets, 1);
      assert.deepEqual(await event(), processed); await assertMutations(1);
    });
    await scenario('U: migration on existing rows takes AccessExclusiveLock without backfill or heap rewrite', async () => {
      const client = await pool.connect();
      const migrationSchema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
      try {
        // Commit fixture DDL before observing the ALTER's own lock.
        await client.query(`CREATE SCHEMA ${migrationSchema}`);
        await client.query(`CREATE TABLE ${migrationSchema}.saas_subscription_events
          (id INTEGER PRIMARY KEY, raw JSONB NOT NULL, "processingStatus" TEXT NOT NULL)`);
        await client.query(`INSERT INTO ${migrationSchema}.saas_subscription_events VALUES
          (1, '{"_opturonBillingOutcome":{"provider":"original"},"nested":[null,42]}', 'ignored')`);
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path=${migrationSchema}`);
        const before = (await client.query('SELECT * FROM saas_subscription_events')).rows[0];
        const physicalBefore = (await client.query(`SELECT pg_relation_filenode('saas_subscription_events'::regclass) AS node`)).rows[0].node;
        await client.query(fs.readFileSync(path.join(root, 'db/migrations/086_saas_subscription_event_contract_outcome.sql'), 'utf8'));
        const after = (await client.query('SELECT * FROM saas_subscription_events')).rows[0];
        assert.deepEqual(after, { ...before, contractOutcome: null });
        assert.equal((await client.query(`SELECT pg_relation_filenode('saas_subscription_events'::regclass) AS node`)).rows[0].node, physicalBefore);
        const locks = (await client.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
          AND relation='saas_subscription_events'::regclass AND granted`)).rows;
        assert.ok(locks.some(row => row.mode === 'AccessExclusiveLock'));
      } finally {
        try {
          await client.query('ROLLBACK');
          await client.query(`DROP SCHEMA IF EXISTS ${migrationSchema} CASCADE`);
        } finally { client.release(); }
      }
    });
    await scenario('I: successful BILL-005 duplicate remains processed without another business write', async () => {
      assert.equal((await deliver()).status, 200); assert.equal((await deliver()).body.duplicate, true);
      assert.equal((await event()).processingStatus, 'processed'); assert.equal(provider.gets, 1); await assertMutations(1);
    });
    await scenario('J: provider failure stays 503/failed and retries normally', async () => {
      provider.fail = true; retryable(await deliver());
      assert.equal((await event()).processingStatus, 'failed'); await assertMutations(0);
      provider.fail = false; assert.equal((await deliver()).status, 200);
      assert.equal((await event()).processingStatus, 'processed'); await assertMutations(1);
    });
    await scenario('K: invalid signature prevents event registration and decision execution', async () => {
      decision = (_client, row) => synthetic('manual_review', row.id);
      assert.equal((await deliver({ valid: false })).status, 401);
      assert.equal(await event(), undefined); assert.equal(decisions, 0); assert.equal(provider.gets, 0); await assertMutations(0);
    });
    await scenario('L: BILL-004 recovery still resolves a durable reservation', async () => {
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1 WHERE id=$2',
        ['provider_call_started', subscription.id]);
      await pool.query('TRUNCATE mutation_audit');
      assert.equal((await deliver()).status, 200);
      const row = await repository.findSaasSubscriptionById(subscription.id);
      assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, 'mp-1');
      assert.deepEqual(row.metadata.contract, subscription.metadata.contract); await assertMutations(1);
    });
    await scenario('manual review accepts unresolved subscription and genuinely legacy contract absence', async () => {
      await pool.query('UPDATE saas_subscriptions SET metadata=$1 WHERE id=$2', ['{}', subscription.id]);
      await pool.query('TRUNCATE mutation_audit'); const before = await business();
      decision = () => outcomes.manualReview({ reasonCode: 'legacy_contract_unknown' });
      assert.equal((await deliver()).status, 200);
      assert.equal((await event()).subscriptionId, null); assert.deepEqual(await business(), before); await assertMutations(0);
    });
    await scenario('failed marker failure rolls back the entire attempt without false terminal data', async () => {
      decision = (_client, row) => synthetic('contract_rejected', row.id);
      fault.beforeQuery = async (client, sql, params) => {
        if (sql.startsWith('UPDATE saas_subscription_events') && (sql.includes('"contractOutcome" =') || params[2] === 'failed')) {
          await client.query('SELECT 1/0');
        }
      };
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'received');
      assert.equal((await event()).contractOutcome, null); await assertMutations(0);
      fault = {}; assert.equal((await deliver()).status, 200);
    });
    await scenario('untrusted payload cannot select or forge a contract outcome', async () => {
      payload.processingStatus = 'contract_rejected';
      payload._opturonBillingOutcome = { type: 'manual_review', reasonCode: 'legacy_contract_unknown' };
      payload.contractOutcome = { type: 'manual_review', reasonCode: 'legacy_contract_unknown' };
      assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'processed');
      assert.equal((await event()).contractOutcome, null); assert.deepEqual((await event()).raw, payload);
      assert.equal(provider.gets, 1); await assertMutations(1);
    });
    await scenario('wrong event ID and malformed internal outcomes remain retryable with no details leakage', async () => {
      for (const result of [
        synthetic('contract_rejected', crypto.randomUUID()),
        { type: 'manual_review', reasonCode: sensitiveError },
        { ...synthetic('manual_review'), details: { token: sensitiveError } }
      ]) {
        decision = () => result; retryable(await deliver());
        assert.equal((await event()).processingStatus, 'failed');
        assert.equal((await event()).contractOutcome, null); await assertMutations(0);
      }
    });
  } finally {
    global.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    for (const [id, previous] of modules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
  }
});
