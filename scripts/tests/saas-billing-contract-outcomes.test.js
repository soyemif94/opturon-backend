const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');
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

test('BILL-006D: safe, allowlisted outcome model', () => {
  for (const reasonCode of outcomes.CONTRACT_REJECT_REASON_CODES) {
    assert.equal(outcomes.contractRejected({ reasonCode }).processingStatus, 'contract_rejected');
  }
  for (const reasonCode of outcomes.MANUAL_REVIEW_REASON_CODES) {
    assert.equal(outcomes.manualReview({ reasonCode }).processingStatus, 'manual_review');
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
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function deliver({ valid = true } = {}) {
    const requestId = crypto.randomUUID(); const ts = '1727300000'; const dataId = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${dataId}`, {
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
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql']) {
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
        assert.equal(row.processingStatus, status); assert.notEqual(row.processingStatus, 'processed');
        assert.equal(row.subscriptionId, subscription.id);
        const saved = row.raw[outcomes.OUTCOME_RAW_KEY];
        assert.equal(saved.eventId, row.id); assert.equal(saved.subscriptionId, subscription.id);
        assert.equal(saved.reasonCode, row.processingError); assert.equal(saved.resourceId, 'mp-1');
        assert.equal(saved.topic, payload.type); assert.equal(saved.processingStatus, status);
        assert.equal(new Date(saved.recordedAt).getTime(), row.updatedAt.getTime());
        assert.deepEqual(saved.details, synthetic(status).details);
        assert.deepEqual(saved.resource, { type: 'preapproval', id: 'mp-1' });
        const { [outcomes.OUTCOME_RAW_KEY]: _result, ...raw } = row.raw;
        assert.deepEqual(raw, payload); assert.deepEqual(await business(), before); await assertMutations(0);
        assert.equal(provider.gets, 0); assert.equal(logs.at(-1).fields.outcome, status.toUpperCase());
      });
      await scenario(`${cases[1]}: ${status} SQL failure returns 503, then failed can retry to terminal`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        failSqlWhen((sql, params) => sql.startsWith('UPDATE saas_subscription_events') && params[2] === status);
        retryable(await deliver()); const failed = await event();
        assert.equal(failed.processingStatus, 'failed'); assert.equal(failed.raw[outcomes.OUTCOME_RAW_KEY], undefined);
        await assertMutations(0);
        assert.equal((await deliver()).status, 200);
        assert.equal((await event()).id, failed.id); assert.equal((await event()).processingStatus, status);
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
        assert.equal(result.duplicate, true); assert.deepEqual(result.contractOutcome, first.raw[outcomes.OUTCOME_RAW_KEY]);
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
        assert.equal(decisions, 1); assert.equal((await event()).processingStatus, status);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n, 1);
        await assertMutations(0); assert.equal(provider.gets, 0);
      });
      await scenario(`${status}: COMMIT failure never acknowledges an uncommitted terminal result`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        fault.beforeCommit = client => client.query('SELECT 1/0');
        retryable(await deliver());
        assert.equal((await event()).processingStatus, 'received');
        assert.equal((await event()).raw[outcomes.OUTCOME_RAW_KEY], undefined); await assertMutations(0);
        fault = {}; assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, status);
      });
      await scenario(`${status}: lost commit acknowledgement retains durable result on retry`, async () => {
        decision = (_client, row) => synthetic(status, row.id);
        fault.afterCommit = () => { throw new Error(sensitiveError); };
        retryable(await deliver()); const first = await event(); assert.equal(first.processingStatus, status);
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
        assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, status);
        assert.deepEqual(await business(), before); await assertMutations(0);
      });
    }
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
        if (sql.startsWith('UPDATE saas_subscription_events') && ['contract_rejected', 'failed'].includes(params[2])) {
          await client.query('SELECT 1/0');
        }
      };
      retryable(await deliver()); assert.equal((await event()).processingStatus, 'received');
      assert.equal((await event()).raw[outcomes.OUTCOME_RAW_KEY], undefined); await assertMutations(0);
      fault = {}; assert.equal((await deliver()).status, 200);
    });
    await scenario('untrusted payload cannot select or forge a contract outcome', async () => {
      payload.processingStatus = 'contract_rejected';
      payload[outcomes.OUTCOME_RAW_KEY] = { processingStatus: 'manual_review', reasonCode: 'legacy_contract_unknown' };
      assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'processed');
      assert.equal(provider.gets, 1); await assertMutations(1);
    });
    await scenario('durable internal metadata replaces a spoofed raw namespace atomically', async () => {
      payload[outcomes.OUTCOME_RAW_KEY] = { reasonCode: 'forged', details: { token: 'untrusted' } };
      decision = (_client, row) => synthetic('manual_review', row.id);
      assert.equal((await deliver()).status, 200);
      const saved = (await event()).raw[outcomes.OUTCOME_RAW_KEY];
      assert.equal(saved.reasonCode, 'legacy_contract_unknown'); assert.equal(saved.details.token, undefined);
      await assertMutations(0);
    });
    await scenario('wrong event ID and malformed internal outcomes remain retryable with no details leakage', async () => {
      for (const result of [
        synthetic('contract_rejected', crypto.randomUUID()),
        { processingStatus: 'manual_review', reasonCode: sensitiveError },
        { ...synthetic('manual_review'), details: { token: sensitiveError } }
      ]) {
        decision = () => result; retryable(await deliver());
        assert.equal((await event()).processingStatus, 'failed');
        assert.equal((await event()).raw[outcomes.OUTCOME_RAW_KEY], undefined); await assertMutations(0);
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
