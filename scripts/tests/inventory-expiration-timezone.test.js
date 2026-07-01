const assert = require('assert');
const { calculateInventoryExpirationStatus, getTenantTodayISO } = require('../../src/utils/inventory-expiration');

const now = new Date('2026-07-01T02:30:00.000Z');
assert.strictEqual(getTenantTodayISO({ timezone: 'America/Argentina/Buenos_Aires', now }), '2026-06-30');
assert.strictEqual(getTenantTodayISO({ timezone: 'UTC', now }), '2026-07-01');
assert.strictEqual(
  calculateInventoryExpirationStatus('2026-06-30', { timezone: 'America/Argentina/Buenos_Aires', now }).status,
  'today'
);
assert.strictEqual(calculateInventoryExpirationStatus('2026-06-30', { timezone: 'UTC', now }).status, 'expired');

console.log('inventory-expiration-timezone.test.js passed');
