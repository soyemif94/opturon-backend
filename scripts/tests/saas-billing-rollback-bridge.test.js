const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const express = require('express');
const { Pool } = require('pg');
const markerProtocol = require('../../src/services/saas-billing-rollback-marker');
const { captureLocalBillingContract } = require('../../src/services/saas-billing-contract');

const root = path.resolve(__dirname, '../..');
const productionBase = 'ffa90f8352abe2df515f228bdbe34e59959e732c';
const claimId = '12345678-1234-4234-8234-123456789abc';
const claim = `billing_contract_v2:claim:${claimId}`;
const marker = `${claim}:provider_timeout`;
const blockedLog = 'billing_contract_v2_event_blocked_by_rollback_bridge';
const invalidMarkers = [
  null, '', 'webhook_processing_failed', 'payment_not_found', 'provider_error', 'random text',
  'billing_contract_v2', 'billing_contract_v2:', 'billing_contract_v2:claim',
  marker.replace('v2:', 'v20:'), `foo ${marker}`, `${marker}:extra`,
  claim.replace(claimId, 'not-a-uuid'), claim.replace('-4234-', '-1234-'),
  claim.replace('-8234-', '-7234-'), claim.replace(claimId, claimId.toUpperCase()),
  `${claim}:`, `${claim}:payment_pending`, `${claim}:payment_in_process`,
  `${claim}:authorized_invoice_zero_match`, `${claim}:arbitrary_exception`,
  `${claim}:Bearer secret`, `${claim}:${'x'.repeat(10000)}`,
  ` ${claim}`, `${claim} `, `${claim}\n`, `${marker}\n`, `${marker}\r\n`,
  claim.replace(':claim:', ':retry:'), claim.replace('billing_', 'BILLING_'),
  123, {}, [marker], Buffer.from(marker)
];

test('Bridge marker: canonical UUID v4, bounded protocol and closed technical reason list', () => {
  assert.equal(markerProtocol.BILLING_CONTRACT_V2_MARKER_PREFIX, 'billing_contract_v2:');
  assert.equal(markerProtocol.isBillingContractV2Marker(claim), true);
  for (const reason of markerProtocol.BILLING_CONTRACT_V2_RETRY_REASONS) {
    const value = `${claim}:${reason}`;
    assert.ok(value.length <= markerProtocol.BILLING_CONTRACT_V2_MARKER_MAX_LENGTH);
    assert.equal(markerProtocol.isBillingContractV2Marker(value), true);
  }
  assert.equal(markerProtocol.isBillingContractV2Marker(`billing_contract_v2:claim:${crypto.randomUUID()}`), true);
});

test('I/J: historical text, malformed UUIDs, false prefixes, normal states and oversized values are not markers', () => {
  for (const value of invalidMarkers) assert.equal(markerProtocol.isBillingContractV2Marker(value), false, String(value).slice(0, 100));
});

