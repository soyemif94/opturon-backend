const { withTransaction } = require('../db/client');
const { logInfo } = require('../utils/logger');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { getAutomationEnablementState } = require('./automation-enablement.service');
const { buildCatalogRiskDiscountSuggestion } = require('./catalog-risk-discount.service');
const { insertAutomationActionEvent } = require('../repositories/automation-action-events.repository');
const {
  listProductsByClinicId,
  findProductById,
  createProduct,
  updateProduct,
  updateProductStatus,
  deleteProductById
} = require('../repositories/products.repository');
const {
  listProductCategoriesByClinicId,
  findProductCategoryById,
  findProductCategoryByName,
  createProductCategory,
  updateProductCategory,
  countProductsForCategory,
  deleteProductCategory
} = require('../repositories/product-categories.repository');

const PRODUCT_STATUSES = new Set(['active', 'archived']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeNullablePercentage(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return NaN;
  if (parsed <= 0) return null;
  return parsed;
}

function normalizeAutomationAttribution(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const templateKey = normalizeString(payload.templateKey);
  const action = normalizeString(payload.action);
  if (!templateKey || !action) return null;

  return {
    templateKey,
    action,
    suggestedDiscountPercentage: normalizeNullablePercentage(payload.suggestedDiscountPercentage),
    source: normalizeString(payload.source) || null
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeProductImage(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '__invalid__';

  const rawUrl = normalizeString(value.url);
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '__invalid__';
    }

    return {
      url: parsed.toString(),
      alt: normalizeString(value.alt) || null,
      source: normalizeString(value.source) || 'external_url'
    };
  } catch (error) {
    return '__invalid__';
  }
}

function normalizeAttributes(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const name = normalizeString(item.name);
      if (!name) return null;
      const options = Array.isArray(item.options)
        ? Array.from(new Set(item.options.map((option) => normalizeString(option)).filter(Boolean)))
        : [];
      return {
        name,
        options
      };
    })
    .filter(Boolean);
}

function normalizeDateOnly(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '__invalid__';
  return normalized;
}

function buildProductPayload(payload, fallbackStatus = 'active') {
  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();
  const unitPrice = normalizeNumber(payload && (payload.unitPrice ?? payload.price));
  const vatRate = normalizeNumber(payload && (payload.vatRate ?? payload.taxRate ?? 0));
  const expirationDate = normalizeDateOnly(payload && payload.expirationDate);
  const discountPercentage = normalizeNullablePercentage(payload && payload.discountPercentage);

  return {
    name: normalizeString(payload && payload.name),
    description: normalizeString(payload && payload.description) || null,
    unitPrice,
    price: unitPrice,
    currency: normalizeString((payload && payload.currency) || 'ARS').toUpperCase() || 'ARS',
    vatRate,
    taxRate: vatRate,
    stock: Number.parseInt(String((payload && payload.stock) ?? (payload && payload.stockQty) ?? 0), 10),
    status: PRODUCT_STATUSES.has(requestedStatus) ? requestedStatus : fallbackStatus,
    sku: normalizeString(payload && payload.sku) || null,
    categoryId: normalizeString(payload && payload.categoryId) || null,
    subcategory: normalizeString(payload && (payload.subcategory ?? payload.subcategoryName)) || null,
    attributes: normalizeAttributes(payload && (payload.attributes ?? payload.configurableAttributes ?? payload.variants)),
    image: normalizeProductImage(payload && payload.image),
    expirationDate,
    discountPercentage,
    metadata: normalizeMetadata(payload && payload.metadata)
  };
}

function validateProductPayload(product) {
  if (!product.name) return 'missing_product_name';
  if (!Number.isFinite(product.unitPrice) || product.unitPrice < 0) return 'invalid_product_price';
  if (!Number.isFinite(product.vatRate) || product.vatRate < 0) return 'invalid_product_tax_rate';
  if (!Number.isInteger(product.stock) || product.stock < 0) return 'invalid_product_stock';
  if (!PRODUCT_STATUSES.has(product.status)) return 'invalid_product_status';
  if (product.expirationDate === '__invalid__') return 'invalid_product_expiration_date';
  if (!Array.isArray(product.attributes)) return 'invalid_product_attributes';
  if (product.attributes.some((attribute) => !attribute || !attribute.name || !Array.isArray(attribute.options))) {
    return 'invalid_product_attributes';
  }
  if (product.image === '__invalid__') return 'invalid_product_image';
  if (product.discountPercentage !== null && product.discountPercentage !== undefined) {
    if (!Number.isFinite(product.discountPercentage) || product.discountPercentage <= 0 || product.discountPercentage > 100) {
      return 'invalid_product_discount_percentage';
    }
  }
  return null;
}

