const XLSX = require('xlsx');
const { withTransaction } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');
const { logInfo, logWarn } = require('../utils/logger');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  createCatalogImportJob,
  findCatalogImportJobById,
  updateCatalogImportJob
} = require('../repositories/catalog-imports.repository');
const { createCatalogImportAuditEvent } = require('../repositories/catalog-import-audit.repository');
const {
  listProductsByClinicId,
  createProduct,
  updateProduct,
  findProductById
} = require('../repositories/products.repository');
const {
  listProductCategoriesByClinicId,
  findProductCategoryByName,
  createProductCategory
} = require('../repositories/product-categories.repository');

const MAX_FILE_SIZE_BYTES = Number(process.env.CATALOG_IMPORT_MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024);
const MAX_ROWS = Number(process.env.CATALOG_IMPORT_MAX_ROWS || 10000);
const MAX_COLUMNS = Number(process.env.CATALOG_IMPORT_MAX_COLUMNS || 100);
const PREVIEW_LIMIT = Number(process.env.CATALOG_IMPORT_PREVIEW_LIMIT || 50);
const PROCESSING_CHUNK_SIZE = Number(process.env.CATALOG_IMPORT_CHUNK_SIZE || 100);
const IMPORT_TTL_HOURS = Number(process.env.CATALOG_IMPORT_TTL_HOURS || 24);
const SUPPORTED_FILE_TYPES = new Set(['xlsx', 'csv', 'txt']);
const HEADERLESS_COLUMN_PREFIX = 'Columna';
const STATUS_VALUES = new Set(['active', 'archived']);
const DUPLICATE_POLICIES = new Set(['skip', 'update', 'cancel']);
const CATEGORY_POLICIES = new Set(['reject_missing', 'create_missing']);
const IMPORT_POLICIES = new Set(['valid_only', 'fail_on_error']);
const IMPORTABLE_FIELDS = [
  'name',
  'description',
  'categoryName',
  'subcategory',
  'brand',
  'manufacturer',
  'barcode',
  'unitOfMeasure',
  'cost',
  'defaultSupplier',
  'weight',
  'weightUnit',
  'presentation',
  'price',
  'stock',
  'sku',
  'active',
  'currency',
  'imageUrl'
];
const FIELD_LABELS = {
  name: 'Nombre',
  description: 'Descripcion',
  categoryName: 'Categoria',
  subcategory: 'Subcategoria',
  brand: 'Marca',
  manufacturer: 'Fabricante',
  barcode: 'Codigo de barras',
  unitOfMeasure: 'Unidad de medida',
  cost: 'Costo',
  defaultSupplier: 'Proveedor habitual',
  weight: 'Peso',
  weightUnit: 'Unidad de peso',
  presentation: 'Presentacion',
  price: 'Precio',
  stock: 'Stock',
  sku: 'SKU',
  active: 'Activo',
  currency: 'Moneda',
  imageUrl: 'Imagen URL'
};

const FIELD_ALIASES = new Map([
  ['producto', 'name'],
  ['nombre', 'name'],
  ['nombreproducto', 'name'],
  ['nombrearticulo', 'name'],
  ['detalle', 'description'],
  ['descripcion', 'description'],
  ['descrip', 'description'],
  ['rubro', 'categoryName'],
  ['categoria', 'categoryName'],
  ['rubrocategoria', 'categoryName'],
  ['subcategoria', 'subcategory'],
  ['subrubro', 'subcategory'],
  ['marca', 'brand'],
  ['brand', 'brand'],
  ['fabricante', 'manufacturer'],
  ['manufacturer', 'manufacturer'],
  ['productor', 'manufacturer'],
  ['elaboradopor', 'manufacturer'],
  ['codigobarras', 'barcode'],
  ['codigodebarras', 'barcode'],
  ['barcode', 'barcode'],
  ['ean', 'barcode'],
  ['gtin', 'barcode'],
  ['unidad', 'unitOfMeasure'],
  ['unidaddemedida', 'unitOfMeasure'],
  ['unit', 'unitOfMeasure'],
  ['unitofmeasure', 'unitOfMeasure'],
  ['costo', 'cost'],
  ['cost', 'cost'],
  ['costounitario', 'cost'],
  ['proveedor', 'defaultSupplier'],
  ['proveedorhabitual', 'defaultSupplier'],
  ['defaultsupplier', 'defaultSupplier'],
  ['peso', 'weight'],
  ['weight', 'weight'],
  ['unidadpeso', 'weightUnit'],
  ['unidaddepeso', 'weightUnit'],
  ['weightunit', 'weightUnit'],
  ['presentacion', 'presentation'],
  ['presentation', 'presentation'],
  ['precio', 'price'],
  ['precioventa', 'price'],
  ['valor', 'price'],
  ['importe', 'price'],
  ['stock', 'stock'],
  ['cantidad', 'stock'],
  ['inventario', 'stock'],
  ['codigo', 'sku'],
  ['codigoproducto', 'sku'],
  ['sku', 'sku'],
  ['activo', 'active'],
  ['estado', 'active'],
  ['moneda', 'currency'],
  ['currency', 'currency'],
  ['imagenurl', 'imageUrl'],
  ['imageurl', 'imageUrl'],
  ['urlimagen', 'imageUrl'],
  ['urlfoto', 'imageUrl']
]);

