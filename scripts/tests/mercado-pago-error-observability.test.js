const assert = require('assert');
const Module = require('module');

process.env.MERCADO_PAGO_ACCESS_TOKEN = 'test-token';

const originalFetch = global.fetch;
const mercadoPago = require('../../src/services/mercado-pago.service');

function response(status, statusText, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => text
  };
}

async function expectUpdateError(body, statusText = 'Bad Request', headers = {}) {
  global.fetch = async () => response(400, statusText, body, headers);
  try {
    await mercadoPago.updatePreapproval('preapproval-test', { status: 'canceled' });
    assert.fail('expected Mercado Pago update to fail');
  } catch (error) {
    return error;
  }
}

async function testJsonErrorFields() {
  const error = await expectUpdateError(
    { error: 'bad_request', code: 'PA_INVALID_STATE', message: 'Cannot cancel', status: 400 },
    'Bad Request',
    { 'x-request-id': 'req-123' }
  );
  assert.equal(error.status, 400);
  assert.equal(error.statusText, 'Bad Request');
  assert.equal(error.providerDiagnostic.providerError, 'bad_request');
  assert.equal(error.providerDiagnostic.providerErrorCode, 'PA_INVALID_STATE');
  assert.equal(error.providerDiagnostic.providerErrorMessage, 'Cannot cancel');
  assert.equal(error.providerDiagnostic.providerErrorStatus, '400');
  assert.equal(error.providerDiagnostic.providerRequestId, 'req-123');
  assert.equal(error.message, 'mercadopago_request_failed_400');
}

async function testCauseDetails() {
  const error = await expectUpdateError({
    cause: [{ code: 'state_error', description: 'Invalid current state' }],
    causes: [{ code: 'secondary', description: 'Additional detail' }],
    details: { reason: 'not cancellable', nested: ['safe'] }
  });
  assert.equal(error.providerDiagnostic.providerCause[0].code, 'state_error');
  assert.equal(error.providerDiagnostic.providerCauses[0].code, 'secondary');
  assert.equal(error.providerDiagnostic.providerDetails.reason, 'not cancellable');
}

async function testUnknownJsonAndTextFallbacks() {
  const jsonError = await expectUpdateError({ unexpected: { explanation: 'provider shape changed' } });
  assert.match(jsonError.providerDiagnostic.providerResponseSummary, /provider shape changed/);

  const textError = await expectUpdateError('<html>provider failure</html>');
  assert.equal(textError.providerDiagnostic.providerResponseSummary, '<html>provider failure</html>');
}

async function testRedactionAndBounds() {
  const longSecret = 'x'.repeat(5000);
  const error = await expectUpdateError({
    message: `Authorization: Bearer secret password=${longSecret} user=person@example.com`,
    access_token: 'never-propagate',
    payer_email: 'person@example.com',
    details: longSecret
  });
  const serialized = JSON.stringify(error.providerDiagnostic);
  assert.ok(!serialized.includes('never-propagate'));
  assert.ok(!serialized.includes('person@example.com'));
  assert.ok(!serialized.includes('Bearer secret'));
  assert.ok(error.providerDiagnostic.providerResponseSummary.length <= 2001);
  assert.ok(error.providerDiagnostic.body.details === '[REDACTED]' || error.providerDiagnostic.body.details.length <= 501);
}

async function testHttp200Unaffected() {
  global.fetch = async () => response(200, 'OK', { id: 'preapproval-test', status: 'pending' });
  const result = await mercadoPago.updatePreapproval('preapproval-test', { status: 'pending' });
  assert.deepEqual(result, { id: 'preapproval-test', status: 'pending' });
}

async function testCancellationFailureLeavesSubscriptionUnchanged() {
  const subscription = {
    id: 'subscription-test',
    externalTenantId: 'tenant-test',
    mercadoPagoPreapprovalId: 'preapproval-test',
    localStatus: 'pending'
  };
  let updateCalls = 0;
  let logged = null;
  const mocks = new Map([
    ['../db/client', { withTransaction: async (callback) => callback({}) }],
    ['../repositories/tenant.repository', { findClinicByExternalTenantId: async () => ({ id: 'clinic-test', settings: '{}' }) }],
    ['../repositories/saas-subscriptions.repository', {
      findSaasSubscriptionById: async () => subscription,
      updateSaasSubscriptionById: async () => { updateCalls += 1; return { ...subscription, localStatus: 'canceled' }; },
      findLatestSaasSubscriptionByTenantId: async () => null,
      findSaasSubscriptionByPreapprovalId: async () => null,
      findSaasSubscriptionByExternalReference: async () => null,
      listSaasSubscriptions: async () => [],
      insertSaasSubscription: async () => null,
      insertSubscriptionEvent: async () => null,
      updateSubscriptionEventStatus: async () => null
    }],
    ['./mercado-pago.service', {
      createPreapproval: async () => null,
      getPreapproval: async () => null,
      pausePreapproval: async () => null,
      cancelPreapproval: async () => {
        const error = new Error('mercadopago_request_failed_400');
        error.status = 400;
        error.providerDiagnostic = {
          providerHttpStatus: 400,
          providerStatusText: 'Bad Request',
          providerError: 'bad_request',
          providerErrorCode: 'PA_INVALID_STATE',
          providerErrorMessage: 'Cannot cancel',
          providerErrorStatus: '400',
          providerCause: [{ code: 'state_error' }],
          providerCauses: null,
          providerDetails: null,
          providerResponseSummary: '{"error":"bad_request"}',
          providerRequestId: 'req-123'
        };
        throw error;
      },
      reactivatePreapproval: async () => null,
      getPayment: async () => null,
      mapMercadoPagoPreapprovalStatus: () => 'pending',
      mapMercadoPagoPaymentStatus: () => 'pending'
    }],
    ['./saas-billing-plans.service', { resolveSaasPlanDefinition: () => null }],
    ['./saas-billing-email.service', { sendBillingSubscriptionAuthorizationEmail: async () => null }],
    ['../utils/logger', { logError: (message, meta) => { logged = { message, meta }; }, logInfo: () => {} }]
  ]);
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (mocks.has(request)) return mocks.get(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../../src/services/saas-billing.service')];
    const billing = require('../../src/services/saas-billing.service');
    await assert.rejects(() => billing.executeSubscriptionAction(subscription.id, 'cancel'), /mercadopago_request_failed_400/);
    assert.equal(updateCalls, 0);
    assert.equal(subscription.localStatus, 'pending');
    assert.equal(logged.message, 'billing_subscription_cancellation_failed');
    assert.equal(logged.meta.providerErrorCode, 'PA_INVALID_STATE');
  } finally {
    Module._load = originalLoad;
  }
}

(async () => {
  try {
    await testJsonErrorFields();
    await testCauseDetails();
    await testUnknownJsonAndTextFallbacks();
    await testRedactionAndBounds();
    await testHttp200Unaffected();
    await testCancellationFailureLeavesSubscriptionUnchanged();
    console.log('mercado-pago-error-observability: PASS');
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