function buildCategoryPayload(payload, fallbackIsActive = true) {
  return {
    name: normalizeString(payload && payload.name),
    isActive: payload && payload.isActive !== undefined ? payload.isActive === true : fallbackIsActive
  };
}

function validateCategoryPayload(category) {
  if (!category.name) return 'missing_product_category_name';
  return null;
}

function normalizeBulkCategoryLabel(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  if (
    lowered === 'undefined' ||
    lowered === 'null' ||
    lowered === 'n/a' ||
    lowered === 'na' ||
    lowered === '-'
  ) {
    return null;
  }

  return normalized;
}

async function createProductForContext(context, payload) {
  const product = buildProductPayload(payload, 'active');
  const reason = validateProductPayload(product);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
  }

  if (product.categoryId) {
    const category = await findProductCategoryById(product.categoryId, context.clinic.id);
    if (!category) {
      return { ok: false, tenantId: context.tenantId, reason: 'product_category_not_found' };
    }
  }

  try {
    const created = await withTransaction((client) =>
      createProduct(
        {
          clinicId: context.clinic.id,
          ...product
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      product: await decorateProductWithAutomations(context, created)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'duplicate_product_sku'
      };
    }
    throw error;
  }
}

async function resolveCatalogRiskDiscountAutomation(context) {
  if (!context || !context.clinic || !context.clinic.id) {
    return { enabled: false, reason: 'tenant_mapping_not_found' };
  }

  return getAutomationEnablementState({
    clinicId: context.clinic.id,
    tenantId: context.tenantId,
    key: 'catalog_risk_discount',
    capabilitiesHint: ['catalog']
  });
}

function decorateProductWithCatalogRiskDiscount(product, automationState) {
  if (!product || !automationState || !automationState.enabled) {
    return {
      ...product,
      riskDiscountSuggestion: null
    };
  }

  return {
    ...product,
    riskDiscountSuggestion: buildCatalogRiskDiscountSuggestion(product)
  };
}

async function decorateProductsWithAutomations(context, products) {
  const automationState = await resolveCatalogRiskDiscountAutomation(context);
  const safeProducts = Array.isArray(products) ? products : [];

  if (automationState.enabled) {
    logInfo('catalog_risk_discount_hook_ready', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      key: 'catalog_risk_discount',
      productCount: safeProducts.length
    });
  }

  return safeProducts.map((product) => decorateProductWithCatalogRiskDiscount(product, automationState));
}

async function decorateProductWithAutomations(context, product) {
  if (!product) return product;
  const [decorated] = await decorateProductsWithAutomations(context, [product]);
  return decorated || null;
}

async function listPortalProducts(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const products = await listProductsByClinicId(context.clinic.id);
  const decoratedProducts = await decorateProductsWithAutomations(context, products);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    products: decoratedProducts
  };
}

async function listPortalProductCategories(tenantId, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const includeInactive = options && options.includeInactive !== undefined ? options.includeInactive === true : true;
  const categories = await listProductCategoriesByClinicId(context.clinic.id, { includeInactive });
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    categories
  };
}

async function getPortalProductDetail(tenantId, productId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeProductId = normalizeString(productId);
  if (!safeProductId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  }

  const product = await findProductById(safeProductId, context.clinic.id);
  if (!product) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    product: await decorateProductWithAutomations(context, product)
  };
}

async function createPortalProduct(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }
  return createProductForContext(context, payload);
}

