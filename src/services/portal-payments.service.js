const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const {
  findInvoiceById,
  lockInvoiceById,
  listInvoicesByParentInvoiceId,
  createInvoice
} = require('../repositories/invoices.repository');
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
  normalizeInvoiceDocumentImpact,
  normalizePaymentImpact,
  calculatePaymentAllocationSnapshot
} = require('./invoice-balance.service');
const { quantizeDecimal } = require('../utils/money');
const {
  awardLoyaltyPointsForPayment,
  reverseLoyaltyPointsForVoidedPayment
} = require('./portal-loyalty.service');

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

function buildCreditNoteReference(invoice) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber || invoice.internalDocumentNumber || null,
    type: invoice.type || 'credit_note',
    status: invoice.status || 'draft',
    currency: invoice.currency || 'ARS',
    totalAmount: quantizeDecimal(invoice.totalAmount || 0, 2, 0),
    issuedAt: invoice.issuedAt || null,
    createdAt: invoice.createdAt || null,
    balanceImpact: normalizeInvoiceDocumentImpact(invoice)
  };
}

function isPaymentVoidCreditNote(invoice, paymentId) {
  const metadata = normalizeMetadata(invoice && invoice.metadata);
  return normalizeString(metadata.paymentVoid && metadata.paymentVoid.paymentId) === normalizeString(paymentId);
}

async function resolvePaymentVoidInvoiceTargets(payment, clinicId, client = null) {
  const allocations = await listAllocationsByPaymentId(payment.id, clinicId, client);
  if (allocations.length) {
    const grouped = allocations.reduce((acc, allocation) => {
      const invoiceId = normalizeString(allocation.invoiceId);
      if (!invoiceId) return acc;
      acc[invoiceId] = quantizeDecimal((acc[invoiceId] || 0) + Number(allocation.amount || 0), 2, 0);
      return acc;
    }, {});

    return Object.entries(grouped)
      .filter(([, amount]) => quantizeDecimal(amount, 2, 0) > 0)
      .map(([invoiceId, amount]) => ({ invoiceId, amount: quantizeDecimal(amount, 2, 0) }));
  }

  const directInvoiceId = normalizeString(payment.invoiceId);
  if (!directInvoiceId) {
    return [];
  }

  return [
    {
      invoiceId: directInvoiceId,
      amount: quantizeDecimal(payment.amount || 0, 2, 0)
    }
  ];
}

