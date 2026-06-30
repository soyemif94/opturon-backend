const assert = require('assert');
const { calculateInventoryExpirationStatus } = require('../../src/utils/inventory-expiration');

const now = new Date('2026-06-30T12:00:00.000Z');

assert.deepStrictEqual(calculateInventoryExpirationStatus(null, now), { status: 'no_expiration', daysUntilExpiration: null });
assert.strictEqual(calculateInventoryExpirationStatus('2026-06-29', now).status, 'expired');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-03', now).status, 'critical');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-07', now).status, 'urgent');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-15', now).status, 'warning');
assert.strictEqual(calculateInventoryExpirationStatus('2026-07-30', now).status, 'upcoming');
assert.strictEqual(calculateInventoryExpirationStatus('2026-08-15', now).status, 'normal');

console.log('inventory-expiration-status.test.js passed');
