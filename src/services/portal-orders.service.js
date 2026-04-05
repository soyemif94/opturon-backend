const { DateTime } = require('luxon');
const { query, withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { logError } = require('../utils/logger');
const {
  listOrdersByClinicId,
  findOrderById,
  createOrder,
  updateOrderStatus,
  updateOrder
} = require('../repositories/orders.repository');
const {
  findContactByIdAndClinicId
} = require('../repositories/contact.repository');
const { findPortalUserByIdAndClinicId } = require('../repositories/portal-users.repository');
const { findPaymentDestinationById } = require('../repositories/payment-destinations.repository');
const {
  findInvoiceByOrderId,
  createInvoice
} = require('../repositories/invoices.repository');
const { createPayment } = require('../repositories/payments.repository');
const { sumRecordedAllocatedAmountsByInvoiceIds } = require('../repositories/payment-allocations.repository');
const {
  findProductById,
  updateProduct
} = require('../repositories/products.repository');
const { getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { findConversationById } = require('../repositories/conversation.repository');
const { updateConversationStage } = require('../repositories/conversation.repository');
const conversationStateRepo = require('../conversations/conversation.repo');
const { sendPortalMessage } = require('./portal-inbox.service');
const { calculateLineAmounts, quantizeDecimal, sumQuantized } = require('../utils/money');

const ORDER_STATUSES = new Set(['draft', 'confirmed', 'cancelled']);
const LEGACY_ORDER_STATUSES = new Set(['new', 'pending_payment', 'paid', 'preparing', 'ready', 'delivered', 'cancelled']);
const PAYMENT_STATUSES = new Set(['unpaid', 'pending', 'paid', 'refunded', 'cancelled']);
const ORDER_SOURCES = new Set(['manual', 'inbox', 'automation', 'api', 'bot']);
const ORDER_CUSTOMER_TYPES = new Set(['registered_contact', 'final_consumer']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeActor(value) {
  const safe = normalizeString(value);
  return safe || null;
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
  if (status === 'confirmed') return 'pending_payment';
  if (status === 'cancelled') return 'cancelled';
  return 'new';
}

function deriveLegacyOrderStatusFromRequested(requestedStatus, fallbackStatus) {
  const requested = normalizeString(requestedStatus).toLowerCase();
  if (LEGACY_ORDER_STATUSES.has(requested)) {
    return requested;
  }
  return deriveLegacyOrderStatus(fallbackStatus);
}

function derivePaymentStatus(orderStatus, paymentStatus, currentPaymentStatus = null, requestedStatus = '') {
  const safePaymentStatus = normalizeString(paymentStatus).toLowerCase();
  if (PAYMENT_STATUSES.has(safePaymentStatus)) {
    return safePaymentStatus;
  }

  const requested = normalizeString(requestedStatus).toLowerCase();
  if (requested === 'paid') {
    return 'paid';
  }
  if (requested === 'cancelled' || orderStatus === 'cancelled') {
    return 'cancelled';
  }
  if (requested === 'new' || orderStatus === 'draft') {
    return 'unpaid';
  }
  if (requested === 'pending_payment') {
    return 'pending';
  }
  return PAYMENT_STATUSES.has(normalizeString(currentPaymentStatus).toLowerCase())
    ? normalizeString(currentPaymentStatus).toLowerCase()
    : 'pending';
}

function derivePaymentMethodFromDestination(destination) {
  if (!destination) return 'other';
  if (destination.type === 'cash_box') return 'cash';
  if (destination.type === 'bank' || destination.type === 'wallet') return 'bank_transfer';
  return 'other';
}

function getTransferPaymentContext(conversation, orderId = null) {
  if (!conversation || typeof conversation !== 'object') return null;
  const context = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const transferPayment = context.transferPayment && typeof context.transferPayment === 'object'
    ? context.transferPayment
    : null;
  if (!transferPayment) return null;

  const transferOrderId = normalizeString(transferPayment.orderId) || null;
  if (orderId && transferOrderId && transferOrderId !== normalizeString(orderId)) {
    return null;
  }

  return transferPayment;
}

function summarizeTransferPayment(order, conversation) {
  const transferPayment = getTransferPaymentContext(conversation, order && order.id ? order.id : null);
  if (!transferPayment) return null;

  const proofMetadata =
    transferPayment.proofMetadata && typeof transferPayment.proofMetadata === 'object'
      ? transferPayment.proofMetadata
      : null;

  return {
    orderId: normalizeString(transferPayment.orderId) || null,
    status: normalizeString(transferPayment.status) || null,
    paymentMethod: normalizeString(transferPayment.paymentMethod) || null,
    destinationId: normalizeString(transferPayment.destinationId) || null,
    requestedAt: transferPayment.requestedAt || null,
    proofSubmittedAt: transferPayment.proofSubmittedAt || null,
    proofMessageId: normalizeString(transferPayment.proofMessageId) || null,
    proofMetadata: proofMetadata
      ? {
          messageId: normalizeString(proofMetadata.messageId) || null,
          providerMessageId: normalizeString(proofMetadata.providerMessageId) || null,
          type: normalizeString(proofMetadata.type) || null,
          mediaId: normalizeString(proofMetadata.mediaId) || null,
          mimeType: normalizeString(proofMetadata.mimeType) || null,
          caption: normalizeString(proofMetadata.caption) || null,
          filename: normalizeString(proofMetadata.filename) || null,
          sha256: normalizeString(proofMetadata.sha256) || null
        }
      : null,
    validationMode: normalizeString(transferPayment.validationMode) || null,
    validationDecision: normalizeString(transferPayment.validationDecision) || null,
    validatedAt: transferPayment.validatedAt || null,
    validatedBy: normalizeString(transferPayment.validatedBy) || null,
    validatedByName: normalizeString(transferPayment.validatedByName) || null,
    rejectionReason: normalizeString(transferPayment.rejectionReason) || null,
    orderPaymentStatus: normalizeString(transferPayment.orderPaymentStatus) || order.paymentStatus || null,
    conversationId: conversation && conversation.id ? conversation.id : null,
    conversationState: conversation && conversation.state ? conversation.state : null,
    conversationStage: conversation && conversation.stage ? conversation.stage : null
  };
}

function buildConversationPreview(conversation, messages = []) {
  if (!conversation || !conversation.id) return null;
  const previewMessages = Array.isArray(messages)
    ? messages
        .slice(-5)
        .map((message) => ({
          id: message.id,
          direction: message.direction,
          text: normalizeString(message.text) || '',
          timestamp: message.createdAt,
          type: normalizeString(message.type) || null
        }))
    : [];

  return {
    conversationId: conversation.id,
    state: conversation.state || null,
    stage: conversation.stage || null,
    messages: previewMessages
  };
}

function buildOrderDetailPayload(order, conversation, conversationMessages = []) {
  return {
    ...order,
    transferPayment: summarizeTransferPayment(order, conversation),
    conversationPreview: buildConversationPreview(conversation, conversationMessages)
  };
}

function buildTransferValidationApprovalReply() {
  return [
    'Recibimos y validamos tu pago.',
    '',
    'Ya quedó acreditado correctamente.'
  ].join('\n');
}

function buildTransferValidationRejectionReply(reason = null) {
  const lines = ['Revisamos tu comprobante pero no pudimos validarlo.'];
  if (reason) {
    lines.push('');
    lines.push(`Motivo: ${reason}`);
  }
  lines.push('');
  lines.push('Si querés, mandame un comprobante nuevo o escribime para revisarlo.');
  return lines.join('\n');
}

function normalizeTaxIdType(value) {
  const requested = normalizeString(value).toUpperCase();
  if (requested === 'CUIT' || requested === 'CUIL' || requested === 'DNI' || requested === 'NONE') {
    return requested;
  }
  return 'NONE';
}

function normalizeSuggestedVoucherType(value) {
  const requested = normalizeString(value).toUpperCase();
  if (requested === 'A' || requested === 'B' || requested === 'C' || requested === 'NONE') {
    return requested;
  }
  return 'NONE';
}

function buildInvoiceItemsFromOrder(order) {
  return (order.items || []).map((item) => ({
    productId: item.productId || null,
    descriptionSnapshot: item.descriptionSnapshot || item.nameSnapshot,
    quantity: quantizeDecimal(item.quantity || 0, 3, 0),
    unitPrice: quantizeDecimal(item.unitPrice || item.priceSnapshot || 0, 2, 0),
    taxRate: quantizeDecimal(item.taxRate || 0, 2, 0),
    subtotalAmount: quantizeDecimal(item.subtotalAmount || 0, 2, 0),
    totalAmount: quantizeDecimal(item.totalAmount || 0, 2, 0)
  }));
}

function buildInternalInvoiceDraft(order, clinicRecord, contact) {
  const businessProfile = clinicRecord && typeof clinicRecord.businessProfile === 'object'
    ? clinicRecord.businessProfile
    : {};
  const customerLegalName =
    normalizeString(contact && (contact.companyName || contact.name)) ||
    normalizeString(order.customerName) ||
    (order.customerType === 'final_consumer' ? 'Consumidor final' : null);
  const customerTaxId = normalizeString(contact && contact.taxId) || null;
  const customerTaxIdDigits = customerTaxId ? customerTaxId.replace(/\D/g, '') : '';
  const customerTaxIdType = normalizeTaxIdType(
    customerTaxIdDigits.length === 11 ? 'CUIT' : customerTaxIdDigits.length >= 7 && customerTaxIdDigits.length <= 8 ? 'DNI' : 'NONE'
  );

  return {
    clinicId: order.clinicId || clinicRecord?.id || null,
    contactId: order.contactId || null,
    orderId: order.id,
    type: 'invoice',
    status: 'draft',
    documentMode: 'internal_only',
    providerStatus: null,
    currency: normalizeCurrency(order.currency, 'ARS'),
    subtotalAmount: quantizeDecimal(order.subtotalAmount || order.subtotal || 0, 2, 0),
    taxAmount: quantizeDecimal(order.taxAmount || 0, 2, 0),
    totalAmount: quantizeDecimal(order.totalAmount || order.total || 0, 2, 0),
    issuedAt: null,
    dueAt: null,
    externalProvider: null,
    externalReference: null,
    documentKind: 'order_summary',
    fiscalStatus: 'draft',
    customerTaxId,
    customerTaxIdType,
    customerLegalName,
    customerVatCondition: normalizeString(contact && contact.taxCondition) || null,
    issuerLegalName: normalizeString(businessProfile.legalName || clinicRecord?.name) || null,
    issuerTaxId: normalizeString(businessProfile.taxId) || null,
    issuerTaxIdType: normalizeTaxIdType(businessProfile.taxIdType),
    issuerVatCondition: normalizeString(businessProfile.vatCondition) || null,
    issuerGrossIncomeNumber: normalizeString(businessProfile.grossIncomeNumber) || null,
    issuerFiscalAddress: normalizeString(businessProfile.fiscalAddress || businessProfile.address) || null,
    issuerCity: normalizeString(businessProfile.city) || null,
    issuerProvince: normalizeString(businessProfile.province) || null,
    pointOfSaleSuggested: normalizeString(businessProfile.pointOfSaleSuggested) || null,
    suggestedFiscalVoucherType: normalizeSuggestedVoucherType(businessProfile.defaultSuggestedFiscalVoucherType),
    accountantNotes: null,
    deliveredToAccountantAt: null,
    invoicedByAccountantAt: null,
    accountantReferenceNumber: null,
    metadata: {
      source: 'order_payment_sync',
      orderId: order.id,
      sourceChannel: order.source || null
    },
    items: buildInvoiceItemsFromOrder(order)
  };
}

async function syncOrderPaidArtifacts({ context, order, paymentDestination, client }) {
  if (!paymentDestination) {
    return buildError(context.tenantId, 'missing_payment_destination_for_paid_order');
  }

  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);
  const contact = order.contactId
    ? await findContactByIdAndClinicId(order.contactId, context.clinic.id)
    : null;
  let invoice = await findInvoiceByOrderId(order.id, context.clinic.id, client);

  if (!invoice) {
    invoice = await createInvoice(buildInternalInvoiceDraft(order, clinicRecord || context.clinic, contact), client);
  }

  const paymentAmount = quantizeDecimal(order.totalAmount || order.total || 0, 2, 0);
  if (!(paymentAmount > 0)) {
    return buildError(context.tenantId, 'invalid_order_payment_amount');
  }

  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id], client);
  const alreadyPaidAmount = quantizeDecimal(paidByInvoiceId[invoice.id] || 0, 2, 0);
  const remainingAmount = quantizeDecimal(paymentAmount - alreadyPaidAmount, 2, 0);

  if (!(remainingAmount > 0)) {
    return { ok: true, invoice };
  }

  await createPayment(
    {
      clinicId: context.clinic.id,
      contactId: order.contactId || null,
      invoiceId: invoice.id,
      amount: remainingAmount,
      currency: normalizeCurrency(order.currency, 'ARS'),
      method: derivePaymentMethodFromDestination(paymentDestination),
      status: 'recorded',
      paidAt: new Date().toISOString(),
      externalReference: null,
      notes: normalizeString(order.notes) || null,
      metadata: {
        source: 'order_payment_sync',
        orderId: order.id,
        destinationId: paymentDestination.id,
        destinationName: paymentDestination.name,
        destinationType: paymentDestination.type
      }
    },
    client
  );

  return { ok: true, invoice };
}