function normalizeString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeHeaderKey(value) {
  return normalizeString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeAttributeKey(value) {
  return normalizeString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function buildAttributeTarget(value) {
  const key = normalizeAttributeKey(value);
  return key ? `attribute:${key}` : null;
}

function parseAttributeTarget(value) {
  const raw = normalizeString(value);
  if (!raw.startsWith('attribute:')) return null;
  return normalizeAttributeKey(raw.slice('attribute:'.length));
}

function normalizeLooseKey(value) {
  return normalizeString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSafeFileName(value) {
  const normalized = normalizeString(value).replace(/[\\/:*?"<>|]+/g, '-');
  return normalized || `catalog-import-${Date.now()}`;
}

function normalizeFileType(fileName) {
  const safeName = normalizeString(fileName).toLowerCase();
  if (safeName.endsWith('.xlsx')) return 'xlsx';
  if (safeName.endsWith('.csv')) return 'csv';
  if (safeName.endsWith('.txt')) return 'txt';
  return null;
}

function detectDelimiter(text) {
  const candidates = [',', ';', '\t', '|'];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  let best = { delimiter: ';', score: -1 };
  for (const delimiter of candidates) {
    const counts = lines.map((line) => splitDelimitedLine(line, delimiter).length).filter((count) => count > 1);
    if (!counts.length) continue;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const score = min === max ? max * 10 : min;
    if (score > best.score) {
      best = { delimiter, score };
    }
  }

  return best.delimiter;
}

function splitDelimitedLine(line, delimiter) {
  const result = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === delimiter && !quoted) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result.map((value) => value.trim());
}

function convertSheetRows(sheet, workbook) {
  const ref = sheet['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const rows = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[address];
      if (!cell) {
        row.push('');
        continue;
      }

      if (cell.f && cell.v === undefined && cell.w === undefined) {
        row.push('');
        continue;
      }

      if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
        row.push(cell.v);
        continue;
      }

      if (cell.t === 'b' && typeof cell.v === 'boolean') {
        row.push(cell.v);
        continue;
      }

      const formatted = cell.w !== undefined ? cell.w : XLSX.utils.format_cell(cell, undefined, workbook);
      row.push(formatted == null ? '' : String(formatted).trim());
    }
    rows.push(row);
  }
  return rows;
}

function inferHasHeaders(rows, explicitValue) {
  if (typeof explicitValue === 'boolean') return explicitValue;
  const firstRow = Array.isArray(rows[0]) ? rows[0] : [];
  const secondRow = Array.isArray(rows[1]) ? rows[1] : [];
  if (!firstRow.length) return true;
  const aliasHits = firstRow.filter((cell) => FIELD_ALIASES.has(normalizeHeaderKey(cell))).length;
  if (aliasHits >= Math.max(1, Math.floor(firstRow.length / 3))) return true;
  const firstNumeric = firstRow.filter((cell) => /^-?\d+([.,]\d+)?$/.test(normalizeString(cell))).length;
  const secondNumeric = secondRow.filter((cell) => /^-?\d+([.,]\d+)?$/.test(normalizeString(cell))).length;
  return !(firstNumeric > 0 && secondNumeric <= firstNumeric);
}

function buildColumnName(index) {
  return `${HEADERLESS_COLUMN_PREFIX} ${index + 1}`;
}

function extractColumns(rows, hasHeaders) {
  const firstRow = Array.isArray(rows[0]) ? rows[0] : [];
  const columnCount = firstRow.length;
  const columns = [];
  for (let index = 0; index < columnCount; index += 1) {
    const label = hasHeaders ? normalizeString(firstRow[index]) || buildColumnName(index) : buildColumnName(index);
    columns.push({
      index,
      key: `column_${index}`,
      label
    });
  }
  return columns;
}

function suggestMapping(columns) {
  const used = new Set();
  return columns.reduce((accumulator, column) => {
    const suggested = FIELD_ALIASES.get(normalizeHeaderKey(column.label));
    if (!suggested || used.has(suggested)) {
      accumulator[column.key] = null;
      return accumulator;
    }
    used.add(suggested);
    accumulator[column.key] = suggested;
    return accumulator;
  }, {});
}

function sanitizeMapping(mapping, columns) {
  const availableColumns = new Set((Array.isArray(columns) ? columns : []).map((column) => column.key));
  const seenTargets = new Set();
  const sanitized = {};

  for (const [columnKey, targetField] of Object.entries(mapping || {})) {
    if (!availableColumns.has(columnKey)) continue;
    const attributeKey = parseAttributeTarget(targetField);
    const sanitizedTarget = attributeKey ? `attribute:${attributeKey}` : targetField;
    if (!sanitizedTarget || (!IMPORTABLE_FIELDS.includes(sanitizedTarget) && !attributeKey)) {
      sanitized[columnKey] = null;
      continue;
    }
    if (seenTargets.has(sanitizedTarget)) continue;
    seenTargets.add(sanitizedTarget);
    sanitized[columnKey] = sanitizedTarget;
  }

  for (const column of columns || []) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, column.key)) {
      sanitized[column.key] = null;
    }
  }

  return sanitized;
}

function parseDecimalString(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return quantizeDecimal(value, 2, NaN);
  }

  const raw = normalizeString(value);
  if (!raw) return null;

  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/[$€£¥₲₱₡₽₴₹₺₦₫₭₲₵₸₼₾₪₤₥₨₿]/g, '');
  if (!normalized) return null;

  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  let canonical = normalized;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      canonical = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      canonical = normalized.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const fractionalLength = normalized.length - lastComma - 1;
    canonical =
      fractionalLength > 0 && fractionalLength <= 2
        ? normalized.replace(/\./g, '').replace(',', '.')
        : normalized.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const fractionalLength = normalized.length - lastDot - 1;
    canonical = fractionalLength === 3 ? normalized.replace(/\./g, '') : normalized;
  }

  if (!/^-?\d+(\.\d+)?$/.test(canonical)) return null;
  return quantizeDecimal(canonical, 2, NaN);
}

function parseIntegerString(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null;
    return value;
  }
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!/^-?\d+$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function parseBooleanStatus(value) {
  const normalized = normalizeLooseKey(value);
  if (!normalized) return null;
  if (['si', 'sí', 'true', '1', 'activo', 'active'].includes(normalized)) return 'active';
  if (['no', 'false', '0', 'inactivo', 'archivado', 'archived'].includes(normalized)) return 'archived';
  return '__invalid__';
}

function buildImagePayload(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '__invalid__';
    }
    return {
      url: parsed.toString(),
      alt: null,
      source: 'external_url'
    };
  } catch {
    return '__invalid__';
  }
}

