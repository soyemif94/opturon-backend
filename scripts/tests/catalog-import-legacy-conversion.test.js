const assert = require('assert');
const { analyzeRows } = require('../../src/services/catalog-imports.service');

const analysis = analyzeRows(
  [
    ['SKU', 'Lote', 'Cantidad del lote', 'Fecha de vencimiento'],
    ['LEG-1', 'NUEVO-1', '12', '2099-12-31']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'create_missing',
    importPolicy: 'valid_only',
    mapping: {}
  },
  {
    products: [
      {
        id: 'product-legacy',
        name: 'Legacy',
        sku: 'LEG-1',
        stock: 7,
        inventoryTrackingMode: 'legacy',
        categoryName: null
      }
    ],
    categories: []
  }
);

assert.strictEqual(analysis.ok, true);
assert.strictEqual(analysis.previewRows[0].action, 'create_lot');
assert.strictEqual(analysis.previewRows[0].status, 'warning');
assert.match(analysis.previewRows[0].warnings.join(' '), /INICIAL/);
assert.strictEqual(analysis.stats.legacyConversions, 1);

console.log('catalog-import-legacy-conversion.test.js passed');
