const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  executeSubscriptionAction,
  __internal
} = require('../../src/services/saas-billing.service');

const SUBSCRIPTION_ID = '5bf4a207-e973-46aa-b84b-fe2134710748';
const PREAPPROVAL_ID = '3918fcf48bc84c52ab6b88e2a6f880db';
const TENANT_ID = 'tenant_guadaluipe_villarreal_mpp58vxs';
const EXTERNAL_REFERENCE = `opturon:${TENANT_ID}:${SUBSCRIPTION_ID}`;

function buildSubscription(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    clinicId: 'clinic-1',
    externalTenantId: TENANT_ID,
    planCode: 'crecimiento',
    amount: 68600,
    currency: 'ARS',
    billingInterval: 'monthly',
    mercadoPagoPreapprovalId: PREAPPROVAL_ID,
    mercadoPagoStatus: 'pending',
    localStatus: 'pending',
    externalReference: EXTERNAL_REFERENCE,
    metadata: {},
    ...overrides
  };
}

function buildRemote(status, overrides = {}) {
  return {
    id: PREAPPROVAL_ID,
    external_reference: EXTERNAL_REFERENCE,
    status,
    auto_recurring: { transaction_amount: 68600, currency_id: 'ARS' },
    ...overrides
  };
}

function buildHarness(options = {}) {
  let stored = buildSubscription(options.subscription);
  const calls = { read: 0, cancel: 0, pause: 0, reactivate: 0, update: 0, sync: 0, audit: 0 };
  const dependencies = {
    findSaasSubscriptionById: async () => stored,
    findClinicByExternalTenantId: async (tenantId) => tenantId === TENANT_ID ? { id: 'clinic-1', settings: {} } : null,
    getPreapproval: async () => {
      calls.read += 1;
      if (options.readError) throw options.readError;
      return options.remote || buildRemote('pending');
    },
    cancelPreapproval: async () => {
      calls.cancel += 1;
      if (options.cancelError) throw options.cancelError;
      return options.actionRemote || buildRemote('canceled');
    },
    pausePreapproval: async () => {
      calls.pause += 1;
      return options.actionRemote || buildRemote('paused');
    },
    reactivatePreapproval: async () => {
      calls.reactivate += 1;
      return options.actionRemote || buildRemote('authorized');
    },
    withTransaction: async (callback) => callback({ query: async () => ({ rows: [] }) }),
    updateSaasSubscriptionById: async (_id, patch) => {
      calls.update += 1;
      stored = { ...stored, ...patch, metadata: { ...stored.metadata, ...(patch.metadata || {}) } };
      return stored;
    },
    syncTenantBillingState: async () => { calls.sync += 1; },
    insertSubscriptionEvent: async (event) => {
      calls.audit += 1;
      calls.lastAudit = event;
      return { id: 'audit-1' };
    }
  };
  return { dependencies, calls, getStored: () => stored };
}

test('pending remote + cancel success reconciles to canceled', async () => {
  const harness = buildHarness();
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.providerActionApplied, true);
  assert.equal(result.subscription.localStatus, 'canceled');
  assert.equal(harness.calls.read, 1);
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.audit, 1);
  assert.equal(harness.calls.lastAudit.raw.eventType, 'BILLING_SUBSCRIPTION_CANCELED');
  assert.notEqual(harness.calls.lastAudit.raw.eventType, 'CLIENT_SUSPENDED');
});

test('billing reconciliation emits a billing event, never a client lifecycle event', async () => {
  const harness = buildHarness({
    subscription: { localStatus: 'active', mercadoPagoStatus: 'authorized' },
    remote: buildRemote('authorized'),
    actionRemote: buildRemote('paused')
  });
  await executeSubscriptionAction(SUBSCRIPTION_ID, 'pause', harness.dependencies);
  assert.equal(harness.calls.lastAudit.raw.eventType, 'BILLING_RECONCILED');
  assert.doesNotMatch(harness.calls.lastAudit.raw.eventType, /^CLIENT_/);
});

test('authorized + cancel is allowed', async () => {
  const harness = buildHarness({
    subscription: { localStatus: 'active', mercadoPagoStatus: 'authorized' },
    remote: buildRemote('authorized')
  });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(harness.calls.cancel, 1);
});

test('authorized + pause and paused + reactivate follow the action matrix', async () => {
  const active = buildHarness({
    subscription: { localStatus: 'active', mercadoPagoStatus: 'authorized' },
    remote: buildRemote('authorized'),
    actionRemote: buildRemote('paused')
  });
  const pausedResult = await executeSubscriptionAction(SUBSCRIPTION_ID, 'pause', active.dependencies);
  assert.equal(pausedResult.subscription.localStatus, 'paused');
  assert.equal(active.calls.pause, 1);

  const paused = buildHarness({
    subscription: { localStatus: 'paused', mercadoPagoStatus: 'paused' },
    remote: buildRemote('paused'),
    actionRemote: buildRemote('authorized')
  });
  const activeResult = await executeSubscriptionAction(SUBSCRIPTION_ID, 'reactivate', paused.dependencies);
  assert.equal(activeResult.subscription.localStatus, 'active');
  assert.equal(paused.calls.reactivate, 1);
});

