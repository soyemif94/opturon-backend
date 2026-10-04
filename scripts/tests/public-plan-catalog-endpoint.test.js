const test = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../../src/app');

test('public plan catalog endpoint serves only canonical commercial DTO fields', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/public/plans`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /max-age=300/);
  const payload = await response.json();
  assert.deepEqual(payload.plans.map(plan => plan.key), ['core', 'growth', 'distribution', 'enterprise']);
  assert.deepEqual(payload.plans.slice(0, 3).map(plan => [plan.amount, plan.currency, plan.billingCadence]), [
    [49900, 'ARS', 'monthly'], [69900, 'ARS', 'monthly'], [89900, 'ARS', 'monthly']
  ]);
  assert.deepEqual([payload.plans[3].pricingMode, payload.plans[3].amount, payload.plans[3].currency, payload.plans[3].ctaMode], ['contact', null, null, 'contact']);
  for (const plan of payload.plans) {
    assert.deepEqual(Object.keys(plan).sort(), [
      'key', 'displayName', 'description', 'pricingMode', 'amount', 'currency',
      'billingCadence', 'highlights', 'recommended', 'ctaMode'
    ].sort());
  }
});
