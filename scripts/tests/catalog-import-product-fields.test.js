const assert = require('assert');
const {
  analyzeRows,
  buildCatalogImportTemplateCsv,
  suggestMapping
} = require('../../src/services/catalog-imports.service');

function emptySnapshot() {
  return { products: [], categories: [] };
}

const mapping = suggestMapping([
  { key: 'column_0', label: 'Nombre' },
  { key: 'column_1', label: 'Fabricante' },
  { key: 'column_2', label: 'Codigo de barras' },
  { key: 'column_3', label: 'Unidad' },
  { key: 'column_4', label: 'Costo' },
  { key: 'column_5', label: 'Proveedor habitual' },
  { key: 'column_6', label: 'Peso' },
  { key: 'column_7', label: 'Unidad de peso' },
  { key: 'column_8', label: 'Presentacion' },
  { key: 'column_9', label: 'Subcategoria' }
]);

assert.strictEqual(mapping.column_0, 'name');
assert.strictEqual(mapping.column_1, 'manufacturer');
assert.strictEqual(mapping.column_2, 'barcode');
assert.strictEqual(mapping.column_3, 'unitOfMeasure');
assert.strictEqual(mapping.column_4, 'cost');
assert.strictEqual(mapping.column_5, 'defaultSupplier');
assert.strictEqual(mapping.column_6, 'weight');
assert.strictEqual(mapping.column_7, 'weightUnit');
assert.strictEqual(mapping.column_8, 'presentation');
assert.strictEqual(mapping.column_9, 'subcategory');

const analysis = analyzeRows(
  [
    ['Nombre', 'Fabricante', 'Codigo de barras', 'Unidad', 'Costo', 'Proveedor habitual', 'Peso', 'Unidad de peso', 'Presentacion', 'Subcategoria', 'Precio', 'Stock', 'Sabor'],
    ['Agua mineral', 'Bebidas Sur', '7790000000029', 'botella', '900', 'Distribuidora Norte', '500', 'ml', 'Botella 500ml', 'Agua', '1500', '200', 'Sin gas']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'manufacturer',
      column_2: 'barcode',
      column_3: 'unitOfMeasure',
      column_4: 'cost',
      column_5: 'defaultSupplier',
      column_6: 'weight',
      column_7: 'weightUnit',
      column_8: 'presentation',
      column_9: 'subcategory',
      column_10: 'price',
      column_11: 'stock',
      column_12: 'attribute:Sabor'
    }
  },
  emptySnapshot()
);

assert.strictEqual(analysis.ok, true);
assert.strictEqual(analysis.previewRows[0].status, 'valid');
assert.strictEqual(analysis.previewRows[0].values.manufacturer, 'Bebidas Sur');
assert.strictEqual(analysis.previewRows[0].values.barcode, '7790000000029');
assert.strictEqual(analysis.previewRows[0].values.unitOfMeasure, 'botella');
assert.strictEqual(analysis.previewRows[0].values.cost, 900);
assert.strictEqual(analysis.previewRows[0].values.defaultSupplier, 'Distribuidora Norte');
assert.strictEqual(analysis.previewRows[0].values.weight, 500);
assert.strictEqual(analysis.previewRows[0].values.weightUnit, 'ml');
assert.strictEqual(analysis.previewRows[0].values.presentation, 'Botella 500ml');
assert.strictEqual(analysis.previewRows[0].values.subcategory, 'Agua');
assert.deepStrictEqual(analysis.previewRows[0].values.attributes, { Sabor: 'Sin gas' });

const invalidAnalysis = analyzeRows(
  [
    ['Nombre', 'Costo', 'Peso'],
    ['Producto invalido', 'caro', '-2']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'cost',
      column_2: 'weight'
    }
  },
  emptySnapshot()
);

assert.strictEqual(invalidAnalysis.previewRows[0].status, 'error');
assert.deepStrictEqual(invalidAnalysis.previewRows[0].errors.map((error) => error.code), ['invalid_cost', 'negative_weight']);
assert.match(buildCatalogImportTemplateCsv(), /Fabricante;Codigo de barras;Unidad;Costo;Precio;Stock;SKU;Proveedor habitual;Peso;Unidad de peso;Presentacion/);

console.log('catalog-import-product-fields.test.js passed');
