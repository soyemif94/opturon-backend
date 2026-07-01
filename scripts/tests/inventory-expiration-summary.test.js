const assert = require('assert');
const {
  calculateInventoryExpirationStatus,
  normalizeExpirationAlertThresholds
} = require('../../src/utils/inventory-expiration');

const thresholds = normalizeExpirationAlertThresholds({ criticalDays: 3, urgentDays: 7, warningDays: 15, upcomingDays: 30 });

assert.strictEqual(calculateInventoryExpirationStatus('2026-06-28', { todayISO: '2026-06-30', thresholds }).status, 'expired');
assert.strictEqual(calculateInventoryExpirationStatus('2026-06-30', { todayISO: '2026-06-30', thresholds }).status, 'today');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-03', { todayISO: '2026-06-30', thresholds }).status, 'critical');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-07', { todayISO: '2026-06-30', thresholds }).status, 'urgent');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-15', { todayISO: '2026-06-30', thresholds }).status, 'warning');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-30', { todayISO: '2026-06-30', thresholds }).status, 'upcoming');
assert.strictEqual(calculateInventoryExpirationStatus(null, { todayISO: '2026-06-30', thresholds }).status, 'no_expiration');

console.log('inventory-expiration-summary.test.js passed');
