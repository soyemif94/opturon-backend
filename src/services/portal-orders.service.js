const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listOrdersByClinicId,
  findOrderById,
  createOrder,
  updateOrderStatus
} = require('../repositories/orders.repository');
const { findProductById } = require('../repositories/products.repository');

const ORDER_STATUSES = new Set(['new', 'pending_payment', 'paid', 'preparing', 'ready', 'delivered', 'cancelled']);
const PAYMENT_STATUSES = new Set(['unpaid', 'pending', 'paid', 'refunded', 'cancelled']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function derivePaymentStatus(orderStatus, paymentStatus) {
  const safePaymentStatus = normalizeString(paymentStatus).toLowerCase();
  if (PAYMENT_STATUSES.has(safePaymentStatus)) {
    return safePaymentStatus;
  }
  if (orderStatus === 'paid' || orderStatus === 'preparing' || orderStatus === 'ready' || orderStatus === 'delivered') {
    return 'paid';
  }
  if (orderStatus === 'cancelled') {
    return 'cancelled';
  }
  return 'pending';
}

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

async function createPortalOrder(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const customerName = normalizeString(payload && payload.customerName);
  const customerPhone = normalizeString(payload && payload.customerPhone);
  const notes = normalizeString(payload && payload.notes);
  const requestedCurrency = normalizeString((payload && payload.currency) || 'ARS').toUpperCase() || 'ARS';
  const requestedOrderStatus = normalizeString((payload && payload.orderStatus) || 'new').toLowerCase();
  const orderStatus = ORDER_STATUSES.has(requestedOrderStatus) ? requestedOrderStatus : 'new';
  const itemsInput = Array.isArray(payload && payload.items) ? payload.items : [];

  if (!customerName) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_customer_name' };
  }
  if (!customerPhone) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_customer_phone' };
  }
  if (itemsInput.length === 0) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_order_items' };
  }

  const rawItems = itemsInput.map((item) => ({
    productId: normalizeString(item && item.productId) || null,
    nameSnapshot: normalizeString(item && item.nameSnapshot),
    priceSnapshot: normalizeNumber(item && item.priceSnapshot),
    quantity: Number.parseInt(String(item && item.quantity), 10),
    variant: normalizeString(item && item.variant) || null
  }));

  if (rawItems.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_order_item_quantity' };
  }

  const items = [];
  for (const item of rawItems) {
    if (item.productId) {
      const product = await findProductById(item.productId, context.clinic.id);
      if (!product) {
        return { ok: false, tenantId: context.tenantId, reason: 'order_item_product_not_found' };
      }
      if (String(product.status || '').toLowerCase() !== 'active') {
        return { ok: false, tenantId: context.tenantId, reason: 'inactive_order_item_product' };
      }
      if (!Number.isFinite(product.price) || product.price < 0) {
        return { ok: false, tenantId: context.tenantId, reason: 'invalid_order_item_price' };
      }

      items.push({
        productId: product.id,
        nameSnapshot: product.name,
        priceSnapshot: product.price,
        quantity: item.quantity,
        variant: item.variant || null,
        currency: product.currency || requestedCurrency
      });
      continue;
    }

    if (!item.nameSnapshot) {
      return { ok: false, tenantId: context.tenantId, reason: 'invalid_order_item_name' };
    }
    if (!Number.isFinite(item.priceSnapshot) || item.priceSnapshot < 0) {
      return { ok: false, tenantId: context.tenantId, reason: 'invalid_order_item_price' };
    }

    items.push({
      productId: null,
      nameSnapshot: item.nameSnapshot,
      priceSnapshot: item.priceSnapshot,
      quantity: item.quantity,
      variant: item.variant || null,
      currency: requestedCurrency
    });
  }

  const currency = items[0]?.currency || requestedCurrency;
  const subtotal = Number(items.reduce((sum, item) => sum + item.priceSnapshot * item.quantity, 0).toFixed(2));
  const paymentStatus = derivePaymentStatus(orderStatus, payload && payload.paymentStatus);

  const order = await withTransaction(async (client) =>
    createOrder(
      {
        clinicId: context.clinic.id,
        contactId: normalizeString(payload && payload.contactId) || null,
        customerName,
        customerPhone,
        notes: notes || null,
        subtotal,
        total: subtotal,
        currency,
        paymentStatus,
        orderStatus,
        items
      },
      client
    )
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order
  };
}

async function patchPortalOrderStatus(tenantId, orderId, payload) {
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

  const requestedOrderStatus = normalizeString(payload && payload.orderStatus).toLowerCase();
  if (!ORDER_STATUSES.has(requestedOrderStatus)) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'invalid_order_status'
    };
  }

  const paymentStatus = derivePaymentStatus(requestedOrderStatus, payload && payload.paymentStatus);
  const order = await updateOrderStatus(
    safeOrderId,
    context.clinic.id,
    {
      orderStatus: requestedOrderStatus,
      paymentStatus
    }
  );

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

module.exports = {
  ORDER_STATUSES: Array.from(ORDER_STATUSES),
  listPortalOrders,
  getPortalOrderDetail,
  createPortalOrder,
  patchPortalOrderStatus
};
