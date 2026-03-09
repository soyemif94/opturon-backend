const assert = require('assert');
const { normalizeToDigits, normalizeWhatsAppTo } = require('../../src/whatsapp/phone.normalize');

function testNormalize(input, expected) {
  const digits = normalizeToDigits(input);
  const result = normalizeWhatsAppTo(digits);
  assert.strictEqual(result, expected, `Expected "${expected}" but got "${result}" for input "${input}"`);
}

testNormalize('+54 9 291 527-5449', '542915275449');
testNormalize('5492915275449', '542915275449');
testNormalize('542915275449', '542915275449');
testNormalize('+1 (555) 123-4567', '15551234567');

console.log('phone-normalize tests: OK');

