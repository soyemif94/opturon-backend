const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const {
  analyzeRows,
  buildCatalogImportTemplateCsv,
  suggestMapping
} = require('../../src/services/catalog-imports.service');

function emptySnapshot() {
  return { products: [], categories: [] };
}

function read(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const mapping = suggestMapping([
  { key: 'column_0', label: 'Nombre' },
  { key: 'column_1', label: 'Marca' },
  { key: 'column_2', label: 'Fabricante' },
  { key: 'column_3', label: 'Manufacturer' },
  { key: 'column_4', label: 'Brand' }
]);

assert.strictEqual(mapping.column_0, 'name');
assert.strictEqual(mapping.column_1, 'brand');
assert.strictEqual(mapping.column_2, null);
assert.strictEqual(mapping.column_3, null);
assert.strictEqual(mapping.column_4, null);

const analysis = analyzeRows(
  [
    ['Nombre', 'Marca', 'Precio', 'Stock', 'SKU'],
    ['Auriculares Bluetooth Pro', ' NovaTech ', '1200', '10', 'AUD-01'],
    ['Cargador USB-C 20W', '', '1800', '8', 'CAR-01'],
    ['Funda Transparente iPhone 15', 'Hoco 2.0', '2200', '5', 'FUN-01'],
    ['Vidrio Templado iPhone 15', 'Ñandú Ágil', '900', '12', 'VID-01']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'brand',
      column_2: 'price',
      column_3: 'stock',
      column_4: 'sku'
    }
  },
  emptySnapshot()
);

assert.strictEqual(analysis.ok, true);
assert.strictEqual(analysis.previewRows[0].values.brand, 'NovaTech');
assert.strictEqual(analysis.previewRows[1].values.brand, null);
assert.strictEqual(analysis.previewRows[2].values.brand, 'Hoco 2.0');
assert.strictEqual(analysis.previewRows[3].values.brand, 'Ñandú Ágil');
assert.strictEqual(analysis.previewRows.every((row) => row.errors.length === 0), true);

const templateCsv = buildCatalogImportTemplateCsv();
assert.match(templateCsv, /Nombre;Descripcion;Categoria;Marca;Precio;Stock;SKU;Activo;Moneda;Imagen URL/);

const importSource = read('src/services/catalog-imports.service.js');
assert.match(importSource, /const IMPORTABLE_FIELDS = \['name', 'description', 'categoryName', 'brand'/);
assert.match(importSource, /\['marca', 'brand'\]/);
assert.match(importSource, /\['fabricante', 'brand'\]/);
assert.match(importSource, /\['manufacturer', 'brand'\]/);
assert.match(importSource, /brand: values\.brand \|\| null/);
assert.match(importSource, /brand: values\.brand !== undefined \? payload\.brand : current\.brand/);

const repositorySource = read('src/repositories/products.repository.js');
assert.match(repositorySource, /const brand = String\(catalog\.brand \|\| ''\)\.trim\(\) \|\| null/);
assert.match(repositorySource, /brand: String\(input\.brand \|\| ''\)\.trim\(\) \|\| null/);
assert.match(repositorySource, /brand: catalogMetadata\.brand/);

console.log('catalog-import-brand.test.js passed');
