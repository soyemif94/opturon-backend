const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { logError } = require('../utils/logger');
const {
  listOrdersByClinicId,
  findOrderById,
  createOrder,
  updateOrderStatus
} = require('../repositories/orders.repository');
const {
  findContactByIdAndClinicId
} = require('../repositories/contact.repository');
const {
  findProductById,
  updateProduct
} = require('../repositories/products.repository');
const { findConversationById } = require('../repositories/conversation.repository');
const { calculateLineAmounts, quantizeDecimal, sumQuantized } = require('../utils/money');

const ORDER_STATUSES = new Set(['draft', 'confirmed', 'cancelled']);
const LEGACY_ORDER_STATUSES = new Set(['new', 'pending_payment', 'paid', 'preparing', 'ready', 'delivered', 'cancelled']);
const PAYMENT_STATUSES = new Set(['unpaid', 'pending', 'paid', 'refunded', 'cancelled']);
const ORDER_SOURCES = new Set(['manual', 'inbox', 'automation', 'api']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeCurrency(value, fallback = 'ARS') {
  return normalizeString(value || fallback).toUpperCase() || fallback;
}

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

function normalizeOrderStatus(value) {
  const requested = normalizeString(value).toLowerCase();
  if (ORDER_STATUSES.has(requested)) {
    return requested;
  }
  if (requested === 'paid' || requested === 'preparing' || requested === 'ready' || requested === 'delivered') {
    return 'confirmed';
  }
  if (requested === 'new' || requested === 'pending_payment') {
    return 'draft';
  }
  if (requested === 'cancelled') {
    return 'cancelled';
  }
  return 'draft';
}

function deriveLegacyOrderStatus(status) {
  if (status === 'confirmed') return 'paid';
  if (status === 'cancelled') return 'cancelled';
  return 'new';
}

function derivePaymentStatus(orderStatus, paymentStatus) {
  const safePaymentStatus = normalizeString(paymentStatus).toLowerCase();
  if (PAYMENT_STATUSES.has(safePaymentStatus)) {
    return safePaymentStatus;
  }
  if (orderStatus === 'confirmed') {
    return 'paid';
  }
  if (orderStatus === 'cancelled') {
    return 'cancelled';
  }
  return 'pending';
}

function normalizeItemDraft(item, fallbackCurrency) {
  const quantity = Number(item.quantity || 0);
  const unitPrice = quantizeDecimal(item.unitPrice ?? item.priceSnapshot, 2, NaN);
  const taxRate = quantizeDecimal(item.taxRate ?? 0, 2, NaN);
  const descriptionSnapshot = normalizeString(item.descriptionSnapshot || item.nameSnapshot);
  const lineAmounts = calculateLineAmounts({ unitPrice, quantity, taxRate, quantityScale: 0 });
  const subtotalAmount = quantizeDecimal(item.subtotalAmount ?? (lineAmounts && lineAmounts.subtotalAmount), 2, NaN);
  const totalAmount = quantizeDecimal(item.totalAmount ?? (lineAmounts && lineAmounts.totalAmount), 2, NaN);

  return {
    productId: normalizeString(item.productId) || null,
    descriptionSnapshot,
    skuSnapshot: normalizeString(item.skuSnapshot) || null,
    unitPrice,
    currencySnapshot: normalizeCurrency(item.currencySnapshot, fallbackCurrency),
    quantity,
    taxRate,
    subtotalAmount,
    totalAmount,
    variant: normalizeString(item.variant) || null
  };
}

function createStockAdjuster(direction) {
  return async (productId, clinicId, quantity, client) => {
    const product = await findProductById(productId, clinicId, client);
    if (!product) {
      return null;
    }

    const currentStock = Number(product.stock || 0);
    const delta = Number(quantity || 0);
    const nextStock = direction === 'decrement' ? currentStock - delta : currentStock + delta;

    if (!Number.isFinite(nextStock) || nextStock < 0) {
      return null;
    }

    return updateProduct(
      productId,
      clinicId,
      {
        name: product.name,
        description: product.description,
        unitPrice: product.unitPrice,
        currency: product.currency,
        vatRate: product.vatRate,
        stock: nextStock,
        status: product.status,
        sku: product.sku,
        metadata: product.metadata
      },
      client
    );
  };
}

const decrementProductStock = createStockAdjuster('decrement');
const incrementProductStock = createStockAdjuster('increment');

async function listPortalOrders(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const orders = await listOrdersByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    orders
  };
}

async function getPortalOrderDetail(tenantId, orderId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'missing_order_id'
    };
  }

  const order = await findOrderById(safeOrderId, context.clinic.id);
  if (!order) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'order_not_found'
    };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order
  };
}

