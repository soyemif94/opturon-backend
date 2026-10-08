const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('pending checkout abandonment is a local-only admin action', () => {
  const service = read('src/services/saas-billing.service.js');
  const action = service.slice(service.indexOf("if (action === 'abandon')"), service.indexOf("if (action === 'cancel')"));
  assert.match(read('src/routes/admin.routes.js'), /action\(cancel\|pause\|reactivate\|abandon\)/);
  assert.match(action, /status\)\.toLowerCase\(\) !== 'pending'/);
  assert.match(action, /checkoutAbandoned: true/);
  assert.match(action, /COUNT\(\*\).*saas_billing_effects/s);
  assert.doesNotMatch(action, /cancelPreapproval\(/);
});

test('abandoned checkout is not reusable or exposed as an authorization link', () => {
  const repository = read('src/repositories/saas-subscriptions.repository.js');
  const service = read('src/services/saas-billing.service.js');
  assert.match(repository, /metadata->>'checkoutAbandoned'/);
  assert.match(repository, /checkoutAbandoned === true \? null/);
  assert.match(service, /subscription\.metadata\?\.checkoutAbandoned !== true/);
  assert.match(service, /subscription\.localStatus !== 'pending' \|\| subscription\.metadata\?\.checkoutAbandoned === true/);
});

test('abandoned checkout cannot activate from a late payment webhook', () => {
  const lifecycle = read('src/services/saas-billing-lifecycle.js');
  assert.match(lifecycle, /checkoutAbandoned === true \|\| state\.checkoutState === 'abandoned'/);
  assert.match(lifecycle, /abandoned_checkout_ineligible/);
  assert.match(lifecycle, /localStatus: abandoned \? 'pending'/);
});

test('admin UI distinguishes pending abandonment from provider cancellation', () => {
  const ui = fs.readFileSync(path.resolve(root, '../opturon-web/components/app/AdminClientConfiguration.tsx'), 'utf8');
  assert.match(ui, /Descartar checkout pendiente/);
  assert.match(ui, /No se aprobo ningun pago/);
  assert.match(ui, /runSubscriptionAction\("abandon"\)/);
  assert.match(ui, /Cancelar suscripcion/);
});