function isRowEmpty(row) {
  return !Array.isArray(row) || row.every((value) => !normalizeString(value));
}

function normalizeCategoryName(value) {
  return normalizeLooseKey(value).replace(/\s+/g, ' ').trim();
}

function normalizeSkuKey(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeNameCategoryKey(name, categoryName) {
  const safeName = normalizeLooseKey(name);
  const safeCategory = normalizeCategoryName(categoryName);
  return safeName ? `${safeName}::${safeCategory}` : '';
}

function translateRowIssue(issue) {
  switch (issue) {
    case 'missing_name':
      return 'El nombre es obligatorio.';
    case 'invalid_price':
      return 'El precio debe ser un numero valido.';
    case 'negative_price':
      return 'El precio no puede ser negativo.';
    case 'invalid_cost':
      return 'El costo debe ser un numero valido.';
    case 'negative_cost':
      return 'El costo no puede ser negativo.';
    case 'invalid_weight':
      return 'El peso debe ser un numero valido.';
    case 'negative_weight':
      return 'El peso no puede ser negativo.';
    case 'invalid_stock':
      return 'El stock debe ser un entero valido.';
    case 'negative_stock':
      return 'El stock no puede ser negativo.';
    case 'invalid_active':
      return 'El valor de activo no es reconocible.';
    case 'invalid_image_url':
      return 'La imagen debe ser una URL http o https.';
    case 'duplicate_in_file':
      return 'Hay un duplicado dentro del mismo archivo.';
    case 'duplicate_existing':
      return 'Ya existe un producto equivalente en el catalogo.';
    case 'missing_category':
      return 'La categoria no existe y la politica actual no permite crearla.';
    case 'duplicate_cancelled':
      return 'La politica actual cancela filas duplicadas.';
    default:
      return 'La fila tiene datos invalidos.';
  }
}

function buildErrorEntry({ rowNumber, field, value, code }) {
  return {
    rowNumber,
    field,
    value: normalizeString(value).slice(0, 120),
    code,
    message: translateRowIssue(code)
  };
}

function buildImportConfig(options = {}) {
  const duplicatePolicy = DUPLICATE_POLICIES.has(options.duplicatePolicy) ? options.duplicatePolicy : 'skip';
  const categoryPolicy = CATEGORY_POLICIES.has(options.categoryPolicy) ? options.categoryPolicy : 'reject_missing';
  const importPolicy = IMPORT_POLICIES.has(options.importPolicy) ? options.importPolicy : 'valid_only';
  const hasHeaders = options.hasHeaders !== undefined ? options.hasHeaders === true : true;
  return {
    sheetName: normalizeString(options.sheetName) || null,
    delimiter: options.delimiter === '\t' ? '\t' : normalizeString(options.delimiter) || null,
    hasHeaders,
    duplicatePolicy,
    categoryPolicy,
    importPolicy,
    mapping: options.mapping && typeof options.mapping === 'object' ? options.mapping : {}
  };
}

function parseStructuredFile(file, options = {}) {
  const fileType = normalizeFileType(file.originalname || file.name || '');
  if (!fileType || !SUPPORTED_FILE_TYPES.has(fileType)) {
    return { ok: false, reason: 'unsupported_catalog_import_file_type' };
  }

  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'missing_catalog_import_file' };
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: 'catalog_import_file_too_large' };
  }

  if (fileType === 'xlsx') {
    try {
      const workbook = XLSX.read(buffer, {
        type: 'buffer',
        dense: false,
        cellFormula: false,
        cellHTML: false,
        cellText: true
      });
      const sheets = workbook.SheetNames.map((sheetName) => {
        const rows = convertSheetRows(workbook.Sheets[sheetName], workbook);
        return {
          name: sheetName,
          rowCount: rows.filter((row) => !isRowEmpty(row)).length,
          columns: Math.max(...rows.map((row) => row.length), 0)
        };
      });
      if (!sheets.length) {
        return { ok: false, reason: 'catalog_import_empty_file' };
      }

      const selectedSheet = normalizeString(options.sheetName) || sheets[0].name;
      const sheet = workbook.Sheets[selectedSheet];
      if (!sheet) {
        return { ok: false, reason: 'catalog_import_sheet_not_found' };
      }

      const rows = convertSheetRows(sheet, workbook);
      return {
        ok: true,
        fileType,
        rows,
        sheets,
        selectedSheet,
        delimiter: null
      };
    } catch (error) {
      return { ok: false, reason: 'catalog_import_corrupt_file', details: error.message };
    }
  }

  const text = buffer.toString('utf8');
  const delimiter = options.delimiter === '\t' ? '\t' : normalizeString(options.delimiter) || detectDelimiter(text);
  const lines = text.split(/\r?\n/);
  const rows = lines.map((line) => splitDelimitedLine(line, delimiter));
  const hasStructuredContent = rows.some((row) => Array.isArray(row) && row.length > 1);
  if (!hasStructuredContent) {
    return { ok: false, reason: 'catalog_import_unstructured_text' };
  }

  return {
    ok: true,
    fileType,
    rows,
    sheets: [
      {
        name: 'Datos',
        rowCount: rows.filter((row) => !isRowEmpty(row)).length,
        columns: Math.max(...rows.map((row) => row.length), 0)
      }
    ],
    selectedSheet: 'Datos',
    delimiter
  };
}

