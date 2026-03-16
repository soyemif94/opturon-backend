const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const { findOrderById } = require('../repositories/orders.repository');
const { findProductById } = require('../repositories/products.repository');
const {
  listInvoicesByClinicId,
  findInvoiceById,
  listInvoicesByParentInvoiceId,
  createInvoice,
  updateInvoice,
  voidInvoice,
  issueInvoice
} = require('../repositories/invoices.repository');
const { createPayment } = require('../repositories/payments.repository');
const {
  createPaymentAllocation,
  listAllocationsByInvoiceId,
  sumRecordedAllocatedAmountsByInvoiceIds
} = require('../repositories/payment-allocations.repository');
const { calculateLineAmounts, quantizeDecimal, sumQuantized } = require('../utils/money');
const { calculateInvoiceReceivable } = require('./invoice-balance.service');

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);
const INVOICE_TYPES = new Set(['invoice', 'credit_note']);
const DOCUMENT_MODES = new Set(['internal_only', 'external_provider', 'synced_external']);
const INITIAL_PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid']);
const INITIAL_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'card', 'other', 'combined']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeCurrency(value, fallback = 'ARS') {
  return normalizeString(value || fallback).toUpperCase() || fallback;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeInitialPaymentMethod(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'combined') {
    return 'other';
  }
  if (INITIAL_PAYMENT_METHODS.has(normalized)) {
    return normalized;
  }
  return 'bank_transfer';
}

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

function normalizeInvoiceItemInput(item, fallbackCurrency, type) {
  const quantity = quantizeDecimal(item && item.quantity, 3, NaN);
  const baseUnitPrice = quantizeDecimal(item && item.unitPrice, 2, NaN);
  const taxRate = quantizeDecimal((item && item.taxRate) ?? 0, 2, NaN);
  const signedUnitPrice = type === 'credit_note' ? quantizeDecimal(-Math.abs(baseUnitPrice), 2, NaN) : baseUnitPrice;
  const lineAmounts = calculateLineAmounts({ unitPrice: signedUnitPrice, quantity, taxRate, quantityScale: 3 });
  const subtotalAmount = quantizeDecimal((item && item.subtotalAmount) ?? (lineAmounts && lineAmounts.subtotalAmount), 2, NaN);
  const totalAmount = quantizeDecimal((item && item.totalAmount) ?? (lineAmounts && lineAmounts.totalAmount), 2, NaN);

  return {
    productId: normalizeString(item && item.productId) || null,
    descriptionSnapshot: normalizeString(item && item.descriptionSnapshot),
    quantity,
    unitPrice: signedUnitPrice,
    taxRate,
    subtotalAmount,
    totalAmount,
    currency: normalizeCurrency(item && item.currency, fallbackCurrency)
  };
}

async function resolveScopedInvoice(invoiceId, clinicId) {
  const safeInvoiceId = normalizeString(invoiceId);
  if (!safeInvoiceId) return null;
  return findInvoiceById(safeInvoiceId, clinicId);
}

async function resolveInvoiceAssociations({ clinicId, contactId, orderId, parentInvoiceId, tenantId }) {
  let contact = null;
  let order = null;
  let parentInvoice = null;

  if (contactId) {
    contact = await findContactByIdAndClinicId(contactId, clinicId);
    if (!contact) {
      return buildError(tenantId, 'contact_not_found');
    }
  }

  if (orderId) {
    order = await findOrderById(orderId, clinicId);
    if (!order) {
      return buildError(tenantId, 'order_not_found');
    }
    if (contactId && order.contactId && order.contactId !== contactId) {
      return buildError(tenantId, 'invoice_order_contact_scope_mismatch');
    }
    if (!contact && order.contactId) {
      contact = await findContactByIdAndClinicId(order.contactId, clinicId);
    }
  }

  if (parentInvoiceId) {
    parentInvoice = await findInvoiceById(parentInvoiceId, clinicId);
    if (!parentInvoice) {
      return buildError(tenantId, 'parent_invoice_not_found');
    }
  }

  return {
    ok: true,
    contact,
    order,
    parentInvoice
  };
}

