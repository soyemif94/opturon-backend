const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { Pool } = require('pg');
const markerProtocol = require('../../src/services/saas-billing-rollback-marker');
const { captureLocalBillingContract } = require('../../src/services/saas-billing-contract');

const root = path.resolve(__dirname, '../..');
// Standalone equality with ffa90f is preserved at bridge commit be5b8f8.
// This suite now checks the permanent protocol and combined 6BC semantics.
// See docs/billing-bridge-6bc-test-adaptation.md for the eight-case mapping.
const paymentReads = ['payment:pay-1', 'search:pay-1', 'invoice:invoice-1', 'preapproval:mp-1'];
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

test('Rollback bridge: permanent protocol and combined 6BC; real PostgreSQL and signed HTTP', async t => {
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
  let bridgeEntries = 0; let useBridge = true;
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
  function readProvider(kind, id, expectedId) {
    provider.gets.push(`${kind}:${id}`);
    assert.equal(String(id), expectedId, `${kind} must use the canonical resource identity`);
    assert.equal(trace.some(sql => /^UPDATE (saas_subscriptions|clinics)\b/.test(sql)), false,
      'business writes must wait until provider proof is complete');
    if (provider.fail === true || provider.fail === kind) throw new Error('synthetic_provider_failure');
    return structuredClone(provider[kind]);
  }
  stub('src/services/mercado-pago.service.js', require('./helpers/billing-v2-fixture').canonicalReads({
    ...realProvider,
    createPreapproval() { throw new Error('provider_write_forbidden'); },
    getPayment: async id => readProvider('payment', id, 'pay-1'),
    searchAuthorizedPaymentsByPaymentId: async id => readProvider('search', id, 'pay-1'),
    getAuthorizedPayment: async id => readProvider('invoice', id, 'invoice-1'),
    getPreapproval: async id => readProvider('preapproval', id, 'mp-1')
  }, {}));
  global.fetch = (value, ...args) => {
    assert.equal(new URL(value).hostname, '127.0.0.1', 'external requests forbidden');
    return originalFetch(value, ...args);
  };
  const repository = require('../../src/repositories/saas-subscriptions.repository');
  const service = require('../../src/services/saas-billing.service');
  // Compile the deployed rollback bridge unchanged; never ask the new runtime
  // to emulate an older runtime's refusal to retry its own claims.
  const bridgePath = path.join(root, 'src/services/saas-billing.service.js');
  const bridgeModule = new (require('node:module'))(bridgePath, module);
  bridgeModule.filename = bridgePath; bridgeModule.paths = module.paths;
  bridgeModule._compile(require('node:child_process').execFileSync('git',
    ['show', 'be5b8f8a7d7b147a5f8a9a69659f4007091e1aee:src/services/saas-billing.service.js'], { cwd: root, encoding: 'utf8' }), bridgePath);
  stub('src/services/saas-billing.service.js', {
    ...service, processMercadoPagoWebhook: (...args) => { bridgeEntries += 1;
      return (useBridge ? bridgeModule.exports : service).processMercadoPagoWebhook(...args); }
  });
  const app = express();
  app.use('/api/webhooks/mercadopago', require('../../src/routes/mercadopago-webhook.routes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function deliver({ valid = true } = {}) {
    const requestId = 'fixture-request'; const ts = '1727300000'; const id = payload.data.id;
    const digest = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await fetch(`${base}/api/webhooks/mercadopago?data.id=${id}`, {
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
      auto_recurring: { transaction_amount: 40600, currency_id: 'ARS', frequency: 1, frequency_type: 'months' } };
    provider.payment = { date_created: new Date().toISOString(), id: 'pay-1', status: 'approved', preapproval_id: 'mp-1', external_reference: input.externalReference,
      transaction_amount: 40600, currency_id: 'ARS' };
    provider.search = { paging: { offset: 0, limit: 2, total: 1 }, results: [{ id: 'invoice-1', payment: { id: 'pay-1' } }] };
    provider.invoice = { id: 'invoice-1', preapproval_id: 'mp-1', status: 'processed', type: 'scheduled',
      payment: { id: 'pay-1', status: 'approved' }, transaction_amount: '40600.00', currency_id: 'ARS' };
    payload = { id: 'notice-bridge', type: 'payment', action: 'payment.updated', data: { id: 'pay-1' } };
  }
  const event = async () => (await pool.query('SELECT * FROM saas_subscription_events')).rows[0];
  const business = async () => ({ subscription: (await pool.query('SELECT * FROM saas_subscriptions')).rows[0],
    tenant: (await pool.query('SELECT * FROM clinics')).rows[0] });
  const scenario = (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  async function seedEvent(status, error, outcome = null) {
    const snapshot = service.__internal.buildWebhookEventSnapshot(payload, { signatureValid: true });
    await repository.insertSubscriptionEvent({ ...snapshot, dedupeKey: (useBridge ? service.__internal.deriveWebhookDedupeKey(snapshot) : require('./helpers/billing-v2-fixture').delivery(payload, secret).dedupeKey),
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
  function assertNormalPipeline(expectedReads) {
    assert.equal(logs.some(l => l.event === blockedLog), false, 'unmarked input must not trigger bridge protection');
    assert.ok(bridgeEntries > 0);
    assert.deepEqual(provider.gets, expectedReads);
    assert.ok(provider.gets.length > 0, 'normal provider processing must actually be reached');
    assert.ok(trace.some(sql => sql.startsWith('UPDATE saas_subscription_events')));
  }
  async function assertProcessed(response, expectedReads = paymentReads, payment = true) {
    assert.equal(response.status, 200); assert.equal(response.body.duplicate, false);
    const row = await event(); const state = await business();
    assert.equal(row.processingStatus, 'processed'); assert.equal(row.processingError, null);
    assert.equal(row.contractOutcome, null); assert.equal(row.subscriptionId, subscription.id);
    assert.deepEqual(row.raw, payload); assert.equal(state.subscription.localStatus, payload.type === 'payment' ? 'active' : 'pending');
    assert.deepEqual(state.subscription.metadata.contract, subscription.metadata.contract);
    assert.equal(state.tenant.settings.portal.billing.subscription.updatedAt, state.subscription.updatedAt.toISOString());
    if (payment) assert.equal(state.subscription.lastPaymentId, 'pay-1');
    await assertBusinessMutations(1); assertNormalPipeline(expectedReads);
  }
  async function assertProcessedDuplicate() {
    const before = await event(); const beforeBusiness = await business(); const reads = [...provider.gets];
    const response = await deliver();
    assert.equal(response.status, 200); assert.equal(response.body.duplicate, true);
    assert.deepEqual(await event(), before); assert.deepEqual(await business(), beforeBusiness);
    assert.deepEqual(provider.gets, reads); await assertBusinessMutations(1);
    assert.equal(logs.some(l => l.event === blockedLog), false);
  }
  async function assertProofOutcome(response, beforeBusiness, type, reason, expectedReads = paymentReads) {
    assert.equal(response.status, 200); assert.equal(response.body.outcome, type.toUpperCase());
    const row = await event();
    assert.equal(row.processingStatus, 'ignored'); assert.equal(row.processingError, reason);
    assert.equal(row.contractOutcome.type, type); assert.equal(row.contractOutcome.reasonCode, reason);
    assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), beforeBusiness);
    await assertBusinessMutations(0); assertNormalPipeline(expectedReads);
    const reads = [...provider.gets]; const duplicate = await deliver();
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.outcome, type.toUpperCase());
    assert.deepEqual(await event(), row); assert.deepEqual(await business(), beforeBusiness);
    assert.deepEqual(provider.gets, reads); await assertBusinessMutations(0);
    assert.equal(logs.some(l => l.event === blockedLog), false);
  }
  async function seedRecovery() {
    payload.type = 'subscription_preapproval'; payload.data.id = 'mp-1';
    await pool.query('UPDATE saas_subscriptions SET "mercadoPagoPreapprovalId"=NULL,"provisioningState"=$1,"providerCallStartedAt"=NOW() WHERE id=$2',
      ['provider_call_started', subscription.id]);
    await seedEvent('failed', 'webhook_processing_failed');
  }
  try {
    await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
      name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
    for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql', '086_saas_subscription_event_contract_outcome.sql', '087_saas_billing_runtime_state.sql', '088_saas_billing_effects_reconciliation.sql']) {
      await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
      if (name.startsWith('088_')) await require('./helpers/billing-v2-fixture').activateFixture(pool);
    }
    await pool.query(`CREATE TABLE mutation_audit (kind TEXT NOT NULL);
      CREATE FUNCTION count_bridge_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO mutation_audit(kind) VALUES (TG_ARGV[0]); RETURN NEW; END $$;
      CREATE TRIGGER subscription_effect AFTER UPDATE ON saas_subscriptions FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('subscription');
      CREATE TRIGGER tenant_effect AFTER UPDATE ON clinics FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('tenant');
      CREATE TRIGGER event_effect AFTER UPDATE ON saas_subscription_events FOR EACH ROW EXECUTE FUNCTION count_bridge_mutation('event');`);
    // A. Permanent rollback protocol invariants: unchanged refusal and terminal checks.
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
    await scenario('H: invalid signature stops before any bridge service/DB access', async () => {
      await seedEvent('failed', marker); const before = await event();
      assert.equal((await deliver({ valid: false })).status, 401);
      assert.equal(bridgeEntries, 0); assert.deepEqual(trace, []); assert.deepEqual(provider.gets, []);
      assert.deepEqual(await event(), before); await assertBusinessMutations(0);
      assert.equal(logs.some(l => l.event === blockedLog), false);
    });
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
    useBridge = false;
    // B. Combined-runtime compatibility: no false bridge guard and no bypass of 6C.
    for (const [code, status] of [['F', 'failed'], ['G', 'received'], ['G', 'processing']]) {
      await scenario(`${code}: unmarked ${status} passes the full 6C chain and applies once`, async () => {
        await seedEvent(status, status === 'failed' ? 'webhook_processing_failed' : null);
        if (status === 'processing') await pool.query(`UPDATE saas_subscription_events SET "updatedAt"=NOW()-interval '1 minute'`);
        const before = await event();
        await assertProcessed(await deliver()); assert.equal((await event()).id, before.id);
        await assertProcessedDuplicate();
      });
      for (const missing of ['native contract', 'cadence', 'matching amount']) {
        await scenario(`${code}: unmarked ${status} cannot bypass 6C without ${missing}`, async () => {
          if (missing === 'native contract') {
            await pool.query('UPDATE saas_subscriptions SET metadata=metadata-\'contract\' WHERE id=$1', [subscription.id]);
          } else if (missing === 'cadence') {
            delete provider.preapproval.auto_recurring.frequency;
          } else {
            provider.payment.transaction_amount = 1;
          }
          await seedEvent(status, status === 'failed' ? 'webhook_processing_failed' : null);
        if (status === 'processing') await pool.query(`UPDATE saas_subscription_events SET "updatedAt"=NOW()-interval '1 minute'`);
          const before = await event(); const beforeBusiness = await business();
          await assertProofOutcome(await deliver(), beforeBusiness,
            missing === 'matching amount' ? 'contract_rejected' : 'manual_review',
            missing === 'native contract' ? 'legacy_contract_unknown'
              : missing === 'cadence' ? 'provider_relationship_unproven' : 'contract_amount_mismatch');
          assert.equal((await event()).id, before.id);
        });
      }
    }
    for (const [label, value] of [['I', claim.replace(claimId, 'bad-uuid')], ['J', marker.replace('v2:', 'v20:')]]) {
      await scenario(`${label}: invalid marker proceeds through full 6C proof without false protection`, async () => {
        await seedEvent('failed', value);
        await assertProcessed(await deliver()); await assertProcessedDuplicate();
      });
      await scenario(`${label}: invalid marker cannot bypass missing cadence review`, async () => {
        delete provider.preapproval.auto_recurring.frequency_type;
        await seedEvent('failed', value); const beforeBusiness = await business();
        await assertProofOutcome(await deliver(), beforeBusiness, 'manual_review', 'provider_relationship_unproven');
      });
    }
    await scenario('Provider payload cannot create an internal marker or skip the full 6C chain', async () => {
      payload.processingError = marker; payload.metadata = { processingError: marker };
      await assertProcessed(await deliver()); await assertProcessedDuplicate();
    });
    await scenario('Provider payload marker cannot bypass a proven contract contradiction', async () => {
      payload.processingError = marker; payload.metadata = { processingError: marker };
      provider.payment.transaction_amount = 1;
      const beforeBusiness = await business();
      await assertProofOutcome(await deliver(), beforeBusiness, 'contract_rejected', 'contract_amount_mismatch');
    });
    await scenario('N: unmarked BILL-004 reservation recovery remains available', async () => {
      // Original intent is successful recovery of a claimed ordinary monthly subscription.
      await seedRecovery(); const before = await business();
      await assertProcessed(await deliver(), ['preapproval:mp-1'], false);
      const row = (await business()).subscription;
      assert.equal(row.provisioningState, 'ready'); assert.equal(row.mercadoPagoPreapprovalId, 'mp-1');
      assert.deepEqual(row.providerCallStartedAt, before.subscription.providerCallStartedAt);
      await assertProcessedDuplicate();
    });
    await scenario('N: incomplete recovery proof preserves the claim and requires manual review', async () => {
      delete provider.preapproval.auto_recurring.frequency;
      await seedRecovery(); const beforeBusiness = await business();
      await assertProofOutcome(await deliver(), beforeBusiness, 'manual_review', 'provider_relationship_unproven', ['preapproval:mp-1']);
    });
    for (const kind of ['payment', 'search']) {
      await scenario(`O: unmarked BILL-005 transient ${kind} failure retries to one proven application`, async () => {
        provider.fail = kind; const beforeBusiness = await business();
        assert.equal((await deliver()).status, 503); const before = await event();
        assert.equal(before.processingStatus, 'failed'); assert.equal(require('../../src/services/saas-billing-rollback-marker').isBillingContractV2Marker(before.processingError), true);
        assert.equal(before.contractOutcome, null); assert.deepEqual(before.raw, payload);
        assert.deepEqual(await business(), beforeBusiness); await assertBusinessMutations(0);
        const failedReads = kind === 'payment' ? ['payment:pay-1'] : ['payment:pay-1', 'search:pay-1'];
        assertNormalPipeline(failedReads);
        provider.fail = false;
        await assertProcessed(await deliver(), [...failedReads, ...paymentReads]);
        assert.equal((await event()).id, before.id); await assertProcessedDuplicate();
      });
    }
    await scenario('Unrelated Payment: weak matching metadata cannot replace a missing authorized invoice', async () => {
      // Deliberately unrelated: do not fabricate a canonical invoice for weak local-looking hints.
      provider.search = { paging: { offset: 0, limit: 2, total: 0 }, results: [] }; provider.invoice = null;
      provider.payment.metadata = { preapproval_id: 'mp-1', subscription_id: subscription.id };
      const beforeBusiness = await business();
      const response = await deliver(); const row = await event();
      assert.equal(response.status, 200); assert.equal(row.processingStatus, 'ignored');
      assert.equal(row.processingError, 'authorized_invoice_not_found'); assert.equal(row.contractOutcome, null);
      assert.deepEqual(row.raw, payload); assert.deepEqual(await business(), beforeBusiness);
      await assertBusinessMutations(0); assertNormalPipeline(['payment:pay-1', 'search:pay-1']);
    });
    for (const resource of ['invoice', 'payment']) {
      await scenario(`Incomplete ${resource} currency cannot authorize an unmarked Payment`, async () => {
        delete provider[resource].currency_id;
        const beforeBusiness = await business();
        await assertProofOutcome(await deliver(), beforeBusiness, 'manual_review', 'provider_relationship_unproven');
      });
    }
    await scenario('Canonical invoice identity contradiction cannot authorize an unmarked Payment', async () => {
      provider.invoice.payment.id = 'other-payment'; const beforeBusiness = await business();
      await assertProofOutcome(await deliver(), beforeBusiness, 'contract_rejected', 'provider_identity_mismatch',
        ['payment:pay-1', 'search:pay-1', 'invoice:invoice-1']);
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