function analyzeRows(rows, options, catalogSnapshot) {
  const nonEmptyRows = (Array.isArray(rows) ? rows : []).filter((row) => !isRowEmpty(row));
  const hasHeaders = inferHasHeaders(nonEmptyRows, options.hasHeaders);
  const columns = extractColumns(nonEmptyRows, hasHeaders);

  if (!columns.length) {
    return { ok: false, reason: 'catalog_import_no_columns_detected' };
  }
  if (columns.length > MAX_COLUMNS) {
    return { ok: false, reason: 'catalog_import_too_many_columns' };
  }

  const bodyRows = hasHeaders ? nonEmptyRows.slice(1) : nonEmptyRows.slice(0);
  if (bodyRows.length > MAX_ROWS) {
    return { ok: false, reason: 'catalog_import_too_many_rows' };
  }

  const mapping = sanitizeMapping(
    Object.keys(options.mapping || {}).length > 0 ? options.mapping : suggestMapping(columns),
    columns
  );

  const skuSeen = new Map();
  const nameCategorySeen = new Map();
  const errors = [];
  const normalizedRows = [];
  let ignoredEmptyRows = 0;
  const pendingNewCategoryNames = new Set();

  const productBySku = new Map();
  const productByNameCategory = new Map();
  for (const product of catalogSnapshot.products) {
    const skuKey = normalizeSkuKey(product.sku);
    if (skuKey) productBySku.set(skuKey, product);
    const composite = normalizeNameCategoryKey(product.name, product.categoryName);
    if (composite) productByNameCategory.set(composite, product);
  }

  const categoriesByNormalizedName = new Map();
  for (const category of catalogSnapshot.categories) {
    categoriesByNormalizedName.set(normalizeCategoryName(category.name), category);
  }

  bodyRows.forEach((row, rowIndex) => {
    const sourceRowNumber = hasHeaders ? rowIndex + 2 : rowIndex + 1;
    if (isRowEmpty(row)) {
      ignoredEmptyRows += 1;
      normalizedRows.push({
        sourceRowNumber,
        status: 'ignored',
        action: 'ignore',
        warnings: [],
        errors: [],
        values: {}
      });
      return;
    }

    const values = {};
    const attributes = {};
    for (const column of columns) {
      const targetField = mapping[column.key];
      if (!targetField) continue;
      const attributeKey = parseAttributeTarget(targetField);
      const rawValue = row[column.index] !== undefined ? row[column.index] : '';
      if (attributeKey) {
        const normalizedValue = normalizeString(rawValue);
        if (normalizedValue) attributes[attributeKey] = normalizedValue;
        continue;
      }
      values[targetField] = rawValue;
    }

    const rowErrors = [];
    const rowWarnings = [];
    const normalizedName = normalizeString(values.name);
    const normalizedDescription = normalizeString(values.description) || null;
    const normalizedCategoryInput = normalizeString(values.categoryName);
    const normalizedSubcategory = normalizeString(values.subcategory) || null;
    const normalizedBrand = normalizeString(values.brand) || null;
    const normalizedManufacturer = normalizeString(values.manufacturer) || null;
    const normalizedBarcode = normalizeString(values.barcode) || null;
    const normalizedUnitOfMeasure = normalizeString(values.unitOfMeasure) || null;
    const normalizedDefaultSupplier = normalizeString(values.defaultSupplier) || null;
    const normalizedWeightUnit = normalizeString(values.weightUnit) || null;
    const normalizedPresentation = normalizeString(values.presentation) || null;
    const normalizedCategoryKey = normalizeCategoryName(normalizedCategoryInput);
    const parsedCost = values.cost === undefined || values.cost === '' ? null : parseDecimalString(values.cost);
    const parsedWeight = values.weight === undefined || values.weight === '' ? null : parseDecimalString(values.weight);
    const parsedPrice = values.price === undefined || values.price === '' ? 0 : parseDecimalString(values.price);
    const parsedStock = values.stock === undefined || values.stock === '' ? 0 : parseIntegerString(values.stock);
    const sku = normalizeString(values.sku) || null;
    const status = values.active === undefined || values.active === '' ? 'active' : parseBooleanStatus(values.active);
    const currency = normalizeString(values.currency) || 'ARS';
    const image = values.imageUrl === undefined ? null : buildImagePayload(values.imageUrl);
    const category = normalizedCategoryKey ? categoriesByNormalizedName.get(normalizedCategoryKey) || null : null;
    const categoryPendingCreation = Boolean(!category && normalizedCategoryInput && options.categoryPolicy === 'create_missing');

    if (!normalizedName) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Nombre', value: values.name, code: 'missing_name' }));
    }

    if (parsedPrice === null || Number.isNaN(parsedPrice)) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Precio', value: values.price, code: 'invalid_price' }));
    } else if (parsedPrice < 0) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Precio', value: values.price, code: 'negative_price' }));
    }

    if (parsedCost === null && values.cost !== undefined && values.cost !== '') {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Costo', value: values.cost, code: 'invalid_cost' }));
    } else if (parsedCost !== null && Number.isNaN(parsedCost)) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Costo', value: values.cost, code: 'invalid_cost' }));
    } else if (parsedCost !== null && parsedCost < 0) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Costo', value: values.cost, code: 'negative_cost' }));
    }

    if (parsedWeight === null && values.weight !== undefined && values.weight !== '') {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Peso', value: values.weight, code: 'invalid_weight' }));
    } else if (parsedWeight !== null && Number.isNaN(parsedWeight)) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Peso', value: values.weight, code: 'invalid_weight' }));
    } else if (parsedWeight !== null && parsedWeight < 0) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Peso', value: values.weight, code: 'negative_weight' }));
    }

    if (parsedStock === null) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Stock', value: values.stock, code: 'invalid_stock' }));
    } else if (parsedStock < 0) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Stock', value: values.stock, code: 'negative_stock' }));
    }

    if (status === '__invalid__') {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Activo', value: values.active, code: 'invalid_active' }));
    }

    if (image === '__invalid__') {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Imagen URL', value: values.imageUrl, code: 'invalid_image_url' }));
    }

    if (!category && normalizedCategoryInput && options.categoryPolicy === 'reject_missing') {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: 'Categoria', value: normalizedCategoryInput, code: 'missing_category' }));
    }

    const skuKey = normalizeSkuKey(sku);
    const nameCategoryKey = normalizeNameCategoryKey(normalizedName, normalizedCategoryInput || category?.name || '');
    const duplicateInFile =
      (skuKey && skuSeen.has(skuKey)) ||
      (!skuKey && nameCategoryKey && nameCategorySeen.has(nameCategoryKey));

    if (duplicateInFile) {
      rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: skuKey ? 'SKU' : 'Nombre', value: sku || normalizedName, code: 'duplicate_in_file' }));
    }

    if (skuKey) skuSeen.set(skuKey, sourceRowNumber);
    if (nameCategoryKey) nameCategorySeen.set(nameCategoryKey, sourceRowNumber);

    const duplicateExisting = (skuKey && productBySku.get(skuKey)) || (!skuKey ? productByNameCategory.get(nameCategoryKey) : null);
    let action = 'create';
    let statusLabel = 'valid';

    if (duplicateExisting) {
      if (options.duplicatePolicy === 'skip') {
        action = 'skip_duplicate';
        statusLabel = 'duplicated';
        rowWarnings.push(translateRowIssue('duplicate_existing'));
      } else if (options.duplicatePolicy === 'update') {
        action = 'update';
        statusLabel = 'warning';
        rowWarnings.push('Se actualizara un producto existente.');
      } else {
        action = 'error';
        statusLabel = 'error';
        rowErrors.push(buildErrorEntry({ rowNumber: sourceRowNumber, field: skuKey ? 'SKU' : 'Nombre', value: sku || normalizedName, code: 'duplicate_cancelled' }));
      }
    }

    if (rowErrors.length > 0) {
      action = 'error';
      statusLabel = 'error';
    }

    if (categoryPendingCreation && action !== 'error' && action !== 'skip_duplicate') {
      pendingNewCategoryNames.add(normalizedCategoryKey);
    }

    normalizedRows.push({
      sourceRowNumber,
      status: statusLabel,
      action,
      warnings: rowWarnings,
      errors: rowErrors,
      duplicateProductId: duplicateExisting ? duplicateExisting.id : null,
      values: {
        name: normalizedName,
        description: normalizedDescription,
        categoryName: normalizedCategoryInput || null,
        subcategory: normalizedSubcategory,
        brand: normalizedBrand,
        manufacturer: normalizedManufacturer,
        barcode: normalizedBarcode,
        unitOfMeasure: normalizedUnitOfMeasure,
        cost: parsedCost === null || Number.isNaN(parsedCost) ? null : parsedCost,
        defaultSupplier: normalizedDefaultSupplier,
        weight: parsedWeight === null || Number.isNaN(parsedWeight) ? null : parsedWeight,
        weightUnit: normalizedWeightUnit,
        presentation: normalizedPresentation,
        attributes,
        price: parsedPrice === null || Number.isNaN(parsedPrice) ? null : parsedPrice,
        stock: parsedStock === null ? null : parsedStock,
        sku,
        status: STATUS_VALUES.has(status) ? status : 'active',
        currency,
        image,
        existingCategoryId: category ? category.id : null,
        categoryPendingCreation
      }
    });

    rowErrors.forEach((item) => errors.push(item));
  });

  const stats = {
    totalRows: normalizedRows.length,
    validRows: normalizedRows.filter((row) => row.status === 'valid').length,
    warningRows: normalizedRows.filter((row) => row.status === 'warning').length,
    errorRows: normalizedRows.filter((row) => row.status === 'error').length,
    duplicateRows: normalizedRows.filter((row) => row.status === 'duplicated' || row.action === 'update').length,
    ignoredRows: normalizedRows.filter((row) => row.status === 'ignored').length + ignoredEmptyRows,
    newCategories: pendingNewCategoryNames.size
  };

  return {
    ok: true,
    hasHeaders,
    columns,
    mapping,
    errors,
    normalizedRows,
    previewRows: normalizedRows.slice(0, PREVIEW_LIMIT),
    stats
  };
}