function buildInvoiceLifecycleView(invoice) {
  return {
    canEdit: invoice.status === 'draft',
    canIssue: invoice.status === 'draft',
    canVoid: invoice.status === 'draft' || invoice.status === 'issued',
    internalStatus: invoice.status,
    providerStatus: invoice.providerStatus || null,
    documentMode: invoice.documentMode
  };
}

function enrichInvoiceView(invoice) {
  const receivable = calculateInvoiceReceivable({
    invoice,
    paidAmount: invoice && invoice.paidAmount ? invoice.paidAmount : 0
  });

  return {
    ...invoice,
    lifecycle: buildInvoiceLifecycleView(invoice),
    balanceImpact: receivable.documentBalanceImpact,
    paidAmount: receivable.paidAmount,
    outstandingAmount: receivable.outstandingAmount,
    receivableStatus: receivable.receivableStatus
  };
}

async function attachReceivables(clinicId, invoices) {
  const items = Array.isArray(invoices) ? invoices : [];
  const invoiceIds = items.map((invoice) => invoice.id).filter(Boolean);
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(clinicId, invoiceIds);

  return items.map((invoice) => ({
    ...invoice,
    paidAmount: paidByInvoiceId[invoice.id] || 0
  }));
}

function validateInvoiceMode(payload) {
  const documentMode = DOCUMENT_MODES.has(normalizeString(payload.documentMode).toLowerCase())
    ? normalizeString(payload.documentMode).toLowerCase()
    : 'internal_only';

  if (documentMode === 'internal_only' && (payload.externalProvider || payload.externalReference || payload.providerStatus)) {
    return null;
  }

  return documentMode;
}

function buildInvoicePayload(payload = {}, fallback = {}) {
  const requestedType = normalizeString(payload.type || fallback.type).toLowerCase();
  const type = INVOICE_TYPES.has(requestedType) ? requestedType : 'invoice';
  const requestedStatus = normalizeString(payload.status || fallback.status).toLowerCase();
  const status = INVOICE_STATUSES.has(requestedStatus) ? requestedStatus : 'draft';
  const requestedDocumentMode = normalizeString(payload.documentMode || fallback.documentMode).toLowerCase();
  const documentMode = DOCUMENT_MODES.has(requestedDocumentMode)
    ? requestedDocumentMode
    : fallback.documentMode || 'internal_only';

  return {
    contactId: normalizeString(payload.contactId ?? fallback.contactId) || null,
    orderId: normalizeString(payload.orderId ?? fallback.orderId) || null,
    parentInvoiceId: normalizeString(payload.parentInvoiceId ?? fallback.parentInvoiceId) || null,
    invoiceNumber: normalizeString(payload.invoiceNumber ?? fallback.invoiceNumber) || null,
    type,
    status,
    documentMode,
    providerStatus: normalizeString(payload.providerStatus ?? fallback.providerStatus) || null,
    currency: normalizeCurrency(payload.currency ?? fallback.currency, 'ARS'),
    issuedAt: payload.issuedAt !== undefined ? payload.issuedAt : fallback.issuedAt || null,
    dueAt: payload.dueAt !== undefined ? payload.dueAt : fallback.dueAt || null,
    externalProvider: normalizeString(payload.externalProvider ?? fallback.externalProvider) || null,
    externalReference: normalizeString(payload.externalReference ?? fallback.externalReference) || null,
    metadata: normalizeMetadata(payload.metadata !== undefined ? payload.metadata : fallback.metadata)
  };
}

function normalizeInitialPaymentPlan(invoice, metadata) {
  const rawPlan = metadata && typeof metadata === 'object' ? metadata.initialPaymentPlan : null;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return null;
  }

  const status = normalizeString(rawPlan.status).toLowerCase();
  if (!INITIAL_PAYMENT_STATUSES.has(status) || status === 'unpaid') {
    return null;
  }

  const invoiceTotal = quantizeDecimal(invoice && invoice.totalAmount, 2, 0);
  const absoluteTotal = Math.abs(invoiceTotal);
  if (!(absoluteTotal > 0) || invoice.type !== 'invoice') {
    return null;
  }

  const requestedAmount =
    status === 'paid'
      ? absoluteTotal
      : quantizeDecimal(rawPlan.amount, 2, NaN);

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > absoluteTotal) {
    return null;
  }

  return {
    status,
    amount: requestedAmount,
    method: normalizeInitialPaymentMethod(rawPlan.method),
    notes: normalizeString(rawPlan.notes) || null
  };
}

