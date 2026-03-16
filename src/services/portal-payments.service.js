const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const { findInvoiceById, lockInvoiceById } = require('../repositories/invoices.repository');
const {
  listPaymentsByClinicId,
  findPaymentById,
  lockPaymentById,
  createPayment,
  voidPayment
} = require('../repositories/payments.repository');
const {
  createPaymentAllocation,
  listAllocationsByPaymentId,
  sumRecordedAllocatedAmountsByInvoiceIds,
  sumRecordedAllocatedAmountsByPaymentIds
} = require('../repositories/payment-allocations.repository');
const {
  calculateInvoiceReceivable,
  normalizePaymentImpact,
  calculatePaymentAllocationSnapshot
} = require('./invoice-balance.service');
const { quantizeDecimal } = require('../utils/money');

const PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'card', 'other']);
const PAYMENT_STATUSES = new Set(['recorded', 'void']);

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

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

function enrichPaymentView(payment) {
  const allocationSnapshot = calculatePaymentAllocationSnapshot({
    payment,
    allocatedAmount: payment && payment.allocatedAmount ? payment.allocatedAmount : 0
  });

  return {
    ...payment,
    lifecycle: {
      canVoid: payment.status === 'recorded',
      canAllocate: payment.status === 'recorded' && allocationSnapshot.unallocatedAmount > 0,
      internalStatus: payment.status
    },
    balanceImpact: allocationSnapshot.paymentImpact,
    allocatedAmount: allocationSnapshot.allocatedAmount,
    unallocatedAmount: allocationSnapshot.unallocatedAmount
  };
}

async function attachAllocationSummaries(clinicId, payments) {
  const items = Array.isArray(payments) ? payments : [];
  const paymentIds = items.map((payment) => payment.id).filter(Boolean);
  const allocatedByPaymentId = await sumRecordedAllocatedAmountsByPaymentIds(clinicId, paymentIds);

  return items.map((payment) => ({
    ...payment,
    allocatedAmount: allocatedByPaymentId[payment.id] || 0
  }));
}

function buildReceivableForInvoice(invoice, paidByInvoiceId) {
  return calculateInvoiceReceivable({
    invoice,
    paidAmount: paidByInvoiceId[invoice.id] || 0
  });
}

async function listPortalPayments(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const payments = await listPaymentsByClinicId(context.clinic.id);
  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, payments);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payments: withAllocationSummary.map(enrichPaymentView)
  };
}

async function getPortalPaymentDetail(tenantId, paymentId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safePaymentId = normalizeString(paymentId);
  if (!safePaymentId) {
    return buildError(context.tenantId, 'missing_payment_id');
  }

  const payment = await findPaymentById(safePaymentId, context.clinic.id);
  if (!payment) {
    return buildError(context.tenantId, 'payment_not_found');
  }

  const allocations = await listAllocationsByPaymentId(payment.id, context.clinic.id);
  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, [payment]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payment: {
      ...enrichPaymentView(withAllocationSummary[0] || payment),
      allocations
    }
  };
}