async function loadCatalogSnapshot(clinicId) {
  const [products, categories] = await Promise.all([
    listProductsByClinicId(clinicId),
    listProductCategoriesByClinicId(clinicId, { includeInactive: true })
  ]);
  return {
    products: Array.isArray(products) ? products : [],
    categories: Array.isArray(categories) ? categories : []
  };
}

async function recordAudit(action, context, importJob, payload = {}, client = null) {
  await createCatalogImportAuditEvent(
    {
      importId: importJob.id,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      actorId: context.actorId || null,
      actorName: context.actorName || null,
      action,
      payload
    },
    client
  );
}

async function resolveImportContext(tenantId, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  return {
    ...context,
    actorId: normalizeString(actor.actorId) || null,
    actorName: normalizeString(actor.actorName) || null
  };
}

function buildAnalysisResponse(importJob) {
  return {
    importId: importJob.id,
    status: importJob.status,
    file: {
      name: importJob.originalFileName,
      type: importJob.fileType,
      mimeType: importJob.mimeType,
      sizeBytes: importJob.fileSizeBytes
    },
    config: importJob.config || {},
    analysis: importJob.analysis || {},
    result: importJob.result || {},
    expiresAt: importJob.expiresAt,
    createdAt: importJob.createdAt,
    updatedAt: importJob.updatedAt
  };
}

