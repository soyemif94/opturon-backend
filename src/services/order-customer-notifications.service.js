const { markOrderFinalized } = require('../repositories/orders.repository');
const {
  insertOrderCustomerNotification
} = require('../repositories/order-customer-notifications.repository');
const { quantizeDecimal } = require('../utils/money');

const ORDER_SUMMARY_NOTIFICATION_TYPE = 'order_summary';

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  const safe = String(value || '').trim();
  return safe || null;
}

function normalizeVersion(value) {
  const version = Number(value || 0);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function resolveSnapshotPaymentMethod(order) {
  const explicitMethod = normalizeStatus(order && order.paymentMethod);
  if (['cash', 'bank_transfer', 'card', 'mercado_pago', 'other'].includes(explicitMethod)) {
    return explicitMethod;
  }

  const destinationType = normalizeStatus(order && order.paymentDestinationTypeSnapshot);
  if (destinationType === 'bank' || destinationType === 'wallet') return 'bank_transfer';
  if (destinationType === 'cash_box') return 'cash';
  return null;
}

function detectNewOrderFinalization({ previousOrder = null, order, directConfirmedCreation = false }) {
  if (!order || normalizeStatus(order.status) !== 'confirmed') {
    return { isNewFinalization: false, reason: 'order_not_confirmed' };
  }

  const previousVersion = normalizeVersion(previousOrder?.finalizationVersion ?? order.finalizationVersion);
  if (previousVersion > 0) {
    return { isNewFinalization: false, reason: 'already_finalized' };
  }

  if (previousOrder && normalizeStatus(previousOrder.status) === 'confirmed') {
    return { isNewFinalization: false, reason: 'confirmed_noop' };
  }

  if (!previousOrder && !directConfirmedCreation) {
    return { isNewFinalization: false, reason: 'missing_transition_origin' };
  }

  return {
    isNewFinalization: true,
    reason: directConfirmedCreation ? 'created_confirmed' : 'transitioned_to_confirmed',
    previousVersion,
    finalizationVersion: previousVersion + 1
  };
}

function buildOrderCustomerNotificationIdempotencyKey({ clinicId, orderId, finalizationVersion }) {
  return `${ORDER_SUMMARY_NOTIFICATION_TYPE}:${clinicId}:${orderId}:v${finalizationVersion}`;
}

function buildOrderCustomerNotificationSnapshot(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const paymentDestination = order && (
    order.paymentDestinationId ||
    order.paymentDestinationNameSnapshot ||
    order.paymentDestinationTypeSnapshot
  )
    ? {
        id: order.paymentDestinationId || null,
        name: normalizeText(order.paymentDestinationNameSnapshot),
        type: normalizeText(order.paymentDestinationTypeSnapshot)
      }
    : null;
  const seller = order && (order.sellerUserId || order.sellerNameSnapshot)
    ? {
        id: order.sellerUserId || null,
        name: normalizeText(order.sellerNameSnapshot)
      }
    : null;

  return {
    schemaVersion: 1,
    notificationType: ORDER_SUMMARY_NOTIFICATION_TYPE,
    orderId: order.id,
    clinicId: order.clinicId,
    contactId: order.contactId || null,
    conversationId: order.conversationId || null,
    currency: normalizeText(order.currency),
    items: items.map((item) => {
      const lineSubtotal = quantizeDecimal(item.subtotalAmount ?? 0, 2, 0);
      const lineTotal = quantizeDecimal(item.totalAmount ?? lineSubtotal, 2, 0);

      return {
        productId: item.productId || null,
        description: normalizeText(item.descriptionSnapshot || item.nameSnapshot),
        sku: normalizeText(item.skuSnapshot),
        variant: normalizeText(item.variant),
        quantity: Number(item.quantity || 0),
        unitPrice: quantizeDecimal(item.unitPrice ?? item.priceSnapshot ?? 0, 2, 0),
        lineSubtotal,
        taxRate: quantizeDecimal(item.taxRate ?? 0, 2, 0),
        taxAmount: quantizeDecimal(lineTotal - lineSubtotal, 2, 0),
        lineTotal
      };
    }),
    subtotal: quantizeDecimal(order.subtotalAmount ?? order.subtotal ?? 0, 2, 0),
    tax: quantizeDecimal(order.taxAmount ?? 0, 2, 0),
    total: quantizeDecimal(order.totalAmount ?? order.total ?? 0, 2, 0),
    payment: {
      status: normalizeText(order.paymentStatus),
      method: resolveSnapshotPaymentMethod(order),
      destination: paymentDestination
    },
    notes: normalizeText(order.notes),
    seller,
    finalizedAt: order.finalizedAt,
    finalizationVersion: normalizeVersion(order.finalizationVersion)
  };
}

async function prepareOrderCustomerNotification({
  previousOrder = null,
  order,
  directConfirmedCreation = false,
  finalizedAt = new Date().toISOString(),
  client
}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('Order finalization requires an active transaction client.');
  }

  const decision = detectNewOrderFinalization({ previousOrder, order, directConfirmedCreation });
  if (!decision.isNewFinalization) {
    return {
      order,
      notification: null,
      inserted: false,
      finalization: decision
    };
  }

  const finalizedOrder = await markOrderFinalized(
    order.id,
    order.clinicId,
    {
      finalizedAt,
      previousFinalizationVersion: decision.previousVersion,
      finalizationVersion: decision.finalizationVersion
    },
    client
  );

  if (!finalizedOrder) {
    throw new Error('Order finalization metadata update failed.');
  }

  const idempotencyKey = buildOrderCustomerNotificationIdempotencyKey({
    clinicId: finalizedOrder.clinicId,
    orderId: finalizedOrder.id,
    finalizationVersion: decision.finalizationVersion
  });
  const status = finalizedOrder.contactId ? 'pending' : 'skipped_no_contact';
  const notificationResult = await insertOrderCustomerNotification(
    {
      clinicId: finalizedOrder.clinicId,
      orderId: finalizedOrder.id,
      contactId: finalizedOrder.contactId || null,
      conversationId: finalizedOrder.conversationId || null,
      channelId: null,
      notificationType: ORDER_SUMMARY_NOTIFICATION_TYPE,
      finalizationVersion: decision.finalizationVersion,
      idempotencyKey,
      status,
      snapshot: buildOrderCustomerNotificationSnapshot(finalizedOrder),
      availableAt: finalizedAt
    },
    client
  );

  return {
    order: finalizedOrder,
    notification: notificationResult.notification,
    inserted: notificationResult.inserted,
    finalization: decision
  };
}

module.exports = {
  ORDER_SUMMARY_NOTIFICATION_TYPE,
  detectNewOrderFinalization,
  buildOrderCustomerNotificationIdempotencyKey,
  buildOrderCustomerNotificationSnapshot,
  prepareOrderCustomerNotification
};
