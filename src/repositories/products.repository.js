const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized.slice(0, 10);
  return normalized;
}

function normalizeMetadataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeCatalogText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeCatalogNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCatalogAttributeValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized) return null;
  return normalized;
}

function normalizeProductAttributeRecord(value) {
  const attributes = {};

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const name = normalizeCatalogText(item.name);
      if (!name) continue;
      const options = Array.isArray(item.options)
        ? Array.from(new Set(item.options.map((option) => String(option || '').trim()).filter(Boolean)))
        : [];
      const normalizedValue = normalizeCatalogAttributeValue(options.join(', '));
      if (normalizedValue !== null) attributes[name] = normalizedValue;
    }
    return attributes;
  }

  if (!value || typeof value !== 'object') return {};

  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeCatalogText(key);
    const normalizedValue = normalizeCatalogAttributeValue(rawValue);
    if (normalizedKey && normalizedValue !== null) {
      attributes[normalizedKey] = normalizedValue;
    }
  }

  return attributes;
}

function normalizeProductImageRecord(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '__invalid__';

  const rawUrl = String(value.url || '').trim();
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '__invalid__';
    }

    return {
      url: parsed.toString(),
      alt: String(value.alt || '').trim() || null,
      source: String(value.source || '').trim() || 'external_url'
    };
  } catch (error) {
    return '__invalid__';
  }
}

function extractCatalogMetadata(metadata) {
  const safeMetadata = normalizeMetadataObject(metadata);
  const catalog = normalizeMetadataObject(safeMetadata.catalog);
  const brand = normalizeCatalogText(catalog.brand);
  const manufacturer = normalizeCatalogText(catalog.manufacturer);
  const barcode = normalizeCatalogText(catalog.barcode);
  const unitOfMeasure = normalizeCatalogText(catalog.unitOfMeasure);
  const cost = normalizeCatalogNumber(catalog.cost);
  const defaultSupplier = normalizeCatalogText(catalog.defaultSupplier);
  const weight = normalizeCatalogNumber(catalog.weight);
  const weightUnit = normalizeCatalogText(catalog.weightUnit);
  const presentation = normalizeCatalogText(catalog.presentation);
  const subcategory = normalizeCatalogText(catalog.subcategory);
  const inventoryTrackingMode = catalog.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy';
  const attributes = normalizeProductAttributeRecord(catalog.attributes);
  const image = normalizeProductImageRecord(catalog.image);

  return {
    brand,
    manufacturer,
    barcode,
    unitOfMeasure,
    cost,
    defaultSupplier,
    weight,
    weightUnit,
    presentation,
    subcategory,
    inventoryTrackingMode,
    attributes,
    image: image === '__invalid__' ? null : image || null
  };
}

function mergeProductMetadata(currentMetadata, nextMetadata) {
  const current = normalizeMetadataObject(currentMetadata);
  const incoming = normalizeMetadataObject(nextMetadata);
  const currentCatalog = normalizeMetadataObject(current.catalog);
  const incomingCatalog = normalizeMetadataObject(incoming.catalog);

  return {
    ...current,
    ...incoming,
    catalog: {
      ...currentCatalog,
      ...incomingCatalog
    }
  };
}

function buildStoredMetadata(inputMetadata, input) {
  const safeMetadata = normalizeMetadataObject(inputMetadata);
  const safeCatalog = normalizeMetadataObject(safeMetadata.catalog);
  const normalizedImage =
    Object.prototype.hasOwnProperty.call(input || {}, 'image')
      ? normalizeProductImageRecord(input.image)
      : normalizeProductImageRecord(safeCatalog.image);
  const nextCatalog = {
    ...safeCatalog,
    brand: normalizeCatalogText(input.brand),
    manufacturer: normalizeCatalogText(input.manufacturer),
    barcode: normalizeCatalogText(input.barcode),
    unitOfMeasure: normalizeCatalogText(input.unitOfMeasure),
    cost: normalizeCatalogNumber(input.cost),
    defaultSupplier: normalizeCatalogText(input.defaultSupplier),
    weight: normalizeCatalogNumber(input.weight),
    weightUnit: normalizeCatalogText(input.weightUnit),
    presentation: normalizeCatalogText(input.presentation),
    subcategory: normalizeCatalogText(input.subcategory),
    inventoryTrackingMode: input.inventoryTrackingMode === 'lot_based' ? 'lot_based' : safeCatalog.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy',
    attributes: normalizeProductAttributeRecord(input.attributes)
  };
  if (normalizedImage === '__invalid__') {
    nextCatalog.image = null;
  } else if (normalizedImage !== undefined) {
    nextCatalog.image = normalizedImage;
  }

  return {
    ...safeMetadata,
    catalog: nextCatalog
  };
}