async function analyzeCatalogImport(tenantId, file, options = {}, actor = {}) {
  const context = await resolveImportContext(tenantId, actor);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const parsed = parseStructuredFile(file, options);
  if (!parsed.ok) {
    return { ok: false, tenantId: context.tenantId, reason: parsed.reason, details: parsed.details || null };
  }

  const importConfig = buildImportConfig({
    ...options,
    sheetName: parsed.selectedSheet,
    delimiter: parsed.delimiter
  });
  const snapshot = await loadCatalogSnapshot(context.clinic.id);
  const analysis = analyzeRows(parsed.rows, importConfig, snapshot);
  if (!analysis.ok) {
    return { ok: false, tenantId: context.tenantId, reason: analysis.reason };
  }

  const expiresAt = new Date(Date.now() + IMPORT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const importJob = await withTransaction(async (client) => {
    const created = await createCatalogImportJob(
      {
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorId: context.actorId,
        actorName: context.actorName,
        status: 'ready',
        originalFileName: normalizeString(file.originalname || file.name || 'catalog-import'),
        safeFileName: normalizeSafeFileName(file.originalname || file.name || 'catalog-import'),
        fileType: parsed.fileType,
        mimeType: normalizeString(file.mimetype) || null,
        fileSizeBytes: file.buffer.length,
        config: {
          ...importConfig,
          sheets: parsed.sheets
        },
        analysis: analysis,
        result: {},
        expiresAt
      },
      client
    );

    await recordAudit(
      'catalog_import_uploaded',
      context,
      created,
      {
        originalFileName: created.originalFileName,
        fileType: created.fileType,
        fileSizeBytes: created.fileSizeBytes
      },
      client
    );
    await recordAudit(
      'catalog_import_analyzed',
      context,
      created,
      {
        rows: analysis.stats.totalRows,
        validRows: analysis.stats.validRows,
        warningRows: analysis.stats.warningRows,
        errorRows: analysis.stats.errorRows,
        duplicateRows: analysis.stats.duplicateRows,
        ignoredRows: analysis.stats.ignoredRows,
        duplicatePolicy: importConfig.duplicatePolicy,
        categoryPolicy: importConfig.categoryPolicy,
        importPolicy: importConfig.importPolicy
      },
      client
    );
    return created;
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    import: buildAnalysisResponse(importJob)
  };
}

async function getCatalogImport(tenantId, importId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const importJob = await findCatalogImportJobById(importId, context.clinic.id);
  if (!importJob) {
    return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_not_found' };
  }
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    import: buildAnalysisResponse(importJob)
  };
}

async function cancelCatalogImport(tenantId, importId, actor = {}) {
  const context = await resolveImportContext(tenantId, actor);
  if (!context.ok || !context.clinic?.id) return context;
  const importJob = await findCatalogImportJobById(importId, context.clinic.id);
  if (!importJob) {
    return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_not_found' };
  }
  if (['completed', 'completed_with_errors', 'cancelled'].includes(importJob.status)) {
    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      import: buildAnalysisResponse(importJob)
    };
  }

  const cancelled = await withTransaction(async (client) => {
    const updated = await updateCatalogImportJob(
      importId,
      context.clinic.id,
      {
        status: 'cancelled',
        cancelledAt: new Date().toISOString()
      },
      client
    );
    await recordAudit('catalog_import_cancelled', context, updated, {}, client);
    return updated;
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    import: buildAnalysisResponse(cancelled)
  };
}

async function resolveCategoryIdForImport(clinicId, categoryName, categoryPolicy, categoryCache, client) {
  const normalizedCategory = normalizeCategoryName(categoryName);
  if (!normalizedCategory) return { ok: true, categoryId: null, created: false };

  if (categoryCache.has(normalizedCategory)) {
    return { ok: true, categoryId: categoryCache.get(normalizedCategory).id, created: false };
  }

  if (categoryPolicy !== 'create_missing') {
    return { ok: false, reason: 'missing_category' };
  }

  const existing = await findProductCategoryByName(categoryName, clinicId, client);
  if (existing) {
    categoryCache.set(normalizedCategory, existing);
    return { ok: true, categoryId: existing.id, created: false };
  }

  const created = await createProductCategory(
    {
      clinicId,
      name: categoryName,
      isActive: true
    },
    client
  );
  categoryCache.set(normalizedCategory, created);
  return { ok: true, categoryId: created.id, created: true };
}

async function applyRowImport(context, row, importConfig, runtime, client) {
  if (row.status === 'ignored') {
    runtime.summary.ignored += 1;
    runtime.results.push({ sourceRowNumber: row.sourceRowNumber, status: 'ignored', code: 'ignored_empty_row' });
    return;
  }

  if (row.status === 'duplicated' && importConfig.duplicatePolicy === 'skip') {
    runtime.summary.skippedDuplicates += 1;
    runtime.results.push({ sourceRowNumber: row.sourceRowNumber, status: 'skipped', code: 'duplicate_existing' });
    return;
  }

  if (row.status === 'error') {
    runtime.summary.errors += 1;
    runtime.results.push({
      sourceRowNumber: row.sourceRowNumber,
      status: 'error',
      code: row.errors[0]?.code || 'row_error',
      message: row.errors[0]?.message || 'La fila tiene errores.'
    });
    return;
  }

  const values = row.values || {};
  const categoryResolution = await resolveCategoryIdForImport(
    context.clinic.id,
    values.categoryName,
    importConfig.categoryPolicy,
    runtime.categoriesByName,
    client
  );
  if (!categoryResolution.ok) {
    runtime.summary.errors += 1;
    runtime.results.push({
      sourceRowNumber: row.sourceRowNumber,
      status: 'error',
      code: categoryResolution.reason,
      message: translateRowIssue(categoryResolution.reason)
    });
    return;
  }
  if (categoryResolution.created) {
    runtime.summary.createdCategories += 1;
  }

  const payload = {
    name: values.name,
    description: values.description || null,
    brand: values.brand || null,
    manufacturer: values.manufacturer || null,
    barcode: values.barcode || null,
    unitOfMeasure: values.unitOfMeasure || null,
    cost: values.cost ?? null,
    defaultSupplier: values.defaultSupplier || null,
    weight: values.weight ?? null,
    weightUnit: values.weightUnit || null,
    presentation: values.presentation || null,
    subcategory: values.subcategory || null,
    attributes: values.attributes || {},
    unitPrice: values.price ?? 0,
    price: values.price ?? 0,
    currency: values.currency || 'ARS',
    vatRate: 0,
    taxRate: 0,
    stock: values.stock ?? 0,
    status: STATUS_VALUES.has(values.status) ? values.status : 'active',
    sku: values.sku || null,
    categoryId: categoryResolution.categoryId,
    image: values.image || null,
    metadata: {}
  };

  if (row.action === 'update' && row.duplicateProductId) {
    const current = await findProductById(row.duplicateProductId, context.clinic.id, client);
    if (!current) {
      runtime.summary.errors += 1;
      runtime.results.push({
        sourceRowNumber: row.sourceRowNumber,
        status: 'error',
        code: 'duplicate_product_missing',
        message: 'No pudimos localizar el producto a actualizar.'
      });
      return;
    }

    const updatePayload = {
      ...current,
      name: payload.name || current.name,
      description: payload.description !== null ? payload.description : current.description,
      brand: values.brand !== undefined ? payload.brand : current.brand,
      manufacturer: values.manufacturer !== undefined ? payload.manufacturer : current.manufacturer,
      barcode: values.barcode !== undefined ? payload.barcode : current.barcode,
      unitOfMeasure: values.unitOfMeasure !== undefined ? payload.unitOfMeasure : current.unitOfMeasure,
      cost: values.cost !== undefined ? payload.cost : current.cost,
      defaultSupplier: values.defaultSupplier !== undefined ? payload.defaultSupplier : current.defaultSupplier,
      weight: values.weight !== undefined ? payload.weight : current.weight,
      weightUnit: values.weightUnit !== undefined ? payload.weightUnit : current.weightUnit,
      presentation: values.presentation !== undefined ? payload.presentation : current.presentation,
      subcategory: values.subcategory !== undefined ? payload.subcategory : current.subcategory,
      attributes: Object.keys(values.attributes || {}).length ? { ...(current.attributes || {}), ...values.attributes } : current.attributes,
      unitPrice: values.price !== null && values.price !== undefined ? payload.unitPrice : current.unitPrice,
      price: values.price !== null && values.price !== undefined ? payload.price : current.unitPrice,
      currency: payload.currency || current.currency,
      stock: values.stock !== null && values.stock !== undefined ? payload.stock : current.stock,
      status: payload.status || current.status,
      categoryId: categoryResolution.categoryId || current.categoryId,
      image: payload.image !== null ? payload.image : current.image,
      sku: payload.sku || current.sku
    };
    await updateProduct(current.id, context.clinic.id, updatePayload, client);
    runtime.summary.updated += 1;
    runtime.results.push({ sourceRowNumber: row.sourceRowNumber, status: 'updated', productId: current.id });
    return;
  }

  try {
    const created = await createProduct(
      {
        clinicId: context.clinic.id,
        ...payload
      },
      client
    );
    runtime.summary.created += 1;
    runtime.results.push({ sourceRowNumber: row.sourceRowNumber, status: 'created', productId: created.id });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      runtime.summary.skippedDuplicates += 1;
      runtime.results.push({ sourceRowNumber: row.sourceRowNumber, status: 'skipped', code: 'duplicate_product_sku' });
      return;
    }
    throw error;
  }
}