function validateLifecycleRules({ currentInvoice = null, nextPayload, isVoidAction = false, isIssueAction = false }) {
  if (!currentInvoice) {
    return null;
  }

  if (isVoidAction) {
    if (currentInvoice.status === 'void') return 'invoice_already_void';
    return null;
  }

  if (isIssueAction) {
    if (currentInvoice.status === 'issued') return 'invoice_already_issued';
    if (currentInvoice.status === 'void') return 'void_invoice_cannot_be_issued';
    if (currentInvoice.status !== 'draft') return 'invoice_not_issuable_in_current_status';
    return null;
  }

  if (currentInvoice.status !== 'draft') {
    return 'invoice_not_editable_in_current_status';
  }

  const requestedStatus = normalizeString(nextPayload && nextPayload.status).toLowerCase();
  if (requestedStatus === 'void') {
    return 'invoice_void_requires_dedicated_action';
  }
  if (requestedStatus === 'issued') {
    return 'invoice_issue_requires_dedicated_action';
  }

  return null;
}

async function buildInvoiceItems({ clinicId, tenantId, payloadItems, fallbackOrder, currency, type }) {
  let items;
  if (Array.isArray(payloadItems) && payloadItems.length > 0) {
    items = [];
    for (const rawItem of payloadItems) {
      const item = normalizeInvoiceItemInput(rawItem, currency, type);
      if (
        !item.descriptionSnapshot ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        !Number.isFinite(item.unitPrice) ||
        !Number.isFinite(item.taxRate) ||
        item.taxRate < 0
      ) {
        return buildError(tenantId, 'invalid_invoice_item');
      }

      if (type === 'invoice' && item.unitPrice < 0) {
        return buildError(tenantId, 'invalid_invoice_item');
      }
      if (type === 'credit_note' && item.unitPrice > 0) {
        return buildError(tenantId, 'invalid_credit_note_item');
      }

      if (item.productId) {
        const product = await findProductById(item.productId, clinicId);
        if (!product) {
          return buildError(tenantId, 'invoice_item_product_not_found');
        }
      }

      items.push({
        productId: item.productId,
        descriptionSnapshot: item.descriptionSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        subtotalAmount: item.subtotalAmount,
        totalAmount: item.totalAmount
      });
    }
  } else if (fallbackOrder) {
    items = (fallbackOrder.items || []).map((item) => {
      const quantity = quantizeDecimal(item.quantity || 0, 3, 0);
      const baseUnitPrice = quantizeDecimal(item.unitPrice || item.priceSnapshot || 0, 2, 0);
      const unitPrice = type === 'credit_note' ? quantizeDecimal(-Math.abs(baseUnitPrice), 2, 0) : baseUnitPrice;
      const taxRate = quantizeDecimal(item.taxRate || 0, 2, 0);
      const amounts = calculateLineAmounts({ unitPrice, quantity, taxRate, quantityScale: 3 });

      return {
        productId: item.productId || null,
        descriptionSnapshot: item.descriptionSnapshot || item.nameSnapshot,
        quantity,
        unitPrice,
        taxRate,
        subtotalAmount: amounts.subtotalAmount,
        totalAmount: amounts.totalAmount
      };
    });
  } else {
    return buildError(tenantId, 'missing_invoice_items');
  }

  return {
    ok: true,
    items
  };
}