function normalizeProduct(row) {
  const unitPrice = quantizeDecimal(row.unitPrice ?? row.price ?? 0, 2, 0);
  const vatRate = quantizeDecimal(row.vatRate ?? 0, 2, 0);
  const discountPercentage = row.discountPercentage == null ? null : quantizeDecimal(row.discountPercentage, 2, 0);
  const status = row.status || 'active';
  const metadata = normalizeMetadataObject(row.metadata);
  const catalogMetadata = extractCatalogMetadata(metadata);

  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    description: row.description || null,
    unitPrice,
    price: unitPrice,
    currency: row.currency,
    vatRate,
    taxRate: vatRate,
    stock: Number(row.stock || 0),
    status,
    active: status === 'active',
    sku: row.sku || null,
    categoryId: row.categoryId || null,
    categoryName: row.categoryName || null,
    brand: catalogMetadata.brand,
    manufacturer: catalogMetadata.manufacturer,
    barcode: catalogMetadata.barcode,
    unitOfMeasure: catalogMetadata.unitOfMeasure,
    cost: catalogMetadata.cost,
    defaultSupplier: catalogMetadata.defaultSupplier,
    weight: catalogMetadata.weight,
    weightUnit: catalogMetadata.weightUnit,
    presentation: catalogMetadata.presentation,
    subcategory: catalogMetadata.subcategory,
    inventoryTrackingMode: catalogMetadata.inventoryTrackingMode,
    attributes: catalogMetadata.attributes,
    image: catalogMetadata.image,
    expirationDate: normalizeDateOnly(row.expirationDate),
    discountPercentage,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function listProductsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       p.id,
       p."clinicId",
       p.name,
       p.description,
       p.price,
       p."unitPrice",
       p.currency,
       p."vatRate",
       p.stock,
       p.status,
       p.sku,
       p."categoryId",
       p."expirationDate",
       p."discountPercentage",
       c.name AS "categoryName",
       p.metadata,
       p."createdAt",
       p."updatedAt"
     FROM products p
     LEFT JOIN product_categories c
       ON c.id = p."categoryId"
     WHERE p."clinicId" = $1::uuid
     ORDER BY p."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeProduct);
}