async function confirmCatalogImport(tenantId, importId, actor = {}) {
  const context = await resolveImportContext(tenantId, actor);
  if (!context.ok || !context.clinic?.id) return context;

  const startedAt = Date.now();
  const confirmed = await withTransaction(async (client) => {
    const importJob = await findCatalogImportJobById(importId, context.clinic.id, client, { forUpdate: true });
    if (!importJob) {
      return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_not_found' };
    }

    if (importJob.status === 'cancelled') {
      return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_cancelled' };
    }

    if (importJob.status === 'completed' || importJob.status === 'completed_with_errors') {
      return {
        ok: true,
        tenantId: context.tenantId,
        clinic: context.clinic,
        import: buildAnalysisResponse(importJob),
        idempotent: true
      };
    }

    const importConfig = buildImportConfig(importJob.config || {});
    const analysis = importJob.analysis || {};
    const rows = Array.isArray(analysis.normalizedRows) ? analysis.normalizedRows : [];
    if (!rows.length) {
      return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_not_ready' };
    }

    if (importConfig.importPolicy === 'fail_on_error' && rows.some((row) => row.status === 'error')) {
      return { ok: false, tenantId: context.tenantId, reason: 'catalog_import_blocked_by_errors' };
    }

    let currentJob = await updateCatalogImportJob(
      importId,
      context.clinic.id,
      {
        status: 'processing',
        confirmedAt: importJob.confirmedAt || new Date().toISOString()
      },
      client
    );

    await recordAudit(
      'catalog_import_confirmed',
      context,
      currentJob,
      {
        duplicatePolicy: importConfig.duplicatePolicy,
        categoryPolicy: importConfig.categoryPolicy,
        importPolicy: importConfig.importPolicy
      },
      client
    );

    const existingCategories = await listProductCategoriesByClinicId(context.clinic.id, { includeInactive: true }, client);
    const runtime = {
      categoriesByName: new Map(
        (Array.isArray(existingCategories) ? existingCategories : []).map((category) => [normalizeCategoryName(category.name), category])
      ),
      summary: {
        created: 0,
        updated: 0,
        skippedDuplicates: 0,
        errors: 0,
        ignored: 0,
        createdCategories: 0
      },
      results: []
    };

    for (let index = 0; index < rows.length; index += PROCESSING_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + PROCESSING_CHUNK_SIZE);
      for (const row of chunk) {
        await applyRowImport(context, row, importConfig, runtime, client);
      }
    }

    const durationMs = Date.now() - startedAt;
    const completedStatus = runtime.summary.errors > 0 ? 'completed_with_errors' : 'completed';
    currentJob = await updateCatalogImportJob(
      importId,
      context.clinic.id,
      {
        status: completedStatus,
        completedAt: new Date().toISOString(),
        result: {
          summary: {
            ...runtime.summary,
            processingTimeMs: durationMs
          },
          rows: runtime.results
        }
      },
      client
    );

    await recordAudit(
      runtime.summary.errors > 0 ? 'catalog_import_completed' : 'catalog_import_completed',
      context,
      currentJob,
      {
        rows: rows.length,
        created: runtime.summary.created,
        updated: runtime.summary.updated,
        skippedDuplicates: runtime.summary.skippedDuplicates,
        errors: runtime.summary.errors,
        createdCategories: runtime.summary.createdCategories,
        processingTimeMs: durationMs
      },
      client
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      import: buildAnalysisResponse(currentJob),
      idempotent: false
    };
  });

  return confirmed;
}

