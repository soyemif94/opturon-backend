const assert = require('assert');
const { parseCommercePrice, resolveProductPrice } = require('../../src/utils/commerce-price');

for (const [label, value] of [
  ['null', null],
  ['undefined', undefined],
  ['empty', ''],
  ['whitespace', '   '],
  ['NaN', Number.NaN],
  ['text', 'abc'],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['negative number', -1],
  ['negative numeric string', '-0.01']
]) {
  const result = parseCommercePrice(value);
  assert.strictEqual(result.valid, false, label);
  assert.strictEqual(result.value, null, label);
  assert.strictEqual(result.explicitZero, false, label);
}

for (const [label, value, expected] of [
  ['numeric zero', 0, 0],
  ['string zero', '0', 0],
  ['decimal string zero', '0.00', 0],
  ['positive integer', 1250, 1250],
  ['positive decimal string', '1250.50', 1250.5]
]) {
  const result = parseCommercePrice(value);
  assert.strictEqual(result.valid, true, label);
  assert.strictEqual(result.value, expected, label);
  assert.strictEqual(result.explicitZero, expected === 0, label);
}

assert.deepStrictEqual(resolveProductPrice({ unitPrice: null, price: null }), {
  valid: false,
  value: null,
  explicitZero: false
});
assert.deepStrictEqual(resolveProductPrice({ unitPrice: '', price: 'abc' }), {
  valid: false,
  value: null,
  explicitZero: false
});
assert.deepStrictEqual(resolveProductPrice({ unitPrice: null, price: 450 }), {
  valid: true,
  value: 450,
  explicitZero: false
});
assert.deepStrictEqual(resolveProductPrice({ unitPrice: 0, price: null }), {
  valid: true,
  value: 0,
  explicitZero: true
});

console.log('commerce-price-safety.test.js passed');
