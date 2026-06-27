const assert = require('assert');
const XLSX = require('xlsx');
const { parseStructuredFile, analyzeRows } = require('../../src/services/catalog-imports.service');

function emptySnapshot() {
  return { products: [], categories: [] };
}

function buildWorkbookRows() {
  return [
    ['Nombre', 'Descripcion', 'Categoria', 'Precio', 'Stock', 'SKU', 'Marca', 'Activo'],
    ['Producto Smoke 001', 'Desc', 'Cat', 1000, 5, 'SMOKE-001', 'Marca', 'Si'],
    ['Producto Smoke 002', 'Desc', 'Cat', 2500, 3, 'SMOKE-002', 'Marca', 'Si'],
    ['Producto Error Precio', 'Desc', 'Cat', 'dos mil', 2, 'SMOKE-003', 'Marca', 'Si'],
    ['Producto SKU Duplicado', 'Desc', 'Cat', 1800, 1, 'SMOKE-002', 'Marca', 'Si'],
    ['Producto Inactivo', 'Desc', 'Cat', 3200, 0, 'SMOKE-004', 'Marca', 'No'],
    ['Producto Sin SKU', 'Desc', 'Cat', 1500, 0, '', 'Marca', 'Si'],
    ['Producto Precio Cero', 'Desc', 'Cat', 0, 0, 'SMOKE-000', 'Marca', 'Si']
  ];
}

function buildCurrencyFormattedWorkbook() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(buildWorkbookRows());
  ['D2', 'D3', 'D5', 'D6', 'D7', 'D8'].forEach((address) => {
    worksheet[address].z = '$ #,##0.00';
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Productos');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

const parsed = parseStructuredFile(
  {
    originalname: 'prueba_importacion_catalogo_opturon.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: buildCurrencyFormattedWorkbook()
  },
  { sheetName: 'Productos' }
);

assert.strictEqual(parsed.ok, true);
assert.strictEqual(parsed.fileType, 'xlsx');
assert.strictEqual(parsed.selectedSheet, 'Productos');
assert.strictEqual(parsed.rows[1][3], 1000);
assert.strictEqual(parsed.rows[2][3], 2500);
assert.strictEqual(parsed.rows[5][4], 0);
assert.strictEqual(parsed.rows[7][3], 0);

const analysis = analyzeRows(
  parsed.rows,
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'create_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'description',
      column_2: 'categoryName',
      column_3: 'price',
      column_4: 'stock',
      column_5: 'sku',
      column_7: 'active'
    }
  },
  emptySnapshot()
);

assert.strictEqual(analysis.ok, true);
assert.deepStrictEqual(analysis.mapping, {
  column_0: 'name',
  column_1: 'description',
  column_2: 'categoryName',
  column_3: 'price',
  column_4: 'stock',
  column_5: 'sku',
  column_6: null,
  column_7: 'active'
});

const row2 = analysis.previewRows.find((row) => row.sourceRowNumber === 2);
const row3 = analysis.previewRows.find((row) => row.sourceRowNumber === 3);
const row4 = analysis.previewRows.find((row) => row.sourceRowNumber === 4);
const row5 = analysis.previewRows.find((row) => row.sourceRowNumber === 5);
const row6 = analysis.previewRows.find((row) => row.sourceRowNumber === 6);
const row7 = analysis.previewRows.find((row) => row.sourceRowNumber === 7);
const row8 = analysis.previewRows.find((row) => row.sourceRowNumber === 8);

assert.strictEqual(row2.values.price, 1000);
assert.strictEqual(row2.errors.length, 0);
assert.strictEqual(row3.values.price, 2500);
assert.strictEqual(row3.errors.length, 0);
assert.strictEqual(row4.values.price, null);
assert.strictEqual(row4.errors[0].code, 'invalid_price');
assert.strictEqual(row5.values.price, 1800);
assert.strictEqual(row5.errors[0].code, 'duplicate_in_file');
assert.strictEqual(row6.values.price, 3200);
assert.strictEqual(row6.values.stock, 0);
assert.strictEqual(row7.values.price, 1500);
assert.strictEqual(row7.values.stock, 0);
assert.strictEqual(row8.values.price, 0);
assert.strictEqual(row8.values.stock, 0);
assert.strictEqual(row8.errors.length, 0);

assert.strictEqual(analysis.stats.validRows, 5);
assert.strictEqual(analysis.stats.errorRows, 2);
assert.strictEqual(analysis.stats.duplicateRows, 0);

console.log('catalog-import-price-xlsx.test.js passed');