function normalizeCustomerType(value) {
  const requested = normalizeString(value).toLowerCase();
  return ORDER_CUSTOMER_TYPES.has(requested) ? requested : null;
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
  const conversationIds = Array.from(new Set(orders.map((order) => order.conversationId).filter(Boolean)));
  const conversations = conversationIds.length
    ? await conversationStateRepo.listConversationsByIds(conversationIds)
    : [];
  const conversationById = new Map(
    conversations
      .filter((conversation) => conversation && conversation.clinicId === context.clinic.id)
      .map((conversation) => [conversation.id, conversation])
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    orders: orders.map((order) => buildOrderDetailPayload(order, conversationById.get(order.conversationId || '') || null))
  };
}

function normalizeTransferMetricsRange(range, timezone) {
  const safeRange = String(range || 'last_7_days').trim().toLowerCase();
  const zone = timezone || 'America/Argentina/Buenos_Aires';
  const now = DateTime.now().setZone(zone);

  if (safeRange === 'today') {
    return {
      range: 'today',
      fromIso: now.startOf('day').toUTC().toISO(),
      toIso: now.endOf('day').toUTC().toISO()
    };
  }

  if (safeRange === 'last_30_days') {
    return {
      range: 'last_30_days',
      fromIso: now.minus({ days: 29 }).startOf('day').toUTC().toISO(),
      toIso: now.endOf('day').toUTC().toISO()
    };
  }

  return {
    range: 'last_7_days',
    fromIso: now.minus({ days: 6 }).startOf('day').toUTC().toISO(),
    toIso: now.endOf('day').toUTC().toISO()
  };
}

