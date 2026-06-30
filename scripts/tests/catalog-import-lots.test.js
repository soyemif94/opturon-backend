const assert = require('assert');
const {
  analyzeRows,
  suggestMapping
} = require('../../src/services/catalog-imports.service');

const mapping = suggestMapping([
  { key: 'column_0', label: 'Nombre' },
  { key: 'column_1', label: 'SKU' },
  { key: 'column_2', label: 'Lote' },
  { key: 'column_3', label: 'Cantidad' },
  { key: 'column_4', label: 'Vencimiento' },
  { key: 'column_5', label: 'Deposito' }
]);

assert.strictEqual(mapping.column_2, 'lotNumber');
assert.strictEqual(mapping.column_3, 'lotQuantity');
assert.strictEqual(mapping.column_4, 'expiresAt');
assert.strictEqual(mapping.column_5, 'warehouseName');

const analysis = analyzeRows(
  [
    ['Nombre', 'SKU', 'Precio', 'Lote', 'Cantidad', 'Vencimiento', 'Deposito'],
    ['Yogur natural 1 kg', 'YOG-LOT-1', '2200', 'A123', '20', '2099-07-06', 'Central'],
    ['Yogur natural 1 kg', 'YOG-LOT-1', '2200', 'B456', '40', '2099-07-20', 'Central']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'create_missing',
    importPolicy: 'valid_only',
    mapping: {}
  },
  { products: [], categories: [] }
);

assert.strictEqual(analysis.ok, true);
assert.strictEqual(analysis.recommendation.type, 'products_and_lots');
assert.strictEqual(analysis.stats.lotRows, 2);
assert.strictEqual(analysis.stats.productsToCreateWithLots, 1);
assert.strictEqual(analysis.previewRows[0].action, 'create_with_lot');
assert.strictEqual(analysis.previewRows[0].values.lotNumber, 'A123');
assert.strictEqual(analysis.previewRows[0].values.lotQuantity, 20);
assert.strictEqual(analysis.previewRows[1].values.lotNumber, 'B456');
assert.strictEqual(analysis.stats.errorRows, 0);

console.log('catalog-import-lots.test.js passed');