test('already canceled is reconciled without another provider mutation', async () => {
  const harness = buildHarness({ remote: buildRemote('canceled') });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.providerActionApplied, false);
  assert.equal(result.subscription.localStatus, 'canceled');
  assert.equal(harness.calls.cancel, 0);
});

test('remote state wins over stale local state before a valid action', async () => {
  const harness = buildHarness({
    subscription: { localStatus: 'canceled', mercadoPagoStatus: 'canceled' },
    remote: buildRemote('authorized')
  });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'pause', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.subscription.localStatus, 'paused');
  assert.equal(harness.calls.pause, 1);
});

test('expired remote status maps to an existing terminal local status', async () => {
  const harness = buildHarness({ remote: buildRemote('expired') });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.subscription.localStatus, 'canceled');
  assert.deepEqual(result.subscription.availableActions, []);
});

test('remote not found preserves history and marks existing status suspended', async () => {
  const error = Object.assign(new Error('not found'), { status: 404, body: { message: 'not found' } });
  const harness = buildHarness({ readError: error });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.subscription.localStatus, 'suspended');
  assert.equal(harness.calls.update, 1);
  assert.equal(harness.calls.audit, 1);
});

test('invalid stale preapproval ID is reconciled as unavailable', async () => {
  const error = Object.assign(new Error('Invalid preapproval id'), { status: 400, body: { message: 'Invalid preapproval id' } });
  const harness = buildHarness({ readError: error });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.subscription.mercadoPagoStatus, 'unavailable');
  assert.deepEqual(result.subscription.availableActions, []);
});

test('Mercado Pago 400 on unaccepted pending intent closes only the local record with audit', async () => {
  const error = Object.assign(new Error('Invalid state transition'), {
    status: 400,
    code: 'mercadopago_invalid_payload',
    body: { message: 'Invalid state transition' }
  });
  const harness = buildHarness({ cancelError: error });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.providerActionApplied, false);
  assert.equal(result.subscription.localStatus, 'canceled');
  assert.equal(result.subscription.mercadoPagoStatus, 'pending');
  assert.equal(result.subscription.metadata.billingReconciliation.disposition, 'pending_authorization_closed_locally');
  assert.equal(harness.calls.lastAudit.raw.upstreamStatus, 400);
});

test('credential/app failure fails closed and does not rewrite local billing', async () => {
  const error = Object.assign(new Error('forbidden'), { status: 403, code: 'mercadopago_credentials_invalid' });
  const harness = buildHarness({ readError: error });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'billing_provider_unavailable');
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.cancel, 0);
});

test('cross-tenant/provider reference mismatch fails closed', async () => {
  const harness = buildHarness({ remote: buildRemote('authorized', { external_reference: 'opturon:another-tenant:other' }) });
  const result = await executeSubscriptionAction(SUBSCRIPTION_ID, 'cancel', harness.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'billing_subscription_remote_mismatch');
  assert.equal(harness.calls.cancel, 0);
  assert.equal(harness.calls.update, 0);
});

test('unknown status exposes no actions', () => {
  assert.deepEqual(__internal.availableSubscriptionActions('unknown', 'pending'), []);
  assert.deepEqual(__internal.availableSubscriptionActions('authorized', 'active'), ['pause', 'cancel']);
  assert.deepEqual(__internal.availableSubscriptionActions('paused', 'paused'), ['reactivate', 'cancel']);
});

test('implementation neither creates duplicate subscriptions nor deletes history', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/saas-billing.service.js'), 'utf8');
  const actionBody = source.slice(source.indexOf('async function executeSubscriptionAction'), source.indexOf('async function refreshSubscriptionFromMercadoPagoByPreapprovalId'));
  assert.doesNotMatch(actionBody, /createPreapproval|createSaasSubscriptionForTenant|DELETE\s+FROM/i);
  assert.match(actionBody, /getPreapproval/);
  assert.match(actionBody, /persistSubscriptionReconciliation/);
  assert.match(source, /async function persistSubscriptionReconciliation[\s\S]*insertSubscriptionEvent/);
});

test('creation guard prevents a duplicate non-terminal subscription', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/saas-billing.service.js'), 'utf8');
  const createBody = source.slice(source.indexOf('async function createSaasSubscriptionForTenant'), source.indexOf('async function getSaasSubscriptionDetails'));
  assert.match(createBody, /findLatestSaasSubscriptionByTenantId/);
  assert.match(createBody, /billing_subscription_already_exists/);
});

test('Mercado Pago reactivation uses authorized, never pending', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/mercado-pago.service.js'), 'utf8');
  const reactivateBody = source.slice(source.indexOf('async function reactivatePreapproval'), source.indexOf('async function getPayment'));
  assert.match(reactivateBody, /status: 'authorized'/);
  assert.doesNotMatch(reactivateBody, /status: 'pending'/);
});