async function patchPortalProduct(tenantId, productId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeProductId = normalizeString(productId);
  if (!safeProductId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  }

  const current = await findProductById(safeProductId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
  }

  const next = buildProductPayload(
    {
      ...current,
      ...payload,
      unitPrice:
        payload && payload.unitPrice !== undefined
          ? payload.unitPrice
          : payload && payload.price !== undefined
            ? payload.price
            : current.unitPrice,
      price:
        payload && payload.price !== undefined
          ? payload.price
          : payload && payload.unitPrice !== undefined
            ? payload.unitPrice
            : current.unitPrice,
      vatRate:
        payload && payload.vatRate !== undefined
          ? payload.vatRate
          : payload && payload.taxRate !== undefined
            ? payload.taxRate
            : current.vatRate,
      taxRate:
        payload && payload.taxRate !== undefined
          ? payload.taxRate
          : payload && payload.vatRate !== undefined
            ? payload.vatRate
            : current.taxRate,
      stock: payload && payload.stock !== undefined ? payload.stock : payload && payload.stockQty !== undefined ? payload.stockQty : current.stock
    },
    current.status
  );
  const reason = validateProductPayload(next);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
  }

  if (next.categoryId) {
    const category = await findProductCategoryById(next.categoryId, context.clinic.id);
    if (!category) {
      return { ok: false, tenantId: context.tenantId, reason: 'product_category_not_found' };
    }
  }

  const automationAttribution = normalizeAutomationAttribution(payload && payload.automationAttribution);
  const previousDiscountPercentage = normalizeNullablePercentage(current.discountPercentage);
  const riskDiscountAutomation = await resolveCatalogRiskDiscountAutomation(context);
  const currentProductView = decorateProductWithCatalogRiskDiscount(current, riskDiscountAutomation);
  const suggestion = currentProductView.riskDiscountSuggestion;
  const updated = await updateProduct(safeProductId, context.clinic.id, next);
  const nextDiscountPercentage = normalizeNullablePercentage(updated.discountPercentage);

  if (
    automationAttribution &&
    automationAttribution.templateKey === 'catalog_risk_discount' &&
    automationAttribution.action === 'apply_suggestion' &&
    riskDiscountAutomation.enabled &&
    suggestion &&
    suggestion.canApply &&
    nextDiscountPercentage !== previousDiscountPercentage &&
    nextDiscountPercentage === suggestion.suggestedDiscountPercentage &&
    automationAttribution.suggestedDiscountPercentage === suggestion.suggestedDiscountPercentage
  ) {
    await insertAutomationActionEvent({
      clinicId: context.clinic.id,
      externalTenantId: context.tenantId,
      templateKey: 'catalog_risk_discount',
      action: 'suggestion_applied',
      entityType: 'product',
      entityId: updated.id,
      suggestedValue: {
        discountPercentage: suggestion.suggestedDiscountPercentage,
        status: suggestion.status
      },
      appliedValue: {
        previousDiscountPercentage,
        discountPercentage: nextDiscountPercentage
      },
      metadata: {
        source: automationAttribution.source || 'catalog_manager',
        hasManualDiscount: suggestion.hasManualDiscount
      }
    });
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    product: await decorateProductWithAutomations(context, updated)
  };
}

async function patchPortalProductStatus(tenantId, productId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeProductId = normalizeString(productId);
  if (!safeProductId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  }

  const status = normalizeString(payload && payload.status).toLowerCase();
  if (!PRODUCT_STATUSES.has(status)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_product_status' };
  }

  const product = await updateProductStatus(safeProductId, context.clinic.id, status);
  if (!product) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    product: await decorateProductWithAutomations(context, product)
  };
}

async function createPortalProductsBulk(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'missing_bulk_items'
    };
  }

  const results = [];
  let created = 0;
  let failed = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      const result = await withTransaction(async (client) => {
        const product = buildProductPayload(
          {
            ...item,
            status: 'active'
          },
          'active'
        );
        const reason = validateProductPayload(product);
        if (reason) {
          return { ok: false, reason };
        }

        const categoryResolution = await resolveBulkImportCategoryId(context, item, client);
        if (!categoryResolution.ok) {
          return categoryResolution;
        }

        product.categoryId = categoryResolution.categoryId;

        const createdProduct = await createProduct(
          {
            clinicId: context.clinic.id,
            ...product
          },
          client
        );

        return {
          ok: true,
          product: createdProduct
        };
      });

      if (result.ok) {
        created += 1;
        results.push({
          row: index + 1,
          status: 'created',
          productId: result.product.id
        });
      } else {
        failed += 1;
        results.push({
          row: index + 1,
          status: 'failed',
          code: result.reason
        });
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === '23505') {
        failed += 1;
        results.push({
          row: index + 1,
          status: 'failed',
          code: 'duplicate_product_sku'
        });
        continue;
      }

      failed += 1;
      results.push({
        row: index + 1,
        status: 'failed',
        code: error instanceof Error ? error.message : 'bulk_product_create_failed'
      });
    }
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    created,
    failed,
    results
  };
}

