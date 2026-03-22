const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listProductsByClinicId,
  findProductById,
  createProduct,
  updateProduct,
  updateProductStatus,
  deleteProductById
} = require('../repositories/products.repository');

const PRODUCT_STATUSES = new Set(['active', 'archived']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function buildProductPayload(payload, fallbackStatus = 'active') {
  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();
  const unitPrice = normalizeNumber(payload && (payload.unitPrice ?? payload.price));
  const vatRate = normalizeNumber(payload && (payload.vatRate ?? payload.taxRate ?? 0));

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
    metadata: normalizeMetadata(payload && payload.metadata)
  };
}

function validateProductPayload(product) {
  if (!product.name) return 'missing_product_name';
  if (!Number.isFinite(product.unitPrice) || product.unitPrice < 0) return 'invalid_product_price';
  if (!Number.isFinite(product.vatRate) || product.vatRate < 0) return 'invalid_product_tax_rate';
  if (!Number.isInteger(product.stock) || product.stock < 0) return 'invalid_product_stock';
  if (!PRODUCT_STATUSES.has(product.status)) return 'invalid_product_status';
  return null;
}

async function createProductForContext(context, payload) {
  const product = buildProductPayload(payload, 'active');
  const reason = validateProductPayload(product);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
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
      product: created
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

async function listPortalProducts(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const products = await listProductsByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    products
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
    product
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
      stock:
        payload && payload.stock !== undefined
          ? payload.stock
          : payload && payload.stockQty !== undefined
            ? payload.stockQty
            : current.stock
    },
    current.status
  );
  const reason = validateProductPayload(next);
  if (reason) {
    return { ok: false, tenantId: context.tenantId, reason };
  }

  const updated = await updateProduct(safeProductId, context.clinic.id, next);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    product: updated
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
    product
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
      const result = await createProductForContext(context, {
        ...item,
        status: 'active'
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
  getPortalProductDetail,
  createPortalProduct,
  createPortalProductsBulk,
  patchPortalProduct,
  patchPortalProductStatus,
  deletePortalProduct
};
