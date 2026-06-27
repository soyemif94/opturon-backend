const assert = require('assert');
const {
  detectDelimiter,
  splitDelimitedLine,
  suggestMapping,
  analyzeRows,
  parseStructuredFile,
  buildCatalogImportErrorCsv
} = require('../../src/services/catalog-imports.service');

function emptySnapshot() {
  return { products: [], categories: [] };
}

const semicolonText = 'Nombre;Precio;Stock\nCafe;2500;10\nTe;1800;5';
assert.strictEqual(detectDelimiter(semicolonText), ';');

const pipeRow = splitDelimitedLine('"Combo | especial"|SKU-1|1500|3', '|');
assert.deepStrictEqual(pipeRow, ['Combo | especial', 'SKU-1', '1500', '3']);

const mapping = suggestMapping([
  { key: 'column_0', label: 'Producto' },
  { key: 'column_1', label: 'Precio venta' },
  { key: 'column_2', label: 'Cantidad' },
  { key: 'column_3', label: 'Codigo' }
]);
assert.deepStrictEqual(mapping, {
  column_0: 'name',
  column_1: 'price',
  column_2: 'stock',
  column_3: 'sku'
});

const parsedCsv = parseStructuredFile(
  {
    originalname: 'catalogo.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from(semicolonText, 'utf8')
  },
  {}
);
assert.strictEqual(parsedCsv.ok, true);
assert.strictEqual(parsedCsv.delimiter, ';');

const analysis = analyzeRows(
  [
    ['Nombre', 'Precio', 'Stock', 'SKU'],
    ['Cafe tostado', '2500', '10', 'CAFE-01'],
    ['Cafe tostado', 'dos mil', '10', 'CAFE-02'],
    ['Cafe tostado', '2500', '10', 'CAFE-01'],
    ['', '', '', '']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {}
  },
  emptySnapshot()
);

assert.strictEqual(analysis.ok, true);
assert.strictEqual(analysis.stats.totalRows, 3);
assert.strictEqual(analysis.stats.validRows, 1);
assert.strictEqual(analysis.stats.errorRows, 2);
assert.strictEqual(analysis.stats.ignoredRows, 0);
assert.strictEqual(analysis.previewRows[0].values.name, 'Cafe tostado');
assert.strictEqual(analysis.previewRows[1].errors[0].code, 'invalid_price');
assert.strictEqual(analysis.previewRows[2].errors[0].code, 'duplicate_in_file');

const formattedCurrencyAnalysis = analyzeRows(
  [
    ['Nombre', 'Precio', 'Stock', 'SKU'],
    ['Gratis', '$ 1,000.50', 0, 'FREE-01'],
    ['Promo', '1,000.50', '0', 'FREE-02'],
    ['AR', '$ 1.000,50', '3', 'FREE-03'],
    ['Cero', 0, 0, 'FREE-04']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {}
  },
  emptySnapshot()
);

assert.strictEqual(formattedCurrencyAnalysis.previewRows[0].values.price, 1000.5);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[0].values.stock, 0);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[1].values.price, 1000.5);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[1].values.stock, 0);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[2].values.price, 1000.5);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[3].values.price, 0);
assert.strictEqual(formattedCurrencyAnalysis.previewRows[3].values.stock, 0);

const missingCategoryRejectAnalysis = analyzeRows(
  [
    ['Nombre', 'Categoria', 'Precio', 'Stock', 'SKU'],
    ['Termo de prueba', 'Prueba Importacion', '1500', '4', 'TERM-01']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'reject_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'categoryName',
      column_2: 'price',
      column_3: 'stock',
      column_4: 'sku'
    }
  },
  emptySnapshot()
);

assert.strictEqual(missingCategoryRejectAnalysis.previewRows[0].status, 'error');
assert.strictEqual(missingCategoryRejectAnalysis.previewRows[0].errors[0].code, 'missing_category');

const missingCategoryCreateAnalysis = analyzeRows(
  [
    ['Nombre', 'Categoria', 'Precio', 'Stock', 'SKU'],
    ['Termo de prueba', 'Prueba Importacion', '1500', '4', 'TERM-01']
  ],
  {
    hasHeaders: true,
    duplicatePolicy: 'skip',
    categoryPolicy: 'create_missing',
    importPolicy: 'valid_only',
    mapping: {
      column_0: 'name',
      column_1: 'categoryName',
      column_2: 'price',
      column_3: 'stock',
      column_4: 'sku'
    }
  },
  emptySnapshot()
);

assert.strictEqual(missingCategoryCreateAnalysis.previewRows[0].status, 'valid');
assert.strictEqual(missingCategoryCreateAnalysis.previewRows[0].errors.length, 0);
assert.strictEqual(missingCategoryCreateAnalysis.previewRows[0].values.categoryName, 'Prueba Importacion');

const structuredTxt = parseStructuredFile(
  {
    originalname: 'catalogo.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('Nombre|Precio|Stock\nJugo|1200|5', 'utf8')
  },
  { delimiter: '|' }
);
assert.strictEqual(structuredTxt.ok, true);
assert.strictEqual(structuredTxt.fileType, 'txt');

const errorCsv = buildCatalogImportErrorCsv({
  analysis: {
    errors: [
      {
        rowNumber: 18,
        field: 'Precio',
        value: '=2+3',
        code: 'invalid_price',
        message: 'El precio debe ser un numero valido.'
      }
    ]
  },
  result: {}
});
assert.match(errorCsv, /'=\d\+\d|'=2\+3/);

console.log('catalog-import.test.js passed');