function validateInvoiceStructure({ payload, items, order, parentInvoice, tenantId }) {
  const subtotalAmount = sumQuantized(items.map((item) => item.subtotalAmount), 2);
  const totalAmount = sumQuantized(items.map((item) => item.totalAmount), 2);
  const taxAmount = quantizeDecimal(totalAmount - subtotalAmount, 2, 0);

  if (payload.type === 'invoice' && (subtotalAmount < 0 || taxAmount < 0 || totalAmount < 0)) {
    return buildError(tenantId, 'invalid_invoice_amount_sign');
  }

  if (payload.type === 'credit_note') {
    if (!payload.parentInvoiceId) {
      return buildError(tenantId, 'credit_note_requires_parent_invoice');
    }
    if (!parentInvoice) {
      return buildError(tenantId, 'parent_invoice_not_found');
    }
    if (parentInvoice.type !== 'invoice') {
      return buildError(tenantId, 'credit_note_parent_invalid');
    }
    if (subtotalAmount > 0 || taxAmount > 0 || totalAmount > 0) {
      return buildError(tenantId, 'credit_note_amount_sign_invalid');
    }
  }

  if (payload.type === 'invoice' && payload.parentInvoiceId) {
    return buildError(tenantId, 'invoice_cannot_have_parent_invoice');
  }

  if (order) {
    const orderSubtotal = quantizeDecimal(order.subtotalAmount || 0, 2, 0);
    const orderTax = quantizeDecimal(order.taxAmount || 0, 2, 0);
    const orderTotal = quantizeDecimal(order.totalAmount || 0, 2, 0);
    if (payload.type === 'invoice' && (orderSubtotal !== subtotalAmount || orderTax !== taxAmount || orderTotal !== totalAmount)) {
      return buildError(tenantId, 'invoice_order_amount_mismatch');
    }
  }

  return {
    ok: true,
    subtotalAmount,
    taxAmount,
    totalAmount
  };
}

async function validateInvoiceForIssue({ invoice, tenantId }) {
  const associationResult = await resolveInvoiceAssociations({
    clinicId: invoice.clinicId,
    contactId: invoice.contactId,
    orderId: invoice.orderId,
    parentInvoiceId: invoice.parentInvoiceId,
    tenantId
  });
  if (!associationResult.ok) return associationResult;

  const items = Array.isArray(invoice.items) ? invoice.items : [];
  if (!items.length) {
    return buildError(tenantId, 'missing_invoice_items');
  }

  const structureResult = validateInvoiceStructure({
    payload: invoice,
    items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId
  });
  if (!structureResult.ok) return structureResult;

  return {
    ok: true,
    associationResult,
    structureResult
  };
}

async function listPortalInvoices(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const invoices = await listInvoicesByClinicId(context.clinic.id);
  const withReceivables = await attachReceivables(context.clinic.id, invoices);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoices: withReceivables.map(enrichInvoiceView)
  };
}

async function getPortalInvoiceDetail(tenantId, invoiceId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const invoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!invoice) {
    return { ok: false, tenantId: context.tenantId, reason: 'invoice_not_found' };
  }
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id]);
  const allocations = await listAllocationsByInvoiceId(invoice.id, context.clinic.id);
  const relatedCreditNotesRaw =
    invoice.type === 'invoice'
      ? await listInvoicesByParentInvoiceId(invoice.id, context.clinic.id)
      : [];
  const relatedCreditNotesWithReceivables =
    relatedCreditNotesRaw.length > 0
      ? await attachReceivables(context.clinic.id, relatedCreditNotesRaw)
      : [];
  const relatedCreditNotes = relatedCreditNotesWithReceivables.map(enrichInvoiceView);
  const withReceivable = {
    ...invoice,
    paidAmount: paidByInvoiceId[invoice.id] || 0
  };

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: {
      ...enrichInvoiceView(withReceivable),
      allocations,
      relatedCreditNotes
    }
  };
}

async function listPortalInvoiceAllocations(tenantId, invoiceId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeInvoiceId = normalizeString(invoiceId);
  if (!safeInvoiceId) {
    return buildError(context.tenantId, 'missing_invoice_id');
  }

  const invoice = await resolveScopedInvoice(safeInvoiceId, context.clinic.id);
  if (!invoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const allocations = await listAllocationsByInvoiceId(invoice.id, context.clinic.id);
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView({
      ...invoice,
      paidAmount: paidByInvoiceId[invoice.id] || 0
    }),
    allocations
  };
}

