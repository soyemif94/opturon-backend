const assert = require('assert');
const { normalizeWhatsAppTo } = require('./normalize-phone');

assert.strictEqual(normalizeWhatsAppTo('+54 9 291 527-5449'), '542915275449');
assert.strictEqual(normalizeWhatsAppTo('5492915275449'), '542915275449');
assert.strictEqual(normalizeWhatsAppTo('542915275449'), '542915275449');
assert.strictEqual(normalizeWhatsAppTo('+1 (555) 123-4567'), '15551234567');

console.log('normalize-phone tests: OK');