async function createPortalProductCategoryRecord(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const category = buildCategoryPayload(payload, true);
  const reason = validateCategoryPayload(category);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
  }

  try {
    const created = await withTransaction((client) =>
      createProductCategory(
        {
          clinicId: context.clinic.id,
          ...category
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      category: created
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'duplicate_product_category_name'
      };
    }
    throw error;
  }
}

async function resolveBulkImportCategoryId(context, payload, client) {
  const categoryId = normalizeString(payload && payload.categoryId) || null;
  if (categoryId) {
    const category = await findProductCategoryById(categoryId, context.clinic.id, client);
    if (!category) {
      return { ok: false, reason: 'product_category_not_found' };
    }
    return { ok: true, categoryId: category.id };
  }

  const categoryName = normalizeBulkCategoryLabel(
    payload && (payload.categoryName ?? payload.category ?? payload.categoryLabel)
  );
  if (!categoryName) {
    return { ok: true, categoryId: null };
  }

  const existing = await findProductCategoryByName(categoryName, context.clinic.id, client);
  if (existing) {
    return { ok: true, categoryId: existing.id };
  }

  try {
    const created = await createProductCategory(
      {
        clinicId: context.clinic.id,
        name: categoryName,
        isActive: true
      },
      client
    );
    return { ok: true, categoryId: created.id };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      const category = await findProductCategoryByName(categoryName, context.clinic.id, client);
      if (category) {
        return { ok: true, categoryId: category.id };
      }
    }
    throw error;
  }
}

async function patchPortalProductCategoryRecord(tenantId, categoryId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeCategoryId = normalizeString(categoryId);
  if (!safeCategoryId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_category_id' };
  }

  const current = await findProductCategoryById(safeCategoryId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_category_not_found' };
  }

  const next = buildCategoryPayload({ ...current, ...payload }, current.isActive !== false);
  const reason = validateCategoryPayload(next);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
  }

  try {
    const updated = await updateProductCategory(safeCategoryId, context.clinic.id, next);
    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      category: updated
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'duplicate_product_category_name'
      };
    }
    throw error;
  }
}

async function deletePortalProductCategoryRecord(tenantId, categoryId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeCategoryId = normalizeString(categoryId);
  if (!safeCategoryId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_category_id' };
  }

  const current = await findProductCategoryById(safeCategoryId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_category_not_found' };
  }

  try {
    const deletion = await withTransaction(async (client) => {
      const linkedProducts = await countProductsForCategory(safeCategoryId, context.clinic.id, client);
      if (linkedProducts > 0) {
        return {
          ok: false,
          reason: 'product_category_delete_blocked',
          details: {
            associatedProductsCount: linkedProducts
          }
        };
      }

      const deleted = await deleteProductCategory(safeCategoryId, context.clinic.id, client);
      if (!deleted) {
        return { ok: false, reason: 'product_category_not_found' };
      }

      return { ok: true };
    });

    if (!deletion.ok) {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: deletion.reason,
        details: deletion.details || null
      };
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      deletedCategoryId: safeCategoryId
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23503') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'product_category_delete_blocked',
        details: {
          associatedProductsCount: null
        }
      };
    }
    throw error;
  }
}

async function deletePortalProduct(tenantId, productId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeProductId = normalizeString(productId);
  if (!safeProductId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_product_id' };
  }

  const current = await findProductById(safeProductId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
  }

  try {
    const deleted = await withTransaction((client) => deleteProductById(safeProductId, context.clinic.id, client));
    if (!deleted) {
      return { ok: false, tenantId: context.tenantId, reason: 'product_not_found' };
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      deletedProductId: safeProductId
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23503') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'product_delete_blocked',
        details: error.detail || null
      };
    }
    throw error;
  }
}

module.exports = {
  PRODUCT_STATUSES: Array.from(PRODUCT_STATUSES),
  listPortalProducts,
  listPortalProductCategories,
  getPortalProductDetail,
  createPortalProduct,
  createPortalProductsBulk,
  createPortalProductCategoryRecord,
  patchPortalProductCategoryRecord,
  deletePortalProductCategoryRecord,
  patchPortalProduct,
  patchPortalProductStatus,
  deletePortalProduct
};