async function createPortalInvoice(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();
  const allowImmediateIssue = requestedStatus === 'issued';
  const invoicePayload = buildInvoicePayload(
    {
      ...(payload || {}),
      status: 'draft'
    }
  );
  const mode = validateInvoiceMode(invoicePayload);
  if (!mode) {
    return buildError(context.tenantId, 'invalid_invoice_document_mode');
  }
  invoicePayload.documentMode = mode;

  const associationResult = await resolveInvoiceAssociations({
    clinicId: context.clinic.id,
    contactId: invoicePayload.contactId,
    orderId: invoicePayload.orderId,
    parentInvoiceId: invoicePayload.parentInvoiceId,
    tenantId: context.tenantId
  });
  if (!associationResult.ok) return associationResult;

  const itemsResult = await buildInvoiceItems({
    clinicId: context.clinic.id,
    tenantId: context.tenantId,
    payloadItems: payload && payload.items,
    fallbackOrder: associationResult.order,
    currency: invoicePayload.currency,
    type: invoicePayload.type
  });
  if (!itemsResult.ok) return itemsResult;

  const structureResult = validateInvoiceStructure({
    payload: invoicePayload,
    items: itemsResult.items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId: context.tenantId
  });
  if (!structureResult.ok) return structureResult;

  try {
    const invoice = await withTransaction(async (client) => {
      const created = await createInvoice(
        {
          clinicId: context.clinic.id,
          contactId: associationResult.contact ? associationResult.contact.id : null,
          orderId: associationResult.order ? associationResult.order.id : null,
          parentInvoiceId: associationResult.parentInvoice ? associationResult.parentInvoice.id : null,
          invoiceNumber: invoicePayload.invoiceNumber,
          type: invoicePayload.type,
          status: 'draft',
          documentMode: invoicePayload.documentMode,
          providerStatus: invoicePayload.providerStatus,
          currency: associationResult.order ? associationResult.order.currency : invoicePayload.currency,
          subtotalAmount: structureResult.subtotalAmount,
          taxAmount: structureResult.taxAmount,
          totalAmount: structureResult.totalAmount,
          issuedAt: null,
          dueAt: invoicePayload.dueAt,
          externalProvider: invoicePayload.externalProvider,
          externalReference: invoicePayload.externalReference,
          metadata: invoicePayload.metadata,
          items: itemsResult.items
        },
        client
      );

      if (!allowImmediateIssue) {
        return created;
      }

      const issueMetadata = {
        ...normalizeMetadata(created.metadata),
        issueFlow: {
          mode: 'create_and_issue_compat',
          at: new Date().toISOString()
        }
      };

      return issueInvoice(
        created.id,
        context.clinic.id,
        {
          issuedAt: payload && payload.issuedAt ? payload.issuedAt : new Date().toISOString(),
          providerStatus: created.providerStatus || null,
          metadata: issueMetadata
        },
        client
      );
    });

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      invoice: enrichInvoiceView(invoice)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return buildError(context.tenantId, 'duplicate_invoice_number');
    }
    throw error;
  }
}

