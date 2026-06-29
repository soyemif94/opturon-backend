const assert = require('assert');
const {
  buildCanonicalImportErrors,
  buildCatalogImportErrorCsv
} = require('../../src/services/catalog-imports.service');

function parseSemicolonCsv(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ';') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }
  row.push(value);
  rows.push(row);
  return rows;
}

const realIncidentJob = {
  analysis: {
    errors: [
      {
        rowNumber: 4,
        field: 'Precio',
        value: 'dos mil',
        code: 'invalid_price',
        message: 'El precio debe ser un número válido'
      },
      {
        rowNumber: 5,
        field: 'SKU',
        value: 'SMOKE-002',
        code: 'duplicate_in_file',
        message: 'El SKU está duplicado en el archivo'
      }
    ]
  },
  result: {
    rows: [
      {
        sourceRowNumber: 4,
        status: 'error',
        code: 'invalid_price',
        message: 'El precio debe ser un número válido'
      },
      {
        sourceRowNumber: 5,
        status: 'error',
        code: 'duplicate_in_file',
        message: 'El SKU está duplicado en el archivo'
      }
    ]
  }
};

const incidentRows = parseSemicolonCsv(buildCatalogImportErrorCsv(realIncidentJob));
assert.deepStrictEqual(incidentRows[0], ['Fila', 'Campo', 'Valor', 'Error', 'Código']);
assert.strictEqual(incidentRows.length - 1, 2);
assert.deepStrictEqual(incidentRows[1], ['4', 'Precio', 'dos mil', 'El precio debe ser un número válido', 'invalid_price']);
assert.deepStrictEqual(incidentRows[2], ['5', 'SKU', 'SMOKE-002', 'El SKU está duplicado en el archivo', 'duplicate_in_file']);

const canonicalIncident = buildCanonicalImportErrors(realIncidentJob);
assert.strictEqual(canonicalIncident.length, 2);
assert.strictEqual(canonicalIncident.every((error) => error.field && error.value), true);

const distinctSameRowCsv = buildCatalogImportErrorCsv({
  analysis: {
    errors: [
      { rowNumber: 8, field: 'Precio', value: 'abc', code: 'invalid_price', message: 'Precio inválido' },
      { rowNumber: 8, field: 'Stock', value: 'xyz', code: 'invalid_stock', message: 'Stock inválido' }
    ]
  },
  result: {}
});
assert.strictEqual(parseSemicolonCsv(distinctSameRowCsv).length - 1, 2);

const sameCodeDifferentRowsCsv = buildCatalogImportErrorCsv({
  analysis: {
    errors: [
      { rowNumber: 3, field: 'Precio', value: 'x', code: 'invalid_price', message: 'Precio inválido' },
      { rowNumber: 9, field: 'Precio', value: 'y', code: 'invalid_price', message: 'Precio inválido' }
    ]
  },
  result: {}
});
assert.strictEqual(parseSemicolonCsv(sameCodeDifferentRowsCsv).length - 1, 2);

const safeCsvRows = parseSemicolonCsv(
  buildCatalogImportErrorCsv({
    analysis: {
      errors: [
        {
          rowNumber: 10,
          field: 'Nombre',
          value: '=SUM(A1:A2)',
          code: 'missing_name',
          message: 'Valor con coma, "comillas" y ñandú'
        }
      ]
    },
    result: {}
  })
);
assert.strictEqual(safeCsvRows[1][2], "'=SUM(A1:A2)");
assert.strictEqual(safeCsvRows[1][3], 'Valor con coma, "comillas" y ñandú');

const emptyCsv = buildCatalogImportErrorCsv({ analysis: {}, result: {} });
assert.strictEqual(emptyCsv, 'Fila;Campo;Valor;Error;Código\n');

const sortedRows = parseSemicolonCsv(
  buildCatalogImportErrorCsv({
    analysis: {
      errors: [
        { rowNumber: 7, field: 'SKU', value: 'B', code: 'duplicate_in_file', message: 'Duplicado' },
        { rowNumber: 2, field: 'Precio', value: 'A', code: 'invalid_price', message: 'Precio inválido' }
      ]
    },
    result: {}
  })
);
assert.deepStrictEqual(sortedRows.slice(1).map((row) => row[0]), ['2', '7']);

console.log('catalog-import-error-report.test.js passed');
