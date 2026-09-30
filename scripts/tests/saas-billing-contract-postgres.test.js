const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { captureLocalBillingContract, resolveLocalBillingContract } = require('../../src/services/saas-billing-contract');

test('BILL-006A: immutable local contract with real PostgreSQL and mocked provider', async (t) => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'billing_test');
  assert.equal(url.password, '');
  const schema = `contract_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 10 });
  const root = path.resolve(__dirname, '../..');
  const modules = new Map();
  const originalFetch = global.fetch;
  let beforeTransaction;
  function stub(name, exports) {
    const id = require.resolve(path.join(root, name));
    modules.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  t.after(async () => {
    global.fetch = originalFetch;
    for (const [id, saved] of modules) { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  global.fetch = async () => { throw new Error('network_forbidden_in_contract_test'); };
  stub('src/db/client.js', {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async (fn) => {
      if (beforeTransaction) await beforeTransaction();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  });
  stub('src/config/env.js', { nodeEnv: 'test' });
  stub('src/utils/logger.js', { logInfo() {}, logWarn() {}, logError() {} });
  stub('src/services/saas-billing-email.service.js', {
    sendBillingSubscriptionAuthorizationEmail() { throw new Error('email_forbidden'); }
  });
  let provider;
  const realProvider = require(path.join(root, 'src/services/mercado-pago.service.js'));
  stub('src/services/mercado-pago.service.js', {
    ...realProvider,
    createPreapproval: async (payload) => {
      provider.calls.push(payload);
      // Independent connection sees committed local expectation BEFORE mock POST.
      const row = (await pool.query('SELECT * FROM saas_subscriptions WHERE "externalReference"=$1', [payload.externalReference])).rows[0];
      assert.ok(row);
      assert.equal(row.provisioningState, 'provider_call_started');
      const resolved = resolveLocalBillingContract(row);
      assert.equal(resolved.status, 'KNOWN');
      assert.equal(resolved.source, 'contract', 'legacy evidence alone cannot authorize a provider POST');
      assert.ok(row.metadata.contract, 'native contract must already be durable');
      provider.captured.push(structuredClone(row.metadata.contract));
      provider.remote = { id: 'mp-contract', status: 'pending', external_reference: payload.externalReference,
        init_point: 'https://example.invalid/checkout',
        auto_recurring: { transaction_amount: payload.amount, currency_id: payload.currency } };
      if (provider.onCreate) await provider.onCreate(payload);
      return provider.remote;
    },
    getPreapproval: async () => provider.remote,
    getPayment: async () => provider.payment
  });
  const repository = require(path.join(root, 'src/repositories/saas-subscriptions.repository.js'));
  const service = require(path.join(root, 'src/services/saas-billing.service.js'));
  const clinicId = '00000000-0000-4000-8000-000000000001';
  const input = { tenantId: 'tenant-contract', planCode: 'inicial', payerEmail: 'payer@example.invalid' };
  await pool.query(`CREATE TABLE clinics (id UUID PRIMARY KEY, "externalTenantId" TEXT UNIQUE,
    name TEXT, timezone TEXT, settings JSONB DEFAULT '{}', "updatedAt" TIMESTAMPTZ DEFAULT NOW())`);
  for (const name of ['050_saas_subscriptions_phase1.sql', '085_saas_subscription_provisioning.sql']) {
    await pool.query(fs.readFileSync(path.join(root, 'db/migrations', name), 'utf8'));
  }
  const row = async () => (await pool.query('SELECT * FROM saas_subscriptions')).rows[0];
  const create = (extra = {}) => service.createSaasSubscriptionForTenant({ ...input, ...extra });
  const scenario = (name, run) => t.test(name, async () => {
    await pool.query('TRUNCATE saas_subscription_events, saas_subscriptions, clinics CASCADE');
    await pool.query('INSERT INTO clinics(id,"externalTenantId") VALUES ($1,$2)', [clinicId, input.tenantId]);
    provider = { calls: [], captured: [] };
    beforeTransaction = null;
    await run();
  });
  async function sameContract(expected) { assert.deepEqual((await row()).metadata.contract, expected); }
  async function seedReserved(edit = () => {}) {
    const id = crypto.randomUUID();
    const seed = { id, clinicId, externalTenantId: input.tenantId, planCode: input.planCode,
      amount: 10000, currency: 'ARS', billingInterval: 'monthly', localStatus: 'pending',
      provisioningState: 'reserved', mercadoPagoPayerEmail: input.payerEmail,
      externalReference: `opturon:${input.tenantId}:${id}`,
      metadata: { billingModel: 'pending_link',
        plan: { code: input.planCode, label: 'Plan Inicial', amount: 10000, currency: 'ARS' } } };
    seed.metadata.contract = captureLocalBillingContract({ plan: seed.metadata.plan, subscriptionId: id,
      clinicId, externalTenantId: seed.externalTenantId, externalReference: seed.externalReference,
      capturedAt: '2026-09-01T00:00:00.000Z' });
    edit(seed);
    return repository.insertSaasSubscription(seed);
  }
  async function webhook(topic = 'subscription_preapproval') {
    return service.processMercadoPagoWebhook({ id: crypto.randomUUID(), type: topic, action: 'updated',
      data: { id: topic === 'payment' ? provider.payment.id : provider.remote.id } }, { signatureValid: true });
  }

  await scenario('CASE A: initial plan contract is committed before provider and retained', async () => {
    const result = await create();
    assert.equal(result.ok, true);
    const contract = provider.captured[0];
    assert.deepEqual(contract, {
      version: 1, source: 'backend_plan_catalog', planCode: 'inicial', amount: '40600.00', currency: 'ARS',
      frequency: 1, frequencyType: 'months', billingInterval: 'monthly', capturedAt: contract.capturedAt,
      subscriptionId: result.subscription.id, clinicId, externalTenantId: input.tenantId,
      externalReference: `opturon:${input.tenantId}:${result.subscription.id}`, profile: 'ordinary_recurring'
    });
    assert.ok(Number.isFinite(Date.parse(contract.capturedAt)));
    await sameContract(contract);
    assert.equal((await row()).metadata.plan.amount, 40600);
  });
  await scenario('CASE B: second plan captures its own backend catalogue values', async () => {
    assert.equal((await create({ planCode: 'crecimiento' })).ok, true);
    assert.equal(provider.captured[0].amount, '68600.00');
    assert.equal(provider.captured[0].planCode, 'crecimiento');
    await sameContract(provider.captured[0]);
  });
  await scenario('CASE C: frontend cannot override expected values or contract identity', async () => {
    await create({ amount: 1, currency: 'USD', externalTenantId: 'other', externalReference: 'forged',
      metadata: { contract: { amount: '1.00', externalTenantId: 'other' } } });
    assert.equal(provider.captured[0].amount, '40600.00');
    assert.equal(provider.captured[0].currency, 'ARS');
    assert.equal(provider.captured[0].externalTenantId, input.tenantId);
    assert.equal(provider.captured[0].clinicId, clinicId);
  });
  await scenario('CASE D: provider amount may change compatibility field, never the contract', async () => {
    provider.onCreate = async () => { provider.remote.auto_recurring.transaction_amount = 1; };
    await create();
    assert.equal(Number((await row()).amount), 1);
    assert.equal(provider.captured[0].amount, '40600.00');
    await sameContract(provider.captured[0]);
  });
  await scenario('CASE E: provider currency may change compatibility field, never the contract', async () => {
    provider.onCreate = async () => { provider.remote.auto_recurring.currency_id = 'USD'; };
    await create();
    assert.equal((await row()).currency, 'USD');
    await sameContract(provider.captured[0]);
  });
  await scenario('CASE F: metadata merge preserves contract, plan and remote observations', async () => {
    const created = await create();
    await repository.updateSaasSubscriptionById(created.subscription.id, { metadata: { mercadoPagoPreapproval: { observed: true }, note: 'local' } });
    const saved = await row();
    assert.deepEqual(saved.metadata.mercadoPagoPreapproval, { observed: true });
    assert.equal(saved.metadata.plan.code, 'inicial');
    await sameContract(provider.captured[0]);
  });
  await scenario('CASE G: uncertain provider failure retains durable expectation and prevents another POST', async () => {
    provider.onCreate = async () => { throw new Error('mock_provider_timeout'); };
    await assert.rejects(create(), /mock_provider_timeout/);
    assert.equal((await row()).provisioningState, 'reconciliation_required');
    await sameContract(provider.captured[0]);
    assert.equal((await create()).status, 409);
    assert.equal(provider.calls.length, 1);
  });
  await scenario('CASE H: concurrent creates capture once and call provider once', async () => {
    let release; let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    provider.onCreate = async () => { entered(); await gate; };
    const first = create();
    await started;
    let competing;
    try { competing = await Promise.all(Array.from({ length: 5 }, () => create())); }
    finally { release(); }
    assert.ok(competing.every(result => result.status === 409));
    assert.equal((await first).ok, true);
    assert.equal(provider.calls.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscriptions')).rows[0].n, 1);
    await sameContract(provider.captured[0]);
    await create();
    await sameContract(provider.captured[0]);
    assert.equal(provider.calls.length, 1);
  });
  await scenario('B1: pre-6A reserved row stays unchanged and cannot POST or backfill on concurrent retries', async () => {
    const seeded = await seedReserved(seed => { delete seed.metadata.contract; });
    assert.equal(resolveLocalBillingContract(seeded).status, 'KNOWN');
    assert.equal(resolveLocalBillingContract(seeded).source, 'legacy_metadata_plan');
    const before = await row();
    const results = await Promise.all(Array.from({ length: 6 }, () => create({ metadata: {
      contract: { version: 1, source: 'backend_plan_catalog' } } })));
    assert.ok(results.every(result => result.status === 409 && result.reason === 'subscription_contract_required'));
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(await row(), before);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscriptions')).rows[0].n, 1);
  });
  await scenario('B1: reserved rows with malformed or conflicting native contracts fail before claim', async () => {
    const changes = [() => null, () => ({}), contract => ({ ...contract, version: 2 }),
      contract => ({ ...contract, source: 'provider' }), contract => ({ ...contract, amount: '1.001' }),
      contract => ({ ...contract, currency: '' }), contract => ({ ...contract, frequency: 2 }),
      contract => ({ ...contract, capturedAt: 'invalid' }), contract => ({ ...contract, planCode: 'empresa' }),
      contract => ({ ...contract, clinicId: crypto.randomUUID() }),
      contract => ({ ...contract, externalTenantId: 'other-tenant' }),
      contract => ({ ...contract, subscriptionId: crypto.randomUUID() }),
      contract => ({ ...contract, externalReference: `opturon:other-tenant:${contract.subscriptionId}` })];
    for (const change of changes) {
      await pool.query('TRUNCATE saas_subscriptions CASCADE');
      await seedReserved(seed => { seed.metadata.contract = change(seed.metadata.contract); });
      const before = await row();
      const result = await create();
      assert.equal(result.status, 409);
      assert.equal(result.reason, 'subscription_contract_required');
      assert.equal(provider.calls.length, 0);
      assert.deepEqual(await row(), before, 'invalid row must not be claimed, rewritten or backfilled');
    }
  });
  await scenario('B1: claim validates the current locked row instead of an earlier reservation snapshot', async () => {
    const seeded = await seedReserved();
    let transactions = 0;
    beforeTransaction = async () => {
      if (++transactions === 2) await repository.updateSaasSubscriptionById(seeded.id, { planCode: 'empresa' });
    };
    const result = await create();
    assert.equal(result.status, 409);
    assert.equal(result.reason, 'subscription_contract_required');
    assert.equal(provider.calls.length, 0);
    assert.equal((await row()).provisioningState, 'reserved');
    assert.equal((await row()).providerCallStartedAt, null);
    await sameContract(seeded.metadata.contract);
  });
  await scenario('B1: a valid durable reserved contract resumes once without recapture or repricing', async () => {
    const seeded = await seedReserved();
    let release; let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    provider.onCreate = async () => { entered(); await gate; };
    const first = create();
    await started;
    let competing;
    try { competing = await Promise.all(Array.from({ length: 5 }, () => create())); }
    finally { release(); }
    assert.ok(competing.every(result => result.status === 409));
    assert.equal((await first).subscription.id, seeded.id);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].amount, 10000);
    assert.deepEqual(provider.captured[0], seeded.metadata.contract);
    await sameContract(seeded.metadata.contract);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM saas_subscriptions')).rows[0].n, 1);
    assert.equal((await create()).ok, true);
    assert.equal(provider.calls.length, 1);
  });
  await scenario('CASE Q: generic replacement/deletion/concurrent patches cannot change or backfill contract', async () => {
    const created = await create();
    for (const metadata of [{ contract: { amount: '1.00' }, keep: true }, { contract: null },
      [{ contract: 'array' }], 'scalar']) {
      await repository.updateSaasSubscriptionById(created.subscription.id, { metadata });
      await sameContract(provider.captured[0]);
    }
    await Promise.all([1, 2].map(n => repository.updateSaasSubscriptionById(created.subscription.id,
      { metadata: { contract: { version: n }, [`note${n}`]: n } })));
    await sameContract(provider.captured[0]);
    const saved = await row();
    assert.equal(saved.metadata.keep, true); assert.equal(saved.metadata.note1, 1); assert.equal(saved.metadata.note2, 2);
    // Simulate a historical row in this disposable schema only.
    await pool.query("UPDATE saas_subscriptions SET metadata=metadata-'contract' WHERE id=$1", [created.subscription.id]);
    await repository.updateSaasSubscriptionById(created.subscription.id, { metadata: { contract: provider.captured[0] } });
    assert.equal(Object.hasOwn((await row()).metadata, 'contract'), false);
  });
  await scenario('CASE Q1 / G1: empty metadata and deleting contract from a full metadata patch cannot erase it', async () => {
    const created = await create();
    await repository.updateSaasSubscriptionById(created.subscription.id, { metadata: {} });
    await sameContract(provider.captured[0]);
    const metadata = structuredClone((await row()).metadata);
    delete metadata.contract;
    metadata.deletionAttempt = 'contract omitted from replacement object';
    await repository.updateSaasSubscriptionById(created.subscription.id, { metadata });
    await sameContract(provider.captured[0]);
    assert.equal((await row()).metadata.deletionAttempt, metadata.deletionAttempt);
  });
  await scenario('CASE Q2 / G1: omitted, undefined or null metadata never deletes the contract', async () => {
    const created = await create();
    for (const patch of [{}, { metadata: undefined }, { metadata: null },
      { metadata: { contract: undefined, omissionAttempt: true } }]) {
      await repository.updateSaasSubscriptionById(created.subscription.id, patch);
      await sameContract(provider.captured[0]);
    }
    assert.equal((await row()).metadata.omissionAttempt, true);
  });
  await scenario('CASE R: provider refresh and both webhook branches keep contract intact', async () => {
    await create();
    provider.remote = { ...provider.remote, status: 'authorized', contract: { amount: '1.00' },
      metadata: { contract: { currency: 'USD' } }, auto_recurring: { transaction_amount: 2, currency_id: 'USD' } };
    assert.equal((await service.refreshSubscriptionFromMercadoPagoByPreapprovalId(provider.remote.id)).ok, true);
    await sameContract(provider.captured[0]);
    assert.equal((await webhook()).ok, true);
    await sameContract(provider.captured[0]);
    provider.payment = { id: 'payment-contract', status: 'approved', preapproval_id: provider.remote.id,
      external_reference: provider.remote.external_reference, metadata: { contract: null } };
    assert.equal((await webhook('payment')).ok, true);
    await sameContract(provider.captured[0]);
    const saved = await row();
    assert.ok(saved.metadata.mercadoPagoPreapproval);
    assert.ok(saved.metadata.mercadoPagoPayment);
    assert.equal(saved.lastPaymentId, 'payment-contract');
  });
  await scenario('CASE S: all existing lifecycle updates preserve expectation', async () => {
    const created = await create();
    for (const localStatus of ['pending', 'active', 'paused', 'payment_failed', 'suspended', 'canceled']) {
      await repository.updateSaasSubscriptionById(created.subscription.id, { localStatus });
      assert.equal((await row()).localStatus, localStatus);
      await sameContract(provider.captured[0]);
    }
  });
  await scenario('CASE T: BILL-004 recovery links missing provider ID without changing contract', async () => {
    provider.onCreate = async () => { throw new Error('mock_lost_provider_response'); };
    await assert.rejects(create(), /mock_lost_provider_response/);
    assert.equal((await row()).mercadoPagoPreapprovalId, null);
    provider.remote.status = 'authorized';
    assert.equal((await webhook()).ok, true);
    const recovered = await row();
    assert.equal(recovered.mercadoPagoPreapprovalId, provider.remote.id);
    assert.equal(recovered.provisioningState, 'ready');
    assert.equal(recovered.localStatus, 'active');
    await sameContract(provider.captured[0]);
    assert.equal(provider.calls.length, 1);
  });
});