async function updatePortalInvoice(tenantId, invoiceId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isVoidAction: false });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const invoicePayload = buildInvoicePayload(
    {
      ...(payload || {}),
      status: 'draft'
    },
    currentInvoice
  );
  const mode = validateInvoiceMode(invoicePayload);
  if (!mode) {
    return buildError(context.tenantId, 'invalid_invoice_document_mode');
  }
  invoicePayload.documentMode = mode;

  const associationResult = await resolveInvoiceAssociations({
    clinicId: context.clinic.id,
    contactId: invoicePayload.contactId,
    orderId: invoicePayload.orderId,
    parentInvoiceId: invoicePayload.parentInvoiceId,
    tenantId: context.tenantId
  });
  if (!associationResult.ok) return associationResult;

  const itemsResult = await buildInvoiceItems({
    clinicId: context.clinic.id,
    tenantId: context.tenantId,
    payloadItems: payload && payload.items,
    fallbackOrder: associationResult.order,
    currency: invoicePayload.currency,
    type: invoicePayload.type
  });
  if (!itemsResult.ok) return itemsResult;

  const structureResult = validateInvoiceStructure({
    payload: invoicePayload,
    items: itemsResult.items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId: context.tenantId
  });
  if (!structureResult.ok) return structureResult;

  try {
    const invoice = await withTransaction((client) =>
      updateInvoice(
        currentInvoice.id,
        context.clinic.id,
        {
          contactId: associationResult.contact ? associationResult.contact.id : null,
          orderId: associationResult.order ? associationResult.order.id : null,
          parentInvoiceId: associationResult.parentInvoice ? associationResult.parentInvoice.id : null,
          invoiceNumber: invoicePayload.invoiceNumber,
          type: invoicePayload.type,
          status: 'draft',
          documentMode: invoicePayload.documentMode,
          providerStatus: invoicePayload.providerStatus,
          currency: associationResult.order ? associationResult.order.currency : invoicePayload.currency,
          subtotalAmount: structureResult.subtotalAmount,
          taxAmount: structureResult.taxAmount,
          totalAmount: structureResult.totalAmount,
          issuedAt: currentInvoice.issuedAt,
          dueAt: invoicePayload.dueAt,
          externalProvider: invoicePayload.externalProvider,
          externalReference: invoicePayload.externalReference,
          metadata: invoicePayload.metadata,
          items: itemsResult.items
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      invoice: enrichInvoiceView(invoice)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return buildError(context.tenantId, 'duplicate_invoice_number');
    }
    throw error;
  }
}

async function issuePortalInvoice(tenantId, invoiceId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isIssueAction: true });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const validationResult = await validateInvoiceForIssue({
    invoice: currentInvoice,
    tenantId: context.tenantId
  });
  if (!validationResult.ok) return validationResult;

  const nextProviderStatus = normalizeString(payload.providerStatus) || currentInvoice.providerStatus || null;
  const nextMetadata = {
    ...normalizeMetadata(currentInvoice.metadata),
    ...normalizeMetadata(payload.metadata),
    issueFlow: {
      mode: 'explicit_issue_action',
      at: new Date().toISOString()
    }
  };
  const initialPaymentPlan = normalizeInitialPaymentPlan(currentInvoice, nextMetadata);

  const invoice = await withTransaction(async (client) => {
    const issuedInvoice = await issueInvoice(
      currentInvoice.id,
      context.clinic.id,
      {
        issuedAt: payload.issuedAt || new Date().toISOString(),
        providerStatus: nextProviderStatus,
        metadata: nextMetadata
      },
      client
    );

    if (!initialPaymentPlan) {
      return issuedInvoice;
    }

    const createdPayment = await createPayment(
      {
        clinicId: context.clinic.id,
        contactId: issuedInvoice.contactId || null,
        invoiceId: issuedInvoice.id,
        amount: initialPaymentPlan.amount,
        currency: issuedInvoice.currency,
        method: initialPaymentPlan.method,
        status: 'recorded',
        paidAt: payload.issuedAt || issuedInvoice.issuedAt || new Date().toISOString(),
        externalReference: null,
        notes: initialPaymentPlan.notes,
        metadata: {
          source: 'invoice_initial_payment_plan',
          initialPaymentStatus: initialPaymentPlan.status
        }
      },
      client
    );

    await createPaymentAllocation(
      {
        clinicId: context.clinic.id,
        paymentId: createdPayment.id,
        invoiceId: issuedInvoice.id,
        amount: initialPaymentPlan.amount
      },
      client
    );

    return findInvoiceById(issuedInvoice.id, context.clinic.id, client);
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView(invoice)
  };
}

async function voidPortalInvoice(tenantId, invoiceId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isVoidAction: true });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const nextProviderStatus = normalizeString(payload.providerStatus) || currentInvoice.providerStatus || null;
  const nextMetadata = {
    ...normalizeMetadata(currentInvoice.metadata),
    ...normalizeMetadata(payload.metadata),
    voidedAt: new Date().toISOString(),
    voidReason: normalizeString(payload.reason) || null
  };

  const invoice = await withTransaction((client) =>
    voidInvoice(
      currentInvoice.id,
      context.clinic.id,
      {
        providerStatus: nextProviderStatus,
        metadata: nextMetadata
      },
      client
    )
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView(invoice)
  };
}

module.exports = {
  INVOICE_STATUSES: Array.from(INVOICE_STATUSES),
  INVOICE_TYPES: Array.from(INVOICE_TYPES),
  DOCUMENT_MODES: Array.from(DOCUMENT_MODES),
  listPortalInvoices,
  getPortalInvoiceDetail,
  listPortalInvoiceAllocations,
  createPortalInvoice,
  updatePortalInvoice,
  issuePortalInvoice,
  voidPortalInvoice
};
