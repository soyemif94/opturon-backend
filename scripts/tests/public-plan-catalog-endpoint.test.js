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
  for (const plan of payload.plans) {
    assert.deepEqual(Object.keys(plan).sort(), [
      'key', 'displayName', 'description', 'pricingMode', 'amount', 'currency',
      'billingCadence', 'highlights', 'recommended', 'ctaMode'
    ].sort());
  }
});