test('Rollback bridge: real PostgreSQL and signed HTTP; historical production controls', async t => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `bridge_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  const modules = new Map(); const originalFetch = global.fetch;
  let server; let payload; let subscription; let provider; let logs; let trace; let beforeQuery; let throwLog;
  let bridgeEntries = 0;
  const secret = 'local-only-rollback-bridge-signature';
  const clinicId = '00000000-0000-4000-8000-000000000001';
  function stub(name, exports) {
    const id = require.resolve(path.join(root, name));
    modules.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  async function query(client, sql, params) {
    trace.push(sql);
    if (beforeQuery) await beforeQuery(client, sql, params);
    return client.query(sql, params);
  }
  stub('src/db/client.js', {
    query: (sql, params) => query(pool, sql, params),
    withTransaction: async fn => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => query(client, sql, params) });
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  });
  stub('src/config/env.js', { mercadoPagoWebhookSecret: secret, nodeEnv: 'production' });
  const log = (event, fields) => {
    if (throwLog) throw new Error('synthetic_log_failure');
    logs.push({ event, fields });
  };
  stub('src/utils/logger.js', { logInfo: log, logWarn: log, logError: log });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  const realProvider = require('../../src/services/mercado-pago.service');
  stub('src/services/mercado-pago.service.js', {
    ...realProvider,
    createPreapproval() { throw new Error('provider_write_forbidden'); },
    getPayment: async () => {
      provider.gets.push('payment');
      if (provider.fail) throw new Error('synthetic_provider_failure');
      return provider.payment;
    },
    getPreapproval: async () => {
      provider.gets.push('preapproval');
      if (provider.fail) throw new Error('synthetic_provider_failure');
      return provider.preapproval;
    }
  });
  global.fetch = (value, ...args) => {
    assert.equal(new URL(value).hostname, '127.0.0.1', 'external requests forbidden');
    return originalFetch(value, ...args);
  };
  const repository = require('../../src/repositories/saas-subscriptions.repository');
  const service = require('../../src/services/saas-billing.service');
  stub('src/services/saas-billing.service.js', {
    ...service, processMercadoPagoWebhook: (...args) => { bridgeEntries += 1; return service.processMercadoPagoWebhook(...args); }
  });
  const app = express();
  app.use('/api/webhooks/mercadopago', require('../../src/routes/mercadopago-webhook.routes'));
  // Exact production service/repository/controller control; no copied production
  // files and no alternate mocked state machine. Both use the same local DB.
  const previousPaths = ['src/services/saas-billing.service.js', 'src/repositories/saas-subscriptions.repository.js',
    'src/controllers/mercadopago.controller.js'];
  const previousModules = new Map();
  function loadPrevious(relative) {
    if (previousModules.has(relative)) return previousModules.get(relative).exports;
    const filename = path.join(root, relative); const localRequire = createRequire(filename);
    const module = { exports: {} }; previousModules.set(relative, module);
    const source = execFileSync('git', ['show', `${productionBase}:${relative}`], { cwd: root, encoding: 'utf8' });
    const run = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${source}\n})`, { filename });
    run(request => {
      const resolved = localRequire.resolve(request);
      const previous = previousPaths.find(name => path.join(root, name) === resolved);
      return previous ? loadPrevious(previous) : localRequire(request);
    }, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  app.post('/audit/production-base', express.raw({ type: '*/*', limit: '2mb' }),
    (req, _res, next) => { req.rawBody = req.body; next(); }, loadPrevious('src/controllers/mercadopago.controller.js').postMercadoPagoWebhook);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function deliver({ valid = true, previous = false } = {}) {
    const requestId = crypto.randomUUID(); const ts = '1727300000'; const id = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}${previous ? '/audit/production-base' : '/api/webhooks/mercadopago'}?data.id=${id}`, {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json',
        'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${valid ? digest : '0'.repeat(64)}` }, body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }
  async function reset() {
    provider = { gets: [], fail: false }; logs = []; trace = []; beforeQuery = null; throwLog = false; bridgeEntries = 0;
    await pool.query('TRUNCATE mutation_audit, saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query('INSERT INTO clinics (id,"externalTenantId") VALUES ($1,$2)', [clinicId, 'tenant-bridge']);
    const id = '00000000-0000-4000-8000-000000000002';
    const input = { id, clinicId, externalTenantId: 'tenant-bridge', planCode: 'inicial', amount: 40600,
      currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending', mercadoPagoPreapprovalId: 'mp-1',
      externalReference: `opturon:tenant-bridge:${id}` };
    const contract = captureLocalBillingContract({ ...input, subscriptionId: id,
      plan: { code: 'inicial', amount: 40600, currency: 'ARS' }, capturedAt: new Date().toISOString() });
    subscription = await repository.insertSaasSubscription({ ...input, metadata: { contract } });
    provider.preapproval = { id: 'mp-1', status: 'authorized', external_reference: input.externalReference,
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS' } };
    provider.payment = { id: 'pay-1', status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference };
    payload = { id: 'notice-bridge', type: 'payment', action: 'payment.updated', data: { id: 'pay-1' } };
  }
  const event = async () => (await pool.query('SELECT * FROM saas_subscription_events')).rows[0];
  const business = async () => ({ subscription: (await pool.query('SELECT * FROM saas_subscriptions')).rows[0],
    tenant: (await pool.query('SELECT * FROM clinics')).rows[0] });
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  async function seedEvent(status, error, outcome = null) {
    const snapshot = service.__internal.buildWebhookEventSnapshot(payload, { signatureValid: true });
    await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: service.__internal.deriveWebhookDedupeKey(snapshot),
      raw: payload, processingStatus: status, processingError: error });
    if (outcome) await pool.query('UPDATE saas_subscription_events SET "contractOutcome"=$1::jsonb', [JSON.stringify(outcome)]);
    await pool.query('TRUNCATE mutation_audit'); trace = [];
  }
  async function assertBusinessMutations(n) {
    const rows = (await pool.query('SELECT kind,count(*)::int AS n FROM mutation_audit GROUP BY kind')).rows;
    for (const kind of ['subscription', 'tenant']) assert.equal(rows.find(r => r.kind === kind)?.n || 0, n, kind);
  }
  async function assertBlocked(response, before, beforeBusiness) {
    assert.deepEqual(response, { status: 503, body: { success: false, error: 'webhook_processing_failed' } });
    assert.deepEqual(await event(), before); assert.deepEqual(await business(), beforeBusiness);
    assert.deepEqual(provider.gets, []); await assertBusinessMutations(0);
    assert.ok(trace.some(sql => sql.includes('"processingError"') && sql.includes('FOR UPDATE')));
    assert.equal(trace.some(sql => sql.startsWith('UPDATE ')), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n, 0);
    assert.equal(JSON.stringify(response).includes(claimId), false);
    assert.equal(JSON.stringify(response).includes('billing_contract_v2:'), false);
    assert.equal(JSON.stringify(logs).includes(claimId), false);
  }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql', '086_saas_subscription_event_contract_outcome.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
    }
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_bridge_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('tenant');
      CREATE TRIGGER event_effect AFTER UPDATE ON saas_subscription_events FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('event');`);
    await scenario('Schema: existing TEXT accepts the longest protocol marker without migration', async () => {
      const column = (await pool.query("SELECT data_type,character_maximum_length FROM information_schema.columns WHERE table_schema=$1 AND table_name='saas_subscription_events' AND column_name='processingError'", [schema])).rows[0];
      assert.deepEqual(column, { data_type: 'text', character_maximum_length: null });
      const value = `${claim}:provider_network_error`;
      assert.equal(value.length, markerProtocol.BILLING_CONTRACT_V2_MARKER_MAX_LENGTH);
      await seedEvent('failed', value); assert.equal((await event()).processingError, value);
    });
    for (const [code, status] of [['A', 'failed'], ['B', 'received'], ['C', 'processing']]) {
      await scenario(`${code}/L/M: rollback of marked ${status} refuses old logic and preserves every byte`, async () => {
        await seedEvent(status, marker); const before = await event(); const beforeBusiness = await business();
        await assertBlocked(await deliver(), before, beforeBusiness);
        await assertBlocked(await deliver(), before, beforeBusiness);
        assert.equal(logs.filter(l => l.event === blockedLog).length, 2);
      });
    }
    for (const topic of ['subscription_preapproval', 'subscription_authorized_payment', 'authorized_payment']) {
      await scenario(`Marked ${topic} cannot reach any legacy provider route`, async () => {
        payload.type = topic;
        await seedEvent('failed', claim);
        const before = await event(); const beforeBusiness = await business();
        await assertBlocked(await deliver(), before, beforeBusiness);
      });
    }
    for (const status of ['processed', 'ignored']) {
      await scenario(`D: ${status} with valid marker stays an ordinary terminal duplicate`, async () => {
        await seedEvent(status, marker); const before = await event();
        const response = await deliver(); assert.equal(response.status, 200); assert.equal(response.body.duplicate, true);
        assert.deepEqual(await event(), before); assert.deepEqual(provider.gets, []); await assertBusinessMutations(0);
        assert.equal(logs.some(l => l.event === blockedLog), false);
      });
    }
    for (const type of ['manual_review', 'contract_rejected']) {
      await scenario(`E/Q: ignored ${type} preserves BILL-006D semantics`, async () => {
        await seedEvent('ignored', type === 'manual_review' ? 'legacy_contract_unknown' : 'contract_amount_mismatch',
          { version: 1, type, reasonCode: type === 'manual_review' ? 'legacy_contract_unknown' : 'contract_amount_mismatch' });
        const before = await event(); const response = await deliver();
        assert.equal(response.status, 200); assert.equal(response.body.duplicate, true); assert.equal(response.body.outcome, type.toUpperCase());
        assert.deepEqual(await event(), before); assert.deepEqual(provider.gets, []); await assertBusinessMutations(0);
      });
    }
    for (const [code, status] of [['F', 'failed'], ['G', 'received'], ['G', 'processing']]) {
      await scenario(`${code}: unmarked ${status} matches exact ffa90f runtime`, async () => {
        async function run(previous) {
          await reset(); await seedEvent(status, status === 'failed' ? 'webhook_processing_failed' : null);
          const contract = subscription.metadata.contract;
          const response = await deliver({ previous }); const row = await event(); const state = await business();
          await assertBusinessMutations(1); assert.deepEqual(state.subscription.metadata.contract, contract);
          // Independent transactions necessarily have different timestamps. Check
          // each snapshot against its own row, then compare all remaining fields.
          const snapshot = state.tenant.settings.portal.billing.subscription;
          assert.equal(snapshot.updatedAt, state.subscription.updatedAt.toISOString());
          delete snapshot.updatedAt;
          return { response, gets: [...provider.gets], status: row.processingStatus, error: row.processingError,
            localStatus: state.subscription.localStatus, lastPaymentId: state.subscription.lastPaymentId, settings: state.tenant.settings };
        }
        const baseline = await run(true); const bridge = await run(false);
        assert.equal(bridge.response.status, 200); assert.equal(bridge.status, 'processed');
        assert.deepEqual(bridge, baseline);
      });
    }
    await scenario('H: invalid signature stops before any bridge service/DB access', async () => {
      await seedEvent('failed', marker); const before = await event();
      assert.equal((await deliver({ valid: false })).status, 401);
      assert.equal(bridgeEntries, 0); assert.deepEqual(trace, []); assert.deepEqual(provider.gets, []);
      assert.deepEqual(await event(), before); await assertBusinessMutations(0);
      assert.equal(logs.some(l => l.event === blockedLog), false);
    });
    for (const [label, value] of [['I', claim.replace(claimId, 'bad-uuid')], ['J', marker.replace('v2:', 'v20:')]]) {
      await scenario(`${label}: invalid marker fixture retains ordinary historical processing`, async () => {
        await seedEvent('failed', value); assert.equal((await deliver()).status, 200);
        assert.equal((await event()).processingStatus, 'processed'); assert.deepEqual(provider.gets, ['payment', 'preapproval']);
        await assertBusinessMutations(1); assert.equal(logs.some(l => l.event === blockedLog), false);
      });
    }
    await scenario('K: concurrent marked deliveries hold independent DB connections and complete bounded', async () => {
      await seedEvent('failed', marker); const before = await event(); const beforeBusiness = await business();
      const connections = new Set();
      let release; const bothEntered = new Promise(resolve => { release = resolve; });
      const safety = setTimeout(release, 2000);
      beforeQuery = async (client, sql) => {
        if (!sql.includes('FOR UPDATE')) return;
        connections.add(client.processID);
        if (connections.size === 2) release();
        await bothEntered;
      };
      const start = performance.now(); let results;
      try { results = await Promise.all([deliver(), deliver()]); }
      finally { release(); clearTimeout(safety); }
      const elapsedMs = Math.round(performance.now() - start);
      for (const response of results) await assertBlocked(response, before, beforeBusiness);
      assert.ok(connections.size >= 2, 'independent PostgreSQL sessions');
      assert.ok(elapsedMs < 3000, `marked requests took ${elapsedMs}ms`);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscription_events')).rows[0].n, 1);
      t.diagnostic(`CONCURRENT_MARKED elapsedMs=${elapsedMs}; providerGets=0; businessMutations=0; independentConnections=${connections.size}`);
    });
    await scenario('Guard failure to log cannot alter durable refusal', async () => {
      await seedEvent('processing', marker); throwLog = true;
      const before = await event(); const beforeBusiness = await business();
      await assertBlocked(await deliver(), before, beforeBusiness);
    });
    await scenario('Provider payload cannot create an internal marker', async () => {
      payload.processingError = marker; payload.metadata = { processingError: marker };
      assert.equal((await deliver()).status, 200); assert.equal((await event()).processingStatus, 'processed');
      assert.equal((await event()).processingError, null); await assertBusinessMutations(1);
      assert.equal(logs.some(l => l.event === blockedLog), false);
    });
    await scenario('N: unmarked BILL-004 reservation recovery remains available', async () => {
      payload.type = 'subscription_preapproval'; payload.data.id = 'mp-1';
      await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1,"providerCallStartedAt"=NOW() WHERE id=$2',
        ['provider_call_started', subscription.id]);
      await seedEvent('failed', 'webhook_processing_failed');
      assert.equal((await deliver()).status, 200); const row = (await business()).subscription;
      assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, 'mp-1'); await assertBusinessMutations(1);
    });
    await scenario('O: unmarked BILL-005 transient failure retries to one successful application', async () => {
      provider.fail = true;
      assert.equal((await deliver()).status, 503); const before = await event();
      assert.equal(before.processingStatus, 'failed'); assert.equal(before.processingError, 'webhook_processing_failed'); await assertBusinessMutations(0);
      provider.fail = false; assert.equal((await deliver()).status, 200);
      assert.equal((await event()).id, before.id); assert.equal((await event()).processingStatus, 'processed'); await assertBusinessMutations(1);
      assert.equal((await deliver()).body.duplicate, true); await assertBusinessMutations(1);
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