function buildPaymentVoidCreditNoteInput(parentInvoice, payment, amount) {
  const safeAmount = quantizeDecimal(Math.abs(amount || 0), 2, 0);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return null;
  }

  const issuedAt = new Date().toISOString();
  const parentLabel = parentInvoice.invoiceNumber || parentInvoice.internalDocumentNumber || parentInvoice.id;
  const paymentLabel = normalizeString(payment.externalReference) || payment.id.slice(0, 8);
  const descriptionSnapshot = `Anulacion de cobro ${paymentLabel} asociada al comprobante ${parentLabel}`;

  return {
    clinicId: parentInvoice.clinicId,
    contactId: parentInvoice.contactId || payment.contactId || null,
    orderId: parentInvoice.orderId || null,
    parentInvoiceId: parentInvoice.id,
    invoiceNumber: null,
    type: 'credit_note',
    status: 'issued',
    documentMode: parentInvoice.documentMode || 'internal_only',
    providerStatus: null,
    currency: parentInvoice.currency || payment.currency || 'ARS',
    subtotalAmount: -safeAmount,
    taxAmount: 0,
    totalAmount: -safeAmount,
    issuedAt,
    dueAt: null,
    externalProvider: null,
    externalReference: null,
    documentKind: parentInvoice.documentKind || 'internal_invoice',
    fiscalStatus: 'ready_for_accountant',
    customerTaxId: parentInvoice.customerTaxId || null,
    customerTaxIdType: parentInvoice.customerTaxIdType || 'NONE',
    customerLegalName: parentInvoice.customerLegalName || parentInvoice.contact?.name || null,
    customerVatCondition: parentInvoice.customerVatCondition || null,
    issuerLegalName: parentInvoice.issuerLegalName || null,
    issuerTaxId: parentInvoice.issuerTaxId || null,
    issuerTaxIdType: parentInvoice.issuerTaxIdType || 'NONE',
    issuerVatCondition: parentInvoice.issuerVatCondition || null,
    issuerGrossIncomeNumber: parentInvoice.issuerGrossIncomeNumber || null,
    issuerFiscalAddress: parentInvoice.issuerFiscalAddress || null,
    issuerCity: parentInvoice.issuerCity || null,
    issuerProvince: parentInvoice.issuerProvince || null,
    pointOfSaleSuggested: parentInvoice.pointOfSaleSuggested || null,
    suggestedFiscalVoucherType: parentInvoice.suggestedFiscalVoucherType || 'NONE',
    accountantNotes: 'Generada automaticamente al anular un cobro.',
    deliveredToAccountantAt: null,
    invoicedByAccountantAt: null,
    accountantReferenceNumber: null,
    metadata: {
      source: 'payment_void_credit_note',
      paymentVoid: {
        paymentId: payment.id,
        generatedAt: issuedAt,
        amount: safeAmount,
        currency: parentInvoice.currency || payment.currency || 'ARS',
        method: payment.method || null,
        originalInvoiceId: parentInvoice.id
      }
    },
    items: [
      {
        productId: null,
        descriptionSnapshot,
        quantity: 1,
        unitPrice: -safeAmount,
        taxRate: 0,
        subtotalAmount: -safeAmount,
        totalAmount: -safeAmount
      }
    ]
  };
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

    if (created.status === 'recorded') {
      await awardLoyaltyPointsForPayment(context.clinic.id, created.id, client);
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
    const existingCreditNotes = Array.isArray(currentPayment.metadata && currentPayment.metadata.voidCreditNotes)
      ? currentPayment.metadata.voidCreditNotes
      : [];
    if (existingCreditNotes.length) {
      return buildError(context.tenantId, 'payment_void_credit_note_already_exists', {
        creditNotes: existingCreditNotes
      });
    }
    return buildError(context.tenantId, 'payment_already_void');
  }

  if (currentPayment.status !== 'recorded') {
    return buildError(context.tenantId, 'payment_not_voidable_in_current_status');
  }

  const result = await withTransaction(async (client) => {
    const paymentLocked = await lockPaymentById(currentPayment.id, context.clinic.id, client);
    if (!paymentLocked) {
      return buildError(context.tenantId, 'payment_not_found');
    }

    const lockedPayment = await findPaymentById(currentPayment.id, context.clinic.id, client);
    if (!lockedPayment) {
      return buildError(context.tenantId, 'payment_not_found');
    }

    const targets = await resolvePaymentVoidInvoiceTargets(lockedPayment, context.clinic.id, client);
    const creditNotes = [];
    let createdCreditNotes = 0;

    for (const target of targets) {
      const invoiceId = normalizeString(target.invoiceId);
      if (!invoiceId) continue;
      const targetAmount = quantizeDecimal(target.amount || 0, 2, 0);
      if (!Number.isFinite(targetAmount) || targetAmount <= 0) continue;

      const invoiceLocked = await lockInvoiceById(invoiceId, context.clinic.id, client);
      if (!invoiceLocked) continue;

      const parentInvoice = await findInvoiceById(invoiceId, context.clinic.id, client);
      if (!parentInvoice || parentInvoice.status !== 'issued' || parentInvoice.type !== 'invoice') {
        continue;
      }

      const existingCreditNotes = await listInvoicesByParentInvoiceId(parentInvoice.id, context.clinic.id, client);
      const existingCreditNote = existingCreditNotes.find((invoice) => isPaymentVoidCreditNote(invoice, lockedPayment.id));
      if (existingCreditNote) {
        creditNotes.push(buildCreditNoteReference(existingCreditNote));
        continue;
      }

      const creditNoteInput = buildPaymentVoidCreditNoteInput(parentInvoice, lockedPayment, targetAmount);
      if (!creditNoteInput) continue;

      const createdCreditNote = await createInvoice(creditNoteInput, client);
      creditNotes.push(buildCreditNoteReference(createdCreditNote));
      createdCreditNotes += 1;
    }

    const voidedPayment = await voidPayment(
      lockedPayment.id,
      context.clinic.id,
      {
        notes: normalizeString(payload.notes) || lockedPayment.notes || null,
        externalReference: normalizeString(payload.externalReference) || lockedPayment.externalReference || null,
        metadata: {
          ...normalizeMetadata(lockedPayment.metadata),
          ...normalizeMetadata(payload.metadata),
          voidFlow: {
            mode: 'explicit_void_action',
            at: new Date().toISOString(),
            reason: normalizeString(payload.reason) || null
          },
          voidCreditNotes: creditNotes
        }
      },
      client
    );

    await reverseLoyaltyPointsForVoidedPayment(context.clinic.id, lockedPayment.id, client);
    return {
      ok: true,
      payment: voidedPayment,
      relatedCreditNotes: creditNotes,
      creditNoteStatus:
        creditNotes.length === 0 ? 'not_applicable' : createdCreditNotes > 0 ? 'generated' : 'already_exists'
    };
  });

  if (!result.ok) {
    return result;
  }

  const withAllocationSummary = await attachAllocationSummaries(context.clinic.id, [result.payment]);
  const payment = withAllocationSummary[0] || result.payment;

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    payment: {
      ...enrichPaymentView(payment),
      relatedCreditNotes: result.relatedCreditNotes,
      voidOutcome: {
        creditNoteStatus: result.creditNoteStatus,
        relatedCreditNotes: result.relatedCreditNotes
      }
    }
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