async function createPortalPayment(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contactId = normalizeString(payload.contactId) || null;
  const invoiceId = normalizeString(payload.invoiceId) || null;
  const amount = quantizeDecimal(payload.amount, 2, NaN);
  const currency = normalizeCurrency(payload.currency, 'ARS');
  const method = PAYMENT_METHODS.has(normalizeString(payload.method).toLowerCase())
    ? normalizeString(payload.method).toLowerCase()
    : 'other';
  const status = PAYMENT_STATUSES.has(normalizeString(payload.status).toLowerCase())
    ? normalizeString(payload.status).toLowerCase()
    : 'recorded';

  if (!Number.isFinite(amount) || amount <= 0) {
    return buildError(context.tenantId, 'invalid_payment_amount');
  }

  let contact = null;
  if (contactId) {
    contact = await findContactByIdAndClinicId(contactId, context.clinic.id);
    if (!contact) {
      return buildError(context.tenantId, 'contact_not_found');
    }
  }

  let invoice = null;
  let receivable = null;
  if (invoiceId) {
    invoice = await findInvoiceById(invoiceId, context.clinic.id);
    if (!invoice) {
      return buildError(context.tenantId, 'invoice_not_found');
    }
    if (invoice.status === 'void') {
      return buildError(context.tenantId, 'payment_cannot_target_void_invoice');
    }
    if (invoice.status !== 'issued') {
      return buildError(context.tenantId, 'payment_cannot_target_non_issued_invoice');
    }
    if (invoice.type === 'credit_note') {
      return buildError(context.tenantId, 'payment_cannot_target_credit_note');
    }
    if (contactId && invoice.contactId && invoice.contactId !== contactId) {
      return buildError(context.tenantId, 'payment_invoice_contact_scope_mismatch');
    }
    if (!contact && invoice.contactId) {
      contact = await findContactByIdAndClinicId(invoice.contactId, context.clinic.id);
    }
    if (invoice.currency !== currency) {
      return buildError(context.tenantId, 'payment_currency_mismatch');
    }

    const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id]);
    receivable = buildReceivableForInvoice(invoice, paidByInvoiceId);

    if (quantizeDecimal(receivable.outstandingAmount, 2, 0) <= 0) {
      return buildError(context.tenantId, 'invoice_has_no_outstanding_amount');
    }
    if (amount > receivable.outstandingAmount) {
      return buildError(context.tenantId, 'payment_exceeds_outstanding_amount');
    }
  }

  const payment = await withTransaction(async (client) => {
    const created = await createPayment(
      {
        clinicId: context.clinic.id,
        contactId: contact ? contact.id : null,
        invoiceId: invoice ? invoice.id : null,
        amount,
        currency,
        method,
        status,
        paidAt: payload.paidAt || new Date().toISOString(),
        externalReference: normalizeString(payload.externalReference) || null,
        notes: normalizeString(payload.notes) || null,
        metadata: {
          ...normalizeMetadata(payload.metadata),
          allocationModel: {
            sourceOfTruth: invoice ? 'payment_allocations' : 'unallocated_payment',
            legacyInvoiceId: invoice ? invoice.id : null
          }
        }
      },
      client
    );

    if (invoice && created.status === 'recorded') {
      await createPaymentAllocation(
        {
          clinicId: context.clinic.id,
          paymentId: created.id,
          invoiceId: invoice.id,
          amount
        },
        client
      );
    }

    return findPaymentById(created.id, context.clinic.id, client);
  });

  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, [payment]);
  const allocations = await listAllocationsByPaymentId(payment.id, context.clinic.id);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payment: {
      ...enrichPaymentView(withAllocationSummary[0] || payment),
      allocations
    }
  };
}