async function findProductById(productId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       p.id,
       p."clinicId",
       p.name,
       p.description,
       p.price,
       p."unitPrice",
       p.currency,
       p."vatRate",
       p.stock,
       p.status,
       p.sku,
       p."categoryId",
       p."expirationDate",
       p."discountPercentage",
       c.name AS "categoryName",
       p.metadata,
       p."createdAt",
       p."updatedAt"
     FROM products p
     LEFT JOIN product_categories c
       ON c.id = p."categoryId"
     WHERE p.id = $1::uuid
       AND p."clinicId" = $2::uuid
     LIMIT 1`,
    [productId, clinicId]
  );

  return result.rows[0] ? normalizeProduct(result.rows[0]) : null;
}

async function createProduct(input, client = null) {
  const safeUnitPrice = quantizeDecimal(input.unitPrice ?? input.price ?? 0, 2, 0);
  const safeVatRate = quantizeDecimal(input.vatRate ?? input.taxRate ?? 0, 2, 0);
  const storedMetadata = buildStoredMetadata(input.metadata, input);

  const result = await dbQuery(
    client,
    `INSERT INTO products (
       "clinicId",
       name,
       description,
       price,
       "unitPrice",
       currency,
       "vatRate",
       stock,
       status,
       sku,
       "categoryId",
       "expirationDate",
       "discountPercentage",
       metadata,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::date, $13, $14::jsonb, NOW())
      RETURNING id`,
    [
      input.clinicId,
      input.name,
      input.description || null,
      safeUnitPrice,
      safeUnitPrice,
      input.currency,
      safeVatRate,
      input.stock,
      input.status,
      input.sku || null,
      input.categoryId || null,
      input.expirationDate || null,
      input.discountPercentage == null ? null : quantizeDecimal(input.discountPercentage, 2, 0),
      JSON.stringify(storedMetadata)
    ]
  );

  return findProductById(result.rows[0].id, input.clinicId, client);
}

async function updateProduct(productId, clinicId, payload, client = null) {
  const current = await findProductById(productId, clinicId, client);
  if (!current) return null;

  const safeUnitPrice = quantizeDecimal(payload.unitPrice ?? payload.price ?? current.unitPrice ?? current.price ?? 0, 2, 0);
  const safeVatRate = quantizeDecimal(payload.vatRate ?? payload.taxRate ?? current.vatRate ?? current.taxRate ?? 0, 2, 0);
  const storedMetadata = buildStoredMetadata(mergeProductMetadata(current.metadata, payload.metadata), {
    ...current,
    ...payload,
    brand: payload.brand !== undefined ? payload.brand : current.brand,
    manufacturer: payload.manufacturer !== undefined ? payload.manufacturer : current.manufacturer,
    barcode: payload.barcode !== undefined ? payload.barcode : current.barcode,
    unitOfMeasure: payload.unitOfMeasure !== undefined ? payload.unitOfMeasure : current.unitOfMeasure,
    cost: payload.cost !== undefined ? payload.cost : current.cost,
    defaultSupplier: payload.defaultSupplier !== undefined ? payload.defaultSupplier : current.defaultSupplier,
    weight: payload.weight !== undefined ? payload.weight : current.weight,
    weightUnit: payload.weightUnit !== undefined ? payload.weightUnit : current.weightUnit,
    presentation: payload.presentation !== undefined ? payload.presentation : current.presentation,
    subcategory: payload.subcategory !== undefined ? payload.subcategory : current.subcategory,
    attributes: payload.attributes !== undefined ? payload.attributes : current.attributes,
    image: payload.image !== undefined ? payload.image : current.image
  });

  await dbQuery(
    client,
    `UPDATE products
     SET
       name = $3,
       description = $4,
       price = $5,
       "unitPrice" = $6,
       currency = $7,
       "vatRate" = $8,
       stock = $9,
       status = $10,
       sku = $11,
       "categoryId" = $12::uuid,
       "expirationDate" = $13::date,
       "discountPercentage" = $14,
       metadata = $15::jsonb,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid`,
    [
      productId,
      clinicId,
      payload.name,
      payload.description || null,
      safeUnitPrice,
      safeUnitPrice,
      payload.currency,
      safeVatRate,
      payload.stock,
      payload.status,
      payload.sku || null,
      payload.categoryId || null,
      payload.expirationDate || null,
      payload.discountPercentage == null ? null : quantizeDecimal(payload.discountPercentage, 2, 0),
      JSON.stringify(storedMetadata)
    ]
  );

  return findProductById(productId, clinicId, client);
}

async function updateProductStatus(productId, clinicId, status, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE products
     SET
       status = $3,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [productId, clinicId, status]
  );

  if (!result.rows[0]) return null;
  return findProductById(productId, clinicId, client);
}

function buildProductDeleteReferenceSummary(row = {}) {
  const summary = {
    inventoryLots: Number(row.inventoryLots || 0),
    inventoryMovements: Number(row.inventoryMovements || 0),
    inventoryAllocations: Number(row.inventoryAllocations || 0),
    orderItems: Number(row.orderItems || 0),
    invoiceItems: Number(row.invoiceItems || 0)
  };

  return {
    ...summary,
    total:
      summary.inventoryLots +
      summary.inventoryMovements +
      summary.inventoryAllocations +
      summary.orderItems +
      summary.invoiceItems
  };
}

async function getProductDeleteReferenceSummary(productId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       (SELECT COUNT(*)::int FROM inventory_lots il
        WHERE il."tenantId" = $2::uuid AND il."productId" = $1::uuid) AS "inventoryLots",
       (SELECT COUNT(*)::int FROM inventory_movements im
        WHERE im."tenantId" = $2::uuid AND im."productId" = $1::uuid) AS "inventoryMovements",
       (SELECT COUNT(*)::int FROM inventory_lot_allocations ila
        WHERE ila."tenantId" = $2::uuid AND ila."productId" = $1::uuid) AS "inventoryAllocations",
       (SELECT COUNT(*)::int FROM order_items oi
        INNER JOIN orders o ON o.id = oi."orderId"
        WHERE o."clinicId" = $2::uuid AND oi."productId" = $1::uuid) AS "orderItems",
       (SELECT COUNT(*)::int FROM invoice_items ii
        INNER JOIN invoices i ON i.id = ii."invoiceId"
        WHERE i."clinicId" = $2::uuid AND ii."productId" = $1::uuid) AS "invoiceItems"`,
    [productId, clinicId]
  );

  return buildProductDeleteReferenceSummary(result.rows[0] || {});
}

async function deleteProductById(productId, clinicId, client = null) {
  const references = await getProductDeleteReferenceSummary(productId, clinicId, client);
  if (references.total > 0) {
    return {
      deleted: false,
      blocked: true,
      reason: 'product_delete_blocked',
      references
    };
  }

  const result = await dbQuery(
    client,
    `DELETE FROM products
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [productId, clinicId]
  );

  return {
    deleted: Boolean(result.rows[0]),
    blocked: false,
    references
  };
}

module.exports = {
  listProductsByClinicId,
  findProductById,
  createProduct,
  updateProduct,
  updateProductStatus,
  getProductDeleteReferenceSummary,
  deleteProductById
};