async function createOrderForContext(context, payload) {
  const contactId = normalizeString(payload && payload.contactId) || null;
  const conversationId = normalizeString(payload && payload.conversationId) || null;
  const requestedCurrency = normalizeCurrency(payload && payload.currency, 'ARS');
  const orderStatus = normalizeOrderStatus((payload && (payload.status || payload.orderStatus)) || 'draft');
  const paymentStatus = derivePaymentStatus(orderStatus, payload && payload.paymentStatus);
  const requestedSource = normalizeString(payload && payload.source).toLowerCase();
  const source = ORDER_SOURCES.has(requestedSource) ? requestedSource : 'manual';
  const notes = normalizeString(payload && payload.notes) || null;
  const itemsInput = Array.isArray(payload && payload.items) ? payload.items : [];

  if (itemsInput.length === 0) {
    return buildError(context.tenantId, 'missing_order_items');
  }

  let contact = null;
  if (contactId) {
    contact = await findContactByIdAndClinicId(contactId, context.clinic.id);
    if (!contact) {
      return buildError(context.tenantId, 'contact_not_found');
    }
  }

  if (conversationId) {
    const conversation = await findConversationById(conversationId);
    if (!conversation || conversation.clinicId !== context.clinic.id) {
      return buildError(context.tenantId, 'conversation_not_found');
    }
    if (contactId && conversation.contactId && conversation.contactId !== contactId) {
      return buildError(context.tenantId, 'conversation_contact_scope_mismatch');
    }
  }

  const customerName = normalizeString(payload && payload.customerName) || (contact && (contact.fullName || contact.name)) || null;
  const customerPhone =
    normalizeString(payload && payload.customerPhone) ||
    (contact && (contact.phone || contact.whatsappPhone || contact.waId)) ||
    null;

  if (!customerName) {
    return buildError(context.tenantId, 'missing_customer_name');
  }
  if (!customerPhone) {
    return buildError(context.tenantId, 'missing_customer_phone');
  }

  const rawItems = itemsInput.map((item) => normalizeItemDraft(item || {}, requestedCurrency));

  if (
    rawItems.some(
      (item) =>
        !Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        !Number.isFinite(item.taxRate) ||
        item.taxRate < 0 ||
        !Number.isFinite(item.quantity)
    )
  ) {
    return buildError(context.tenantId, 'invalid_order_item_amount');
  }

  if (rawItems.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    return buildError(context.tenantId, 'invalid_order_item_quantity');
  }

  if (rawItems.some((item) => !item.productId && !item.descriptionSnapshot)) {
    return buildError(context.tenantId, 'invalid_order_item_name');
  }

  let transactionResult;
  try {
    transactionResult = await withTransaction(async (client) => {
      const items = [];

      for (const item of rawItems) {
        if (item.productId) {
          const product = await findProductById(item.productId, context.clinic.id, client);
          if (!product) {
            return buildError(context.tenantId, 'order_item_product_not_found', `Product ${item.productId} was not found.`);
          }
          if (String(product.status || '').toLowerCase() !== 'active') {
            return buildError(context.tenantId, 'order_item_product_archived', `Product ${product.name} is archived.`);
          }
          if (Number(product.stock) < item.quantity) {
            return buildError(
              context.tenantId,
              'order_item_insufficient_stock',
              `Not enough stock for product ${product.name}. Requested ${item.quantity}, available ${product.stock}.`
            );
          }

          const unitPrice = quantizeDecimal(product.unitPrice ?? product.price ?? 0, 2, 0);
          const taxRate = quantizeDecimal(product.vatRate ?? product.taxRate ?? 0, 2, 0);
          const amounts = calculateLineAmounts({ unitPrice, quantity: item.quantity, taxRate, quantityScale: 0 });

          items.push({
            productId: product.id,
            descriptionSnapshot: item.descriptionSnapshot || product.description || product.name,
            skuSnapshot: normalizeString(product.sku) || null,
            unitPrice,
            currencySnapshot: normalizeCurrency(product.currency, requestedCurrency || 'ARS'),
            quantity: item.quantity,
            taxRate,
            subtotalAmount: amounts.subtotalAmount,
            totalAmount: amounts.totalAmount,
            variant: item.variant || null
          });
        } else {
          const amounts = calculateLineAmounts({
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            taxRate: item.taxRate,
            quantityScale: 0
          });

          items.push({
            productId: null,
            descriptionSnapshot: item.descriptionSnapshot,
            skuSnapshot: item.skuSnapshot,
            unitPrice: item.unitPrice,
            currencySnapshot: normalizeCurrency(item.currencySnapshot, requestedCurrency),
            quantity: item.quantity,
            taxRate: item.taxRate,
            subtotalAmount: amounts.subtotalAmount,
            totalAmount: amounts.totalAmount,
            variant: item.variant || null
          });
        }
      }

      for (const item of items) {
        if (!item.productId) continue;

        const updatedProduct = await decrementProductStock(item.productId, context.clinic.id, item.quantity, client);
        if (!updatedProduct) {
          return buildError(
            context.tenantId,
            'order_item_insufficient_stock',
            `Not enough stock to reserve ${item.quantity} unit(s) for ${item.descriptionSnapshot}.`
          );
        }
      }

      const orderCurrency = normalizeCurrency(items[0] && items[0].currencySnapshot, requestedCurrency || 'ARS');
      const subtotalAmount = sumQuantized(items.map((item) => item.subtotalAmount), 2);
      const totalAmount = sumQuantized(items.map((item) => item.totalAmount), 2);
      const taxAmount = quantizeDecimal(totalAmount - subtotalAmount, 2, 0);

      const order = await createOrder(
        {
          clinicId: context.clinic.id,
          contactId,
          customerName,
          customerPhone,
          source,
          status: orderStatus,
          orderStatus: deriveLegacyOrderStatus(orderStatus),
          notes,
          subtotalAmount,
          taxAmount,
          totalAmount,
          currency: orderCurrency,
          paymentStatus,
          conversationId,
          items
        },
        client
      );

      return {
        ok: true,
        order
      };
    });
  } catch (error) {
    logError('portal_order_create_transaction_failed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      customerPhone,
      itemCount: rawItems.length,
      currency: requestedCurrency,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      where: error.where || null,
      constraint: error.constraint || null
    });
    throw error;
  }

  if (!transactionResult.ok) {
    return transactionResult;
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order: transactionResult.order
  };
}