async function getPortalOrderPaymentMetrics(tenantId, range) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const normalizedRange = normalizeTransferMetricsRange(range, context.clinic.timezone);
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN context->'transferPayment'->>'status' = 'payment_pending_validation'
           AND NULLIF(context->'transferPayment'->>'orderId', '') IS NOT NULL
           AND NULLIF(context->'transferPayment'->>'proofSubmittedAt', '')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz
         THEN 1 ELSE 0 END), 0)::int AS pending,
       COALESCE(SUM(CASE
         WHEN context->'transferPayment'->>'status' = 'payment_confirmed'
           AND NULLIF(context->'transferPayment'->>'validatedAt', '')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz
         THEN 1 ELSE 0 END), 0)::int AS approved,
       COALESCE(SUM(CASE
         WHEN context->'transferPayment'->>'status' = 'payment_rejected'
           AND NULLIF(context->'transferPayment'->>'validatedAt', '')::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz
         THEN 1 ELSE 0 END), 0)::int AS rejected
     FROM conversations
     WHERE "clinicId" = $1::uuid
       AND context ? 'transferPayment'`,
    [context.clinic.id, normalizedRange.fromIso, normalizedRange.toIso]
  );

  const row = result.rows[0] || {};
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    metrics: {
      range: normalizedRange.range,
      pending: Number(row.pending || 0),
      approved: Number(row.approved || 0),
      rejected: Number(row.rejected || 0)
    }
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

  const conversation =
    order.conversationId
      ? await conversationStateRepo.getConversationById(order.conversationId)
      : null;

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order: buildOrderDetailPayload(
      order,
      conversation && conversation.clinicId === context.clinic.id ? conversation : null,
      conversation && conversation.clinicId === context.clinic.id && order.conversationId
        ? await conversationStateRepo.listConversationMessagesByClinicId(order.conversationId, context.clinic.id, 5)
        : []
    )
  };
}

async function createOrderForContext(context, payload) {
  const contactId = normalizeString(payload && payload.contactId) || null;
  const conversationId = normalizeString(payload && payload.conversationId) || null;
  const requestedCurrency = normalizeCurrency(payload && payload.currency, 'ARS');
  const orderStatus = normalizeOrderStatus((payload && (payload.status || payload.orderStatus)) || 'draft');
  const paymentStatus = derivePaymentStatus(orderStatus, payload && payload.paymentStatus, null, payload && (payload.status || payload.orderStatus));
  const requestedSource = normalizeString(payload && payload.source).toLowerCase();
  const source = ORDER_SOURCES.has(requestedSource) ? requestedSource : 'manual';
  const requestedCustomerType = normalizeCustomerType(payload && payload.customerType);
  const sellerUserId = normalizeString(payload && payload.sellerUserId) || null;
  const paymentDestinationId = normalizeString(payload && payload.paymentDestinationId) || null;
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

  const hasManualCustomerData = Boolean(normalizeString(payload && payload.customerName) || normalizeString(payload && payload.customerPhone));
  const customerType = requestedCustomerType || (contactId || hasManualCustomerData ? 'registered_contact' : 'final_consumer');

  let seller = null;
  if (sellerUserId) {
    seller = await findPortalUserByIdAndClinicId(sellerUserId, context.clinic.id);
    if (!seller || seller.role === 'viewer') {
      return buildError(context.tenantId, 'seller_user_not_found');
    }
  }

  let paymentDestination = null;
  if (paymentDestinationId) {
    paymentDestination = await findPaymentDestinationById(paymentDestinationId, context.clinic.id);
    if (!paymentDestination) {
      return buildError(context.tenantId, 'payment_destination_not_found');
    }
    if (!paymentDestination.isActive) {
      return buildError(context.tenantId, 'payment_destination_inactive');
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

  const customerName =
    customerType === 'final_consumer'
      ? normalizeString(payload && payload.customerName) || null
      : normalizeString(payload && payload.customerName) || (contact && (contact.fullName || contact.name)) || null;
  const customerPhone =
    customerType === 'final_consumer'
      ? normalizeString(payload && payload.customerPhone) || null
      : normalizeString(payload && payload.customerPhone) ||
        (contact && (contact.phone || contact.whatsappPhone || contact.waId)) ||
        null;

  if (customerType === 'registered_contact' && !contactId && !customerName && !customerPhone) {
    return buildError(context.tenantId, 'missing_contact_id');
  }

  if (source === 'manual' && !sellerUserId) {
    return buildError(context.tenantId, 'missing_seller_user_id');
  }

  const rawItems = itemsInput.map((item) => normalizeItemDraft(item || {}, requestedCurrency));

  if (rawItems.some((item) => !Number.isFinite(item.quantity))) {
    return buildError(context.tenantId, 'invalid_order_item_amount');
  }

  if (
    rawItems.some(
      (item) =>
        !item.productId &&
        (
          !Number.isFinite(item.unitPrice) ||
          item.unitPrice < 0 ||
          !Number.isFinite(item.taxRate) ||
          item.taxRate < 0
        )
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
          customerType,
          source,
          sellerUserId,
          sellerNameSnapshot: seller ? seller.name : null,
          paymentDestinationId: paymentDestination ? paymentDestination.id : null,
          paymentDestinationNameSnapshot: paymentDestination ? paymentDestination.name : null,
          paymentDestinationTypeSnapshot: paymentDestination ? paymentDestination.type : null,
          status: orderStatus,
          orderStatus: deriveLegacyOrderStatusFromRequested(payload && (payload.status || payload.orderStatus), orderStatus),
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

async function applyOrderStatusPatchForContext(context, orderId, payload, client) {
  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return buildError(context.tenantId, 'missing_order_id');
  }

  const requestedRawStatus = normalizeString(payload && (payload.status || payload.orderStatus)).toLowerCase();
  if (!ORDER_STATUSES.has(normalizeOrderStatus(requestedRawStatus)) && !LEGACY_ORDER_STATUSES.has(requestedRawStatus)) {
    return buildError(context.tenantId, 'invalid_order_status');
  }

  const requestedOrderStatus = normalizeOrderStatus(requestedRawStatus);
  const requestedPaymentDestinationId = normalizeString(payload && payload.paymentDestinationId) || null;
  const currentOrder = await findOrderById(safeOrderId, context.clinic.id, client);
  if (!currentOrder) {
    return buildError(context.tenantId, 'order_not_found');
  }

  let paymentDestination = currentOrder.paymentDestination || null;
  let nextPaymentDestinationId = currentOrder.paymentDestinationId || null;
  let nextPaymentDestinationNameSnapshot = currentOrder.paymentDestinationNameSnapshot || null;
  let nextPaymentDestinationTypeSnapshot = currentOrder.paymentDestinationTypeSnapshot || null;

  if (requestedPaymentDestinationId || (payload && Object.prototype.hasOwnProperty.call(payload, 'paymentDestinationId'))) {
    if (requestedPaymentDestinationId) {
      paymentDestination = await findPaymentDestinationById(requestedPaymentDestinationId, context.clinic.id, client);
      if (!paymentDestination) {
        return buildError(context.tenantId, 'payment_destination_not_found');
      }
      if (!paymentDestination.isActive) {
        return buildError(context.tenantId, 'payment_destination_inactive');
      }
      nextPaymentDestinationId = paymentDestination.id;
      nextPaymentDestinationNameSnapshot = paymentDestination.name;
      nextPaymentDestinationTypeSnapshot = paymentDestination.type;
    } else {
      paymentDestination = null;
      nextPaymentDestinationId = null;
      nextPaymentDestinationNameSnapshot = null;
      nextPaymentDestinationTypeSnapshot = null;
    }
  }

  const nextPaymentStatus = derivePaymentStatus(
    requestedOrderStatus,
    payload && payload.paymentStatus,
    currentOrder.paymentStatus,
    requestedRawStatus
  );
  const needsOrderFieldUpdate =
    nextPaymentDestinationId !== (currentOrder.paymentDestinationId || null) ||
    nextPaymentDestinationNameSnapshot !== (currentOrder.paymentDestinationNameSnapshot || null) ||
    nextPaymentDestinationTypeSnapshot !== (currentOrder.paymentDestinationTypeSnapshot || null);

  if (currentOrder.status === requestedOrderStatus && currentOrder.paymentStatus === nextPaymentStatus && !needsOrderFieldUpdate) {
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
      orderStatus: deriveLegacyOrderStatusFromRequested(requestedRawStatus, requestedOrderStatus),
      paymentStatus: nextPaymentStatus
    },
    client
  );

  if (!order) {
    return buildError(context.tenantId, 'order_not_found');
  }

  const orderWithDestination = needsOrderFieldUpdate
    ? await updateOrder(
        safeOrderId,
        context.clinic.id,
        {
          paymentDestinationId: nextPaymentDestinationId,
          paymentDestinationNameSnapshot: nextPaymentDestinationNameSnapshot,
          paymentDestinationTypeSnapshot: nextPaymentDestinationTypeSnapshot,
          notes: order.notes
        },
        client
      )
    : order;

  if (!orderWithDestination) {
    return buildError(context.tenantId, 'order_not_found');
  }

  if (nextPaymentStatus === 'paid' && currentOrder.paymentStatus !== 'paid') {
    const paymentSyncResult = await syncOrderPaidArtifacts({
      context,
      order: orderWithDestination,
      paymentDestination,
      client
    });
    if (!paymentSyncResult.ok) {
      return paymentSyncResult;
    }
  }

  return {
    ok: true,
    order: orderWithDestination
  };
}

async function patchOrderStatusForContext(context, orderId, payload) {
  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return buildError(context.tenantId, 'missing_order_id');
  }

  let transactionResult;
  const requestedRawStatus = normalizeString(payload && (payload.status || payload.orderStatus)).toLowerCase();
  const requestedOrderStatus = normalizeOrderStatus(requestedRawStatus);
  try {
    transactionResult = await withTransaction(async (client) => applyOrderStatusPatchForContext(context, safeOrderId, payload, client));
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

async function patchOrderForContext(context, orderId, payload) {
  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return buildError(context.tenantId, 'missing_order_id');
  }

  const requestedPaymentDestinationId = normalizeString(payload && payload.paymentDestinationId) || null;
  try {
    const result = await withTransaction(async (client) => {
      const currentOrder = await findOrderById(safeOrderId, context.clinic.id, client);
      if (!currentOrder) {
        return buildError(context.tenantId, 'order_not_found');
      }

      let paymentDestination = null;
      if (requestedPaymentDestinationId) {
        paymentDestination = await findPaymentDestinationById(requestedPaymentDestinationId, context.clinic.id, client);
        if (!paymentDestination) {
          return buildError(context.tenantId, 'payment_destination_not_found');
        }
        if (!paymentDestination.isActive) {
          return buildError(context.tenantId, 'payment_destination_inactive');
        }
      }

      const order = await updateOrder(
        safeOrderId,
        context.clinic.id,
        {
          paymentDestinationId: paymentDestination ? paymentDestination.id : null,
          paymentDestinationNameSnapshot: paymentDestination ? paymentDestination.name : null,
          paymentDestinationTypeSnapshot: paymentDestination ? paymentDestination.type : null,
          notes: currentOrder.notes
        },
        client
      );

      if (!order) {
        return buildError(context.tenantId, 'order_not_found');
      }

      return { ok: true, order };
    });

    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      order: result.order
    };
  } catch (error) {
    logError('portal_order_patch_transaction_failed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      orderId: safeOrderId,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      where: error.where || null,
      constraint: error.constraint || null
    });
    throw error;
  }
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

async function patchPortalOrder(tenantId, orderId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  return patchOrderForContext(context, orderId, payload);
}

async function validatePortalOrderTransferPayment(tenantId, orderId, payload = {}, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeOrderId = normalizeString(orderId);
  if (!safeOrderId) {
    return buildError(context.tenantId, 'missing_order_id');
  }

  const action = normalizeString(payload && payload.action).toLowerCase();
  if (action !== 'approve' && action !== 'reject') {
    return buildError(context.tenantId, 'invalid_payment_validation_action');
  }

  const rejectionReason = normalizeString(payload && payload.rejectionReason) || null;
  const actorId = normalizeActor(actor && actor.actorId);
  const actorName = normalizeActor(actor && actor.actorName);

  const result = await withTransaction(async (client) => {
    const currentOrder = await findOrderById(safeOrderId, context.clinic.id, client);
    if (!currentOrder) {
      return buildError(context.tenantId, 'order_not_found');
    }

    if (!currentOrder.conversationId) {
      return buildError(context.tenantId, 'order_without_conversation');
    }

    const conversation = await conversationStateRepo.getConversationById(currentOrder.conversationId, client);
    if (!conversation || conversation.clinicId !== context.clinic.id) {
      return buildError(context.tenantId, 'conversation_not_found');
    }

    const currentTransferPayment = getTransferPaymentContext(conversation, currentOrder.id);
    if (!currentTransferPayment) {
      return buildError(context.tenantId, 'transfer_payment_not_found');
    }

    const currentTransferStatus = normalizeString(currentTransferPayment.status).toLowerCase();
    if (action === 'approve' && currentTransferStatus === 'payment_confirmed') {
      return buildError(context.tenantId, 'transfer_payment_already_confirmed');
    }
    if (action === 'reject' && currentTransferStatus === 'payment_rejected') {
      return buildError(context.tenantId, 'transfer_payment_already_rejected');
    }

    const now = new Date().toISOString();
    let order = currentOrder;

    if (action === 'approve') {
      const approvalResult = await applyOrderStatusPatchForContext(
        context,
        currentOrder.id,
        {
          orderStatus: 'paid',
          paymentStatus: 'paid',
          paymentDestinationId: currentOrder.paymentDestinationId || normalizeString(currentTransferPayment.destinationId) || null
        },
        client
      );
      if (!approvalResult.ok) {
        return approvalResult;
      }
      order = approvalResult.order;
    } else if (currentOrder.paymentStatus !== 'pending') {
      const rejectionOrder = await updateOrderStatus(
        currentOrder.id,
        context.clinic.id,
        {
          status: normalizeOrderStatus(currentOrder.status || currentOrder.orderStatus),
          orderStatus: currentOrder.orderStatus || deriveLegacyOrderStatus(normalizeOrderStatus(currentOrder.status || currentOrder.orderStatus)),
          paymentStatus: 'pending'
        },
        client
      );
      if (rejectionOrder) {
        order = rejectionOrder;
      }
    }

    const nextTransferPayment = {
      ...currentTransferPayment,
      status: action === 'approve' ? 'payment_confirmed' : 'payment_rejected',
      validationMode: 'manual',
      validationDecision: action === 'approve' ? 'approved' : 'rejected',
      validatedAt: now,
      validatedBy: actorId,
      validatedByName: actorName,
      rejectionReason: action === 'reject' ? rejectionReason : null,
      orderPaymentStatus: action === 'approve' ? 'paid' : order.paymentStatus || 'pending'
    };

    await conversationStateRepo.updateConversationState(
      {
        conversationId: conversation.id,
        state: action === 'approve' ? 'READY' : 'PAYMENT_TRANSFER',
        contextPatch: {
          commerceLastOrderId: currentOrder.id,
          commerceLastOrderAt: now,
          transferPayment: nextTransferPayment
        }
      },
      client
    );
    await updateConversationStage(
      conversation.id,
      action === 'approve' ? 'payment_confirmed' : 'payment_rejected',
      client
    );

    const updatedConversation = await conversationStateRepo.getConversationById(conversation.id, client);

    return {
      ok: true,
      order: buildOrderDetailPayload(order, updatedConversation || conversation),
      conversationId: conversation.id,
      notificationText: action === 'approve'
        ? buildTransferValidationApprovalReply()
        : buildTransferValidationRejectionReply(rejectionReason)
    };
  });

  if (!result.ok) {
    return result;
  }

  const notification = await sendPortalMessage(tenantId, result.conversationId, result.notificationText);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    order: result.order,
    notification: notification.ok
      ? notification.message
      : {
          ok: false,
          reason: notification.reason || 'message_send_failed'
        }
  };
}

module.exports = {
  ORDER_STATUSES: Array.from(ORDER_STATUSES),
  listPortalOrders,
  getPortalOrderPaymentMetrics,
  getPortalOrderDetail,
  createPortalOrder,
  createOrderForClinic,
  patchPortalOrder,
  patchPortalOrderStatus,
  patchOrderStatusForClinic,
  validatePortalOrderTransferPayment
};
