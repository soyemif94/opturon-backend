const assert = require('assert');
const { normalizeExpirationAlertThresholds } = require('../../src/utils/inventory-expiration');
const service = require('../../src/services/inventory-lots.service');

assert.deepStrictEqual(normalizeExpirationAlertThresholds({ criticalDays: 2, urgentDays: 5, warningDays: 10, upcomingDays: 20 }), {
  criticalDays: 2,
  urgentDays: 5,
  warningDays: 10,
  upcomingDays: 20
});
assert.throws(() => normalizeExpirationAlertThresholds({ criticalDays: 7, urgentDays: 3, warningDays: 10, upcomingDays: 20 }), /invalid_expiration_alert_threshold_order/);
assert.strictEqual(typeof service.updatePortalInventoryExpirationSettings, 'function');
assert.strictEqual(typeof service.getPortalInventoryExpirationSettings, 'function');

console.log('inventory-expiration-settings.test.js passed');