async function createPortalPaymentAllocation(tenantId, paymentId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safePaymentId = normalizeString(paymentId);
  const invoiceId = normalizeString(payload.invoiceId);
  const amount = quantizeDecimal(payload.amount, 2, NaN);

  if (!safePaymentId) {
    return buildError(context.tenantId, 'missing_payment_id');
  }
  if (!invoiceId) {
    return buildError(context.tenantId, 'missing_invoice_id');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return buildError(context.tenantId, 'invalid_payment_allocation_amount');
  }

  const result = await withTransaction(async (client) => {
    const paymentLocked = await lockPaymentById(safePaymentId, context.clinic.id, client);
    if (!paymentLocked) {
      return buildError(context.tenantId, 'payment_not_found');
    }

    const invoiceLocked = await lockInvoiceById(invoiceId, context.clinic.id, client);
    if (!invoiceLocked) {
      return buildError(context.tenantId, 'invoice_not_found');
    }

    const payment = await findPaymentById(safePaymentId, context.clinic.id, client);
    const invoice = await findInvoiceById(invoiceId, context.clinic.id, client);

    if (!payment || !invoice) {
      return buildError(context.tenantId, !payment ? 'payment_not_found' : 'invoice_not_found');
    }
    if (payment.status !== 'recorded') {
      return buildError(context.tenantId, 'payment_not_allocatable_in_current_status');
    }
    if (invoice.status === 'void') {
      return buildError(context.tenantId, 'payment_allocation_cannot_target_void_invoice');
    }
    if (invoice.status !== 'issued') {
      return buildError(context.tenantId, 'payment_allocation_cannot_target_non_issued_invoice');
    }
    if (invoice.type === 'credit_note') {
      return buildError(context.tenantId, 'payment_allocation_cannot_target_credit_note');
    }
    if (payment.currency !== invoice.currency) {
      return buildError(context.tenantId, 'payment_allocation_currency_mismatch');
    }
    if (payment.contactId && invoice.contactId && payment.contactId !== invoice.contactId) {
      return buildError(context.tenantId, 'payment_allocation_contact_scope_mismatch');
    }

    const allocatedByPaymentId = await sumRecordedAllocatedAmountsByPaymentIds(context.clinic.id, [payment.id], client);
    const paymentSnapshot = calculatePaymentAllocationSnapshot({
      payment,
      allocatedAmount: allocatedByPaymentId[payment.id] || 0
    });
    if (paymentSnapshot.unallocatedAmount <= 0) {
      return buildError(context.tenantId, 'payment_has_no_unallocated_amount');
    }
    if (amount > paymentSnapshot.unallocatedAmount) {
      return buildError(context.tenantId, 'payment_allocation_exceeds_unallocated_amount');
    }

    const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id], client);
    const receivable = buildReceivableForInvoice(invoice, paidByInvoiceId);
    if (receivable.outstandingAmount <= 0) {
      return buildError(context.tenantId, 'invoice_has_no_outstanding_amount');
    }
    if (amount > receivable.outstandingAmount) {
      return buildError(context.tenantId, 'payment_allocation_exceeds_invoice_outstanding_amount');
    }

    const allocation = await createPaymentAllocation(
      {
        clinicId: context.clinic.id,
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount
      },
      client
    );

    return { ok: true, allocation };
  });

  if (!result.ok) {
    return result;
  }

  const payment = await findPaymentById(safePaymentId, context.clinic.id);
  const allocations = await listAllocationsByPaymentId(safePaymentId, context.clinic.id);
  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, [payment]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    allocation: result.allocation,
    payment: {
      ...enrichPaymentView(withAllocationSummary[0] || payment),
      allocations
    }
  };
}

async function listPortalPaymentAllocations(tenantId, paymentId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safePaymentId = normalizeString(paymentId);
  if (!safePaymentId) {
    return buildError(context.tenantId, 'missing_payment_id');
  }

  const payment = await findPaymentById(safePaymentId, context.clinic.id);
  if (!payment) {
    return buildError(context.tenantId, 'payment_not_found');
  }

  const allocations = await listAllocationsByPaymentId(safePaymentId, context.clinic.id);
  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, [payment]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payment: enrichPaymentView(withAllocationSummary[0] || payment),
    allocations
  };
}

async function voidPortalPayment(tenantId, paymentId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safePaymentId = normalizeString(paymentId);
  if (!safePaymentId) {
    return buildError(context.tenantId, 'missing_payment_id');
  }

  const currentPayment = await findPaymentById(safePaymentId, context.clinic.id);
  if (!currentPayment) {
    return buildError(context.tenantId, 'payment_not_found');
  }

  if (currentPayment.status === 'void') {
    return buildError(context.tenantId, 'payment_already_void');
  }

  if (currentPayment.status !== 'recorded') {
    return buildError(context.tenantId, 'payment_not_voidable_in_current_status');
  }

  const payment = await withTransaction((client) =>
    voidPayment(
      currentPayment.id,
      context.clinic.id,
      {
        notes: normalizeString(payload.notes) || currentPayment.notes || null,
        externalReference: normalizeString(payload.externalReference) || currentPayment.externalReference || null,
        metadata: {
          ...normalizeMetadata(currentPayment.metadata),
          ...normalizeMetadata(payload.metadata),
          voidFlow: {
            mode: 'explicit_void_action',
            at: new Date().toISOString(),
            reason: normalizeString(payload.reason) || null
          }
        }
      },
      client
    )
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payment: enrichPaymentView(payment)
  };
}

module.exports = {
  PAYMENT_METHODS: Array.from(PAYMENT_METHODS),
  PAYMENT_STATUSES: Array.from(PAYMENT_STATUSES),
  listPortalPayments,
  getPortalPaymentDetail,
  createPortalPayment,
  createPortalPaymentAllocation,
  listPortalPaymentAllocations,
  voidPortalPayment
};