function normalizeImportErrorFieldKey(value) {
  const text = normalizeString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (['precio', 'price', 'unit_price', 'unitprice'].includes(text)) return 'price';
  if (['stock', 'cantidad', 'quantity'].includes(text)) return 'stock';
  if (['sku', 'codigo', 'codigo sku', 'code'].includes(text)) return 'sku';
  if (['nombre', 'name', 'producto'].includes(text)) return 'name';
  if (['categoria', 'category', 'categoryname', 'category name'].includes(text)) return 'category';
  if (['activo', 'active', 'estado', 'status'].includes(text)) return 'active';
  if (['moneda', 'currency'].includes(text)) return 'currency';
  if (['imagen url', 'image url', 'imageurl'].includes(text)) return 'image_url';
  return text;
}

function normalizeCatalogImportError(rawError, sourceIndex = 0) {
  const rowNumber = Number(rawError?.rowNumber ?? rawError?.sourceRowNumber ?? 0) || 0;
  const code = normalizeString(rawError?.code || 'row_error') || 'row_error';
  const field = normalizeString(rawError?.field);
  const value = rawError?.value === null || rawError?.value === undefined ? '' : String(rawError.value);
  const fallbackMessage = translateRowIssue(code);
  const message = normalizeString(rawError?.message) || fallbackMessage;
  return {
    rowNumber,
    field,
    fieldKey: normalizeImportErrorFieldKey(field),
    value,
    code,
    codeKey: code.toLowerCase(),
    message,
    genericMessage: fallbackMessage,
    sourceIndex
  };
}

function scoreCanonicalImportError(error) {
  let score = 0;
  if (error.fieldKey) score += 8;
  if (normalizeString(error.value)) score += 4;
  if (error.message && error.message !== error.genericMessage) score += 2;
  if (error.message) score += 1;
  return score;
}

function chooseBestImportError(current, candidate) {
  if (!current) return candidate;
  const currentScore = scoreCanonicalImportError(current);
  const candidateScore = scoreCanonicalImportError(candidate);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore < currentScore) return current;
  return candidate.sourceIndex < current.sourceIndex ? candidate : current;
}

function buildCanonicalImportErrors(importJob) {
  const analysisErrors = Array.isArray(importJob?.analysis?.errors) ? importJob.analysis.errors : [];
  const resultRows = Array.isArray(importJob?.result?.rows) ? importJob.result.rows : [];
  const resultErrors = resultRows
    .filter((row) => row && row.status === 'error')
    .map((row) => ({
      rowNumber: row.sourceRowNumber,
      field: '',
      value: '',
      code: row.code || 'row_error',
      message: row.message || translateRowIssue(row.code)
    }));

  const errors = [...analysisErrors, ...resultErrors].map((error, index) => normalizeCatalogImportError(error, index));
  const groupsByRowCode = new Map();
  for (const error of errors) {
    const key = `${error.rowNumber}::${error.codeKey}`;
    if (!groupsByRowCode.has(key)) groupsByRowCode.set(key, []);
    groupsByRowCode.get(key).push(error);
  }

  const canonical = [];
  for (const group of groupsByRowCode.values()) {
    const fieldKeys = new Set(group.map((error) => error.fieldKey).filter(Boolean));
    if (fieldKeys.size <= 1) {
      canonical.push(group.reduce((best, error) => chooseBestImportError(best, error), null));
      continue;
    }

    const groupsByField = new Map();
    for (const error of group) {
      const fieldKey = error.fieldKey || '__generic__';
      groupsByField.set(fieldKey, chooseBestImportError(groupsByField.get(fieldKey), error));
    }
    canonical.push(...groupsByField.values());
  }

  return canonical.sort((left, right) => {
    if (left.rowNumber !== right.rowNumber) return left.rowNumber - right.rowNumber;
    return left.sourceIndex - right.sourceIndex;
  });
}

function buildCatalogImportErrorCsv(importJob) {
  const rows = buildCanonicalImportErrors(importJob);
  const header = 'Fila;Campo;Valor;Error;Código';
  const body = rows.map((row) =>
    [
      row.rowNumber,
      escapeCsvValue(row.field || ''),
      escapeCsvValue(row.value || ''),
      escapeCsvValue(row.message || ''),
      escapeCsvValue(row.code || '')
    ].join(';')
  );
  return `${header}\n${body.join('\n')}`;
}

function escapeCsvValue(value) {
  const normalized = value === null || value === undefined ? '' : String(value);
  const neutralized = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  if (/[;,"\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

function buildCatalogImportTemplateCsv() {
  return [
    'Nombre;Descripcion;Categoria;Subcategoria;Marca;Fabricante;Codigo de barras;Unidad;Costo;Precio;Stock;SKU;Proveedor habitual;Peso;Unidad de peso;Presentacion;Activo;Moneda;Imagen URL;Sabor',
    'EJEMPLO - No importar;Fila de ejemplo para borrar antes de subirla;Combos;Promos;NovaTech;Laboratorio Uno;7790000000012;unidad;8000;12500;100;SKU-EJEMPLO-1;Proveedor Centro;0.5;kg;Caja x 1;si;ARS;https://ejemplo.com/producto-1.jpg;Vainilla',
    'EJEMPLO - No importar;Segunda fila de referencia;Bebidas;Agua;Voltix;Bebidas Sur;7790000000029;botella;900;1500;200;SKU-EJEMPLO-2;Distribuidora Norte;500;ml;Botella 500ml;si;ARS;https://ejemplo.com/producto-2.jpg;Sin gas'
  ].join('\n');
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  MAX_ROWS,
  MAX_COLUMNS,
  PREVIEW_LIMIT,
  PROCESSING_CHUNK_SIZE,
  analyzeCatalogImport,
  getCatalogImport,
  cancelCatalogImport,
  confirmCatalogImport,
  buildCanonicalImportErrors,
  buildCatalogImportErrorCsv,
  buildCatalogImportTemplateCsv,
  detectDelimiter,
  splitDelimitedLine,
  suggestMapping,
  analyzeRows,
  parseStructuredFile
};