async function createPortalOrder(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  return createOrderForContext(context, payload);
}

async function createOrderForClinic(clinicId, payload) {
  const safeClinicId = normalizeString(clinicId);
  if (!safeClinicId) {
    return buildError(null, 'missing_clinic_id');
  }

  return createOrderForContext(
    {
      ok: true,
      tenantId: null,
      clinic: { id: safeClinicId },
      channel: null
    },
    payload
  );
}

async function patchOrderStatusForContext(context, orderId, payload) {
  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'missing_order_id'
    };
  }

  const requestedRawStatus = normalizeString(payload && (payload.status || payload.orderStatus)).toLowerCase();
  if (!ORDER_STATUSES.has(normalizeOrderStatus(requestedRawStatus)) && !LEGACY_ORDER_STATUSES.has(requestedRawStatus)) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'invalid_order_status'
    };
  }

  const requestedOrderStatus = normalizeOrderStatus(requestedRawStatus);
  const paymentStatus = derivePaymentStatus(requestedOrderStatus, payload && payload.paymentStatus);
  let transactionResult;
  try {
    transactionResult = await withTransaction(async (client) => {
      const currentOrder = await findOrderById(safeOrderId, context.clinic.id, client);
      if (!currentOrder) {
        return buildError(context.tenantId, 'order_not_found');
      }

      if (currentOrder.status === requestedOrderStatus) {
        return {
          ok: true,
          order: currentOrder
        };
      }

      if (requestedOrderStatus === 'cancelled' && currentOrder.status !== 'cancelled') {
        for (const item of currentOrder.items || []) {
          if (!item.productId) continue;

          const updatedProduct = await incrementProductStock(item.productId, context.clinic.id, item.quantity, client);
          if (!updatedProduct) {
            return buildError(
              context.tenantId,
              'order_item_product_not_found',
              `Product ${item.productId} was not found while restoring stock.`
            );
          }
        }
      }

      const order = await updateOrderStatus(
        safeOrderId,
        context.clinic.id,
        {
          status: requestedOrderStatus,
          orderStatus: deriveLegacyOrderStatus(requestedOrderStatus),
          paymentStatus
        },
        client
      );

      if (!order) {
        return buildError(context.tenantId, 'order_not_found');
      }

      return {
        ok: true,
        order
      };
    });
  } catch (error) {
    logError('portal_order_status_transaction_failed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      orderId: safeOrderId,
      nextStatus: requestedOrderStatus,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      where: error.where || null,
      constraint: error.constraint || null
    });
    throw error;
  }

  if (!transactionResult.ok) {
    return transactionResult;
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order: transactionResult.order
  };
}

async function patchPortalOrderStatus(tenantId, orderId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  return patchOrderStatusForContext(context, orderId, payload);
}

async function patchOrderStatusForClinic(clinicId, orderId, payload) {
  const safeClinicId = normalizeString(clinicId);
  if (!safeClinicId) {
    return buildError(null, 'missing_clinic_id');
  }

  return patchOrderStatusForContext(
    {
      ok: true,
      tenantId: null,
      clinic: { id: safeClinicId },
      channel: null
    },
    orderId,
    payload
  );
}

module.exports = {
  ORDER_STATUSES: Array.from(ORDER_STATUSES),
  listPortalOrders,
  getPortalOrderDetail,
  createPortalOrder,
  createOrderForClinic,
  patchPortalOrderStatus,
  patchOrderStatusForClinic
};
